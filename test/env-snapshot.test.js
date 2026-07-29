import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { githubAccountEnvironment } from "../src/github-account-env.js";
import {
  REDACTED_ENV_VALUE,
  collectRunDebugSnapshot,
  detectCapabilities,
  isSensitiveEnvKey,
  isSensitiveEnvValue,
  installedPluginOptions,
  scrubSecretEnv,
} from "../src/env-snapshot.js";

const FRAGMENTED_SECRET_VARIANTS = [
  ["mixed", "Q7M4-Z9N2_C8V5.B1X6:L3K0 P7R2-T9Y4_U8I5"],
  ["uneven-1", "Q7-M4Z9N_2C8.V5B1X6:L3K 0P7R2-T9Y4_U8I5"],
  ["uneven-2", "Q-7M4_Z9N2C.8V5:B1X6L 3K0-P7R2T_9Y4U8-I5"],
  ["control-1", "Q7M4\u001bZ9N2_C8V5.B1X6:L3K0 P7R2-T9Y4_U8I5"],
  ["control-2", "Q7M4-Z9N2\u202eC8V5.B1X6:L3K0\tP7R2-T9Y4_U8I5"],
  ["long-fragments", "Q7M4Z9N-2C8V5_B1X6L3.K0P7R2:T9Y4U8I5"],
  ["fragmented-bearer-path", "Bearer/Q7M4Z9N/2C8V5/B1X6L3/K0P7R2/T9Y4U8I5"],
];

