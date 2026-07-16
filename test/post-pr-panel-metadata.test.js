import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { affectedPathsHash, canonicalizePanelAffectedPaths, classifyPanelResult, snapshotPanelAffectedValue } from "../src/post-pr-ci.js";

// Full adversarial row inventory for panel-runner result metadata, exercised
// directly at the exported pure seams (classifyPanelResult,
// snapshotPanelAffectedValue, canonicalizePanelAffectedPaths). The post-PR
// workflow suite keeps a small wiring subset that proves these classifications
// flow into terminal facts through both panels; the exhaustive matrices live
// here where a row costs microseconds instead of a git fixture plus two
// resumeFactory passes.
const WORKTREE = "/tmp/panel-metadata-worktree";
const EMPTY_PATHS_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

describe("post-PR panel result metadata seams", () => {
  it("pins the empty affected-paths hash used by terminal attribution facts", () => {
    assert.equal(affectedPathsHash([]), EMPTY_PATHS_HASH);
  });

  it("classifies every malformed panel-runner result shape for both panels", async () => {
    const classValue = new (class PanelResult { constructor(verdict) { this.verdict = verdict; } })("GO");
    const crossRealm = (await import("node:vm")).runInNewContext('({ verdict: "GO" })');
    const revoked = Proxy.revocable({ verdict: "GO" }, {}); revoked.revoke();
    const throwingToJson = { verdict: "GO", toJSON() { throw new Error("must not run"); } };
    const cases = [
      ["non-object", null], ["non-object", []], ["non-object", undefined], ["non-object", 1], ["non-object", true], ["non-object", 1n], ["non-object", Symbol("x")], ["non-object", () => {}], ["non-object", "GO"], ["non-object", new Date()], ["non-object", classValue], ["non-object", crossRealm],
      ["non-object", new Proxy({ verdict: "GO" }, { ownKeys() { throw new Error("trap must not run"); } })], ["non-object", revoked.proxy],
      ["missing-verdict", {}], ["missing-verdict", { affected_paths: ["src/api.js"] }], ["missing-verdict", { extra: true }],
      ["unexpected-result-keys", { verdict: "GO", extra: true }], ["unexpected-result-keys", Object.defineProperty({ verdict: "GO" }, "affected_paths", { get() { throw new Error("getter must not run"); } })],
      ["unexpected-result-keys", throwingToJson], ["unexpected-result-keys", { verdict: "GO", [Symbol("secret")]: true }],
      ["invalid-verdict", { verdict: "WRONG" }], ["invalid-verdict", { verdict: 1 }],
    ];
    for (const activity of ["validator", "security"]) {
      for (const [index, [issue, supplied]] of cases.entries()) {
        const inspected = classifyPanelResult(supplied, activity);
        assert.equal(inspected.ok, false, `${activity}:${index}:${issue}`);
        assert.equal(inspected.issue, issue, `${activity}:${index}`);
      }
    }
  });

  it("accepts exactly the panel vocabulary and exposes the affected descriptor", () => {
    assert.equal(classifyPanelResult({ verdict: "GO" }, "validator").ok, true);
    assert.equal(classifyPanelResult({ verdict: "NO-GO" }, "validator").ok, true);
    assert.equal(classifyPanelResult({ verdict: "PASS" }, "security").ok, true);
    assert.equal(classifyPanelResult({ verdict: "BLOCK" }, "security").ok, true);
    assert.equal(classifyPanelResult({ verdict: "PASS" }, "validator").issue, "invalid-verdict", "vocabularies must not cross panels");
    assert.equal(classifyPanelResult({ verdict: "GO" }, "security").issue, "invalid-verdict", "vocabularies must not cross panels");
    const inspected = classifyPanelResult({ verdict: "GO", affected_paths: ["src/api.js"] }, "validator");
    assert.equal(inspected.ok, true);
    assert.deepEqual(inspected.affectedDescriptor.value, ["src/api.js"]);
    assert.equal(classifyPanelResult({ verdict: "GO" }, "validator").affectedDescriptor, null);
  });

  it("classifies every affected-value shape and exact-limit row through the snapshot and canonicalization seams", () => {
    const invalid = (label, make) => ({ label, make, category: "invalid-paths" });
    const missing = (label, make, omit = false) => ({ label, make, omit, category: "missing-paths" });
    const rows = [
      missing("absent", () => undefined, true), missing("undefined", () => undefined),
      invalid("null", () => null), invalid("boolean", () => true), invalid("safe-string", () => "src/api.js"), invalid("finite-number", () => 1.5), invalid("negative-zero", () => -0), invalid("safe-record", () => ({ a: true })),
      { label: "empty-array", make: () => [], category: "empty-paths" },
      { label: "mixed-array", make: () => ["src/api.js", "test/api.test.js"], paths: ["src/api.js", "test/api.test.js"], hash: "2f976d81ca6cdbeec8123186abfdb21687e092b0b59c0793f4b87f5bfd8c31b9" },
      missing("sparse-array", () => { const value = []; value.length = 1; return value; }), missing("extra-key-array", () => Object.assign(["src/api.js"], { extra: true })),
      missing("symbol-key-array", () => { const value = ["src/api.js"]; value[Symbol("x")] = true; return value; }), missing("accessor-array", () => Object.defineProperty(["src/api.js"], "0", { enumerable: true, get() { throw new Error("must not run"); } })),
      missing("nested-accessor", () => ({ value: Object.defineProperty({}, "x", { enumerable: true, get() { throw new Error("must not run"); } }) })), missing("nested-proxy", () => ({ value: new Proxy({}, { ownKeys() { throw new Error("must not run"); } }) })),
      missing("cycle", () => { const value = {}; value.self = value; return value; }), invalid("repeated-reference", () => { const shared = { x: true }; return { first: shared, second: shared }; }),
      missing("bigint", () => ({ value: 1n })), missing("symbol", () => ({ value: Symbol("x") })), missing("function", () => ({ value() {} })), missing("nan", () => ({ value: NaN })), missing("infinity", () => ({ value: Infinity })),
      missing("unsupported-date", () => new Date()), missing("unsupported-custom-prototype", () => Object.assign(Object.create({}), { x: true })), missing("callable-toJSON", () => ({ toJSON() { throw new Error("must not run"); } })),
      missing("inherited-toJSON", () => Object.assign(Object.create({ toJSON() { throw new Error("must not run"); } }), { x: true })), missing("malformed-unicode", () => "\uD800"),
      invalid("string-byte-limit", () => "a".repeat(4096)), missing("string-byte-limit-plus-one", () => "a".repeat(4097)),
      { label: "array-length-limit", make: () => new Array(4096).fill("src/api.js"), paths: ["src/api.js"] }, missing("array-length-limit-plus-one", () => new Array(4097).fill("src/api.js")),
      invalid("depth-32-container-primitive-child", () => affectedDepthValue(32)), missing("depth-33-container", () => affectedDepthValue(33)),
      invalid("occurrence-limit", () => affectedOccurrenceTree(1)), missing("occurrence-limit-plus-one", () => affectedOccurrenceTree(2)),
      invalid("entry-limit", () => affectedEntryObject(8192)), missing("entry-limit-plus-one", () => affectedEntryObject(8193)),
      missing("aggregate-string-limit", () => new Array(256).fill("a".repeat(4096))), missing("aggregate-string-limit-plus-one", () => [...new Array(256).fill("a".repeat(4096)), "a"]),
      invalid("emitted-byte-limit", () => affectedEmissionObject(false)), missing("emitted-byte-limit-plus-one", () => affectedEmissionObject(true)),
      invalid("path-non-string", () => [1]), missing("path-boxed-string", () => [new String("src/api.js")]), invalid("path-empty", () => [""]), invalid("path-absolute", () => ["/tmp/x"]), invalid("path-drive-upper", () => ["C:/x"]), invalid("path-drive-lower", () => ["c:/x"]),
      invalid("path-backslash", () => ["a\\b"]), invalid("path-nul", () => ["a\u0000b"]), invalid("path-control", () => ["a\u001fb"]), invalid("path-del", () => ["a\u007fb"]), invalid("path-repeated-separator", () => ["a//b"]), invalid("path-trailing-separator", () => ["a/"]),
      invalid("path-dot", () => ["a/./b"]), invalid("path-dotdot", () => ["a/../b"]), invalid("path-escape", () => ["../x"]), invalid("path-mixed-invalid", () => ["src/api.js", "../x"]),
      { label: "path-byte-limit", make: () => ["a".repeat(4096)], paths: ["a".repeat(4096)], hash: "58850230e822043b8c75a23c51fa30686e3c6826d6a671773e6189308a33dde6" }, missing("path-byte-limit-plus-one", () => ["a".repeat(4097)]),
      missing("path-malformed-unicode", () => ["\uD800"]),
      { label: "path-nfc-duplicates-byte-sort", make: () => ["src/\u00e9.js", "src/e\u0301.js", "src/api.js"], paths: ["src/api.js", "src/\u00e9.js"], hash: "0c5966fdf11b361b50edc4de95bf8751a89f9dfc431be364c353c5197a9e1836" },
    ];

    for (const row of rows) {
      const outcome = classifyAffectedRow(row);
      if (row.category) {
        assert.equal(outcome.ok, false, row.label);
        assert.equal(outcome.category, row.category, row.label);
        assert.equal(outcome.hash, EMPTY_PATHS_HASH, `${row.label}: category rows must attribute the empty-paths hash`);
      } else {
        assert.equal(outcome.ok, true, row.label);
        assert.deepEqual(outcome.paths, row.paths, row.label);
        if (row.hash) assert.equal(outcome.hash, row.hash, row.label);
      }
    }
  });
});

