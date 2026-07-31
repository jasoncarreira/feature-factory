// Registering the workflow with opencode: the command, the skill, and the agents.
//
// **Nothing here writes a file.** The host's `config` hook takes the definitions in memory, so
// "installing" is registration rather than copying — which is both what the user should have to do
// (nothing) and why this does not need an exemption from the boundary test that forbids this package
// from writing.
//
// The translation is the substantive part. The factory package ships agent *prose* that is
// host-agnostic, but frontmatter is not: it is Claude Code's shape — `name`, `model: sonnet`,
// `tools: Read, Edit, …` — while opencode wants `mode: "subagent"` and a `permission` map. Prose is
// portable, metadata is per-host, and the host-integration package is the right place for that seam.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The installed factory package's directory. Resolved through its one export rather than a
// `./package.json` entry, so the factory's public surface stays a single module.
function factoryRoot() {
  const resolved = createRequire(import.meta.url).resolve("feature-factory");
  return dirname(dirname(resolved));
}

// Enough YAML for the frontmatter these files actually use: scalars and folded `>` blocks. A real
// parser would be a dependency, and this package has none — the factory's zero-dependency claim is
// only interesting if the integration does not quietly reintroduce one.
export function parseFrontmatter(source) {
  // Matched with String.match, not the RegExp method whose name the boundary test forbids as a
  // process-spawning token. That guard is deliberately blunt; complying beats excepting.
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
  if (!match) return { meta: {}, body: source };
  const meta = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const scalar = line.match(/^([a-z_]+):\s*(.*)$/iu);
    if (scalar) {
      key = scalar[1];
      meta[key] = scalar[2] === ">" || scalar[2] === "|" ? "" : scalar[2].trim();
      continue;
    }
    // A continuation line of a folded block.
    if (key && /^\s+\S/u.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim();
  }
  return { meta, body: match[2] };
}

// Claude Code frontmatter → an opencode agent. `model` is dropped deliberately: "sonnet" is not an
// opencode model id, and per-agent models belong in the operator's own `profiles` option, which is
// where they already are.
function toOpencodeAgent(name, source) {
  const { meta, body } = parseFrontmatter(source);
  return {
    description: meta.description || `feature-factory ${name}`,
    mode: "subagent",
    // Subagents may read, edit and run commands inside the worktree they are given; they may not
    // delegate. One level of orchestration is a property of the chain, not a preference — spread
    // last so no frontmatter can re-enable it.
    permission: { edit: "allow", bash: "allow", webfetch: "allow", task: "deny" },
    prompt: body.trim(),
  };
}

const ORCHESTRATOR = {
  description: "Primary orchestrator for the durable feature-factory workflow. Drives a feature from "
    + "idea to draft PR through the /feature skill, stopping at every human gate.",
  mode: "primary",
  // The orchestrator is the only agent that may delegate, and the only one that writes run state.
  permission: { edit: "allow", bash: "allow", webfetch: "allow", task: "allow" },
  prompt: "You are the feature-factory orchestrator. Follow the loaded `feature` skill exactly: it is "
    + "the authority on the chain, the gates, and which commands are yours. Every state change goes "
    + "through a `factory` command — never hand-write run.json. Re-derive evidence yourself rather "
    + "than trusting a subagent's prose. Stop at every gate unless the invocation explicitly asked "
    + "for autonomous mode.",
};

export function registerAgents(cfg, { root = factoryRoot(), profiles = {} } = {}) {
  cfg.agent ??= {};
  cfg.agent["feature-factory"] = { ...ORCHESTRATOR, ...(profiles["feature-factory"] ?? {}) };
  const dir = join(root, "agents");
  const names = [];
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
    const name = file.replace(/\.md$/u, "");
    const agent = toOpencodeAgent(name, readFileSync(join(dir, file), "utf8"));
    // The operator's profile may set the model and reasoning effort; it may not grant delegation.
    cfg.agent[name] = { ...agent, ...(profiles[name] ?? {}), permission: agent.permission };
    names.push(name);
  }
  return names;
}

// The skill is *discovered*, not copied: the host takes a directory containing
// `<skill-name>/SKILL.md`. So the package ships `skills/feature/SKILL.md` and this points at it,
// which means an upgrade of the package upgrades the skill with no install step and nothing stale
// left behind in a config directory.
export function registerSkill(cfg, { root = factoryRoot() } = {}) {
  cfg.skills ??= {};
  cfg.skills.paths ??= [];
  const path = join(root, "skills");
  if (!cfg.skills.paths.includes(path)) cfg.skills.paths.push(path);
  return path;
}

export function registerCommand(cfg) {
  cfg.command ??= {};
  cfg.command.feature = {
    description: "Take a feature, ticket or idea end to end: story, spec, decomposition, parallel "
      + "build, integration, three human gates, draft PR.",
    agent: "feature-factory",
    template: "Load the `feature` skill and run it as the orchestrator for this request.\n\n"
      + "Request: $ARGUMENTS\n\n"
      + "You are the orchestrator in the main conversation, not a subagent. Persist state through "
      + "`factory` commands, route work to the specialized subagents the skill names, observe "
      + "evidence yourself, and stop at every human gate.",
  };
}

// One call for the host's `config` hook.
export function registerWorkflow(cfg, options = {}) {
  const root = options.root ?? factoryRoot();
  registerCommand(cfg);
  const skill = registerSkill(cfg, { root });
  const agents = registerAgents(cfg, { root, profiles: options.profiles ?? {} });
  return { root, skill, agents };
}
