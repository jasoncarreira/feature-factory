import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readJsoncConfig, readStrictJsonConfig } from "./config.js";
import { REDACTED_ENV_VALUE, collectEnv, resolvePluginConfig, scrubSecretEnv } from "./env-snapshot.js";
import { checkOpenTelemetryApiLoadability, evaluateContentCaptureRisk, sanitizeOtlpEnv } from "./telemetry.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SUBAGENTS = [
  "backend-builder",
  "codebase-researcher",
  "design-interpreter",
  "frontend-builder",
  "implementation-validator",
  "security-reviewer",
  "spec-writer",
  "story-reader",
  "story-writer",
  "test-verifier",
  "work-decomposer",
  "work-reviewer",
];
const EDIT_AGENTS = new Set(["feature-factory", "backend-builder", "frontend-builder", "test-verifier"]);
const NON_INTERACTIVE_ALLOW = ["read", "glob", "grep", "list", "bash", "webfetch", "task", "todowrite"];
const FACTORY_DENY = ["external_directory"];
const FEATURE_FACTORY_PLUGIN_SPECS = new Set(["opencode-feature-factory"]);
const COMPANION_TELEMETRY_PLUGIN_PATTERNS = [
  /@devtheops\/opencode-plugin-otel/u,
  /opencode-plugin-otel/u,
  /opentelemetry/u,
  /telemetry/u,
  /\botel\b/u,
];
const OTEL_ENDPOINT_KEYS = ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"];
const OTEL_HEADER_KEYS = ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_HEADERS"];
const OTEL_RESOURCE_ATTRIBUTES = "OTEL_RESOURCE_ATTRIBUTES";
const OTEL_SERVICE_NAME = "OTEL_SERVICE_NAME";
const ENDPOINT_SECRET_KEY_PATTERN = /(?:key|token|secret|password|authorization|credential|access|team|api[_-]?key)/iu;
const ENDPOINT_SECRET_VALUE_PATTERN = /(?:hc[a-z0-9_-]*|gh[pousr]|github_pat|sk(?:-proj)?|xox[abp]|glpat)[_-][A-Za-z0-9_-]{10,}/iu;
const ENDPOINT_BARE_HEX_SECRET_PATTERN = /^[A-Fa-f0-9]{32,}$/u;
const ENDPOINT_LONG_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{16,}$/u;

