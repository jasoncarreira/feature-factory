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
import { fileURLToPath } from "node:url";

const RUN_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const BACKGROUND_CALLER_AGENTS = Object.freeze(["build", "feature-factory"]);

function encoded(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "number") return Number.isFinite(value) ? value : { $type: "nonfinite", value: String(value) };
  if (typeof value === "symbol") return { $type: "symbol", value: String(value) };
  if (typeof value === "function") return { $type: "function", name: value.name || null };
  if (seen.has(value)) return { $type: "reference" };
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => encoded(entry, seen));
  if (value instanceof Error) {
    return {
      $type: "error",
      name: value.name,
      message: value.message,
      ...(Object.hasOwn(value, "cause") ? { cause: encoded(value.cause, seen) } : {}),
    };
  }
  const properties = Object.fromEntries(Object.keys(value).map((key) => [key, encoded(value[key], seen)]));
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return properties;
  return { $type: "nonplain", constructor: value.constructor?.name || null, properties };
}

function rejected(operation, runId, reason) {
  return {
    status: "rejected",
    operation,
    ...(typeof runId === "string" && RUN_ID.test(runId) ? { runId } : {}),
    reason,
  };
}

function unknown(operation, runId, title, sessionId, stage, outcome) {
  return {
    status: "unknown",
    operation,
    runId,
    title,
    ...(sessionId ? { sessionId } : {}),
    stage,
    outcome,
  };
}

function returnedOutcome(result) {
  if (result && typeof result === "object" && result.error !== undefined) return encoded(result.error);
  return encoded(result);
}