// Mirrors the production classification pipeline in src/factory.js: classify
// the runner result envelope, snapshot the untrusted affected descriptor into
// a bounded primitive graph, then canonicalize paths against the worktree.
// Category rows carry the empty-paths hash exactly as terminalPanelAttribution
// records it.
function classifyAffectedRow(row) {
  const result = row.omit ? { verdict: "GO" } : { verdict: "GO", affected_paths: row.make() };
  const inspected = classifyPanelResult(result, "validator");
  assert.equal(inspected.ok, true, `${row.label}: envelope must be admissible before affected-value classification`);
  const snapshot = snapshotPanelAffectedValue(inspected.affectedDescriptor);
  if (!snapshot.ok) return { ok: false, category: snapshot.category, hash: affectedPathsHash([]) };
  const attribution = canonicalizePanelAffectedPaths(snapshot.value, WORKTREE);
  if (!attribution.ok) return { ok: false, category: attribution.category, hash: attribution.hash ?? affectedPathsHash([]) };
  return { ok: true, paths: attribution.paths, hash: attribution.hash };
}

function affectedDepthValue(containers) { let root = {}; let cursor = root; for (let index = 1; index < containers; index += 1) { cursor.x = {}; cursor = cursor.x; } cursor.x = null; return root; }
function affectedOccurrenceTree(extras) { const root = {}; let level = [root]; for (let depth = 0; depth < 12; depth += 1) { const next = []; for (const node of level) { node.a = {}; node.b = {}; next.push(node.a, node.b); } level = next; } if (extras > 0) level[0].x = {}; if (extras > 1) level[0].y = {}; return root; }
function affectedEntryObject(count) { return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index.toString(16).padStart(4, "0")}`, null])); }
function affectedEmissionObject(over) {
  const value = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`k${index.toString(16).padStart(3, "0")}`, "a".repeat(4096)])); value.final = "";
  const remaining = 1_048_576 - Buffer.byteLength(JSON.stringify(value, null, 2), "utf8"); assert.ok(remaining >= 0 && remaining <= 4096); value.final = "a".repeat(remaining + (over ? 1 : 0)); return value;
}
