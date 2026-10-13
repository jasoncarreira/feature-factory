// The factory's agents, translated to OpenCode 2.0 agents.
//
// The factory ships agent prose that is host-agnostic and frontmatter that is Claude Code's shape
// (`model: sonnet`, `tools: Read, Edit, …`). This module turns that into V2 `Agent.Info` fields:
// `system`, `description`, `mode`, an optional `model` reference, and a `permissions` rule list.
//
// V2 permission rules are evaluated last-match-wins, and an agent's rules are appended after the
// global ones. So each list below opens with the broad rule and follows it with the exceptions.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The eleven specialists a run driver dispatches. Named here, not derived from the agents directory,
// because the grant is a closed list: a new file under `agents/` must not silently widen it.
export const SPECIALISTS = Object.freeze([
  "story-reader", "story-writer", "codebase-researcher", "design-interpreter", "spec-writer",
  "work-decomposer", "work-reviewer", "test-verifier", "implementation-validator",
  "backend-builder", "frontend-builder",
]);

// Enough YAML for the frontmatter these files use: scalars and folded `>` blocks. A real parser would
// be a dependency, and the factory's zero-dependency claim is only interesting if the adapter does not
// quietly reintroduce one.
export function parseFrontmatter(source) {
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
    if (key && /^\s+\S/u.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim();
  }
  return { meta, body: match[2] };
}

// Model selection, most specific first: profiles[<agent>] -> profiles[<role>] -> profiles.default ->
// profile. The declared frontmatter `model` is a tier ("sonnet"), never a model id, so it is ignored.
function usable(profile) {
  if (!profile || typeof profile !== "object") return null;
  return profile.model || profile.variant ? profile : null;
}

export function profileFor(name, role, { profiles = {}, profile } = {}) {
  return usable(profiles[name]) ?? usable(role ? profiles[role] : null)
    ?? usable(profiles.default) ?? usable(profile);
}

// A configured `provider/model` string, plus an optional variant, as V2's model reference. A string
// with no provider names nothing V2 can resolve, so it selects no model rather than a wrong one.
export function modelRef(model, variant) {
  if (typeof model !== "string") return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant ? { variant } : {}) };
}

const rule = (action, effect, resource = "*") => ({ action, resource, effect });

// Enforcement, not instruction: who may edit is derived from what each agent declares. A reviewer that
// can change the code it judges breaks the separation the chain is built on. Every specialist is denied
// `subagent`, because one level of orchestration is a property of the chain, and `external_directory`,
// because a specialist reading the *installed* package judges what shipped last week, not this run.
export function specialistPermissions(tools) {
  const declared = String(tools ?? "").split(",").map((entry) => entry.trim().toLowerCase());
  const has = (name) => declared.includes(name);
  return [
    rule("edit", has("edit") || has("write") ? "allow" : "deny"),
    rule("shell", has("bash") ? "allow" : "deny"),
    rule("webfetch", has("webfetch") ? "allow" : "deny"),
    rule("subagent", "deny"),
    rule("external_directory", "deny"),
  ];
}

// The drivers may edit, run commands and fetch, and may dispatch only the eleven specialists. In V1 that
// target list was prompt policy, because the host's task permission could not name targets; V2's
// `subagent` resource is the target agent id, so here it is enforced.
export function driverPermissions() {
  return [
    rule("edit", "allow"),
    rule("shell", "allow"),
    rule("webfetch", "allow"),
    rule("subagent", "deny"),
    ...SPECIALISTS.map((name) => rule("subagent", "allow", name)),
    rule("external_directory", "deny"),
  ];
}

// The one statement of how the CLI is invoked, composed after whatever prompt was selected so that a
// project's prompt override cannot remove it.
export function cliBinding(cli) {
  return `Every \`factory\` command runs as \`node ${cli}\`, the CLI this adapter resolved and shipped against. `
    + "Bind that one invocation before any factory command and use nothing else. Do not resolve `factory` from PATH, "
    + "and never obtain the CLI with `npx`, `npm exec`, `pnpm dlx`, or `bunx`: a fetched CLI can be a different "
    + "generation of this tool with its own state store, and it answers confidently about a run that is not this one. "
    + "If that path is not readable, stop without effects rather than substituting another resolution.";
}

const SESSION = "Call the `feature_factory_context` tool once before the first factory command and use its `sessionID` "
  + "as `SESSION_ID` for every lock claim, heartbeat, release and resume. Never invent a session label.";

