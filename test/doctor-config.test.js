import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectTelemetryReadiness,
  evaluateCompanionTelemetryPluginReadiness,
  evaluateFeatureFactoryTelemetryReadiness,
  evaluateOpenTelemetryConfigReadiness,
  evaluateOtlpEnvReadiness,
  evaluatePackageInstrumentationLoadability,
  formatTelemetryEndpointDetail,
  hasTuiExport,
  permissionFailures,
  readOpencodeConfig,
} from "../src/doctor.js";
import { REDACTED_ENV_VALUE, resolvePluginConfig } from "../src/env-snapshot.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const LOCAL_PLUGIN_SPEC = pathToFileURL(fileURLToPath(new URL("..", import.meta.url))).href;
const FRAGMENTED_SECRET_VARIANTS = [
  ["mixed", "Q7M4-Z9N2_C8V5.B1X6:L3K0 P7R2-T9Y4_U8I5"],
  ["uneven-1", "Q7-M4Z9N_2C8.V5B1X6:L3K 0P7R2-T9Y4_U8I5"],
  ["uneven-2", "Q-7M4_Z9N2C.8V5:B1X6L 3K0-P7R2T_9Y4U8-I5"],
  ["control-1", "Q7M4\u001bZ9N2_C8V5.B1X6:L3K0 P7R2-T9Y4_U8I5"],
  ["control-2", "Q7M4-Z9N2\u202eC8V5.B1X6:L3K0\tP7R2-T9Y4_U8I5"],
  ["long-fragments", "Q7M4Z9N-2C8V5_B1X6L3.K0P7R2:T9Y4U8I5"],
  ["fragmented-bearer-path", "Bearer/Q7M4Z9N/2C8V5/B1X6L3/K0P7R2/T9Y4U8I5"],
];

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

