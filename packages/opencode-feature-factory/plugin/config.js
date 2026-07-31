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

// Claude Code frontmatter → an opencode agent.
//
// Model selection is a port of the predecessor's, which was a better design than the one I invented.
// I had mapped the declared `model: sonnet|opus` tier to a configured id — and checking it against a
// real configuration showed the tier is the wrong vocabulary: two agents declaring `sonnet` were
// deliberately given the *strong* model, because writing production code is the hard part. Mapping
// `sonnet` to a cheaper id would have quietly downgraded both builders.
//
// The old plugin resolved a profile through four levels instead, most specific first:
//
//   profiles[<agent>]  ->  profiles[<role>]  ->  profiles.default  ->  profile
//
// Roles — planning, story, research, design, builder, test, reviewer — are a vocabulary that actually
// fits: against one real config, five of seven roles were uniform, and the two that were not are
// exactly what the per-agent level is for. A new agent inherits its role rather than needing a new
// entry, which the tier map could not do either.
//
// The role is declared in each agent's frontmatter rather than in a table here, because a table
// drifts from the agent set, and which stage of the chain an agent serves is a fact about the chain.
//
// `effort` still becomes `variant` as a baseline, since the agent knows how hard its own job is; any
// profile overrides it. `model` from frontmatter is ignored: "sonnet" is not a model id anywhere.
function usable(profile) {
  if (!profile || typeof profile !== "object") return null;
  return profile.model || profile.variant ? profile : null;
}

export function profileFor(name, role, { profiles = {}, profile } = {}) {
  return usable(profiles[name]) ?? usable(role ? profiles[role] : null)
    ?? usable(profiles.default) ?? usable(profile);
}

function toOpencodeAgent(name, source, options = {}) {
  const { meta, body } = parseFrontmatter(source);
  const selected = profileFor(name, meta.role, options) ?? {};
  return {
    description: meta.description || `feature-factory ${name}`,
    mode: "subagent",
    ...(meta.effort ? { variant: meta.effort } : {}),
    ...(selected.model ? { model: selected.model } : {}),
    ...(selected.variant ? { variant: selected.variant } : {}),
    permission: permissionFor(meta.tools),
    prompt: body.trim(),
  };
}

// `tools` is *not* dropped, and flattening it was a real defect. Every subagent was given
// `edit: allow`, including `implementation-validator`, whose own prompt says "Read-only: no edits, no
// commits", and `work-reviewer` — so a reviewer could modify the code it was judging. Separating the
// party being judged from the party judging is the premise of the whole chain, and a uniform
// permission map quietly removed it. Permissions are derived from what each agent declares.
function permissionFor(tools) {
  const declared = String(tools ?? "").split(",").map((entry) => entry.trim().toLowerCase());
  const has = (name) => declared.includes(name);
  return {
    edit: has("edit") || has("write") ? "allow" : "deny",
    bash: has("bash") ? "allow" : "deny",
    webfetch: has("webfetch") ? "allow" : "deny",
    // One level of orchestration is a property of the chain, not a preference.
    task: "deny",
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

export function registerAgents(cfg, { root = factoryRoot(), ...options } = {}) {
  cfg.agent ??= {};
  // The orchestrator has no frontmatter file, so its tier is stated here: the deep model, since it
  // holds the whole chain and every gate decision.
  cfg.agent["feature-factory"] = {
    ...ORCHESTRATOR,
    // The orchestrator has no frontmatter file, so its role is named here: it plans.
    variant: "xhigh",
    ...(profileFor("feature-factory", "planning", options) ?? {}),
    ...(cfg.agent["feature-factory"] ?? {}),
    permission: { ...(cfg.agent["feature-factory"]?.permission ?? {}), ...ORCHESTRATOR.permission },
  };
  const dir = join(root, "agents");
  const names = [];
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
    const name = file.replace(/\.md$/u, "");
    const agent = toOpencodeAgent(name, readFileSync(join(dir, file), "utf8"), options);
    // Precedence, last wins: what this package derives from the agent's own frontmatter, then the
    // plugin's `profiles` option, then whatever is *already* in the config — which is how per-project
    // configuration works. The host merges a repository's `opencode.json` before calling this hook,
    // so a project that sets `agent: { "work-reviewer": { "model": … } }` must not be overwritten by
    // a default. This used to assign unconditionally, which silently discarded it.
    //
    // `permission` is held back deliberately. Model and effort are preferences; who may edit is not —
    // a reviewer that can change the code it judges breaks the separation the chain is built on, and
    // a subagent that can delegate makes the tree unbounded. Both are derived from the agent's
    // declared tools, and the honest place to change them is the agent definition.
    cfg.agent[name] = {
      ...agent,
        ...(cfg.agent[name] ?? {}),
      permission: { ...(cfg.agent[name]?.permission ?? {}), ...agent.permission },
    };
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
  const agents = registerAgents(cfg, { root, ...options });
  return { root, skill, agents };
}