export async function runDoctor(options = {}) {
  const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc");
  const cfg = readOpencodeConfig(configPath);
  const pluginSpec = options.local ? pathToFileURL(root).href : "opencode-feature-factory";
  const pluginEntry = findPluginEntry(cfg, pluginSpec, options.local);
  const pluginOptions = Array.isArray(pluginEntry) ? pluginEntry[1] || {} : {};
  const registered = await resolvePluginConfig(pluginOptions);
  const env = await collectEnv({ cwd: options.cwd, pluginSpec, pluginOptions });
  const providers = providerAuthState();
  const checks = [];

  add(checks, "HOME", Boolean(process.env.HOME), process.env.HOME || "unset");
  add(checks, "opencode config", existsSync(configPath), configPath);
  add(checks, "plugin configured", Boolean(pluginEntry), pluginSpec);
  add(checks, "profile config shape", staleProfileKeys(pluginOptions).length === 0, staleProfileKeys(pluginOptions).join(", ") || "profiles", "warn");
  add(checks, "opencode CLI", env.capabilities.opencode, env.opencode_version || "opencode");
  add(checks, "opencode run --command", env.capabilities.opencode_run_command, "opencode run --help");
  add(checks, "opencode run --dir", env.capabilities.opencode_run_dir, "opencode run --help");
  add(checks, "/feature command registered", Boolean(registered.command?.feature), "command.feature");
  add(checks, "/feature command uses primary agent", registered.command?.feature?.agent === "feature-factory", registered.command?.feature?.agent || "unset");
  add(checks, "feature-factory primary agent", Boolean(registered.agent?.["feature-factory"]), "agent.feature-factory");
  add(checks, "12 subagents registered", missingSubagents(registered.agent).length === 0, missingSubagents(registered.agent).length ? `missing ${missingSubagents(registered.agent).join(", ")}` : "12 subagents");
  add(checks, "factory permissions non-interactive", permissionFailures(registered.agent).length === 0, permissionFailures(registered.agent).join("; ") || "factory agent permissions");
  add(checks, "feature skill path", Boolean(registered.skills?.paths?.length), registered.skills?.paths?.join(", ") || "none");
  add(checks, "TUI sidebar export", hasTuiExport(), "package.json exports[\"./tui\"]", "warn");
  add(checks, "repo-local feature skill", existsSync(join(options.cwd || process.cwd(), ".opencode", "skills", "feature", "SKILL.md")), ".opencode/skills/feature/SKILL.md", "warn");
  add(checks, "repo-local feature schema", existsSync(join(options.cwd || process.cwd(), ".opencode", "skills", "feature", "SCHEMA.md")), ".opencode/skills/feature/SCHEMA.md", "warn");
  add(checks, "git CLI", env.capabilities.git, "git");
  add(checks, "git repository", env.capabilities.git_repo, options.cwd || process.cwd());
  add(checks, "base branch", Boolean(env.capabilities.base_branch), env.capabilities.base_branch || "not detected");
  add(checks, "gh CLI", env.capabilities.gh, "gh");
  add(checks, "gh auth", env.capabilities.gh_auth, "gh auth status", "warn");
  add(checks, ".opencode/factory ignored", env.capabilities.factory_gitignored === true, ".opencode/factory/", "warn");
  add(checks, ".opencode/worktrees ignored", env.capabilities.worktrees_gitignored === true, ".opencode/worktrees/", "warn");

  const telemetry = options.telemetry
    ? await collectTelemetryReadiness({ cfg, pluginOptions, env: process.env })
    : null;

  if (telemetry) addTelemetryChecks(checks, telemetry);

  for (const [agent, model] of Object.entries(env.resolved_models)) {
    if (!model) continue;
    const provider = modelProvider(model);
    add(checks, `model ${agent}`, Boolean(provider), model);
    if (provider) {
      const auth = providersAuthenticated(provider, providers);
      add(checks, `provider ${provider} auth`, auth.ok, auth.detail, auth.ok ? "ok" : "missing");
      if (options.providerSmoke) {
        const smoke = smokeProvider(model, options.cwd || process.cwd());
        add(checks, `provider ${provider} smoke`, smoke.ok, smoke.detail, smoke.ok ? "ok" : "missing");
      }
    }
  }

  if (!options.providerSmoke) {
    add(checks, "provider smoke", false, "run with --provider-smoke before long scripted runs", "warn");
  }

  if (options.json) {
    console.log(JSON.stringify(telemetry ? { checks, env, telemetry } : { checks, env }, null, 2));
  } else {
    if (options.profiles) printProfileMap(env.resolved_models, env.resolved_variants);
    for (const check of checks) console.log(`${check.level}: ${check.label} (${check.detail})`);
  }
  return checks.every((check) => check.level !== "missing");
}

export function readOpencodeConfig(configPath = join(homedir(), ".config", "opencode", "opencode.jsonc")) {
  return readJsoncConfig(configPath, { label: "opencode.jsonc" });
}

export async function collectTelemetryReadiness({ cfg = {}, pluginOptions = {}, env = process.env, instrumentationLoadability } = {}) {
  const loadability = instrumentationLoadability || await checkOpenTelemetryApiLoadability();
  const opencode = evaluateOpenTelemetryConfigReadiness(cfg);
  return scrubSecretEnv({
    opencode,
    otlpEnv: evaluateOtlpEnvReadiness(env),
    companionPlugin: evaluateCompanionTelemetryPluginReadiness(cfg),
    instrumentation: evaluatePackageInstrumentationLoadability(loadability),
    featureFactory: evaluateFeatureFactoryTelemetryReadiness({ cfg, pluginOptions, env, nativeOpenTelemetry: opencode.enabled }),
  });
}

