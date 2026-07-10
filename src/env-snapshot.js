import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { readJsoncConfig } from "./config.js";
import { git } from "./git.js";
import plugin from "./plugin.js";
import { timestamp } from "./utils.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SENSITIVE_ENV_KEY_PATTERN = /(?:secret|token|password|passwd|pwd|api[_-]?key|private[_-]?key|credential|authorization|auth[_-]?header|access[_-]?key|bearer|cookie)/iu;
const SENSITIVE_ENV_VALUE_PATTERN = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)/iu;
const TOKEN_SHAPED_ENV_VALUE_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bhc_[A-Za-z0-9][A-Za-z0-9_-]{10,}\b/iu,
  /\bsk-proj[-_][A-Za-z0-9_-]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[abp][_-][A-Za-z0-9-]{10,}(?:-[A-Za-z0-9-]{10,})*\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /(?:^|[^A-Za-z0-9-])(?:[A-Fa-f0-9]{32,})(?=$|[^A-Za-z0-9-])/u,
  /(?:https?|ssh|git|ftp):\/\/[^/\s:@]+:[^/\s@]+@/iu,
];
const HIGH_ENTROPY_SINGLE_TOKEN_MIN_LENGTH = 32;
const HIGH_ENTROPY_MIN_SHANNON = 3.5;
const SAFE_HIGH_ENTROPY_ENV_KEY_PATTERN = /^(?:OTEL_EXPORTER_OTLP(?:_(?:TRACES|METRICS|LOGS))?_(?:ENDPOINT|HEADERS|PROTOCOL|TIMEOUT|COMPRESSION|INSECURE|CERTIFICATE)|FEATURE_FACTORY_OTEL_ENABLED)$/u;
export const REDACTED_ENV_VALUE = "[redacted]";

export async function collectEnv(options = {}) {
  const { pluginOptions, resolvedFrom } = resolveEffectivePluginOptions(options);
  const resolvedConfig = await resolvePluginConfig(pluginOptions);
  return {
    feature_factory_version: packageVersion(),
    opencode_version: commandOutput("opencode", ["--version"]),
    plugin_spec: options.pluginSpec || "opencode-feature-factory",
    // How the model/variant map below was resolved: "plugin-options" (passed by
    // a caller that has them, e.g. doctor), "opencode-config" (recovered from the
    // operator's opencode.jsonc plugin entry), or "package-default" (no operator
    // profiles visible). A null model under "package-default" means "not visible
    // to this process", NOT "unconfigured" — opencode still applies operator
    // profiles at runtime.
    resolved_from: resolvedFrom,
    resolved_models: Object.fromEntries(Object.entries(resolvedConfig.agent || {}).map(([name, agent]) => [name, agent.model || null])),
    resolved_variants: Object.fromEntries(Object.entries(resolvedConfig.agent || {}).map(([name, agent]) => [name, agent.variant || null])),
    driver: {
      kind: options.driverKind || "cli",
      name: "feature-factory",
      version: packageVersion(),
    },
    capabilities: detectCapabilities(options.cwd || process.cwd()),
  };
}

function resolveEffectivePluginOptions(options = {}) {
  if (hasProfileConfig(options.pluginOptions)) return { pluginOptions: options.pluginOptions, resolvedFrom: "plugin-options" };
  // The `factory env` snapshot path collects without the operator's plugin
  // options (they live in the opencode.jsonc plugin entry, which only opencode
  // parses). Recover them from the config so resolved_models reflects what
  // opencode actually applies rather than misleading nulls.
  if (options.readConfiguredProfiles !== false) {
    const recovered = readConfiguredPluginOptions(options.cwd, { configPath: options.configPath });
    if (hasProfileConfig(recovered)) return { pluginOptions: recovered, resolvedFrom: "opencode-config" };
  }
  return { pluginOptions: isRecord(options.pluginOptions) ? options.pluginOptions : {}, resolvedFrom: "package-default" };
}

export function readConfiguredPluginOptions(cwd = process.cwd(), { configPath } = {}) {
  void cwd;
  const path = configPath || join(homedir(), ".config", "opencode", "opencode.jsonc");
  let cfg;
  try {
    if (!existsSync(path)) return null;
    cfg = readJsoncConfig(path, { label: "opencode.jsonc" });
  } catch {
    return null;
  }
  for (const entry of Array.isArray(cfg?.plugin) ? cfg.plugin : []) {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (typeof spec !== "string") continue;
    if (spec === "opencode-feature-factory" || spec.includes("opencode-feature-factory")) {
      return Array.isArray(entry) && isRecord(entry[1]) ? entry[1] : {};
    }
  }
  return null;
}