describe("environment snapshot redaction", () => {
  it("builds a fresh exact-account GitHub environment without inherited auth tokens", () => {
    const parent = {
      KEEP: "operator-value",
      GH_CONFIG_DIR: "/operator/config",
      GH_HOST: "enterprise.example",
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "github-token",
      GH_ENTERPRISE_TOKEN: "gh-enterprise-token",
      GITHUB_ENTERPRISE_TOKEN: "github-enterprise-token",
      gh_token: "lower-gh-token",
      Github_Token: "mixed-github-token",
      gh_enterprise_token: "lower-gh-enterprise-token",
      github_enterprise_token: "lower-github-enterprise-token",
      gh_config_dir: "/wrong/lower-config",
      gh_host: "wrong.example",
      gh_prompt_disabled: "0",
      gh_pager: "wrong-pager",
      pager: "wrong-pager",
      GH_PROMPT_DISABLED: "0",
      GH_PAGER: "less",
      PAGER: "more",
    };
    const original = { ...parent };
    const environment = githubAccountEnvironment("Exact-Account", parent);

    assert.notEqual(environment, parent);
    assert.deepEqual(parent, original);
    assert.equal(environment.KEEP, "operator-value");
    assert.equal(environment.GH_CONFIG_DIR, join(homedir(), ".config", "opencode-feature-factory", "gh", "Exact-Account"));
    assert.equal(environment.GH_HOST, "github.com");
    assert.equal(environment.GH_PROMPT_DISABLED, "1");
    assert.equal(environment.GH_PAGER, "cat");
    assert.equal(environment.PAGER, "cat");
    const tokenKeys = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
    for (const key of Object.keys(environment)) {
      assert.equal(tokenKeys.has(key.toUpperCase()), false, key);
    }
    for (const key of ["gh_config_dir", "gh_host", "gh_prompt_disabled", "gh_pager", "pager"]) {
      assert.equal(Object.hasOwn(environment, key), false, key);
    }

    const savedToken = process.env.GH_TOKEN;
    const savedMarker = process.env.FACTORY_ACCOUNT_ENV_MARKER;
    try {
      process.env.GH_TOKEN = "process-parent-token";
      process.env.FACTORY_ACCOUNT_ENV_MARKER = "process-parent-value";
      const processChild = githubAccountEnvironment("Process-Account");
      assert.equal(process.env.GH_TOKEN, "process-parent-token");
      assert.equal(process.env.FACTORY_ACCOUNT_ENV_MARKER, "process-parent-value");
      assert.equal(Object.hasOwn(processChild, "GH_TOKEN"), false);
      assert.equal(processChild.FACTORY_ACCOUNT_ENV_MARKER, "process-parent-value");
    } finally {
      if (savedToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = savedToken;
      if (savedMarker === undefined) delete process.env.FACTORY_ACCOUNT_ENV_MARKER;
      else process.env.FACTORY_ACCOUNT_ENV_MARKER = savedMarker;
    }
  });

  it("redacts token-shaped and high-entropy values", () => {
    assert.equal(scrubSecretEnv("github_pat_123456789012345678901234567890"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("ghp_123456789012345678901234567890"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("hc_api_12345678901234567890"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("0123456789abcdef0123456789abcdef"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("abcdefghijklmnopqrstuvwxyz123456"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("Bearer abcdefghijklmnopqrstuvwxyz123456"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("https://user:pass@example.test/repo.git"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("a".repeat(20)), "a".repeat(20));
    assert.equal(isSensitiveEnvValue("AKIA1234567890ABCDEF"), true);
  });

  it("omits sensitive keys recursively", () => {
    const honeycombKey = "hc_api_12345678901234567890";
    const hexKey = "0123456789abcdef0123456789abcdef";
    const uppercaseKey = "Q7M4Z9N2C8V5B1X6L3K0P7R2T9Y4U8I5";
    const otelishUppercaseKey = `OTEL_EXPORTER_OTLP_${uppercaseKey}_HEADERS`;

    assert.equal(isSensitiveEnvKey("api_token"), true);
    assert.equal(isSensitiveEnvKey(honeycombKey), true);
    assert.equal(isSensitiveEnvKey(hexKey), true);
    assert.equal(isSensitiveEnvKey(uppercaseKey), true);
    assert.equal(isSensitiveEnvKey(otelishUppercaseKey), true);
    assert.deepEqual(scrubSecretEnv({ keep: "ok", api_token: "secret", [honeycombKey]: "safe", [uppercaseKey]: "safe", [otelishUppercaseKey]: "safe", nested: { password: "secret", [hexKey]: "safe", [uppercaseKey]: "safe", [otelishUppercaseKey]: "safe", safe: "value" } }), {
      keep: "ok",
      nested: { safe: "value" },
    });
  });

  it("keeps known safe uppercase env-style config keys", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "present",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://api.honeycomb.io/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "present",
      FEATURE_FACTORY_OTEL_ENABLED: "true",
    };

    assert.equal(isSensitiveEnvKey("OTEL_EXPORTER_OTLP_ENDPOINT"), false);
    assert.equal(isSensitiveEnvKey("OTEL_EXPORTER_OTLP_HEADERS"), false);
    assert.equal(isSensitiveEnvKey("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"), false);
    assert.equal(isSensitiveEnvKey("OTEL_EXPORTER_OTLP_TRACES_HEADERS"), false);
    assert.equal(isSensitiveEnvKey("FEATURE_FACTORY_OTEL_ENABLED"), false);
    assert.deepEqual(scrubSecretEnv(env), env);
  });

  it("collects run snapshots under env", async () => {
    const snapshot = await collectRunDebugSnapshot({
      cwd: process.cwd(),
      event: "run-created",
      now: "2026-07-08T12:00:00.000Z",
      runtimeIdentity: {
        plugin: { source: "/tmp/configured-plugin.js", version: "1.2.3", hash: `sha256:${"c".repeat(64)}` },
        cli: { source: "/tmp/secret-cli\u001b[2J", version: "secret-version", hash: `sha256:${"a".repeat(64)}` },
      },
    });
    assert.equal(snapshot.event, "run-created");
    assert.equal(snapshot.diagnostic_only, true);
    assert.equal(typeof snapshot.env, "object");
    assert.deepEqual(snapshot.env.plugin_identity, { source: "/tmp/configured-plugin.js", version: "1.2.3", hash: `sha256:${"c".repeat(64)}` });
    assert.deepEqual(snapshot.env.cli_identity, { source: REDACTED_ENV_VALUE, version: REDACTED_ENV_VALUE, hash: `sha256:${"a".repeat(64)}` });
    assert.doesNotMatch(JSON.stringify(snapshot), /[\u001b\u009b]/u);
    assert.equal(snapshot.provenance, undefined);
  });

  it("keeps mixed, uneven, and control-interrupted identity credentials out of run snapshots", async () => {
    const hash = `sha256:${"b".repeat(64)}`;
    for (const [name, fragmented] of FRAGMENTED_SECRET_VARIANTS) {
      const snapshot = await collectRunDebugSnapshot({
        cwd: process.cwd(),
        runtimeIdentity: {
          cli: {
            source: `/tmp/home ${fragmented}/feature-factory`,
            version: `feature-factory 1.2.3 ${fragmented}`,
            hash,
          },
          opencode: {
            source: "/tmp/opencode",
            version: `opencode ${fragmented}`,
            hash: `sha256:${"d".repeat(64)}`,
          },
        },
      });

      assert.deepEqual(snapshot.env.cli_identity, { source: REDACTED_ENV_VALUE, version: REDACTED_ENV_VALUE, hash }, name);
      assert.equal(snapshot.env.opencode_version, REDACTED_ENV_VALUE, name);
      assert.equal(JSON.stringify(snapshot).includes(fragmented), false, name);
    }
  });

  it("loads the configured feature-factory tuple options used by OpenCode", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-opencode-config-"));
    const file = join(dir, "opencode.jsonc");
    try {
      writeFileSync(file, JSON.stringify({ plugin: [["file:///tmp/opencode-feature-factory", { prMode: "draft", profiles: { "work-reviewer": { model: "test/reviewer" } } }]] }), "utf8");
      assert.deepEqual(installedPluginOptions(file), { prMode: "draft", profiles: { "work-reviewer": { model: "test/reviewer" } } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps accountless GitHub diagnostics read-only in the operator environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-gh-diagnostics-"));
    const log = join(dir, "gh-calls.jsonl");
    const executable = join(dir, "gh");
    const saved = Object.fromEntries(["PATH", "FACTORY_GH_LOG", "DIAGNOSTIC_MARKER", "GH_CONFIG_DIR", "GH_TOKEN"].map((key) => [key, process.env[key]]));
    try {
      writeFileSync(executable, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.FACTORY_GH_LOG, JSON.stringify({ args: process.argv.slice(2), marker: process.env.DIAGNOSTIC_MARKER, config: process.env.GH_CONFIG_DIR, token: process.env.GH_TOKEN }) + "\\n");\n`, "utf8");
      chmodSync(executable, 0o755);
      process.env.PATH = `${dir}:${saved.PATH ?? ""}`;
      process.env.FACTORY_GH_LOG = log;
      process.env.DIAGNOSTIC_MARKER = "operator-environment";
      process.env.GH_CONFIG_DIR = "/operator/gh-config";
      process.env.GH_TOKEN = "operator-token";

      detectCapabilities(dir);

      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(calls.map((call) => call.args), [["--version"], ["auth", "status"]]);
      assert.deepEqual(calls.map(({ marker, config, token }) => ({ marker, config, token })), [
        { marker: "operator-environment", config: "/operator/gh-config", token: "operator-token" },
        { marker: "operator-environment", config: "/operator/gh-config", token: "operator-token" },
      ]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects opencode run flags across combined help stdout and stderr on failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-opencode-help-"));
    const executable = join(dir, "opencode");
    const savedPath = process.env.PATH;
    try {
      writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'opencode-test'
  exit 0
fi
printf '%s\\n' 'Usage: opencode run --command value'
printf '%s\\n' 'Options: --dir path' >&2
exit 2
`, "utf8");
      chmodSync(executable, 0o755);
      process.env.PATH = `${dir}:${savedPath ?? ""}`;

      const capabilities = detectCapabilities(dir);
      assert.equal(capabilities.opencode, true);
      assert.equal(capabilities.opencode_run_command, true);
      assert.equal(capabilities.opencode_run_dir, true);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