export function evaluateOpenTelemetryConfigReadiness(cfg = {}) {
  const experimental = plainObject(cfg.experimental) ? cfg.experimental : {};
  const value = experimental.openTelemetry;
  const enabled = value === true;
  return {
    ok: enabled,
    level: enabled ? "ok" : "warn",
    enabled,
    configured: value !== undefined,
    detail: enabled
      ? "experimental.openTelemetry=true; native opencode/AI SDK spans may be emitted when an SDK/exporter is initialized"
      : `experimental.openTelemetry=${value === undefined ? "unset" : safeValue(value)}; enable it for native opencode AI SDK spans`,
    nativeAiSdkSpansExpected: enabled,
  };
}

export function evaluateOtlpEnvReadiness(env = process.env) {
  const safeOtlp = sanitizeOtlpEnv(env || {});
  const endpoint = firstPresent(OTEL_ENDPOINT_KEYS, env);
  const headers = OTEL_HEADER_KEYS
    .filter((key) => stringValue(env?.[key]))
    .map((key) => ({ key, headers: safeOtlp[key] || [] }));
  const resourceAttributes = parseOtelKeyValueList(env?.[OTEL_RESOURCE_ATTRIBUTES]);
  const serviceNameFromResource = resourceAttributes.find((item) => item.name === "service.name");
  const serviceName = stringValue(env?.[OTEL_SERVICE_NAME])
    ? { source: OTEL_SERVICE_NAME, value: safeValue(env[OTEL_SERVICE_NAME]) }
    : serviceNameFromResource
      ? { source: OTEL_RESOURCE_ATTRIBUTES, value: safeValue(serviceNameFromResource.value) }
      : null;

  return {
    ok: Boolean(endpoint),
    level: endpoint ? "ok" : "missing",
    endpoint: endpoint
      ? { ok: true, key: endpoint.key, value: sanitizeEndpointSummary(endpoint.value) }
      : { ok: false, missing: OTEL_ENDPOINT_KEYS },
    headers: {
      ok: headers.some((item) => item.headers.length > 0),
      vars: headers,
      missing: headers.length === 0 ? OTEL_HEADER_KEYS : [],
      detail: headers.length > 0 ? headerDetail(headers) : "no OTLP header variables configured",
    },
    resource: {
      ok: Boolean(serviceName),
      serviceName,
      attributes: resourceAttributes.map((item) => ({ name: item.name, present: true })),
      detail: serviceName ? `service.name from ${serviceName.source}` : "set OTEL_SERVICE_NAME or service.name in OTEL_RESOURCE_ATTRIBUTES",
    },
  };
}

export function evaluateCompanionTelemetryPluginReadiness(cfg = {}) {
  const plugins = Array.isArray(cfg.plugin) ? cfg.plugin : [];
  const matches = plugins
    .map((entry) => companionPluginCandidate(entry))
    .filter(Boolean);

  if (matches.length === 0) {
    return {
      ok: false,
      level: "warn",
      present: false,
      detail: "no companion telemetry plugin configured; use native opencode OTel or install @devtheops/opencode-plugin-otel",
      action: "Configure native experimental.openTelemetry or add a companion telemetry plugin that initializes an OpenTelemetry SDK/exporter.",
    };
  }

  const unusable = matches.filter((item) => item.unusable);
  return {
    ok: unusable.length === 0,
    level: unusable.length === 0 ? "ok" : "warn",
    present: true,
    plugins: matches,
    detail: unusable.length === 0
      ? `companion telemetry plugin configured: ${matches.map((item) => item.spec).join(", ")}`
      : `companion telemetry plugin needs attention: ${unusable.map((item) => `${item.spec} (${item.reason})`).join(", ")}`,
    action: unusable.length === 0 ? "none" : "Enable or fix the companion telemetry plugin options.",
  };
}

