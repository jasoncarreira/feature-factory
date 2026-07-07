import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTuiExport, readOpencodeConfig } from "../src/doctor.js";

describe("doctor package.json parsing", () => {
  it("returns true when package.json has a TUI export", () => {
    const dir = tempDir();

    try {
      const packageJsonPath = join(dir, "package.json");
      writeFileSync(
        packageJsonPath,
        JSON.stringify({ exports: { "./tui": "./src/tui.jsx" } }, null, 2),
        "utf8",
      );

      assert.equal(hasTuiExport(packageJsonPath), true);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects package.json line comments with a sanitized invalid JSON error", () => {
    assertPackageJsonRejected(`{
      "exports": {
        // super-secret-comment must not be echoed
        "./tui": "./src/tui.jsx"
      }
    }`);
  });

  it("rejects package.json trailing commas with a sanitized invalid JSON error", () => {
    assertPackageJsonRejected(`{
      "exports": {
        "./tui": "./src/tui.jsx",
      }
    }`);
  });
});

describe("doctor opencode config parsing", () => {
  it("parses JSONC opencode config without running doctor checks", () => {
    const dir = tempDir();

    try {
      const configDir = join(dir, ".config", "opencode");
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "opencode.jsonc");
      writeFileSync(
        configPath,
        `{
          // opencode config may use JSONC
          "plugin": [
            ["opencode-feature-factory", { "profiles": {} }],
          ],
        }`,
        "utf8",
      );

      assert.deepEqual(readOpencodeConfig(configPath), {
        plugin: [["opencode-feature-factory", { profiles: {} }]],
      });
    } finally {
      cleanup(dir);
    }
  });
});

function assertPackageJsonRejected(packageJson) {
  const dir = tempDir();

  try {
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(packageJsonPath, packageJson, "utf8");

    const error = thrownBy(() => hasTuiExport(packageJsonPath));
    assert.equal(error instanceof SyntaxError, true);
    assert.match(error.message, /^Invalid JSON in package\.json: JSON parse error/u);
    assert.doesNotMatch(error.message, /super-secret-comment/u);
    assert.doesNotMatch(error.message, new RegExp(escapeRegExp(dir), "u"));
  } finally {
    cleanup(dir);
  }
}

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }

  assert.fail("expected function to throw");
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "doctor-config-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