export function createBackgroundTool(input = {}) {
  const client = input.client;
  const projectId = input.project?.id;
  const capturedDirectory = input.directory;
  const capturedWorktree = input.worktree;
  const inFlight = new Map();
  const uncertain = new Map();

  async function operate(operation, runId, request, decision, title) {
    let listed;
    try {
      listed = await client.session.list({ query: { directory: capturedDirectory } });
    } catch (error) {
      return unknown(operation, runId, title, null, "list", String(error));
    }
    if (!listed || typeof listed !== "object" || listed.error !== undefined || !Array.isArray(listed.data)
      || listed.data.some((session) => !session || typeof session !== "object"
        || typeof session.id !== "string" || session.id.length === 0 || typeof session.title !== "string")) {
      return unknown(operation, runId, title, null, "list", returnedOutcome(listed));
    }
    const sessionIds = listed.data.filter((session) => session.title === title).map((session) => session.id);
    if (operation === "start" && sessionIds.length > 0) {
      return { status: "existing", operation, runId, title, sessionIds };
    }
    if (operation === "answer" && sessionIds.length === 0) {
      return { status: "not_backgrounded", operation, runId, title };
    }
    if (operation === "answer" && sessionIds.length > 1) {
      return { status: "ambiguous", operation, runId, title, sessionIds };
    }

    let sessionId = sessionIds[0];
    if (operation === "start") {
      let created;
      try {
        created = await client.session.create({
          query: { directory: capturedDirectory },
          body: { title },
        });
      } catch (error) {
        return unknown(operation, runId, title, null, "create", String(error));
      }
      if (!created || typeof created !== "object" || created.error !== undefined
        || !created.data || typeof created.data !== "object"
        || typeof created.data.id !== "string" || created.data.id.length === 0) {
        return unknown(operation, runId, title, null, "create", returnedOutcome(created));
      }
      sessionId = created.data.id;
    }

    const controlText = `Drive exactly one feature-factory run as the bounded run-orchestrator. Load and follow the feature skill. The expected canonical run ID is "${runId}". The captured host worktree is "${capturedWorktree}". Independently derive the same run ID before any factory command, then enter existing Step 0. This session alone initializes or resumes the run, owns factory commands, claims and releases its lock, and continues from status.next/nextAction. Treat the next text part as the unchanged invocation request.`;
    const parts = operation === "start"
      ? [{ type: "text", text: controlText }, { type: "text", text: request }]
      : [{ type: "text", text: decision }];
    let prompted;
    try {
      prompted = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: capturedDirectory },
        body: { agent: "run-orchestrator", parts },
      });
    } catch (error) {
      return unknown(operation, runId, title, sessionId, "prompt_async", String(error));
    }
    if (!prompted || typeof prompted !== "object" || prompted.error !== undefined
      || !prompted.response || prompted.response.status !== 204) {
      return unknown(operation, runId, title, sessionId, "prompt_async", returnedOutcome(prompted));
    }
    return { status: "dispatched", operation, runId, title, sessionId };
  }

  // A plain object, not the `tool()` helper. That helper is a pass-through which only shapes types,
  // and reaching it meant depending on `@opencode-ai/plugin` — pinned at 1.17.13 against a host
  // running 1.18.11, the same package whose SDK at that version is missing endpoints the 1.18.11
  // server has. A dependency that can drift from the host, to import a function that returns its
  // argument, and which `pack.test.js` then has to police in the packed graph.
  //
  // Measured on the running host: an object literal with plain descriptors is accepted, and an agent
  // passes enum and optional parameters through it unchanged —
  //   ⚙ probe_enum_args {"operation":"start","runId":"210","request":"hello world"}
  //   received:         {"operation":"start","runId":"210","request":"hello world"}
  //
  // Nothing is lost by dropping the schemas, because `execute` below validates every argument itself:
  // the run id against RUN_ID, the request's emptiness, the decision grammar, and the operation. The
  // schema described parameters to the model; it never enforced them.
  return {
    description: "Start a feature-factory run in its scoped background session or answer its pending gate.",
    args: {
      operation: { type: "string", enum: ["start", "answer"], description: "start a background run, or answer its pending gate" },
      runId: { type: "string", description: "the run id" },
      request: { type: "string", description: "for start: the complete /feature request, forwarded unchanged" },
      decision: { type: "string", description: "for answer: approve, stop, or changes: <feedback>" },
    },
    async execute(args, context) {
      const operation = args?.operation;
      const runId = args?.runId;
      let reason = null;
      if (typeof runId !== "string" || !RUN_ID.test(runId)) reason = "invalid_run_id";
      else if (operation === "start" && (typeof args.request !== "string" || args.request.trim().length === 0)) {
        reason = "missing_request";
      } else if (operation === "answer" && !(args.decision === "approve" || args.decision === "stop"
        || (typeof args.decision === "string" && args.decision.startsWith("changes: ")
          && args.decision.slice("changes: ".length).trim().length > 0))) {
        reason = "invalid_decision";
      } else if (operation !== "start" && operation !== "answer") reason = "invalid_operation";
      else if (typeof projectId !== "string" || projectId.length === 0
        || typeof capturedDirectory !== "string" || capturedDirectory.length === 0
        || typeof capturedWorktree !== "string" || capturedWorktree.length === 0) reason = "invalid_plugin_scope";
      else if (!BACKGROUND_CALLER_AGENTS.includes(context?.agent)) reason = "unauthorized_agent";
      else if (context.directory !== capturedDirectory) reason = "directory_mismatch";
      else if (context.worktree !== capturedWorktree) reason = "worktree_mismatch";
      if (reason) return JSON.stringify(rejected(operation, runId, reason));

      const key = `${projectId}\0${capturedDirectory}\0${capturedWorktree}\0${runId}`;
      const active = inFlight.get(key);
      if (active) {
        if (operation !== "start" || active.operation !== "start") {
          return JSON.stringify(rejected(operation, runId, "operation_in_flight"));
        }
        return JSON.stringify(await active.promise);
      }
      const prior = uncertain.get(key);
      if (prior?.messageId === context.messageID) return JSON.stringify(prior.result);
      if (prior) uncertain.delete(key);

      const title = `feature-factory:${runId}@${Buffer.from(capturedWorktree, "utf8").toString("base64url")}`;
      const promise = operate(operation, runId, args.request, args.decision, title);
      inFlight.set(key, { operation, promise });
      try {
        const result = await promise;
        if (result.status === "unknown") uncertain.set(key, { messageId: context.messageID, result });
        return JSON.stringify(result);
      } finally {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      }
    },
  };
}