export function evaluatePackageInstrumentationLoadability(loadability = {}) {
  return {
    ok: loadability.ok === true,
    level: loadability.ok === true ? "ok" : "missing",
    package: loadability.package || "@opentelemetry/api",
    exports: Array.isArray(loadability.exports) ? loadability.exports : [],
    detail: loadability.ok === true
      ? `${loadability.package || "@opentelemetry/api"} loadable`
      : scrubSecretEnv(loadability.error || `${loadability.package || "@opentelemetry/api"} is not loadable`),
  };
}

export function evaluateFeatureFactoryTelemetryReadiness({ cfg = {}, pluginOptions = {}, env = process.env, nativeOpenTelemetry } = {}) {
  const telemetryOptions = plainObject(pluginOptions.telemetry) ? pluginOptions.telemetry : {};
  const envEnabled = parseBooleanEnv(env?.FEATURE_FACTORY_OTEL_ENABLED);
  const optionEnabled = telemetryOptions.enabled === true;
  const enabled = optionEnabled || envEnabled === true;
  const risk = evaluateContentCaptureRisk({
    config: cfg,
    telemetry: telemetryOptions,
    nativeOpenTelemetry: nativeOpenTelemetry === true,
  });

  return {
    ok: risk.ok,
    level: risk.ok ? "ok" : "warn",
    enabled,
    mode: safeValue(telemetryOptions.mode || (nativeOpenTelemetry ? "native-opencode" : "noop")),
    source: optionEnabled ? "plugin.telemetry.enabled" : envEnabled === true ? "FEATURE_FACTORY_OTEL_ENABLED" : "default-off",
    redactionActive: risk.redactionActive === true,
    capture: risk.capture,
    risks: risk.risks,
    detail: risk.ok
      ? `feature-factory telemetry ${enabled ? "enabled" : "off by default"}; content capture disabled and redaction active`
      : risk.risks.map((item) => item.message).join(" "),
  };
}

function add(checks, label, passed, detail, failureLevel = "missing") {
  checks.push({ label, level: passed ? "ok" : failureLevel, detail: String(detail ?? "") });
}

function addTelemetryChecks(checks, telemetry) {
  add(checks, "telemetry opencode experimental.openTelemetry", telemetry.opencode.ok, telemetry.opencode.detail, telemetry.opencode.level);
  add(checks, "telemetry native AI SDK spans", telemetry.opencode.nativeAiSdkSpansExpected, telemetry.opencode.nativeAiSdkSpansExpected ? "expected when SDK/exporter is initialized" : "not expected until experimental.openTelemetry is true", "warn");
  add(checks, "telemetry OTLP endpoint", telemetry.otlpEnv.endpoint.ok, formatTelemetryEndpointDetail(telemetry.otlpEnv.endpoint), telemetry.otlpEnv.level);
  add(checks, "telemetry OTLP headers", telemetry.otlpEnv.headers.ok, telemetry.otlpEnv.headers.detail, "warn");
  add(checks, "telemetry resource service", telemetry.otlpEnv.resource.ok, telemetry.otlpEnv.resource.detail, "warn");
  add(checks, "telemetry companion plugin", telemetry.companionPlugin.ok, telemetry.companionPlugin.detail, telemetry.companionPlugin.level);
  add(checks, "telemetry package instrumentation", telemetry.instrumentation.ok, telemetry.instrumentation.detail, telemetry.instrumentation.level);
  add(checks, "telemetry feature-factory options", telemetry.featureFactory.enabled, telemetry.featureFactory.detail, "warn");
  add(checks, "telemetry content capture risk", telemetry.featureFactory.ok, telemetry.featureFactory.detail, telemetry.featureFactory.level);
}

export function formatTelemetryEndpointDetail(endpoint) {
  if (endpoint.ok) return `${endpoint.key}=${endpoint.value}`;
  return `missing ${endpoint.missing.join(" or ")}`;
}

