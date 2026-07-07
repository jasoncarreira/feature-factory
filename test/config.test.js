import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJsoncConfig,
  parseStrictJsonConfig,
  readJsoncConfig,
  readStrictJsonConfig,
} from "../src/config.js";

describe("parseJsoncConfig", () => {
  it("parses strict JSON objects without changing values", () => {
    assert.deepEqual(parseJsoncConfig('{"enabled":true,"items":[1,2],"name":"factory"}'), {
      enabled: true,
      items: [1, 2],
      name: "factory",
    });
  });

  it("accepts line comments, inline comments, and block comments", () => {
    const config = parseJsoncConfig(`
      // before the object
      {
        "enabled": true, // after a property
        /* before another property */
        "name": "factory"
      }
    `);

    assert.deepEqual(config, { enabled: true, name: "factory" });
  });

  it("accepts trailing commas in objects and arrays", () => {
    const config = parseJsoncConfig(`
      {
        "agents": [
          "backend-builder",
          "test-verifier",
        ],
      }
    `);

    assert.deepEqual(config, { agents: ["backend-builder", "test-verifier"] });
  });

  it("preserves comment-like strings including URLs and block comment markers", () => {
    const config = parseJsoncConfig(`
      {
        "url": "https://example.com/path//segment",
        "glob": "literal /* not a comment */ text"
      }
    `);

    assert.deepEqual(config, {
      url: "https://example.com/path//segment",
      glob: "literal /* not a comment */ text",
    });
  });

  it("returns an empty object for empty, whitespace-only, and comments-only content", () => {
    assert.deepEqual(parseJsoncConfig(""), {});
    assert.deepEqual(parseJsoncConfig("  \n\t  "), {});
    assert.deepEqual(parseJsoncConfig("// note\n/* block note */\n"), {});
  });

  it("rejects top-level arrays", () => {
    assert.throws(
      () => parseJsoncConfig("[]", { label: "settings.jsonc" }),
      /settings\.jsonc: expected top-level config value to be a non-array object/u,
    );
  });

  it("reports deterministic sanitized malformed JSONC errors", () => {
    const raw = `{
      "token": "super-secret-value",
      invalid
    }`;
    const label = "/Users/jcarreira/private/config.jsonc";

    const first = thrownBy(() => parseJsoncConfig(raw, { label }));
    const second = thrownBy(() => parseJsoncConfig(raw, { label }));

    assert.equal(first instanceof SyntaxError, true);
    assert.equal(second instanceof SyntaxError, true);
    assert.equal(first.message, second.message);
    assert.match(first.message, /^config\.jsonc: JSONC parse error at line \d+, column \d+: parser \w+ \(\d+\)$/u);
    assert.doesNotMatch(first.message, /super-secret-value/u);
    assert.doesNotMatch(first.message, /invalid/u);
    assert.doesNotMatch(first.message, /\/Users\/jcarreira\/private/u);
  });
});

describe("parseStrictJsonConfig", () => {
  it("parses strict JSON without changing values", () => {
    assert.deepEqual(parseStrictJsonConfig('{"enabled":true,"items":[1,2],"name":"factory"}'), {
      enabled: true,
      items: [1, 2],
      name: "factory",
    });
  });

  it("rejects comments", () => {
    const error = thrownBy(() => parseStrictJsonConfig('{"enabled":true // nope\n}', { label: "opencode.json" }));

    assert.equal(error instanceof SyntaxError, true);
    assert.match(error.message, /^opencode\.json: JSON parse error/u);
    assert.doesNotMatch(error.message, /nope/u);
  });

  it("rejects trailing commas", () => {
    const error = thrownBy(() => parseStrictJsonConfig('{"enabled":true,}', { label: "opencode.json" }));

    assert.equal(error instanceof SyntaxError, true);
    assert.match(error.message, /^opencode\.json: JSON parse error/u);
  });
});

describe("config read helpers", () => {
  it("return an empty object for missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));

    try {
      assert.deepEqual(readJsoncConfig(join(dir, "missing.jsonc")), {});
      assert.deepEqual(readStrictJsonConfig(join(dir, "missing.json")), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }

  assert.fail("expected function to throw");
}
