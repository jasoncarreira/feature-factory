import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SafeJsonError,
  assertJsonDataModel,
  encodeTerminalLabel,
  encodeTerminalText,
  serializeTerminalJson,
} from "../src/hardening/terminal-encoding.js";

const JSON_ERROR_MESSAGE = "Value is not valid safe JSON data.";

describe("terminal text encoding", () => {
  it("uses exact, code-unit-injective ASCII identity escapes", () => {
    const raw = "AZ az09 ~!\"'\\u001B\u001bé😀";
    assert.equal(
      encodeTerminalText(raw, { profile: "ascii-identity" }),
      "AZ az09 ~!\"'\\\\u001B\\u001B\\u00E9\\uD83D\\uDE00",
    );
    assert.equal(encodeTerminalText("quote: \""), "quote: \"");
  });

  it("adds trusted label quotes and reserves raw quotes and backslashes", () => {
    assert.equal(encodeTerminalLabel("a\"b\\c"), "\"a\\\"b\\\\c\"");
    assert.equal(
      encodeTerminalLabel("é😀", { profile: "unicode-prose" }),
      "\"é😀\"",
    );
  });

  it("escapes every C0, DEL, and C1 code unit", () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("")
      + Array.from({ length: 0x21 }, (_, offset) => String.fromCharCode(0x7F + offset)).join("");
    const expected = Array.from(controls, (character) => escapeUnit(character.charCodeAt(0))).join("");
    assert.equal(encodeTerminalText(controls), expected);
  });

  it("makes ANSI, OSC, NEL, bidi, and format payloads inert", () => {
    assert.equal(encodeTerminalText("ok\u001B[2J"), "ok\\u001B[2J");
    assert.equal(encodeTerminalText("x\u001B]52;c;AAAA\u0007y"), "x\\u001B]52;c;AAAA\\u0007y");
    assert.equal(encodeTerminalText("a\u0085b"), "a\\u0085b");

    const bidiUnits = "\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
    const defaultIgnorables = "\u00AD\u200B\u200D\uFEFF\uFE0F";
    assert.equal(encodeTerminalText(bidiUnits), [...bidiUnits].map((unit) => escapeUnit(unit.charCodeAt(0))).join(""));
    assert.equal(
      encodeTerminalText(defaultIgnorables),
      [...defaultIgnorables].map((unit) => escapeUnit(unit.charCodeAt(0))).join(""),
    );
    assert.equal(encodeTerminalText("\u{E0001}"), "\\uDB40\\uDC01");
  });

  it("preserves supported Unicode prose without normalization", () => {
    const prose = "Café Καλημέρα 中文 — ™ © 😀 e\u0301";
    assert.equal(encodeTerminalText(prose), prose);
    assert.equal(encodeTerminalText("é"), "é");
    assert.equal(encodeTerminalText("e\u0301"), "e\u0301");
    assert.notEqual(encodeTerminalText("é"), encodeTerminalText("e\u0301"));
  });

  it("escapes non-ASCII separators, private use, and unassigned scalars", () => {
    assert.equal(
      encodeTerminalText(" \u00A0\u2028\u2029\uE000\u0378"),
      " \\u00A0\\u2028\\u2029\\uE000\\u0378",
    );
  });

  it("preserves allowed surrogate pairs and escapes lone or unsupported surrogates", () => {
    assert.equal(encodeTerminalText("😀𐐷"), "😀𐐷");
    assert.equal(encodeTerminalText("\uD800A\uDC00"), "\\uD800A\\uDC00");
    assert.equal(
      encodeTerminalText("😀", { profile: "ascii-identity" }),
      "\\uD83D\\uDE00",
    );
  });

  it("keeps adversarially similar inputs distinct in both profiles", () => {
    const values = [
      "\u001B",
      "\\u001B",
      "\\\\u001B",
      "\"",
      "\\\"",
      "é",
      "e\u0301",
      "\uD800",
      "\\uD800",
      "\u202E",
      "\\u202E",
    ];
    for (const profile of ["ascii-identity", "unicode-prose"]) {
      assert.equal(new Set(values.map((value) => encodeTerminalText(value, { profile }))).size, values.length);
      assert.equal(new Set(values.map((value) => encodeTerminalLabel(value, { profile }))).size, values.length);
    }
  });

  it("uses fixed failures for invalid options and failed coercion", () => {
    assert.throws(
      () => encodeTerminalText("x", { profile: "unknown-secret-profile" }),
      { name: "TypeError", message: "Invalid terminal encoding options." },
    );
    assert.throws(
      () => encodeTerminalText({ toString() { throw new Error("secret-value"); } }),
      { name: "TypeError", message: "Terminal text encoding failed." },
    );
  });
});