describe("doctor output projection", () => {
  it("accepts task deny for subagents while requiring task allow for the primary agent", async () => {
    const registered = await resolvePluginConfig();

    assert.deepEqual(permissionFailures(registered.agent), []);

    const primaryDenied = structuredClone(registered.agent);
    primaryDenied["feature-factory"].permission.task = "deny";
    assert.deepEqual(permissionFailures(primaryDenied), ["feature-factory.task=deny"]);

    const subagentAllowed = structuredClone(registered.agent);
    subagentAllowed["backend-builder"].permission.task = "allow";
    assert.deepEqual(permissionFailures(subagentAllowed), ["backend-builder.task=allow"]);
  });

  it("reports the supported bounded-delegation policy as healthy", () => {
    const fixture = doctorFixture();
    try {
      const proc = runDoctorFixture(fixture, ["--json"]);
      const payload = JSON.parse(proc.stdout);
      const permissions = payload.checks.find((check) => check.label === "factory permissions non-interactive");

      assert.equal(proc.status, 0);
      assert.equal(permissions.level, "ok");
      assert.equal(permissions.detail, "factory agent permissions");
    } finally {
      cleanup(fixture.dir);
    }
  });

  it("fails deterministically for stale global definitions in human and JSON output", () => {
    const fixture = doctorFixture();
    const stale = join(fixture.home, ".config", "opencode", "skills", "feature", "SKILL.md");
    try {
      mkdirSync(join(fixture.home, ".config", "opencode", "skills", "feature"), { recursive: true });
      writeFileSync(stale, "stale feature instructions\n", "utf8");

      const human = runDoctorFixture(fixture);
      assert.equal(human.status, 1);
      assert.match(human.stdout, /missing: global feature-factory definitions \(stale global feature-factory definitions detected/u);
      assert.match(human.stdout, /replace them with exact current packaged definitions; then restart opencode/u);

      const json = runDoctorFixture(fixture, ["--json"]);
      const payload = JSON.parse(json.stdout);
      const check = payload.checks.find((item) => item.label === "global feature-factory definitions");
      assert.equal(json.status, 1);
      assert.equal(check.level, "missing");
      assert.match(check.detail, /stale global feature-factory definitions detected/u);
      assert.match(check.detail, /restart opencode/u);
    } finally {
      cleanup(fixture.dir);
    }
  });

  it("projects the whole JSON payload and human profile rows", () => {
    const fixture = doctorFixture({
      profiles: {
        "backend-builder": { model: "provider/safe-model", variant: "safe-variant" },
        "test-verifier": { model: "provider/control\u001B]0;pwned\u0007", variant: "variant\u202Ehidden" },
      },
    });
    try {
      const human = runDoctorFixture(fixture, ["--profiles"]);
      assert.match(human.stdout, /profile: backend-builder -> model=provider\/safe-model variant=safe-variant/u);
      assert.match(human.stdout, /provider\/control\\u001B/u);
      assert.doesNotMatch(human.stdout, /[\u001B\u0007\u009B\u202E]/u);

      const json = runDoctorFixture(fixture, ["--json"], { FAKE_OPENCODE_VERSION: "safe\u001B[2J" });
      const payload = JSON.parse(json.stdout);
      assert.equal(payload.env.cli_identity.source, CLI);
      assert.equal(payload.env.cli_identity.version, "0.2.1");
      assert.match(payload.env.cli_identity.hash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(payload.env.resolved_models["backend-builder"], "provider/safe-model");
      assert.equal(payload.env.resolved_models["test-verifier"], "provider/control\u001B]0;pwned\u0007");
      assert.equal(payload.env.opencode_version, "safe?[2J");
      assert.doesNotMatch(json.stdout, /[\u001B\u0007\u009B\u202E]/u);
    } finally {
      cleanup(fixture.dir);
    }
  });

  it("redacts smoke credentials before applying the detail cap", () => {
    const fixture = doctorFixture({
      profiles: { "backend-builder": { model: "provider/safe-model" } },
    });
    const secret = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
    try {
      const proc = runDoctorFixture(fixture, ["--provider-smoke", "--json"], {
        FAKE_SMOKE_FAILURE: `prefix Authorization: Basic ${secret}\u001B]0;pwned\u0007${"x".repeat(400)}`,
      });
      const payload = JSON.parse(proc.stdout);
      const smoke = payload.checks.find((check) => check.label === "provider provider smoke");
      assert.equal(smoke.detail.length <= 300, true);
      assert.doesNotMatch(proc.stdout, new RegExp(secret, "u"));
      assert.doesNotMatch(proc.stdout, /[\u001B\u0007\u009B]/u);
    } finally {
      cleanup(fixture.dir);
    }
  });

  it("keeps mixed, uneven, and control-interrupted identity credentials out of human and JSON output", () => {
    for (const [name, fragmented] of FRAGMENTED_SECRET_VARIANTS) {
      const fixture = doctorFixture();
      const packageRoot = join(fixture.dir, `home ${fragmented}`, "node_modules", "opencode-feature-factory");
      const effectiveCli = join(packageRoot, "feature-factory");
      const bin = join(fixture.dir, "identity-bin");
      try {
        mkdirSync(bin, { recursive: true });
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
          name: "opencode-feature-factory",
          version: `feature-factory 1.2.3 ${fragmented}`,
        }), "utf8");
        writeExecutable(effectiveCli, "#!/bin/sh\nexit 0\n");
        symlinkSync(effectiveCli, join(bin, "feature-factory"));
        const env = {
          PATH: `${bin}${delimiter}${fixture.bin}${delimiter}${process.env.PATH}`,
          FAKE_OPENCODE_VERSION: `opencode ${fragmented}`,
        };

        const human = runDoctorFixture(fixture, [], env);
        const json = runDoctorFixture(fixture, ["--json"], env);
        const payload = JSON.parse(json.stdout);
        for (const output of [human.stdout, human.stderr, json.stdout, json.stderr]) {
          assert.equal(output.includes(fragmented), false, name);
        }
        assert.match(human.stdout, /feature-factory CLI identity \(\[redacted\]\)/u);
        assert.match(human.stdout, /opencode CLI \(\[redacted\]\)/u);
        assert.deepEqual(payload.env.cli_identity, {
          source: REDACTED_ENV_VALUE,
          version: REDACTED_ENV_VALUE,
          hash: payload.env.cli_identity.hash,
        }, name);
        assert.match(payload.env.cli_identity.hash, /^sha256:[0-9a-f]{64}$/u);
        assert.equal(payload.env.opencode_version, REDACTED_ENV_VALUE, name);
      } finally {
        cleanup(fixture.dir);
      }
    }
  });
});

