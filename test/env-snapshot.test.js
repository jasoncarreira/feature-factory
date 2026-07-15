import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDACTED_ENV_VALUE,
  collectEffectiveProvenance,
  collectRunDebugSnapshot,
  isSensitiveEnvKey,
  isSensitiveEnvValue,
  installedPluginOptions,
  scrubSecretEnv,
} from "../src/env-snapshot.js";

describe("environment snapshot redaction", () => {
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
    const snapshot = await collectRunDebugSnapshot({ cwd: process.cwd(), event: "run-created", now: "2026-07-08T12:00:00.000Z" });
    assert.equal(snapshot.event, "run-created");
    assert.equal(snapshot.diagnostic_only, true);
    assert.equal(typeof snapshot.env, "object");
    assert.equal(snapshot.provenance, undefined);
  });

  it("hashes effective prompts, skills, plugin bytes, and git state without raw prompt content", async () => {
    const secretPrompt = "review prompt containing sensitive operator text";
    const promptHash = `sha256:${(await import("node:crypto")).createHash("sha256").update(secretPrompt).digest("hex")}`;
    const provenance = await collectEffectiveProvenance({
      repo: process.cwd(),
      gitCwd: process.cwd(),
      event: "review-dispatch",
      agent: "work-reviewer",
      subject: "spec-writer",
      attempt: 2,
      promptHash,
      promptBytes: Buffer.byteLength(secretPrompt),
      now: "2026-07-08T12:00:00.000Z",
      pluginOptions: {},
    });

    assert.equal(provenance.dispatch.prompt_hash, promptHash);
    assert.match(provenance.content.command_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.match(provenance.content.agent_prompt_hashes["work-reviewer"], /^sha256:[a-f0-9]{64}$/u);
    assert.match(provenance.content.skill_hashes["feature/SKILL.md"], /^sha256:[a-f0-9]{64}$/u);
    assert.match(provenance.runtime.plugin.source_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(provenance.runtime.model.actual, null);
    assert.equal(provenance.runtime.model.actual_source, "unavailable");
    assert.equal(JSON.stringify(provenance).includes(secretPrompt), false);
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
});
