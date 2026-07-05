import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { collectProvenance, resolvePluginConfig } from "./provenance.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SUBAGENTS = [
  "backend-builder",
  "codebase-researcher",
  "design-interpreter",
  "frontend-builder",
  "implementation-validator",
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

export async function runDoctor(options = {}) {
  const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc");
  const cfg = readConfig(configPath);
  const pluginSpec = options.local ? pathToFileURL(join(root, "src", "plugin.js")).href : "opencode-feature-factory";
  const pluginEntry = findPluginEntry(cfg, pluginSpec, options.local);
  const pluginOptions = Array.isArray(pluginEntry) ? pluginEntry[1] || {} : {};
  const registered = await resolvePluginConfig(pluginOptions);
  const provenance = await collectProvenance({ cwd: options.cwd, pluginSpec, pluginOptions });
  const providers = providerAuthState();
  const checks = [];

  add(checks, "HOME", Boolean(process.env.HOME), process.env.HOME || "unset");
  add(checks, "opencode config", existsSync(configPath), configPath);
  add(checks, "plugin configured", Boolean(pluginEntry), pluginSpec);
  add(checks, "opencode CLI", provenance.capabilities.opencode, provenance.opencode_version || "opencode");
  add(checks, "opencode run --command", provenance.capabilities.opencode_run_command, "opencode run --help");
  add(checks, "opencode run --dir", provenance.capabilities.opencode_run_dir, "opencode run --help");
  add(checks, "/feature command registered", Boolean(registered.command?.feature), "command.feature");
  add(checks, "/feature command uses primary agent", registered.command?.feature?.agent === "feature-factory", registered.command?.feature?.agent || "unset");
  add(checks, "feature-factory primary agent", Boolean(registered.agent?.["feature-factory"]), "agent.feature-factory");
  add(checks, "11 subagents registered", missingSubagents(registered.agent).length === 0, missingSubagents(registered.agent).length ? `missing ${missingSubagents(registered.agent).join(", ")}` : "11 subagents");
  add(checks, "factory permissions non-interactive", permissionFailures(registered.agent).length === 0, permissionFailures(registered.agent).join("; ") || "factory agent permissions");
  add(checks, "feature skill path", Boolean(registered.skills?.paths?.length), registered.skills?.paths?.join(", ") || "none");
  add(checks, "repo-local feature skill", existsSync(join(options.cwd || process.cwd(), ".opencode", "skills", "feature", "SKILL.md")), ".opencode/skills/feature/SKILL.md", "warn");
  add(checks, "repo-local feature schema", existsSync(join(options.cwd || process.cwd(), ".opencode", "skills", "feature", "SCHEMA.md")), ".opencode/skills/feature/SCHEMA.md", "warn");
  add(checks, "git CLI", provenance.capabilities.git, "git");
  add(checks, "git repository", provenance.capabilities.git_repo, options.cwd || process.cwd());
  add(checks, "base branch", Boolean(provenance.capabilities.base_branch), provenance.capabilities.base_branch || "not detected");
  add(checks, "gh CLI", provenance.capabilities.gh, "gh");
  add(checks, "gh auth", provenance.capabilities.gh_auth, "gh auth status", "warn");
  add(checks, ".opencode/factory ignored", provenance.capabilities.factory_gitignored === true, ".opencode/factory/", "warn");
  add(checks, ".opencode/worktrees ignored", provenance.capabilities.worktrees_gitignored === true, ".opencode/worktrees/", "warn");

  for (const [agent, model] of Object.entries(provenance.resolved_models)) {
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

  if (options.models) printModelMap(provenance.resolved_models, provenance.resolved_variants);
  if (options.json) {
    console.log(JSON.stringify({ checks, provenance }, null, 2));
  } else {
    for (const check of checks) console.log(`${check.level}: ${check.label} (${check.detail})`);
  }
  return checks.every((check) => check.level !== "missing");
}

function add(checks, label, passed, detail, failureLevel = "missing") {
  checks.push({ label, level: passed ? "ok" : failureLevel, detail: String(detail ?? "") });
}

function missingSubagents(agents = {}) {
  return SUBAGENTS.filter((name) => !agents[name]);
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

function readConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  return stripped ? JSON.parse(stripped) : {};
}

function findPluginEntry(cfg, pluginSpec, local) {
  for (const entry of cfg.plugin || []) {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (spec === pluginSpec) return entry;
    if (!local && spec === "opencode-feature-factory") return entry;
    if (local && typeof spec === "string" && spec.endsWith("/opencode-feature-factory/src/plugin.js")) return entry;
  }
  return null;
}

function providerAuthState() {
  const proc = spawnSync("opencode", ["providers", "list"], { encoding: "utf8" });
  return proc.status === 0 ? `${proc.stdout}\n${proc.stderr}`.toLowerCase() : "";
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
  const proc = spawnSync("opencode", ["run", "--dir", cwd, "--model", model, "Reply OK only."], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const output = `${proc.stdout || ""}\n${proc.stderr || ""}`.trim();
  return { ok: proc.status === 0, detail: proc.status === 0 ? "smoke passed" : output.slice(0, 300) };
}

function printModelMap(models) {
  for (const [agent, model] of Object.entries(models)) console.log(`model: ${agent} -> ${model || "<opencode default>"}`);
}
