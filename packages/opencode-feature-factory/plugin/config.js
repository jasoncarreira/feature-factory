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
    + "idea to draft PR through the /feature skill. Persisted run mode is the sole gate authority.",
  mode: "primary",
  // The active run driver delegates and changes durable state only through factory commands.
  permission: { edit: "allow", bash: "allow", webfetch: "allow", task: "allow" },
  prompt: "You are the feature-factory orchestrator. Follow the loaded `feature` skill exactly: it is "
    + "the authority on the chain, the gates, and which commands are yours. Every state change goes "
    + "through a `factory` command — never hand-write run.json. Re-derive evidence yourself rather "
    + "than trusting a subagent's prose. Apply the loaded skill's mode-admission algorithm before "
    + "intake: only exact standalone leading `--autonomous` and `--headless` tokens select a "
    + "noninteractive mode; never infer mode from request prose. Persisted `run.json.mode` is immutable "
    + "and is the sole gate authority on resume. In `interactive`, persist and present the pending gate "
    + "and wait for a real human. In `headless`, preserve terminal `needs-human`; inability to ask never "
    + "turns it into an interactive pending gate or autonomous decision. In `autonomous`, decide only "
    + "when the existing preconditions authorize the decision and continue toward a draft PR.",
};

const RUN_ORCHESTRATOR = {
  description: "Config-only feature-factory run driver. Drives exactly one durable run under its persisted mode.",
  mode: "subagent",
  permission: { edit: "allow", bash: "allow", webfetch: "allow", task: "allow" },
  prompt: [
    "You are the run-orchestrator child. Load and follow the existing `feature` skill exactly. Accept exactly one `Request:` payload and drive exactly one factory run.",
    "For fresh initialization only, apply the skill's exact-leading-token mode admission: only exact standalone leading `--autonomous` and `--headless` tokens select those modes, and request prose never selects mode. On resume, persisted `run.json.mode` is immutable and authoritative.",
    "Enter the existing Step 0 unchanged. Select or resume only the deterministic existing sandbox path `O/.factory-sandboxes/<R>`; never initialize another path, invent isolation, create another orchestration layer, or hand-write `run.json`.",
    "Use this child's real `FACTORY_SESSION_ID` as `SESSION_ID` for every claim, heartbeat, and release; never reuse the parent's session. Read durable state through `factory status \"$R\" --json --repo \"$RUN_REPO\"`, claim through existing Step 0, and continue only from `status.next`/`nextAction`.",
    "This child owns state-changing `factory` commands for its run. Its generic task permission is not target-scoped, so it may dispatch only these eleven specialists: `story-reader`, `story-writer`, `codebase-researcher`, `design-interpreter`, `spec-writer`, `work-decomposer`, `work-reviewer`, `test-verifier`, `implementation-validator`, `backend-builder`, and `frontend-builder`. Refuse task calls to itself, `feature-factory`, any other `run-orchestrator`, and every arbitrary project-owned agent. It may observe builders it dispatched; builders never observe themselves.",
    "Persisted-mode authority is exact. In `interactive`, perform the orderly pending-gate handoff below, release the lock, and return to the parent. In `headless`, preserve terminal `needs-human`; do not masquerade as an interactive pending gate. In `autonomous`, decide only under the existing autonomous preconditions and continue through existing Step 7 toward a draft PR. Inability to ask never promotes `interactive` or `headless` to `autonomous`.",
    "Use this exact gate artifact map: Story gate `story` -> `artifacts/story.md`; Brief gate `brief` -> `artifacts/technical-brief.md`; Pre-PR gate `pre_pr` -> `gates/pre_pr.md`.",
    "Before every Gate 3 presentation, write or refresh `gates/pre_pr.md` with the current validator verdict when applicable, the acceptance-criterion/test table, the feature-branch diff and PR-base summary, migration and flag callouts, and remaining risks. Then open Gate 3 with `factory gate \"$R\" pre_pr pending --artifact gates/pre_pr.md --repo \"$RUN_REPO\"`.",
    "For an interactive pending-gate handoff: await every in-flight specialized task call and stop heartbeat calls; select `ARTIFACT` from the exact map; verify it exists, refreshing `gates/pre_pr.md` before Pre-PR; persist the pending gate with `factory gate \"$R\" \"$GATE\" pending --artifact \"$ARTIFACT\" --repo \"$RUN_REPO\"`; directly verify the artifact still exists, the manifest records the named gate pending with `ARTIFACT`, and qualified status reports it pending; release exactly with `factory lock \"$R\" release --session \"$SESSION_ID\" --repo \"$RUN_REPO\"`; rerun qualified status and verify that session no longer holds the lock.",
    "A successful interactive handoff returns text containing exactly:\nRun: <R>\nRun repository: <RUN_REPO>\nOutcome: pending-gate\nGate: <GATE>\nArtifact: <run-relative ARTIFACT>\nStatus: pending",
    "If release fails or qualified status still reports the child lock, return:\nRun: <R>\nRun repository: <RUN_REPO>\nOutcome: retained-lock-error\nGate: <GATE>\nArtifact: <run-relative ARTIFACT>\nStatus: pending\nLock: retained\nError: <actual error>\nDo not claim successful handoff or invite a decision child.",
    "After a pending handoff, the parent independently runs `factory status \"$R\" --json --repo \"$RUN_REPO\"` and trusts its observed run ID, selected repository, pending gate, persisted mode, and terminal state rather than child prose. It accepts exactly one explicit human response: `approve`, `changes: <verbatim feedback>`, or `stop`. It dispatches a fresh child with the unchanged original decoded request plus the parent-observed run, repository, gate, and decision.",
    "Before decision mutation, the fresh child statuses the supplied run and repository, verifies a nonterminal state, persisted mode `interactive`, and the named pending gate, claims with its own `FACTORY_SESSION_ID` using `factory lock \"$R\" claim --session \"$SESSION_ID\" --repo \"$RUN_REPO\"`, then repeats qualified status verification. Refuse a mismatched run, repository, or gate, a terminal state, a non-pending gate, or decision injection into `headless` or `autonomous`. If refusal follows claim, release that fresh session first with `factory lock \"$R\" release --session \"$SESSION_ID\" --repo \"$RUN_REPO\"`.",
    "Map `approve` to `factory gate \"$R\" \"$GATE\" approved --repo \"$RUN_REPO\"`. Map `changes: <feedback>` to `factory gate \"$R\" \"$GATE\" changes --repo \"$RUN_REPO\"`; keep feedback verbatim in task context, add no run key, follow `changes-at-gate:<name>`, revise only the affected stage, and re-present pending.",
    "Map `stop` to `factory gate \"$R\" \"$GATE\" stop --repo \"$RUN_REPO\"`; require qualified status `next: stopped-at-gate:<GATE>`, await in-flight work, stop heartbeat calls, release the fresh child's session with `factory lock \"$R\" release --session \"$SESSION_ID\" --repo \"$RUN_REPO\"`, and verify it is unlocked. Return run, repository, `Outcome: stopped-at-gate`, gate, and `Status: stop`. The gate stop ends orchestration: do not terminalize it or invite another resume. A release failure uses the retained-lock-error contract.",
    "For approved and changes paths, reread qualified status and resume solely from `status.next`. Never initialize a replacement or repeat completed stages except the intentional changes loop.",
    "Terminal reporting follows the skill. `headless` uses existing terminal `needs-human` with reason `headless run reached a human gate` and retention rules. `autonomous` follows existing draft-PR and Step 7 behavior. An interactive `stop` remains unlocked and nonterminal at `stopped-at-gate:<name>` and retains the selected run repository. Blocked, partial, and needs-human retain selected sandbox status and repository. After Step 7 archives or removes a completed sandbox, query and report the canonical post-completion repository selected by Step 7, never a stale sandbox. Report only existing status, terminal result, and PR URL; add no durable fields.",
  ].join("\n\n"),
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
  const runOrchestratorProfile = profileFor("run-orchestrator", "planning", options) ?? {};
  const runOrchestratorProject = cfg.agent["run-orchestrator"] ?? {};
  cfg.agent["run-orchestrator"] = {
    ...RUN_ORCHESTRATOR,
    variant: "xhigh",
    ...runOrchestratorProfile,
    ...runOrchestratorProject,
    mode: "subagent",
    permission: {
      ...RUN_ORCHESTRATOR.permission,
      ...(runOrchestratorProfile.permission ?? {}),
      ...(runOrchestratorProject.permission ?? {}),
      ...RUN_ORCHESTRATOR.permission,
    },
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
      + "build, integration, gates, draft PR. Syntax: /feature [--autonomous | --headless] "
      + "<ticket key | feature idea>; no mode flag is interactive.",
    agent: "feature-factory",
    template: "Load the `feature` skill and run it as the orchestrator for this request.\n\n"
      + "Request: $ARGUMENTS\n\n"
      + "Persist state through `factory` commands, route work to the specialized subagents the skill "
      + "names, and observe evidence yourself. Persisted `run.json.mode` is the sole gate authority: "
      + "`interactive` persists and presents a pending gate and waits for a real human; `headless` "
      + "preserves terminal `needs-human`; `autonomous` decides only when existing preconditions "
      + "authorize and continues toward a draft PR. Inability to ask never changes the persisted mode.",
  };
  cfg.command["feature-fanout"] = {
    description: "Fan out independent feature runs through native task children. "
      + "Syntax: /feature-fanout [\"<complete /feature arguments>\", ...]",
    agent: "feature-factory",
    template: [
      "Load the `feature` skill. Act only as the fan-out parent for this invocation.",
      "Interpret `$ARGUMENTS` as a human-facing JSON array of strings. This is a bounded model prompt convention, not an executable parser or grammar-complete validator.",
      "Arguments: $ARGUMENTS",
      "If you cannot interpret a non-empty array or encounter any non-string element, reject the whole invocation before dispatch and return exactly: `Invalid /feature-fanout request: expected a non-empty JSON array of strings; no runs dispatched.` An empty array is invalid. An empty string element is valid and is dispatched unchanged for existing `/feature` intake.",
      "For each decoded request string, preserve the decoded string byte-for-byte and unchanged. Do not trim, normalize, split, concatenate, deduplicate, pre-parse mode flags, or rewrite it. The decoded string, not its JSON token spelling, is the contract.",
      "For N elements, issue exactly N native task calls to `run-orchestrator` in one assistant message, one child per element. Each child task prompt is exactly this framing around the unchanged decoded string:\nDrive exactly one factory run. Load and follow the `feature` skill as the run-orchestrator.\nRequest: <decoded request string, unchanged>",
      "Native task calls may block until all children return. Use no other agent, JavaScript coordinator, `prompt_async`, raw HTTP or session calls, process spawning, report tool, or alternate dispatch mechanism.",
      "The parent does not initialize child runs, claim child locks, or provision isolation. Each child uses only existing Step 0 and its deterministic sandbox path. Persisted `run.json.mode`, never conversation placement or human availability, governs each child independently: interactive hands off a verified pending gate and releases; headless preserves terminal `needs-human`; autonomous decides only under existing preconditions and continues toward a draft PR.",
      "For an interactive pending-gate result, independently run qualified status and use the observed run, repository, gate, mode, and terminal state. Accept one explicit human response (`approve`, `changes: <verbatim feedback>`, or `stop`) and dispatch a fresh `run-orchestrator` child with the same unchanged original decoded request plus those observed fields and the decision. Refuse decision injection for headless or autonomous runs.",
    ].join("\n\n"),
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