function headerDetail(headers) {
  return headers
    .map((item) => {
      const names = item.headers.map((header) => header.name).join(", ") || "no parseable headers";
      return `${item.key}: ${names}`;
    })
    .join("; ");
}

function firstPresent(keys, env) {
  for (const key of keys) {
    if (stringValue(env?.[key])) return { key, value: env[key] };
  }
  return null;
}

function parseOtelKeyValueList(value) {
  if (!stringValue(value)) return [];
  return String(value)
    .split(",")
    .map((entry) => {
      const index = entry.indexOf("=");
      const rawName = index === -1 ? entry : entry.slice(0, index);
      const rawValue = index === -1 ? "" : entry.slice(index + 1);
      const name = sanitizePublicName(rawName);
      if (!name) return null;
      return { name, value: safeValue(rawValue), present: true };
    })
    .filter(Boolean);
}

function companionPluginCandidate(entry) {
  const spec = pluginEntrySpec(entry);
  if (!stringValue(spec)) return null;
  const normalized = spec.toLowerCase();
  if (FEATURE_FACTORY_PLUGIN_SPECS.has(normalized)) return null;
  if (!COMPANION_TELEMETRY_PLUGIN_PATTERNS.some((pattern) => pattern.test(normalized))) return null;

  const options = Array.isArray(entry) && plainObject(entry[1]) ? entry[1] : {};
  const disabled = options.enabled === false || options.telemetry?.enabled === false;
  return {
    spec: safeValue(spec),
    present: true,
    unusable: disabled,
    reason: disabled ? "configured disabled" : undefined,
    action: disabled ? "set enabled=true or remove the disabled companion plugin entry" : "none",
  };
}

function pluginEntrySpec(entry) {
  return Array.isArray(entry) ? entry[0] : entry;
}

function sanitizePublicName(value) {
  const name = String(value || "").trim();
  if (!name) return null;
  return scrubSecretEnv(name);
}

function safeValue(value) {
  return scrubSecretEnv(String(value ?? ""));
}

function sanitizeEndpointSummary(value) {
  if (!stringValue(value)) return "unset";
  const raw = String(value).trim();

  try {
    const parsed = new URL(raw);
    const safePath = parsed.pathname
      .split("/")
      .map((segment) => sanitizeEndpointPathSegment(segment))
      .join("/") || "/";
    const safeQuery = endpointSearchHasValues(parsed.searchParams) ? `?${REDACTED_ENV_VALUE}` : "";
    return `${parsed.protocol}//${parsed.host}${safePath}${safeQuery}`;
  } catch {
    return endpointValueLooksSensitive(raw) ? REDACTED_ENV_VALUE : safeValue(raw);
  }
}

function sanitizeEndpointPathSegment(segment) {
  if (!segment) return segment;
  const decoded = safeDecodeURIComponent(segment);
  if (endpointValueLooksSensitive(decoded)) return REDACTED_ENV_VALUE;
  return scrubSecretEnv(segment);
}

function endpointSearchHasValues(searchParams) {
  for (const [key, value] of searchParams.entries()) {
    if (key || value) return true;
  }
  return false;
}

function endpointValueLooksSensitive(value) {
  const string = String(value || "").trim();
  if (!string) return false;
  if (scrubSecretEnv(string) === REDACTED_ENV_VALUE) return true;
  if (ENDPOINT_SECRET_VALUE_PATTERN.test(string)) return true;
  if (ENDPOINT_BARE_HEX_SECRET_PATTERN.test(string)) return true;
  if (ENDPOINT_SECRET_KEY_PATTERN.test(string) && /[=:]/u.test(string)) return true;
  if (ENDPOINT_LONG_TOKEN_PATTERN.test(string) && string.length >= 24 && mixedTokenChars(string)) return true;
  return false;
}

