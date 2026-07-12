import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFeatureCommandPayload, safePayloadValue } from "./feature-command-payload.js";
import { normalizePostPrCiConfig } from "./config.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, "assets");
const OPERATOR_PAYLOAD_MARKER = "UNTRUSTED_OPERATOR_PAYLOAD_START";
const PARSED_PAYLOAD_START = "PLUGIN_PARSED_OPERATOR_PAYLOAD_START";
const PARSED_PAYLOAD_END = "PLUGIN_PARSED_OPERATOR_PAYLOAD_END";

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

function registerCommand(cfg, options = {}) {
  const source = readAsset("command", "feature.md");
  const { meta, body } = parseFrontmatter(source);
  cfg.command ??= {};
  cfg.command.feature = {
    description: meta.description || "Run the durable feature-factory workflow.",
    agent: meta.agent || "build",
    template: commandTemplate(body, options),
  };
}

function commandTemplate(body, options = {}) {
  const prMode = normalizePrMode(options.prMode ?? options.pr_mode ?? options.pullRequests?.mode);
  const postPrCi = normalizePostPrCiConfig(options.postPrCi);
  const config = [
    "Plugin configuration defaults:",
    `- PR mode: \`${prMode}\`. Use this as the default for successful PR creation when the driver payload has no \`pr_mode\` override.`,
    `- Post-PR CI policy: ${JSON.stringify(postPrCi)}. Use this default-off policy only when the driver payload has no per-field \`post_pr_ci\` override; persist the complete effective policy once and never recalculate it on resume.`,
  ].join("\n");
  const markerIndex = operatorPayloadMarkerIndex(body);
  if (markerIndex < 0) return `${body.trim()}\n\n${config}`;
  return `${body.slice(0, markerIndex)}${config}\n\n${body.slice(markerIndex)}`.trim();
}

function parsedPayloadBlock(parsed) {
  if (!parsed.ok) {
    return [
      PARSED_PAYLOAD_START,
      "parse_status: invalid",
      "trust: untrusted-operator-data",
      `reason: ${parsed.reason}`,
      "driver.mode: interactive",
      "routing_authority: none",
      PARSED_PAYLOAD_END,
    ].join("\n");
  }
  const payload = parsed.payload;
  const lines = [
    PARSED_PAYLOAD_START,
    "parse_status: valid",
    "trust: untrusted-operator-data",
    `operator_request: ${safePayloadValue(payload.operator_request)}`,
    `driver.mode: ${payload.driver.mode}`,
    `driver.ready: ${payload.driver.ready}`,
    `driver.pr_mode: ${safePayloadValue(payload.driver.pr_mode)}`,
    `driver.reviewer: ${safePayloadValue(payload.driver.reviewer)}`,
    `driver.github_account: ${safePayloadValue(payload.driver.github_account)}`,
    `driver.run_id: ${safePayloadValue(payload.driver.run_id)}`,
    `driver.post_pr_ci: ${safePayloadValue(payload.driver.post_pr_ci)}`,
    `resume: ${safePayloadValue(payload.resume)}`,
    `steering: ${safePayloadValue(payload.steering)}`,
    `continuation: ${safePayloadValue(payload.continuation)}`,
    PARSED_PAYLOAD_END,
  ];
  return lines.join("\n");
}

function injectParsedPayload(parts, parsed) {
  const block = parsedPayloadBlock(parsed);
  for (const part of parts || []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    const markerIndex = operatorPayloadMarkerIndex(part.text);
    if (markerIndex < 0 || part.text.slice(0, markerIndex).includes(`${PARSED_PAYLOAD_START}\nparse_status:`)) continue;
    part.text = `${part.text.slice(0, markerIndex)}${block}\n\n${part.text.slice(markerIndex)}`;
    return;
  }
}

function operatorPayloadMarkerIndex(text) {
  if (text.startsWith(`${OPERATOR_PAYLOAD_MARKER}\n`)) return 0;
  const index = text.indexOf(`\n${OPERATOR_PAYLOAD_MARKER}\n`);
  return index < 0 ? -1 : index + 1;
}

function normalizePrMode(value) {
  const mode = value === undefined || value === null || value === "" ? "ready" : String(value).trim();
  if (mode === "ready" || mode === "draft") return mode;
  throw new Error("opencode-feature-factory option prMode must be 'ready' or 'draft'");
}

function registerAgents(cfg) {
  cfg.agent ??= {};
  cfg.agent["feature-factory"] = {
    description: "Primary orchestrator for the durable feature-factory workflow. Scoped non-interactive permissions prevent headless factory runs from blocking on approval prompts.",
    mode: "primary",
    permission: nonInteractivePermission("allow", { task: "allow" }),
    prompt: "You are the feature-factory orchestrator. Follow the loaded feature skill exactly: classify intent, persist durable state, use file-based gates, delegate only from this primary agent to specialized subagents, observe evidence yourself, stop at gates in headless/scripted mode instead of waiting for interactive approval, and in explicit autonomous mode use the factory's own reviewed evidence/panel verdicts to record bounded autonomous gate decisions and terminal_result without auto-merging.",
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

// Force-deny Task delegation for every loaded subagent so only the primary
// feature-factory orchestrator can dispatch, keeping the orchestration tree one
// level deep. The forced `task: "deny"` is spread last, so agent frontmatter cannot
// re-enable delegation.
export function mergeFactoryPermission(existing = {}) {
  const edit = typeof existing === "object" && existing.edit ? existing.edit : "deny";
  return { ...(typeof existing === "object" ? existing : {}), ...nonInteractivePermission(edit, { task: "deny" }) };
}

function nonInteractivePermission(edit, { task = "deny" } = {}) {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: "allow",
    edit,
    webfetch: "allow",
    task,
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

export default async function featureFactoryPlugin(pluginInput, options = {}) {
  return {
    config(cfg) {
      registerCommand(cfg, options);
      registerAgents(cfg);
      applyProfileOptions(cfg, options);
      registerSkills(cfg);
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "feature") return;
      injectParsedPayload(output.parts, decodeFeatureCommandPayload(input.arguments, { repo: pluginInput?.directory || pluginInput?.worktree }));
    },
  };
}