describe("strict JSON data model", () => {
  it("clones supported trees into prototype-safe data-property structures", () => {
    const source = Object.create(null);
    Object.defineProperty(source, "__proto__", {
      value: { text: "value", numbers: [0, 1.25, -3e20], enabled: true, empty: null },
      enumerable: true,
    });

    const clone = assertJsonDataModel(source);
    assert.equal(Object.getPrototypeOf(clone), null);
    assert.equal(Object.getPrototypeOf(clone.__proto__), null);
    assert.equal(Object.getPrototypeOf(clone.__proto__.numbers), null);
    assert.notEqual(clone, source);
    assert.notEqual(clone.__proto__, source.__proto__);
    assert.equal(clone.__proto__.numbers.length, 3);
    assert.equal(clone.__proto__.numbers[0], 0);
    assert.equal(clone.__proto__.numbers[1], 1.25);
    assert.equal(clone.__proto__.numbers[2], -3e20);
    assert.equal(Object.getOwnPropertyDescriptor(clone, "__proto__").value, clone.__proto__);
  });

  it("accepts frozen enumerable data properties", () => {
    assert.deepEqual(
      JSON.parse(serializeTerminalJson(Object.freeze({ items: Object.freeze(["a", "b"]) }))),
      { items: ["a", "b"] },
    );
  });

  it("rejects unsupported scalar values with one fixed error", () => {
    for (const value of [undefined, 1n, Symbol("secret"), () => {}, NaN, Infinity, -Infinity, -0]) {
      assertSafeJsonFailure(() => assertJsonDataModel(value));
      assertSafeJsonFailure(() => serializeTerminalJson(value));
    }
  });

  it("rejects sparse or named arrays, symbols, non-enumerables, and accessors", () => {
    const sparse = new Array(2);
    sparse[1] = "present";
    const named = ["value"];
    named.extra = true;
    const hiddenArray = ["value"];
    Object.defineProperty(hiddenArray, "hidden", { value: true });
    const symbolArray = ["value"];
    symbolArray[Symbol("secret-array-key")] = true;
    const accessorArray = ["value"];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() { throw new Error("secret-array-accessor"); },
    });

    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret-key", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("secret-accessor-value");
      },
    });
    const hiddenObject = {};
    Object.defineProperty(hiddenObject, "secret-hidden-key", { value: true });
    const symbolObject = { visible: true };
    symbolObject[Symbol("secret-symbol-key")] = true;

    for (const value of [sparse, named, hiddenArray, symbolArray, accessorArray, accessor, hiddenObject, symbolObject]) {
      assertSafeJsonFailure(() => serializeTerminalJson(value));
    }
    assert.equal(getterCalls, 0);
  });

  it("rejects custom prototypes and any own toJSON property", () => {
    class Custom {}
    const customArray = [];
    Object.setPrototypeOf(customArray, null);
    const customPrototype = Object.create({ inherited: true });
    customPrototype.value = true;
    const stringToJson = { toJSON: "not callable" };
    const accessorToJson = {};
    Object.defineProperty(accessorToJson, "toJSON", {
      enumerable: true,
      get() { throw new Error("secret-to-json"); },
    });

    for (const value of [new Custom(), new Date(), customArray, customPrototype, stringToJson, accessorToJson]) {
      assertSafeJsonFailure(() => serializeTerminalJson(value));
    }
  });

  it("rejects cycles and completed shared references", () => {
    const cycle = {};
    cycle.self = cycle;
    const shared = { value: true };
    for (const value of [cycle, { left: shared, right: shared }, [shared, shared]]) {
      assertSafeJsonFailure(() => serializeTerminalJson(value));
    }
  });

  it("turns reflection and option failures into fixed safe errors", () => {
    const failures = [
      new Proxy({}, { getPrototypeOf() { throw new Error("secret-prototype"); } }),
      new Proxy({}, { ownKeys() { throw new Error("secret-own-key"); } }),
      new Proxy({ secret: true }, { getOwnPropertyDescriptor() { throw new Error("secret-descriptor"); } }),
    ];
    for (const value of failures) assertSafeJsonFailure(() => serializeTerminalJson(value));

    const options = Object.create(null);
    Object.defineProperty(options, "space", {
      get() { throw new Error("secret-space"); },
    });
    assertSafeJsonFailure(() => serializeTerminalJson({}, options));
  });
});