function mixedTokenChars(value) {
  return /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /[0-9]/u.test(value);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseBooleanEnv(value) {
  if (!stringValue(value)) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function missingSubagents(agents = {}) {
  return SUBAGENTS.filter((name) => !agents[name]);
}

function staleProfileKeys(options = {}) {
  return ["model", "models", "variant", "variants"].filter((key) => Object.prototype.hasOwnProperty.call(options, key));
}

function permissionFailures(agents = {}) {
  const failures = [];
  for (const name of ["feature-factory", ...SUBAGENTS]) {
    const permission = agents[name]?.permission || {};
    for (const key of NON_INTERACTIVE_ALLOW) {
      if (permission[key] !== "allow") failures.push(`${name}.${key}=${permission[key] || "unset"}`);
    }
    for (const key of FACTORY_DENY) {
      if (permission[key] !== "deny") failures.push(`${name}.${key}=${permission[key] || "unset"}`);
    }
    const expectedEdit = EDIT_AGENTS.has(name) ? "allow" : "deny";
    if (permission.edit !== expectedEdit) failures.push(`${name}.edit=${permission.edit || "unset"}`);
  }
  return failures;
}

export function hasTuiExport(packageJsonPath = join(root, "package.json")) {
  const pkg = readPackageJson(packageJsonPath);
  return typeof pkg.exports?.["./tui"] === "string";
}

function readPackageJson(packageJsonPath) {
  try {
    return readStrictJsonConfig(packageJsonPath, { label: "package.json" });
  } catch (error) {
    if (error instanceof SyntaxError) {
      const detail = String(error.message || "invalid JSON syntax").replace(/^package\.json:\s*/u, "");
      throw new SyntaxError(`Invalid JSON in package.json: ${detail}`);
    }

    throw error;
  }
}

function findPluginEntry(cfg, pluginSpec, local) {
  for (const entry of cfg.plugin || []) {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (spec === pluginSpec) return entry;
    if (!local && spec === "opencode-feature-factory") return entry;
    if (local && typeof spec === "string" && spec.endsWith("/opencode-feature-factory")) return entry;
    if (local && typeof spec === "string" && spec.endsWith("/opencode-feature-factory/src/plugin.js")) return entry;
  }
  return null;
}

function providerAuthState() {
  const proc = runOpencode(["providers", "list"]);
  return proc.ok ? `${proc.stdout}\n${proc.stderr}`.toLowerCase() : "";
}

function modelProvider(model) {
  const [provider, name] = String(model).split("/");
  return provider && name ? provider : null;
}

function providersAuthenticated(provider, providersOutput) {
  const env = providerEnv(provider).filter((name) => process.env[name]);
  if (env.length) return { ok: true, detail: `env ${env.join(",")}` };
  if (providersOutput.includes(provider.toLowerCase())) return { ok: true, detail: "opencode providers list" };
  return { ok: false, detail: `no auth found for ${provider}` };
}

function providerEnv(provider) {
  const key = provider.toLowerCase();
  const known = {
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
    gemini: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    github: ["GITHUB_TOKEN"],
    groq: ["GROQ_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
  };
  return known[key] || [`${key.toUpperCase()}_API_KEY`];
}

function smokeProvider(model, cwd) {
  const proc = runOpencode(["run", "--dir", cwd, "--model", model, "Reply OK only."], { cwd, maxBuffer: 1024 * 1024 });
  const output = scrubSecretEnv(`${proc.stdout || ""}\n${proc.stderr || ""}`.trim());
  return { ok: proc.ok, detail: proc.ok ? "smoke passed" : output.slice(0, 300) };
}

function runOpencode(args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync("opencode", args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout || 30000, maxBuffer: options.maxBuffer || 1024 * 1024 }),
      stderr: "",
      status: 0,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: normalizeCommandOutput(error.stdout),
      stderr: normalizeCommandOutput(error.stderr || error.message),
      status: error.status ?? 1,
    };
  }
}

function normalizeCommandOutput(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value || "");
}

function printProfileMap(models, variants) {
  for (const [agent, model] of Object.entries(models)) {
    console.log(`profile: ${agent} -> model=${model || "<opencode default>"} variant=${variants[agent] || "<opencode default>"}`);
  }
}
