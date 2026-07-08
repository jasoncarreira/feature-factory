import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import plugin from "./plugin.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SENSITIVE_PROVENANCE_KEY_PATTERN =
  /(?:secret|token|password|passwd|pwd|api[_-]?key|private[_-]?key|credential|authorization|auth[_-]?header|access[_-]?key|bearer|cookie)/iu;
const SENSITIVE_PROVENANCE_VALUE_PATTERN = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)/iu;
const TOKEN_SHAPED_PROVENANCE_VALUE_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-proj[-_][A-Za-z0-9_-]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[abp][_-][A-Za-z0-9-]{10,}(?:-[A-Za-z0-9-]{10,})*\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/iu,
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /(?:https?|ssh|git|ftp):\/\/[^/\s:@]+:[^/\s@]+@/iu,
];
const HIGH_ENTROPY_SINGLE_TOKEN_MIN_LENGTH = 40;
const HIGH_ENTROPY_MIN_SHANNON = 3.5;
export const REDACTED_PROVENANCE_VALUE = "[redacted]";

export async function collectProvenance(options = {}) {
  const resolvedConfig = await resolvePluginConfig(options.pluginOptions || {});
  return {
    feature_factory_version: packageVersion(),
    opencode_version: commandOutput("opencode", ["--version"]),
    plugin_spec: options.pluginSpec || "opencode-feature-factory",
    resolved_models: Object.fromEntries(
      Object.entries(resolvedConfig.agent || {}).map(([name, agent]) => [name, agent.model || null]),
    ),
    resolved_variants: Object.fromEntries(
      Object.entries(resolvedConfig.agent || {}).map(([name, agent]) => [name, agent.variant || null]),
    ),
    driver: {
      kind: options.driverKind || "cli",
      name: "feature-factory",
      version: packageVersion(),
    },
    capabilities: detectCapabilities(options.cwd || process.cwd()),
  };
}

export async function collectRunProvenanceSnapshot({ cwd, driverKind, pluginSpec, pluginOptions, event, now } = {}) {
  return {
    collected_at: timestamp(now),
    event: stringValue(event) ? event.trim() : "run-created",
    diagnostic_only: true,
    provenance: scrubSecretProvenance(
      await collectProvenance({
        cwd,
        driverKind,
        pluginSpec,
        pluginOptions,
      }),
    ),
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

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.version || "unknown";
}

function commandOk(command, args, cwd = process.cwd()) {
  return spawnSync(command, args, { cwd, stdio: "ignore" }).status === 0;
}

function commandOutput(command, args, cwd = process.cwd()) {
  const proc = spawnSync(command, args, { cwd, encoding: "utf8" });
  return proc.status === 0 ? (proc.stdout || proc.stderr || "").trim() : null;
}

function opencodeRunSupports(flag) {
  const help = commandOutput("opencode", ["run", "--help"]);
  return Boolean(help && help.includes(flag));
}

function detectBaseBranch(cwd) {
  const symbolic = commandOutput("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
  if (symbolic) return symbolic.replace(/^origin\//, "");
  for (const candidate of ["main", "master", "development", "develop"]) {
    if (commandOk("git", ["rev-parse", "--verify", `origin/${candidate}`], cwd)) return candidate;
  }
  return null;
}

function gitIgnored(cwd, path) {
  if (!existsSync(join(cwd, ".git")) && !commandOk("git", ["rev-parse", "--show-toplevel"], cwd)) return null;
  return commandOk("git", ["check-ignore", path], cwd);
}

export function scrubSecretProvenance(value) {
  if (Array.isArray(value)) return value.map((item) => scrubSecretProvenance(item));
  if (typeof value === "string") return isSensitiveProvenanceValue(value) ? REDACTED_PROVENANCE_VALUE : value;
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveProvenanceKey(key))
      .map(([key, item]) => [key, scrubSecretProvenance(item)]),
  );
}

export function isSensitiveProvenanceKey(key) {
  return SENSITIVE_PROVENANCE_KEY_PATTERN.test(String(key ?? ""));
}

export function isSensitiveProvenanceValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    SENSITIVE_PROVENANCE_VALUE_PATTERN.test(trimmed) ||
    TOKEN_SHAPED_PROVENANCE_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
    credentialBearingUrl(trimmed) ||
    highEntropySingleToken(trimmed)
  );
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

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function timestamp(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid provenance timestamp");
  return new Date(parsed).toISOString();
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