// The installed factory package's directory and the CLI inside it. Resolved through its one export rather
// than a `./package.json` entry, so the factory's public surface stays a single module.
//
// `cli` exists because a driver that has to find the CLI itself will find the wrong one. Resuming a run
// through this adapter, a driver tried `feature-factory factory --help`, got `command not found` for the
// package name, and escalated to `npx --package opencode-feature-factory` -- which fetched a version
// published before the rename, with its own command set and its own state store. It initialized a fresh run
// there and presented a gate for it while the real manifest sat untouched. The Prime adapter's
// `factoryResources` has always named this path; this is the same thing, and the resolver is injectable for
// the same reason: so a test can assert the exact path without depending on where the host installed it.
export function factoryResources(resolve) {
  // The literal `createRequire(import.meta.url).resolve("feature-factory")` shape appears exactly once,
  // because the package boundary test admits exactly that one call and nothing else. Injecting the resolver
  // as a default parameter looked tidier and tripped it -- correctly, since a defaulted resolver is a second
  // way to reach the module system.
  const entry = resolve ? resolve("feature-factory") : createRequire(import.meta.url).resolve("feature-factory");
  const root = dirname(dirname(entry));
  return { root, cli: join(root, "bin", "factory.js") };
}

// The one statement of how the CLI is invoked, composed after whatever prompt was selected. It is appended
// rather than embedded because both agent prompts are overridable: a project or profile `prompt` replaces the
// default wholesale, and an embedded binding would vanish with it -- reopening the command inference and
// registry fetch this exists to close. Composed last, it survives every supported override.
export function cliBinding(cli) {
  return `Every \`factory\` command runs as \`node ${cli}\`, the CLI this adapter resolved and shipped against. `
    + "Bind that one invocation before any factory command and use nothing else. Do not resolve `factory` from PATH, "
    + "and never obtain the CLI with `npx`, `npm exec`, `pnpm dlx`, or `bunx`: a fetched CLI can be a different "
    + "generation of this tool with its own state store, and it answers confidently about a run that is not this one. "
    + "If that path is not readable, stop without effects rather than substituting another resolution.";
}

function factoryRoot() {
  return factoryResources().root;
}

function integrationRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
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
    // Enforcement, not instruction, and this one was earned. `external_directory` ships as
    // `{"*": "ask"}`, and a headless `opencode run` has nobody to answer an ask -- run 1551 stopped
    // mid-step for an hour while `work-reviewer` waited on
    // `~/.asdf/installs/.../node_modules/feature-factory/*`. It wanted the *installed* package, which
    // is the read CLAUDE.md forbids in the first line of its read-scope rule: that copy is what
    // shipped last week, not what the run is changing, so a reviewer judging against it can approve a
    // tree it never read. Instruction did not hold -- the agent went looking anyway -- and the
    // failure is silent, so it is denied here.
    external_directory: "deny",
  };
}