describe("doctor telemetry readiness helpers", () => {
  it("reports doctor --telemetry JSON categories with sanitized OTLP values", () => {
    const dir = tempDir();

    try {
      const home = join(dir, "home");
      const repo = join(dir, "repo");
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(home, ".config", "opencode", "opencode.jsonc"),
        JSON.stringify({
          experimental: { openTelemetry: true },
          plugin: [
            [LOCAL_PLUGIN_SPEC, { telemetry: { enabled: true } }],
            "@devtheops/opencode-plugin-otel",
          ],
        }, null, 2),
        "utf8",
      );

      const proc = spawnSync(process.execPath, [CLI, "doctor", "--local", "--telemetry", "--json"], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          FEATURE_FACTORY_OTEL_ENABLED: "true",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
          OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=github_pat_123456789012345678901234567890,hc_api_12345678901234567890,Authorization=Bearer abcdefghijklmnopqrstuvwxyz123456",
          OTEL_SERVICE_NAME: "feature-factory",
        },
      });

      const output = JSON.parse(proc.stdout);
      assert.equal(typeof output.telemetry, "object");
      assert.equal(output.telemetry.opencode.ok, true);
      assert.equal(output.telemetry.companionPlugin.ok, true);
      assert.equal(output.telemetry.instrumentation.ok, true);
      assert.equal(output.telemetry.featureFactory.enabled, true);
      assert.equal(output.telemetry.otlpEnv.endpoint.value, "https://api.honeycomb.io/");
      assert.deepEqual(output.telemetry.otlpEnv.headers.vars[0].headers.map((header) => header.name), [
        "x-honeycomb-team",
        REDACTED_ENV_VALUE,
      ]);
      const serialized = JSON.stringify(output);
      assert.doesNotMatch(serialized, /github_pat_/u);
      assert.doesNotMatch(serialized, /hc_api_/u);
      assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz/u);
    } finally {
      cleanup(dir);
    }
  });

  it("reports native opencode OpenTelemetry readiness from JSONC config", () => {
    assert.deepEqual(evaluateOpenTelemetryConfigReadiness({ experimental: { openTelemetry: true } }), {
      ok: true,
      level: "ok",
      enabled: true,
      configured: true,
      detail: "experimental.openTelemetry=true; native opencode/AI SDK spans may be emitted when an SDK/exporter is initialized",
      nativeAiSdkSpansExpected: true,
    });

    const missing = evaluateOpenTelemetryConfigReadiness({});
    assert.equal(missing.ok, false);
    assert.equal(missing.level, "warn");
    assert.match(missing.detail, /experimental\.openTelemetry=unset/u);
  });

  it("summarizes OTLP env readiness without leaking header values or credential-shaped endpoints", () => {
    const readiness = evaluateOtlpEnvReadiness({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
      OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=github_pat_123456789012345678901234567890,hc_api_12345678901234567890,x-honeycomb-dataset=feature-factory,Authorization=Bearer abcdefghijklmnopqrstuvwxyz123456",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://user:pass@example.test/v1/traces",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test,service.name=feature-factory,api_token=github_pat_123456789012345678901234567890",
    });

    assert.equal(readiness.ok, true);
    assert.deepEqual(readiness.endpoint, {
      ok: true,
      key: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      value: "https://example.test/v1/traces",
    });
    assert.equal(readiness.headers.ok, true);
    assert.deepEqual(readiness.headers.vars[0].headers, [
      { name: "x-honeycomb-team", present: true, value: REDACTED_ENV_VALUE },
      { name: "x-honeycomb-dataset", present: true, value: REDACTED_ENV_VALUE },
      { name: REDACTED_ENV_VALUE, present: true, value: REDACTED_ENV_VALUE },
    ]);
    assert.equal(readiness.resource.serviceName.value, "feature-factory");
    assert.deepEqual(readiness.resource.attributes.map((item) => item.name), [
      "deployment.environment",
      "service.name",
      REDACTED_ENV_VALUE,
    ]);
    const serialized = JSON.stringify(readiness);
    assert.doesNotMatch(serialized, /github_pat_/u);
    assert.doesNotMatch(serialized, /hc_api_/u);
    assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz/u);
    assert.doesNotMatch(serialized, /user:pass/u);
  });

  it("redacts OTLP endpoint credentials from JSON and check detail output", async () => {
    const honeycombEndpointCredential = "hc_api_12345678901234567890";
    const apiKeyEndpointCredential = "sk-123456789012345678901234567890";

    const endpointReadiness = evaluateOtlpEnvReadiness({
      OTEL_EXPORTER_OTLP_ENDPOINT: `https://api.honeycomb.io/${honeycombEndpointCredential}/v1/traces?x-honeycomb-team=${honeycombEndpointCredential}`,
      OTEL_SERVICE_NAME: "feature-factory",
    });
    assert.equal(
      endpointReadiness.endpoint.value,
      `https://api.honeycomb.io/${REDACTED_ENV_VALUE}/v1/traces?${REDACTED_ENV_VALUE}`,
    );

    const tracesReadiness = evaluateOtlpEnvReadiness({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://collector:${apiKeyEndpointCredential}@otel.example.test/v1/traces?api_key=${apiKeyEndpointCredential}`,
      OTEL_SERVICE_NAME: "feature-factory",
    });
    assert.equal(
      tracesReadiness.endpoint.value,
      `https://otel.example.test/v1/traces?${REDACTED_ENV_VALUE}`,
    );

    const endpointDetail = formatTelemetryEndpointDetail(endpointReadiness.endpoint);
    const tracesDetail = formatTelemetryEndpointDetail(tracesReadiness.endpoint);
    const aggregate = await collectTelemetryReadiness({
      cfg: { experimental: { openTelemetry: true } },
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://collector:${apiKeyEndpointCredential}@otel.example.test/${honeycombEndpointCredential}/v1/traces?api_key=${apiKeyEndpointCredential}`,
        OTEL_SERVICE_NAME: "feature-factory",
      },
      instrumentationLoadability: { ok: true, package: "@opentelemetry/api", exports: ["trace"] },
    });
    const jsonOutput = JSON.stringify({ telemetry: aggregate });

    assert.doesNotMatch(endpointDetail, new RegExp(escapeRegExp(honeycombEndpointCredential), "u"));
    assert.doesNotMatch(endpointDetail, /x-honeycomb-team/u);
    assert.doesNotMatch(tracesDetail, new RegExp(escapeRegExp(apiKeyEndpointCredential), "u"));
    assert.doesNotMatch(tracesDetail, /collector:/u);
    assert.doesNotMatch(tracesDetail, /api_key/u);
    assert.doesNotMatch(jsonOutput, new RegExp(escapeRegExp(honeycombEndpointCredential), "u"));
    assert.doesNotMatch(jsonOutput, new RegExp(escapeRegExp(apiKeyEndpointCredential), "u"));
    assert.doesNotMatch(jsonOutput, /collector:/u);
    assert.doesNotMatch(jsonOutput, /api_key/u);
  });

  it("redacts bare Honeycomb-style endpoint path credentials from JSON and check detail output", async () => {
    const endpointPathCredential = "0123456789abcdef0123456789abcdef";
    const tracesPathCredential = "abcdef0123456789abcdef0123456789";

    const endpointReadiness = evaluateOtlpEnvReadiness({
      OTEL_EXPORTER_OTLP_ENDPOINT: `https://api.honeycomb.io/${endpointPathCredential}/v1/traces`,
      OTEL_SERVICE_NAME: "feature-factory",
    });
    assert.equal(
      endpointReadiness.endpoint.value,
      `https://api.honeycomb.io/${REDACTED_ENV_VALUE}/v1/traces`,
    );

    const tracesReadiness = evaluateOtlpEnvReadiness({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://otel.example.test/v1/${tracesPathCredential}/traces`,
      OTEL_SERVICE_NAME: "feature-factory",
    });
    assert.equal(
      tracesReadiness.endpoint.value,
      `https://otel.example.test/v1/${REDACTED_ENV_VALUE}/traces`,
    );

    const endpointDetail = formatTelemetryEndpointDetail(endpointReadiness.endpoint);
    const tracesDetail = formatTelemetryEndpointDetail(tracesReadiness.endpoint);
    const endpointAggregate = await collectTelemetryReadiness({
      cfg: { experimental: { openTelemetry: true } },
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `https://api.honeycomb.io/${endpointPathCredential}/v1/traces`,
        OTEL_SERVICE_NAME: "feature-factory",
      },
      instrumentationLoadability: { ok: true, package: "@opentelemetry/api", exports: ["trace"] },
    });
    const tracesAggregate = await collectTelemetryReadiness({
      cfg: { experimental: { openTelemetry: true } },
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://otel.example.test/v1/${tracesPathCredential}/traces`,
        OTEL_SERVICE_NAME: "feature-factory",
      },
      instrumentationLoadability: { ok: true, package: "@opentelemetry/api", exports: ["trace"] },
    });
    const jsonOutput = JSON.stringify({ endpointTelemetry: endpointAggregate, tracesTelemetry: tracesAggregate });

    assert.equal(
      endpointAggregate.otlpEnv.endpoint.value,
      `https://api.honeycomb.io/${REDACTED_ENV_VALUE}/v1/traces`,
    );
    assert.equal(
      tracesAggregate.otlpEnv.endpoint.value,
      `https://otel.example.test/v1/${REDACTED_ENV_VALUE}/traces`,
    );

    assert.doesNotMatch(endpointDetail, new RegExp(escapeRegExp(endpointPathCredential), "u"));
    assert.doesNotMatch(tracesDetail, new RegExp(escapeRegExp(tracesPathCredential), "u"));
    assert.doesNotMatch(jsonOutput, new RegExp(escapeRegExp(endpointPathCredential), "u"));
    assert.doesNotMatch(jsonOutput, new RegExp(escapeRegExp(tracesPathCredential), "u"));
  });

  it("redacts credential-shaped OTLP endpoint host labels from JSON and check detail output", async () => {
    const hexHostCredential = "0123456789abcdef0123456789abcdef";
    const honeycombPathCredential = "hc_api_12345678901234567890";

    const readiness = evaluateOtlpEnvReadiness({
      OTEL_EXPORTER_OTLP_ENDPOINT: `https://${hexHostCredential}.collector.example.test/${honeycombPathCredential}/v1/traces`,
      OTEL_SERVICE_NAME: "feature-factory",
    });
    assert.equal(
      readiness.endpoint.value,
      `https://${REDACTED_ENV_VALUE}.collector.example.test/${REDACTED_ENV_VALUE}/v1/traces`,
    );

    const detail = formatTelemetryEndpointDetail(readiness.endpoint);
    const aggregate = await collectTelemetryReadiness({
      cfg: { experimental: { openTelemetry: true } },
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `https://${hexHostCredential}.collector.example.test/${honeycombPathCredential}/v1/traces`,
        OTEL_SERVICE_NAME: "feature-factory",
      },
      instrumentationLoadability: { ok: true, package: "@opentelemetry/api", exports: ["trace"] },
    });
    const jsonOutput = JSON.stringify({ telemetry: aggregate });

    assert.doesNotMatch(detail, new RegExp(escapeRegExp(hexHostCredential), "u"));
    assert.doesNotMatch(detail, new RegExp(escapeRegExp(honeycombPathCredential), "u"));
    assert.doesNotMatch(jsonOutput, new RegExp(escapeRegExp(hexHostCredential), "u"));
    assert.doesNotMatch(jsonOutput, new RegExp(escapeRegExp(honeycombPathCredential), "u"));
  });

  it("reports companion telemetry plugin presence and disabled action", () => {
    const missing = evaluateCompanionTelemetryPluginReadiness({ plugin: ["opencode-feature-factory"] });
    assert.equal(missing.ok, false);
    assert.equal(missing.present, false);
    assert.match(missing.action, /companion telemetry plugin/u);

    const disabled = evaluateCompanionTelemetryPluginReadiness({
      plugin: [["@devtheops/opencode-plugin-otel", { enabled: false }]],
    });
    assert.equal(disabled.present, true);
    assert.equal(disabled.ok, false);
    assert.match(disabled.detail, /configured disabled/u);

    const ready = evaluateCompanionTelemetryPluginReadiness({ plugin: ["@devtheops/opencode-plugin-otel"] });
    assert.equal(ready.ok, true);
  });

  it("does not treat local feature-factory paths containing otel as companion telemetry plugins", () => {
    const readiness = evaluateCompanionTelemetryPluginReadiness({
      plugin: [
        "file:///tmp/local-otel-fixture/opencode-feature-factory",
        "file:///tmp/local-telemetry-fixture/opencode-feature-factory/src/plugin.js",
      ],
    });

    assert.equal(readiness.ok, false);
    assert.equal(readiness.present, false);
    assert.match(readiness.detail, /no companion telemetry plugin configured/u);
  });

  it("reports instrumentation loadability and feature-factory content-capture risks safely", async () => {
    assert.deepEqual(evaluatePackageInstrumentationLoadability({
      ok: true,
      package: "@opentelemetry/api",
      exports: ["trace"],
    }), {
      ok: true,
      level: "ok",
      package: "@opentelemetry/api",
      exports: ["trace"],
      detail: "@opentelemetry/api loadable",
    });

    const failed = evaluatePackageInstrumentationLoadability({
      ok: false,
      package: "@opentelemetry/api",
      error: "cannot load ghp_123456789012345678901234567890",
    });
    assert.equal(failed.detail, REDACTED_ENV_VALUE);

    const risk = evaluateFeatureFactoryTelemetryReadiness({
      cfg: { experimental: { openTelemetry: true } },
      pluginOptions: { telemetry: { enabled: true, captureMessages: true } },
      env: {},
      nativeOpenTelemetry: true,
    });
    assert.equal(risk.enabled, true);
    assert.equal(risk.ok, false);
    assert.equal(risk.redactionActive, true);
    assert.deepEqual(risk.risks.map((item) => item.kind), [
      "native-opencode-content-capture",
      "feature-factory-content-capture",
    ]);

    const aggregate = await collectTelemetryReadiness({
      cfg: { experimental: { openTelemetry: true }, plugin: ["@devtheops/opencode-plugin-otel"] },
      pluginOptions: { telemetry: { enabled: true } },
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
        OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=github_pat_123456789012345678901234567890",
        OTEL_SERVICE_NAME: "feature-factory",
      },
      instrumentationLoadability: { ok: true, package: "@opentelemetry/api", exports: ["trace"] },
    });
    assert.equal(aggregate.opencode.ok, true);
    assert.equal(aggregate.otlpEnv.headers.vars[0].headers[0].name, "x-honeycomb-team");
    assert.doesNotMatch(JSON.stringify(aggregate), /github_pat_/u);
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

function doctorFixture(pluginOptions = {}) {
  const dir = tempDir();
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), JSON.stringify({
    plugin: [["opencode-feature-factory", pluginOptions]],
  }), "utf8");
  writeExecutable(join(bin, "opencode"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "\${FAKE_OPENCODE_VERSION:-opencode-safe}"
elif [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  printf '%s\\n' '--command --dir'
elif [ "$1" = "providers" ]; then
  printf '%s\\n' 'provider'
elif [ "$1" = "run" ]; then
  printf '%s\\n' "$FAKE_SMOKE_FAILURE" >&2
  exit 1
fi
`);
  writeExecutable(join(bin, "git"), "#!/bin/sh\nif [ \"$1\" = \"symbolic-ref\" ]; then printf '%s\\n' 'origin/main'; fi\n");
  writeExecutable(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  symlinkSync(CLI, join(bin, "feature-factory"));
  return { dir, repo, home, bin };
}

function runDoctorFixture(fixture, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, "doctor", ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      ...extraEnv,
    },
  });
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}
