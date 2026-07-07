import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ROOT = dirname(dirname(CLI));
const LOCAL_PLUGIN_SPEC = pathToFileURL(ROOT).href;

describe("cli install config parsing", () => {
  it("reads opencode.jsonc as JSONC and rewrites strict formatted JSON", () => {
    const home = tempHome();
    const configPath = configFile(home);

    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `{
  // install should accept user comments
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "already-installed",
  ],
  "url": "https://example.com/path//segment",
  "literal": "keep /* not a comment */ value",
}
`, "utf8");

      const proc = runInstall(home);

      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /configured opencode plugin:/u);
      assert.equal(proc.stderr, "");

      const rewritten = readFileSync(configPath, "utf8");
      const config = JSON.parse(rewritten);

      assert.equal(config.$schema, "https://opencode.ai/config.json");
      assert.deepEqual(config.plugin, ["already-installed", LOCAL_PLUGIN_SPEC]);
      assert.equal(config.url, "https://example.com/path//segment");
      assert.equal(config.literal, "keep /* not a comment */ value");
      assert.doesNotMatch(rewritten, /^\s*\/\//mu);
      assert.doesNotMatch(rewritten, /,\s*[}\]]/u);
    } finally {
      cleanup(home);
    }
  });

  it("reports malformed opencode.jsonc without leaking raw config content", () => {
    const home = tempHome();
    const configPath = configFile(home);
    const secret = "super-secret-install-token";

    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `{
  "token": "${secret}",
  "plugin": [
    "already-installed",
    broken-entry,
  ],
}
`, "utf8");

      const proc = runInstall(home);

      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /^error: opencode\.jsonc: (?:JSONC parse error|\d+ JSONC parse errors; first error)/u);
      assert.doesNotMatch(proc.stderr, new RegExp(secret, "u"));
      assert.doesNotMatch(proc.stderr, /broken-entry/u);
      assert.doesNotMatch(proc.stderr, new RegExp(escapeRegExp(home), "u"));
      assert.equal(proc.stdout, "");
    } finally {
      cleanup(home);
    }
  });
});

function runInstall(home) {
  return spawnSync(process.execPath, [CLI, "install", "--local"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function configFile(home) {
  return join(home, ".config", "opencode", "opencode.jsonc");
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "feature-factory-cli-install-"));
}

function cleanup(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