const ORCHESTRATOR = {
  description: "Primary orchestrator for the durable feature-factory workflow. Drives a feature from "
    + "idea to draft PR through the /feature skill. Persisted run mode is the sole gate authority.",
  mode: "primary",
  // The active run driver delegates and changes durable state only through factory commands.
  permission: { edit: "allow", bash: "allow", webfetch: "allow", task: "allow", external_directory: "deny" },
  prompt: [
    "You are the feature-factory orchestrator. Follow the loaded `feature` skill exactly: it is the authority on the chain, gates, admission, run-ID derivation, and which commands are yours. Every state change goes through a `factory` command; never hand-write run.json. Re-derive evidence yourself rather than trusting agent prose.",
    "Apply outer background admission before mode admission. Only a case-sensitive exact `--background` first non-whitespace token is the selector. It must have at least one separator; consume the token and exactly one separator character and preserve every remaining code unit as the inner request. A later, repeated, near-miss, differently-cased, punctuated, or mode-preceded background token is request content. Empty or whitespace foreground input and a foreground request containing only repeated identical leading modes return `missing /feature request; no run created.` before effects. An outer selector with no non-mode request returns `missing /feature request after --background; no session or run created.` before effects. Conflicting inner or foreground mode prefixes use the existing exact conflict response before effects.",
    "Apply the loaded skill's maximal mode-prefix algorithm to a derivation copy while forwarding admitted bytes unchanged: only exact standalone leading `--autonomous` and `--headless` tokens select a noninteractive mode, identical repeats are idempotent, and request prose never selects mode. Background is placement, never a mode. Persisted `run.json.mode` is immutable and is the sole gate authority on resume.",
    "Before a background tool call, derive one canonical run ID by the skill's shared policy after inner mode admission. Classify only on a trimmed copy. Whole-candidate `N`, `#N`, or canonical `https://github.com/<owner>/<repo>/issues/N` require positive N, no query, fragment, trailing path, or extra token, read-only repository and issue resolution, and matching invocation repository; failures return `unresolvable issue reference: <unchanged reference>`, while success uses canonical decimal N without leading zeros. Otherwise collect distinct standalone case-insensitive ticket keys matching `[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*` bounded by non-ASCII-alphanumeric, count repeated identical keys once, lowercase one key, and reject multiple request keys as `ambiguous ticket keys: <sorted lowercase keys>; no session or run created.` Apply the same key rule to the current branch and reject multiple as `ambiguous branch ticket keys: <sorted lowercase keys>; no session or run created.` With no key, free text uses NFKD, removes combining marks, lowercases, replaces maximal non-`[a-z0-9]` sequences with `-`, and strips edge dashes. A final invalid or empty ID returns `cannot derive a canonical run id; no session or run created.` All these rejections occur before tool, client, manifest, factory, lock, task, sandbox, or worktree effects.",
    "For admitted background start, do not inspect or initialize a manifest, run a factory command, claim a lock, dispatch a specialist, create isolation, or drive a stage. Call only `feature_background` with operation `start`, the canonical run ID, and the unchanged inner request. Treat `dispatched` as asynchronous admission only, never execution or completion; return immediately so this conversation remains usable. An `existing`, rejected, ambiguous, not-backgrounded, or unknown result is reported exactly and is never automatically retried.",
    "Route a background gate answer only from either explicit `<canonical-run-id> approve`, `<canonical-run-id> stop`, or `<canonical-run-id> changes: <verbatim feedback>`, or a bare allowed decision when this conversation contains exactly one prior scoped background tool result identifying one run. Explicit ID takes precedence. Preserve the decision bytes unchanged. Invalid decisions return `invalid gate answer: expected exactly approve, changes: <feedback>, or stop; no run changed.` Missing or ambiguous context returns `cannot route gate answer: provide one canonical run id or use a conversation with exactly one prior background tool result.` Call only `feature_background` operation `answer`; never mutate locally, dispatch a fresh child, use delivery, steer, queue, wait, or treat admittedSeq as execution proof.",
    "Foreground requests retain the existing workflow. In `interactive`, persist and present the pending gate and wait for a real human. In `headless`, preserve parked top-level `needs-human`; inability to ask never turns it into an interactive pending gate or autonomous decision. In `autonomous`, decide only when the existing preconditions authorize the decision and continue toward a draft PR. Top-level `needs-human` is parked and resumable, not final. Resume only in this order after fixing the external cause: select and bind the retained sandbox and complete every existing pre-lock check; claim or perform a justified steal and verify the fresh owner and unchanged parked result; explicitly run `factory resume` and verify running status, unchanged historical result, real next action, and the same fresh owner; replay only existing post-lock reconciliation and safety checks; continue solely from newly qualified `status.next`. Never auto-clear or continue from `terminal_result.reason`; this plugin is read-only and never clears state.",
  ].join("\n\n"),
};