const ORCHESTRATOR_PROMPT = [
  "You are the feature-factory orchestrator. Follow the loaded `feature` skill exactly: it is the authority on the chain, gates, admission, run-ID derivation, and which commands are yours. Every state change goes through a `factory` command; never hand-write run.json. Re-derive evidence yourself rather than trusting agent prose.",
  SESSION,
  "For an admitted `--background` request, derive the canonical run ID by the skill's policy, then call only `feature_background` with operation `start`, that run ID and the unchanged inner request, and return. Route a later gate answer only through `feature_background` operation `answer`.",
  "Persisted `run.json.mode` is the sole gate authority. Top-level `needs-human` is parked and resumable, not final; resume only through the skill's ordered resume procedure and continue solely from qualified `status.next`.",
].join("\n\n");

const RUN_ORCHESTRATOR_PROMPT = [
  "You are the bounded run-orchestrator for exactly one background feature-factory session. Load and follow the `feature` skill exactly. A start turn holds the tool's control text followed by one unchanged request part; a later answer turn holds exactly one decision part.",
  SESSION,
  "Before the first factory command, independently derive the canonical run ID by the skill's policy and require it to equal the expected run ID in the control text; on mismatch stop before any factory effect. This session alone initializes or resumes the run, owns its factory commands, claims and releases its lock, and continues only from `status.next`.",
  "Persisted `run.json.mode` is the sole gate authority. In `interactive`, perform the skill's orderly pending-gate park and end the turn; in `headless`, preserve parked `needs-human`; in `autonomous`, decide only under the skill's preconditions.",
].join("\n\n");

// The model an agent runs on, with its effort as a V2 variant. Precedence, most specific first, for the model:
// the project's own agent model, the profile's, then the host default; and for the variant: the project
// model's own variant, the profile's, then the agent's declared effort. A variant needs a model to attach
// to, so an effort-only profile or a bare declared effort pins the host default model. A variant that the
// chosen model is known not to offer is dropped rather than sent, since the host would refuse it.
export function resolvedModel({ existing, profile, effort, models = [], defaultModel }) {
  const base = existing?.model ?? modelRef(profile?.model) ?? (defaultModel?.providerID && defaultModel?.id
    ? { providerID: defaultModel.providerID, id: defaultModel.id } : undefined);
  if (!base) return undefined;
  const variant = existing?.model?.variant ?? profile?.variant ?? effort;
  const info = models.find((model) => model.providerID === base.providerID && model.id === base.id);
  const offered = !info || !Array.isArray(info.variants) || info.variants.some((entry) => entry?.id === variant);
  const { variant: _ignored, ...ref } = base;
  if (variant && offered) return { ...ref, variant };
  // With no variant to apply, an agent on the host default stays unpinned so it follows the default.
  return existing?.model || profile?.model ? ref : undefined;
}

// Agents a project or profile may tune. Model and effort are preferences; permissions are not, so they
// are always this module's. A project `system` override is honoured, with the CLI binding re-appended.
function composed(base, existing, profile, cli, models, defaultModel) {
  const system = typeof existing?.system === "string" && existing.system !== base.system ? existing.system : base.system;
  const model = resolvedModel({ existing, profile, effort: base.variant, models, defaultModel });
  return {
    description: existing?.description ?? base.description,
    mode: base.mode,
    system: `${system}\n\n${cliBinding(cli)}`,
    ...(model ? { model } : {}),
    permissions: base.permissions,
  };
}

// Everything the plugin registers, as plain data: one entry per agent id. Pure, so it is testable without
// a host. `existing` is what the host already holds for an id (a project's own definition, or nothing).
export function agentDefinitions({ root, cli, options = {}, existing = () => undefined, models = [], defaultModel }) {
  const agents = new Map();
  const drivers = [
    ["feature-factory", { description: "Primary orchestrator for the durable feature-factory workflow. Drives a feature from idea to draft PR through the /feature skill.", mode: "primary", system: ORCHESTRATOR_PROMPT }],
    ["run-orchestrator", { description: "Feature-factory run driver for one background session.", mode: "subagent", system: RUN_ORCHESTRATOR_PROMPT }],
  ];
  for (const [id, base] of drivers) {
    const profile = profileFor(id, "planning", options);
    agents.set(id, composed({ ...base, variant: "xhigh", permissions: driverPermissions() }, existing(id), profile, cli, models, defaultModel));
  }
  for (const file of readdirSync(join(root, "agents")).filter((entry) => entry.endsWith(".md")).sort()) {
    const id = file.replace(/\.md$/u, "");
    if (!SPECIALISTS.includes(id)) continue;
    const { meta, body } = parseFrontmatter(readFileSync(join(root, "agents", file), "utf8"));
    const base = {
      description: meta.description || `feature-factory ${id}`,
      mode: "subagent",
      system: body.trim(),
      variant: meta.effort || undefined,
      permissions: specialistPermissions(meta.tools),
    };
    agents.set(id, composed(base, existing(id), profileFor(id, meta.role, options), cli, models, defaultModel));
  }
  return agents;
}
