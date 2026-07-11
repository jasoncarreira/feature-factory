import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDACTED_ENV_VALUE,
  collectEnv,
  collectRunDebugSnapshot,
  isSensitiveEnvKey,
  isSensitiveEnvValue,
  readConfiguredPluginOptions,
  scrubSecretEnv,
} from "../src/env-snapshot.js";

describe("resolved model provenance", () => {
  function withConfig(profilesJson) {
    const dir = mkdtempSync(join(tmpdir(), "ff-env-cfg-"));
    const configPath = join(dir, "opencode.jsonc");
    writeFileSync(configPath, JSON.stringify({ plugin: [["file:///x/opencode-feature-factory", { profiles: profilesJson }]] }), "utf8");
    return { dir, configPath };
  }

  it("recovers operator profiles from the opencode config and labels the source", async () => {
    const { dir, configPath } = withConfig({ "spec-writer": { model: "openai/gpt-5.6-sol", variant: "xhigh" } });
    try {
      const env = await collectEnv({ pluginOptions: {}, configPath });
      assert.equal(env.resolved_from, "visible-config-plugin-entry");
      assert.deepEqual(env.profile_observation, { scope: "feature-factory-plugin-profiles", authoritative: false });
      assert.equal(env.resolved_models["spec-writer"], "openai/gpt-5.6-sol");
      assert.equal(env.resolved_variants["spec-writer"], "xhigh");
      assert.deepEqual(readConfiguredPluginOptions(process.cwd(), { configPath }).profiles["spec-writer"], { model: "openai/gpt-5.6-sol", variant: "xhigh" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors the OPENCODE_CONFIG override when recovering profiles (not just ~/.config)", async () => {
    const { dir, configPath } = withConfig({ "work-decomposer": { model: "openai/gpt-5.6-sol", variant: "xhigh" } });
    const emptyCwd = mkdtempSync(join(tmpdir(), "ff-env-cwd-"));
    const prev = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = configPath;
    try {
      // No configPath option passed: discovery must follow opencode's override
      // semantics and find the profile via OPENCODE_CONFIG. cwd is an empty dir so
      // no project-level config interferes.
      const env = await collectEnv({ pluginOptions: {}, cwd: emptyCwd });
      assert.equal(env.resolved_from, "visible-config-plugin-entry");
      assert.equal(env.resolved_models["work-decomposer"], "openai/gpt-5.6-sol");
      assert.equal(env.resolved_variants["work-decomposer"], "xhigh");
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
      rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it("honors OPENCODE_CONFIG_DIR above project/global (matches opencode CLI precedence)", async () => {
    // Mirror the CLI probe: global + project + OPENCODE_CONFIG_DIR all define a profile;
    // opencode resolves the OPENCODE_CONFIG_DIR one, so our snapshot must too.
    const dirOverride = mkdtempSync(join(tmpdir(), "ff-env-dir-"));
    const project = mkdtempSync(join(tmpdir(), "ff-env-proj-"));
    const writeEntry = (dir, model) => writeFileSync(join(dir, "opencode.jsonc"), JSON.stringify({ plugin: [["opencode-feature-factory", { profiles: { "work-decomposer": { model, variant: "xhigh" } } }]] }), "utf8");
    writeEntry(dirOverride, "openai/dir-profile");
    writeEntry(project, "openai/project-profile");
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevFile = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG_DIR = dirOverride;
    delete process.env.OPENCODE_CONFIG;
    try {
      const env = await collectEnv({ pluginOptions: {}, cwd: project });
      assert.equal(env.resolved_from, "visible-config-plugin-entry");
      assert.equal(env.resolved_models["work-decomposer"], "openai/dir-profile", "OPENCODE_CONFIG_DIR must outrank project config");
    } finally {
      if (prevDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prevDir;
      if (prevFile !== undefined) process.env.OPENCODE_CONFIG = prevFile;
      rmSync(dirOverride, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("retains the global profile when OPENCODE_CONFIG_DIR contributes unrelated settings", async () => {
    const dirOverride = mkdtempSync(join(tmpdir(), "ff-env-dir-"));
    const configHome = mkdtempSync(join(tmpdir(), "ff-env-global-"));
    const emptyCwd = mkdtempSync(join(tmpdir(), "ff-env-cwd-"));
    const globalDir = join(configHome, "opencode");
    mkdirSync(globalDir);
    writeFileSync(join(dirOverride, "opencode.jsonc"), JSON.stringify({ theme: "system" }), "utf8");
    writeFileSync(join(globalDir, "opencode.jsonc"), JSON.stringify({ plugin: [["opencode-feature-factory", { profiles: { "work-decomposer": { model: "openai/global-profile", variant: "xhigh" } } }]] }), "utf8");
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevFile = process.env.OPENCODE_CONFIG;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.OPENCODE_CONFIG_DIR = dirOverride;
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.OPENCODE_CONFIG;
    try {
      const env = await collectEnv({ pluginOptions: {}, cwd: emptyCwd });
      assert.equal(env.resolved_from, "visible-config-plugin-entry");
      assert.equal(env.resolved_models["work-decomposer"], "openai/global-profile");
    } finally {
      if (prevDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prevDir;
      if (prevFile === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = prevFile;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      rmSync(dirOverride, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
      rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it("recovers profiles from a project-level opencode.jsonc walked up from cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-env-proj-"));
    writeFileSync(join(dir, "opencode.jsonc"), JSON.stringify({ plugin: [["opencode-feature-factory", { profiles: { "security-reviewer": { model: "openai/gpt-5.6-sol", variant: "xhigh" } } }]] }), "utf8");
    const prev = process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG;
    try {
      const env = await collectEnv({ pluginOptions: {}, cwd: dir });
      assert.equal(env.resolved_from, "visible-config-plugin-entry");
      assert.equal(env.resolved_models["security-reviewer"], "openai/gpt-5.6-sol");
    } finally {
      if (prev !== undefined) process.env.OPENCODE_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("labels explicitly passed options and package defaults distinctly", async () => {
    const passed = await collectEnv({ pluginOptions: { profiles: { "spec-writer": { model: "m", variant: "high" } }, readConfiguredProfiles: false }, configPath: "/does/not/exist" });
    assert.equal(passed.resolved_from, "plugin-options");
    assert.equal(passed.resolved_models["spec-writer"], "m");

    const none = await collectEnv({ pluginOptions: {}, configPath: "/does/not/exist" });
    assert.equal(none.resolved_from, "not-observed");
    assert.equal(none.resolved_models["spec-writer"], null); // not visible to this process, not "unconfigured"
  });

  it("preserves unknown provenance for malformed and ambiguous config observations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-env-bad-cfg-"));
    const malformedPath = join(dir, "malformed.jsonc");
    const duplicatePath = join(dir, "duplicate.jsonc");
    writeFileSync(malformedPath, "{ invalid", "utf8");
    writeFileSync(duplicatePath, JSON.stringify({ plugin: [
      ["opencode-feature-factory", { profiles: { planning: { model: "one" } } }],
      ["file:///x/opencode-feature-factory", { profiles: { planning: { model: "two" } } }],
    ] }), "utf8");
    try {
      for (const configPath of [malformedPath, duplicatePath]) {
        const env = await collectEnv({ pluginOptions: {}, configPath });
        assert.equal(env.resolved_from, "config-observation-error");
        assert.equal(env.resolved_models["spec-writer"], null);
        assert.equal(env.profile_observation.authoritative, false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
});