// The eleven specialists a run driver dispatches. Named here rather than derived from the agents
// directory because the grant must be a closed list: a new file appearing under `agents/` should not
// silently widen who a child may invoke.
const CHILD_TASK_TARGETS = Object.freeze([
  "story-reader", "story-writer", "codebase-researcher", "design-interpreter", "spec-writer",
  "work-decomposer", "work-reviewer", "test-verifier", "implementation-validator",
  "backend-builder", "frontend-builder",
]);

const RUN_ORCHESTRATOR_TARGET_POLICY = [
  "For this OpenCode background driver, the host's flat `task: \"allow\"` makes the task tool available but does not enforce target names.",
  `The exact eleven-target list and its exclusions are prompt/skill policy: dispatch only these eleven specialists: ${CHILD_TASK_TARGETS.map((name) => `\`${name}\``).join(", ")}.`,
  "This child must not dispatch itself, `feature-factory`, another `run-orchestrator`, or any arbitrary project-owned agent. It may observe builders it dispatched; builders never observe themselves.",
].join(" ");

const RUN_ORCHESTRATOR = {
  description: "Config-only feature-factory run driver. Drives exactly one durable run under its persisted mode.",
  mode: "subagent",
  // Flat task allow is required for task-tool availability. The host does not enforce target names;
  // the exact eleven names and exclusions are prompt/skill policy.
  permission: {
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    task: "allow",
    // The drivers are denied too: a driver reading the installed package is the same false green as a
    // reviewer doing it, and the deny composes with `--auto`, which cannot approve an explicit deny.
    external_directory: "deny",
  },
  prompt: [
    "You are the bounded run-orchestrator for exactly one background feature-factory session. Load and follow the existing `feature` skill exactly. A start turn contains the tool's control text followed by one unchanged invocation-request text part. A later answer turn in this same session contains exactly one unchanged decision text part and no request framing.",
    "Before the first factory command, apply the skill's maximal exact-leading-token inner mode admission to a derivation copy of the unchanged request, then independently apply the shared issue, ticket, branch, and free-text run-ID policy. The request part is already the admitted inner request, so a later or repeated `--background` token remains request content. Require exact equality with the expected canonical run ID in the control text and stop before initialization, lock, or factory effects on mismatch. For fresh initialization, only exact standalone leading `--autonomous` and `--headless` tokens select those modes, identical repeats are idempotent, and request prose never selects mode. Background is not a mode. On resume, persisted `run.json.mode` is immutable and authoritative.",
    "Enter the existing Step 0 unchanged. Select or resume only the deterministic existing sandbox path `O/.factory-sandboxes/<R>`; never initialize another path, invent isolation, create another orchestration layer, or hand-write `run.json`.",
    "Use this session's real `FACTORY_SESSION_ID` as `SESSION_ID` for every claim, heartbeat, release, and later resume. Read durable state through `factory status \"$R\" --json --repo \"$RUN_REPO\"`, claim through existing Step 0, and continue only from `status.next`/`nextAction`.",
    "This child owns state-changing `factory` commands for its run.",
    "Persisted-mode authority is exact. In `interactive`, perform the orderly pending-gate park below, release the lock, and end this session's turn. In `headless`, preserve parked top-level `needs-human`; do not masquerade as an interactive pending gate. In `autonomous`, decide only under the existing autonomous preconditions and continue through existing Step 7 toward a draft PR. Inability to ask never promotes `interactive` or `headless` to `autonomous`. Top-level `needs-human` is parked and resumable, not final. Resume only in this order after fixing the external cause: select and bind the retained sandbox and complete every existing pre-lock check; claim or perform a justified steal and verify the fresh owner and unchanged parked result; explicitly run `factory resume` and verify running status, unchanged historical result, real next action, and the same fresh owner; replay only existing post-lock reconciliation and safety checks; continue solely from newly qualified `status.next`. Never auto-clear or continue from `terminal_result.reason`; this plugin is read-only and never clears state.",
    "Use this exact gate artifact map: Story gate `story` -> `artifacts/story.md`; Brief gate `brief` -> `artifacts/technical-brief.md`; Pre-PR gate `pre_pr` -> `gates/pre_pr.md`. Those references are run-relative and stored verbatim, so a run-relative reference `X` is physically `$RUN_REPO/.factory/$R/X`: create and read every artifact there and pass only the run-relative reference. Writing an artifact to the repository root instead dirties the integration worktree and parks the run at post-merge verify.",
    "Before every Gate 3 presentation, write or refresh `.factory/$R/gates/pre_pr.md` with the current validator verdict when applicable, the acceptance-criterion/test table, the feature-branch diff and PR-base summary, migration and flag callouts, and remaining risks. Then open Gate 3 with `factory gate \"$R\" pre_pr pending --artifact gates/pre_pr.md --repo \"$RUN_REPO\"`.",
    "For an interactive background session, an orderly pending-gate park is complete only after you await every in-flight specialized task call and stop heartbeat calls; select `ARTIFACT` from the exact map and verify it exists at `$RUN_REPO/.factory/$R/$ARTIFACT`, refreshing `.factory/$R/gates/pre_pr.md` before Pre-PR; persist the pending gate with `factory gate \"$R\" \"$GATE\" pending --artifact \"$ARTIFACT\" --repo \"$RUN_REPO\"`; directly verify the artifact still exists, the manifest records the named gate pending with `ARTIFACT`, and qualified status reports it pending; release exactly with `factory lock \"$R\" release --session \"$SESSION_ID\" --repo \"$RUN_REPO\"`; and rerun qualified status to verify that session no longer holds the lock.",
    "A successful interactive park returns text containing exactly:\nRun: <R>\nRun repository: <RUN_REPO>\nOutcome: parked-pending-gate\nGate: <GATE>\nArtifact: <run-relative ARTIFACT>\nStatus: pending",
    "If release fails or qualified status still reports this session's lock, return:\nRun: <R>\nRun repository: <RUN_REPO>\nOutcome: retained-lock-error\nGate: <GATE>\nArtifact: <run-relative ARTIFACT>\nStatus: pending\nLock: retained\nError: <actual error>\nDo not claim success or park. Crash recovery remains outside this flow.",
    "After a parked pending gate, accept in this same session only one sole-part decision exactly equal to `approve`, `stop`, or `changes: <verbatim feedback>` with non-whitespace feedback. Refuse every other answer before mutation. Do not infer a run or gate from delivery metadata, use steer or queue behavior, or treat admittedSeq as proof that a prompt executed.",
    "Before decision mutation, status this session's existing run and selected repository, verify a nonterminal persisted mode `interactive` run with exactly one pending gate, claim with this same `FACTORY_SESSION_ID` using `factory lock \"$R\" claim --session \"$SESSION_ID\" --repo \"$RUN_REPO\"`, then repeat qualified status verification. Refuse an early, mismatched, terminal, non-pending, multiple-pending, conflicting-lock, `headless`, or `autonomous` injection without gate mutation. If refusal follows claim, release this session first with `factory lock \"$R\" release --session \"$SESSION_ID\" --repo \"$RUN_REPO\"` and verify unlock.",
    "Map `approve` to `factory gate \"$R\" \"$GATE\" approved --repo \"$RUN_REPO\"`. Map `changes: <feedback>` to `factory gate \"$R\" \"$GATE\" changes --repo \"$RUN_REPO\"`; keep feedback verbatim in task context, add no run key, follow `changes-at-gate:<name>`, revise only the affected stage, and re-present pending.",
    "Map `stop` to `factory gate \"$R\" \"$GATE\" stop --repo \"$RUN_REPO\"`; require qualified status `next: stopped-at-gate:<GATE>`, await in-flight work, stop heartbeat calls, release this session with `factory lock \"$R\" release --session \"$SESSION_ID\" --repo \"$RUN_REPO\"`, and verify it is unlocked. Return run, repository, `Outcome: stopped-at-gate`, gate, and `Status: stop`. The gate stop ends orchestration: do not terminalize it or invite another resume. A release failure uses the retained-lock-error contract.",
    "For approved and changes paths, reread qualified status and resume solely from `status.next`. Never initialize a replacement or repeat completed stages except the intentional changes loop. When the next interactive gate parks, persist it and release this same session's lock again.",
    "Final and parked reporting follows the skill. `headless` uses existing parked top-level `needs-human` with reason `headless run reached a human gate` and retention rules. `autonomous` follows existing draft-PR and Step 7 behavior. An interactive `stop` remains unlocked and nonterminal at `stopped-at-gate:<name>` and retains the selected run repository. Blocked, partial, and needs-human retain selected sandbox status and repository. After Step 7 archives or removes a completed sandbox, query and report the canonical post-completion repository selected by Step 7, never a stale sandbox. Report only existing status, terminal result, and PR URL; add no durable fields. Top-level `needs-human` is parked and resumable, not final. Resume only in this order after fixing the external cause: select and bind the retained sandbox and complete every existing pre-lock check; claim or perform a justified steal and verify the fresh owner and unchanged parked result; explicitly run `factory resume` and verify running status, unchanged historical result, real next action, and the same fresh owner; replay only existing post-lock reconciliation and safety checks; continue solely from newly qualified `status.next`. Never auto-clear or continue from `terminal_result.reason`; this plugin is read-only and never clears state.",
  ].join("\n\n"),
};