function hasProfileConfig(value) {
  if (!isRecord(value)) return false;
  return isRecord(value.profiles) && Object.keys(value.profiles).length > 0
    ? true
    : isRecord(value.profile) && (value.profile.model || value.profile.variant) ? true : false;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function collectRunDebugSnapshot({ cwd, driverKind, pluginSpec, pluginOptions, event, now } = {}) {
  return {
    collected_at: timestamp(now, "environment snapshot timestamp"),
    event: stringValue(event) ? event.trim() : "run-created",
    diagnostic_only: true,
    env: scrubSecretEnv(await collectEnv({ cwd, driverKind, pluginSpec, pluginOptions })),
  };
}

export async function resolvePluginConfig(pluginOptions = {}) {
  const hooks = await plugin({}, pluginOptions);
  const cfg = {};
  hooks.config(cfg);
  return cfg;
}

export function detectCapabilities(cwd = process.cwd()) {
  return {
    git: commandOk("git", ["--version"]),
    gh: commandOk("gh", ["--version"]),
    gh_auth: commandOk("gh", ["auth", "status"]),
    opencode: commandOk("opencode", ["--version"]),
    opencode_run_command: opencodeRunSupports("--command"),
    opencode_run_dir: opencodeRunSupports("--dir"),
    git_repo: commandOk("git", ["rev-parse", "--show-toplevel"], cwd),
    base_branch: detectBaseBranch(cwd),
    factory_gitignored: gitIgnored(cwd, ".opencode/factory/"),
    worktrees_gitignored: gitIgnored(cwd, ".opencode/worktrees/"),
  };
}

export function scrubSecretEnv(value) {
  if (Array.isArray(value)) return value.map((item) => scrubSecretEnv(item));
  if (typeof value === "string") return isSensitiveEnvValue(value) ? REDACTED_ENV_VALUE : value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveEnvKey(key))
      .map(([key, item]) => [key, scrubSecretEnv(item)]),
  );
}

export function isSensitiveEnvKey(key) {
  const string = String(key ?? "");
  return SENSITIVE_ENV_KEY_PATTERN.test(string) || isSecretShapedEnvKey(string);
}

export function isSensitiveEnvValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return SENSITIVE_ENV_VALUE_PATTERN.test(trimmed)
    || TOKEN_SHAPED_ENV_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed))
    || credentialBearingUrl(trimmed)
    || highEntropySingleToken(trimmed);
}

export function isSecretShapedEnvKey(key) {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) return false;
  return TOKEN_SHAPED_ENV_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed))
    || credentialBearingUrl(trimmed)
    || highEntropySecretKey(trimmed);
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.version || "unknown";
}

function commandOk(command, args, cwd = process.cwd()) {
  if (command === "git") return git(cwd, args).ok;
  try {
    execFileSync(command, args, { cwd, stdio: "ignore", timeout: 10000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function commandOutput(command, args, cwd = process.cwd()) {
  if (command === "git") {
    const proc = git(cwd, args);
    return proc.ok ? (proc.stdout || proc.stderr || "").trim() : null;
  }
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

function opencodeRunSupports(flag) {
  const help = opencodeRunHelpText();
  if (!help) return false;
  // Token-boundary match: a bare substring test would let '--dir' match a
  // future '--directory' (or '--command' match '--commands') and report
  // support that does not exist.
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[\\s,=])${escaped}(?:$|[\\s,=])`, "mu").test(help);
}

// `opencode run --help` prints its usage to stderr and may exit non-zero, so
// capture both streams instead of relying on stdout-only commandOutput().
function opencodeRunHelpText() {
  try {
    const proc = spawnSync("opencode", ["run", "--help"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return `${proc.stdout || ""}\n${proc.stderr || ""}`.trim() || null;
  } catch {
    return null;
  }
}

function detectBaseBranch(cwd) {
  const symbolic = commandOutput("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
  if (symbolic) return symbolic.replace(/^origin\//u, "");
  for (const candidate of ["main", "master", "development", "develop"]) {
    if (commandOk("git", ["rev-parse", "--verify", `origin/${candidate}`], cwd)) return candidate;
  }
  return null;
}

function gitIgnored(cwd, path) {
  if (!existsSync(join(cwd, ".git")) && !commandOk("git", ["rev-parse", "--show-toplevel"], cwd)) return null;
  return commandOk("git", ["check-ignore", path], cwd);
}

function credentialBearingUrl(value) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function highEntropySingleToken(value) {
  if (value.length < HIGH_ENTROPY_SINGLE_TOKEN_MIN_LENGTH) return false;
  if (/\s/u.test(value)) return false;
  if (!/^[A-Za-z0-9._~+/=-]+$/u.test(value)) return false;
  return shannonEntropy(value) >= HIGH_ENTROPY_MIN_SHANNON;
}

function highEntropySecretKey(value) {
  if (SAFE_HIGH_ENTROPY_ENV_KEY_PATTERN.test(value)) return false;
  return highEntropySingleToken(value);
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