describe("terminal-safe JSON serialization", () => {
  it("supports only zero or two spaces and never appends a line feed", () => {
    assert.equal(serializeTerminalJson({ a: [1, true, null] }), '{"a":[1,true,null]}');
    assert.equal(
      serializeTerminalJson({ a: [1] }, { space: 2 }),
      '{\n  "a": [\n    1\n  ]\n}',
    );
    assert.equal(serializeTerminalJson({}, { space: 2 }).endsWith("\n"), false);
    for (const space of [null, 1, 4, "2", new Number(2)]) {
      assertSafeJsonFailure(() => serializeTerminalJson({}, { space }));
    }
  });

  it("byte-escapes unsafe JSON string units while retaining parsed identity", () => {
    const key = "key\u0085\u202E\uFEFF\uE000";
    const value = "literal \\u001B | control \u001B | \"quote\" | \\ | \u2028 | \u{E0001} | \uD800";
    const source = Object.create(null);
    Object.defineProperty(source, key, { value, enumerable: true });

    const serialized = serializeTerminalJson(source);
    assert.equal(/[\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF\uE000]/u.test(serialized), false);
    assert.match(serialized, /\\u0085/u);
    assert.match(serialized, /\\u202E/u);
    assert.match(serialized, /\\uFEFF/u);
    assert.match(serialized, /\\uE000/u);
    assert.match(serialized, /\\uDB40\\uDC01/u);
    assert.deepEqual(JSON.parse(serialized), { [key]: value });
  });

  it("round-trips exact keys, code units, numbers, types, and structure", () => {
    const source = Object.create(null);
    for (const [key, value] of [
      ["__proto__", "prototype-value"],
      ["constructor", "constructor-value"],
      ["\\u001B", "literal-escape"],
      ["\u001B", "actual-control"],
      ["é", "composed"],
      ["e\u0301", "decomposed"],
      ["\uD800", "lone-high"],
      ["\uDC00", "lone-low"],
    ]) {
      Object.defineProperty(source, key, { value, enumerable: true });
    }
    Object.defineProperty(source, "nested", {
      value: [false, null, 1.5, -2e-9, "😀", "a\"b\\c"],
      enumerable: true,
    });

    const parsed = JSON.parse(serializeTerminalJson(source, { space: 2 }));
    assert.deepEqual(Reflect.ownKeys(parsed), Reflect.ownKeys(source));
    for (const key of Reflect.ownKeys(source)) {
      if (key === "nested") assert.deepEqual(parsed[key], source[key]);
      else assert.equal(parsed[key], source[key]);
    }
  });

  it("does not invoke inherited object or array toJSON methods", () => {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() { throw new Error("secret-object-to-json"); },
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value() { throw new Error("secret-array-to-json"); },
    });
    try {
      assert.equal(serializeTerminalJson({ values: [1, 2] }), '{"values":[1,2]}');
    } finally {
      delete Object.prototype.toJSON;
      delete Array.prototype.toJSON;
    }
  });
});

function escapeUnit(codeUnit) {
  return `\\u${codeUnit.toString(16).toUpperCase().padStart(4, "0")}`;
}

function assertSafeJsonFailure(callback) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof SafeJsonError, true);
    assert.equal(error.name, "SafeJsonError");
    assert.equal(error.message, JSON_ERROR_MESSAGE);
    assert.equal(/secret|prototype|descriptor|accessor|symbol|path|key|value/u.test(error.message), false);
    return true;
  });
}
