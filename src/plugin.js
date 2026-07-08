import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, "assets");

function readAsset(...parts) {
  return readFileSync(join(assets, ...parts), "utf8");
}

export function parseFrontmatter(markdown) {
  const normalized = String(markdown).replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: normalized };
  return { meta: parseSimpleYaml(match[1]), body: match[2] };
}

function parseSimpleYaml(src) {
  const meta = {};
  let currentMap = null;
  for (const raw of src.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const nested = raw.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && currentMap) {
      meta[currentMap][nested[1]] = coerce(nested[2]);
      continue;
    }
    currentMap = null;
    const mapStart = raw.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (mapStart) {
      currentMap = mapStart[1];
      meta[currentMap] = {};
      continue;
    }
    const scalar = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (scalar) meta[scalar[1]] = coerce(scalar[2]);
  }
  return meta;
}

function coerce(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function registerCommand(cfg) {
  const source = readAsset("command", "feature.md");
  const { meta, body } = parseFrontmatter(source);
  cfg.command ??= {};
  cfg.command.feature = {
    description: meta.description || "Run the durable feature-factory workflow.",
    agent: meta.agent || "build",
    template: body.trim(),
  };
}

function registerAgents(cfg) {
  cfg.agent ??= {};
  cfg.agent["feature-factory"] = {
    description: "Primary orchestrator for the durable feature-factory workflow. Scoped non-interactive permissions prevent headless factory runs from blocking on approval prompts.",
    mode: "primary",
    permission: nonInteractivePermission("allow"),
    prompt: "You are the feature-factory orchestrator. Follow the loaded feature skill exactly: classify intent, persist durable state, use file-based gates, delegate to specialized subagents, observe evidence yourself, stop at gates in headless/scripted mode instead of waiting for interactive approval, and in explicit autonomous mode use the factory's own reviewed evidence/panel verdicts to record bounded autonomous gate decisions and terminal_result without auto-merging.",
  };
  const agentDir = join(assets, "agent");
  for (const file of readdirSync(agentDir).filter((name) => name.endsWith(".md"))) {
    const name = file.replace(/\.md$/, "");
    const { meta, body } = parseFrontmatter(readFileSync(join(agentDir, file), "utf8"));
    const agent = { ...meta, prompt: body.trim() };
    delete agent.name;
    agent.permission = mergeFactoryPermission(agent.permission);
    cfg.agent[name] = agent;
  }
}

function mergeFactoryPermission(existing = {}) {
  const edit = typeof existing === "object" && existing.edit ? existing.edit : "deny";
  return { ...(typeof existing === "object" ? existing : {}), ...nonInteractivePermission(edit) };
}

function nonInteractivePermission(edit) {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: "allow",
    edit,
    webfetch: "allow",
    task: "allow",
    todowrite: "allow",
    external_directory: "deny",
  };
}

const AGENT_ROLES = {
  "feature-factory": "planning",
  "story-reader": "story",
  "story-writer": "story",
  "codebase-researcher": "research",
  "design-interpreter": "design",
  "spec-writer": "planning",
  "work-decomposer": "planning",
  "backend-builder": "builder",
  "frontend-builder": "builder",
  "test-verifier": "test",
  "work-reviewer": "reviewer",
  "implementation-validator": "reviewer",
  "security-reviewer": "security",
};

function applyProfileOptions(cfg, options = {}) {
  const profiles = options.profiles || {};
  const topLevelProfile = usableProfile(options.profile);
  for (const [agentName, agent] of Object.entries(cfg.agent || {})) {
    const role = AGENT_ROLES[agentName];
    const selected =
      usableProfile(profiles[agentName]) ||
      roleProfile(profiles, role) ||
      usableProfile(profiles.default) ||
      topLevelProfile;
    if (!selected) continue;
    if (selected.model) agent.model = selected.model;
    if (selected.variant) agent.variant = selected.variant;
  }
}

function roleProfile(profiles, role) {
  if (!role) return null;
  return usableProfile(profiles[role]) || (role === "security" ? usableProfile(profiles.reviewer) : null);
}

function usableProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  return profile.model || profile.variant ? profile : null;
}

function registerSkills(cfg) {
  cfg.skills ??= {};
  cfg.skills.paths ??= [];
  const skillPath = join(assets, "skills");
  if (!cfg.skills.paths.includes(skillPath)) cfg.skills.paths.push(skillPath);
}

export default async function featureFactoryPlugin(_input, options = {}) {
  return {
    config(cfg) {
      registerCommand(cfg);
      registerAgents(cfg);
      applyProfileOptions(cfg, options);
      registerSkills(cfg);
    },
  };
}