export function registerAgents(cfg, { root = factoryRoot(), ...options } = {}) {
  cfg.agent ??= {};
  // The orchestrator has no frontmatter file, so its tier is stated here: the deep model, since it
  // holds the whole chain and every gate decision.
  const cli = options.cli ?? join(root, "bin", "factory.js");
  const orchestratorProfile = profileFor("feature-factory", "planning", options) ?? {};
  const orchestratorProject = cfg.agent["feature-factory"] ?? {};
  // Read before the spreads and composed after them. A project or profile `prompt` is a supported override, so
  // a binding written before it is a binding that override deletes.
  const selectedOrchestratorPrompt = Object.hasOwn(orchestratorProject, "prompt") ? orchestratorProject.prompt
    : Object.hasOwn(orchestratorProfile, "prompt") ? orchestratorProfile.prompt : ORCHESTRATOR.prompt;
  cfg.agent["feature-factory"] = {
    ...ORCHESTRATOR,
    // The orchestrator has no frontmatter file, so its role is named here: it plans.
    variant: "xhigh",
    ...orchestratorProfile,
    ...orchestratorProject,
    prompt: `${selectedOrchestratorPrompt}\n\n${cliBinding(cli)}`,
    permission: { ...(orchestratorProject.permission ?? {}), ...ORCHESTRATOR.permission },
  };
  const runOrchestratorProfile = profileFor("run-orchestrator", "planning", options) ?? {};
  const runOrchestratorProject = cfg.agent["run-orchestrator"] ?? {};
  const selectedRunOrchestratorPrompt = Object.hasOwn(runOrchestratorProject, "prompt")
    ? runOrchestratorProject.prompt : runOrchestratorProfile.prompt;
  // One composition for both the custom and the default prompt: selected text, then the host-owned CLI
  // binding, then the target policy last and exactly once.
  const selectedChildBase = typeof selectedRunOrchestratorPrompt === "string"
    ? selectedRunOrchestratorPrompt : RUN_ORCHESTRATOR.prompt;
  const runOrchestratorPrompt = `${selectedChildBase}\n\n${cliBinding(cli)}\n\n${RUN_ORCHESTRATOR_TARGET_POLICY}`;
  cfg.agent["run-orchestrator"] = {
    ...RUN_ORCHESTRATOR,
    variant: "xhigh",
    ...runOrchestratorProfile,
    ...runOrchestratorProject,
    mode: "subagent",
    prompt: runOrchestratorPrompt,
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
export function registerSkill(cfg, { root = integrationRoot() } = {}) {
  cfg.skills ??= {};
  cfg.skills.paths ??= [];
  const path = join(root, "skills");
  if (!cfg.skills.paths.includes(path)) cfg.skills.paths.push(path);
  return path;
}

export function registerCommand(cfg, { cli = factoryResources().cli } = {}) {
  cfg.command ??= {};
  cfg.command.feature = {
    description: "Take a feature, ticket or idea end to end: story, spec, decomposition, parallel "
      + "build, integration, gates, draft PR. Syntax: /feature [--background] [--autonomous | --headless] "
      + "<ticket key | feature idea>; no mode flag is interactive.",
    agent: "feature-factory",
    template: [
      "Load the `feature` skill and run it as the primary orchestrator for this invocation.",
      "Request: $ARGUMENTS",
      "Before effects, apply the skill's outer admission. Only exact case-sensitive `--background` as the first non-whitespace token selects background placement. Require a separator, consume exactly one separator character, and preserve every remaining inner code unit. Any later, repeated, near-miss, differently-cased, punctuated, or mode-preceded background token is request content.",
      "Apply maximal exact-leading-token mode admission to a copy of the admitted request; preserve forwarded bytes unchanged. Exact repeated identical `--autonomous` or `--headless` prefixes are idempotent; both modes conflict; mode-only input is missing. Background is never a mode, and persisted `run.json.mode` remains the sole gate authority.",
      "Reject empty, whitespace, or foreground mode-only input before effects with `missing /feature request; no run created.` Reject background input with no non-mode request before effects with `missing /feature request after --background; no session or run created.` Use the existing exact mode-conflict response. Do not call the tool or client and do not inspect or initialize a manifest, call factory, claim a lock, dispatch a task, create a sandbox, or drive a stage for any rejected input.",
      "For background start, derive the canonical run ID before effects with the skill's shared issue, ticket, branch, and NFKD free-text policy. Preserve the inner request unchanged. Reject unresolvable issue references, ambiguous request or branch ticket keys, and an invalid or empty final ID with the skill's exact responses. Then invoke only `feature_background` operation `start` with that run ID and unchanged inner request. Return immediately after `dispatched`; HTTP 204 means admission only, not execution or completion. Report `existing`, `rejected`, or `unknown` without automatic retry.",
      "For a gate answer, accept only explicit `<canonical-run-id> approve`, `<canonical-run-id> stop`, or `<canonical-run-id> changes: <verbatim feedback>`, or a bare allowed decision with exactly one prior scoped background tool result in this conversation. Explicit ID takes precedence. Invoke only `feature_background` operation `answer` with the exact decision bytes. Invalid or ambiguous routing is mutation-free. Never dispatch a fresh child, mutate a gate locally, use delivery, steer, queue, wait, or treat admittedSeq as execution proof.",
      "For a foreground request, persist state through `factory` commands, route work to the specialized agents the skill names, and observe evidence yourself. Persisted `run.json.mode` is the sole gate authority: `interactive` persists and presents a pending gate and waits for a real human; `headless` preserves parked top-level `needs-human`; `autonomous` decides only when existing preconditions authorize and continues toward a draft PR. Inability to ask never changes the persisted mode. Top-level `needs-human` is parked and resumable, not final. Resume only in this order after fixing the external cause: select and bind the retained sandbox and complete every existing pre-lock check; claim or perform a justified steal and verify the fresh owner and unchanged parked result; explicitly run `factory resume` and verify running status, unchanged historical result, real next action, and the same fresh owner; replay only existing post-lock reconciliation and safety checks; continue solely from newly qualified `status.next`. Never auto-clear or continue from `terminal_result.reason`; this plugin is read-only and never clears state.",
    ].join("\n\n") + `\n\n${cliBinding(cli)}`,
  };
}

// One call for the host's `config` hook.
export function registerWorkflow(cfg, options = {}) {
  const root = options.root ?? factoryRoot();
  const cli = options.cli ?? join(root, "bin", "factory.js");
  registerCommand(cfg, { cli });
  const skill = registerSkill(cfg, { root: options.skillRoot ?? integrationRoot() });
  const agents = registerAgents(cfg, { root, ...options, cli });
  return { root, skill, agents };
}
