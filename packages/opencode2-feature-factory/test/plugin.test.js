// The OpenCode 2.0 server plugin, against a fake host with the domain surfaces a live 2.0.28 host showed:
// transforms whose `update` creates an agent the host does not hold, `list()` answering `{ location, data }`,
// plugin storage, and a session domain with no `list`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import plugin, { commandText, factoryResources } from "../plugin/index.js";
import { SPECIALISTS, agentDefinitions, modelRef, resolvedModel } from "../plugin/agents.js";
import { rejection } from "../plugin/background.js";
import { runCommands } from "../tui/commands.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { root, cli } = factoryResources();
const BUILTIN = ["build", "general", "explore", "plan"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id }));
const MODELS = [
  { providerID: "opencode", id: "house", variants: EFFORTS },
  { providerID: "anthropic", id: "claude-sonnet-5", variants: EFFORTS },
  { providerID: "acme", id: "big", variants: [{ id: "fast" }] },
];

function fakeHost({ createsOnUpdate = true, existing = {} } = {}) {
  let created = 0;
  const state = {
    agents: new Map([...BUILTIN.map((id) => [id, { id, name: id, mode: "primary" }]), ...Object.entries(existing)]),
    skills: [], commands: [], tools: [], storage: new Map(), sessions: new Map(), prompts: [], switched: [],
  };
  const ctx = {
    location: { directory: "/work/repo" },
    options: {},
    model: { list: async () => ({ data: MODELS }), default: async () => ({ data: MODELS[0] }) },
    agent: {
      transform: async (edit) => edit({
        get: (id) => state.agents.get(id),
        update: (id, apply) => {
          const draft = state.agents.get(id) ?? (createsOnUpdate ? { id, name: id, mode: "primary", permissions: [] } : null);
          if (!draft) return;
          apply(draft);
          state.agents.set(id, draft);
        },
      }),
      list: async () => ({ location: ctx.location, data: [...state.agents.values()] }),
    },
    skill: { transform: async (edit) => edit({ add: (skill) => state.skills.push(skill) }) },
    command: { transform: async (edit) => edit({ add: (command) => state.commands.push(command) }) },
    tool: { transform: async (edit) => edit({ add: (tool) => state.tools.push(tool) }) },
    storage: { get: async (key) => state.storage.get(key), set: async (key, value) => { state.storage.set(key, value); } },
    session: {
      create: async ({ title }) => {
        const id = `ses_${++created}`;
        state.sessions.set(id, { id, title });
        return { id, title };
      },
      get: async ({ sessionID }) => {
        if (!state.sessions.has(sessionID)) throw Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID });
        return { data: state.sessions.get(sessionID) };
      },
      remove: async ({ sessionID }) => { state.sessions.delete(sessionID); state.removed = [...(state.removed ?? []), sessionID]; },
      switchAgent: async (input) => { state.switched.push(input); },
      prompt: async (input) => { state.prompts.push(input); return { id: "msg_1" }; },
    },
  };
  return { ctx, state };
}

const tool = (state, name) => state.tools.find((entry) => entry.name === name);
const call = async (state, name, input, context) => JSON.parse((await tool(state, name).execute(input, context)).content);

describe("OpenCode 2.0 plugin", () => {
  it("registers the workflow: thirteen agents with derived permissions, the command, the skill, and both tools", async () => {
    const { ctx, state } = fakeHost();
    await plugin.setup(ctx);
    assert.equal(plugin.id, "feature-factory");

    const ours = ["feature-factory", "run-orchestrator", ...SPECIALISTS];
    for (const id of ours) assert.ok(state.agents.has(id), `agent ${id} is registered`);
    const agent = (id) => state.agents.get(id);
    const effect = (id, action, resource = "*") => agent(id).permissions.filter((rule) => rule.action === action && rule.resource === resource).at(-1)?.effect;
    assert.deepEqual([agent("feature-factory").mode, agent("run-orchestrator").mode, agent("work-reviewer").mode], ["primary", "subagent", "subagent"]);
    // Who may edit comes from each agent's declared tools: the judge may not change what it judges.
    assert.deepEqual([effect("work-reviewer", "edit"), effect("implementation-validator", "edit"), effect("backend-builder", "edit")], ["deny", "deny", "allow"]);
    for (const id of ours) {
      assert.equal(effect(id, "external_directory"), "deny", `${id} may not read outside the workspace`);
      assert.match(agent(id).system, new RegExp(`runs as \`node ${cli.replaceAll("/", "\\/")}\``, "u"), `${id} carries the CLI binding`);
    }
    // The driver's closed target list is enforced: deny every subagent, then allow exactly the eleven.
    for (const driver of ["feature-factory", "run-orchestrator"]) {
      assert.equal(effect(driver, "subagent"), "deny");
      assert.deepEqual(agent(driver).permissions.filter((rule) => rule.action === "subagent" && rule.effect === "allow").map((rule) => rule.resource), SPECIALISTS);
    }
    for (const id of SPECIALISTS) assert.equal(effect(id, "subagent"), "deny", `${id} may not delegate`);

    assert.deepEqual(state.skills.map((skill) => [skill.id, skill.path]), [["feature", join(pkg, "skills", "feature", "SKILL.md")]]);
    assert.equal(state.skills[0].content, readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8"));
    assert.deepEqual(state.commands.map((command) => command.name), ["feature"]);
    assert.deepEqual(state.tools.map((entry) => entry.name).sort(), ["feature_background", "feature_factory_context"]);

    // The command runs under the orchestrator with the request and the CLI binding.
    await state.commands[0].execute({ sessionID: "ses_cmd", prompt: { text: "--autonomous #42" }, delivery: "steer" });
    assert.deepEqual(state.switched.at(-1), { sessionID: "ses_cmd", agent: "feature-factory" });
    assert.equal(state.prompts.at(-1).text, commandText("--autonomous #42", cli));
    assert.match(state.prompts.at(-1).text, /Request: --autonomous #42/u);

    // The session id a run records comes from the host, through the context tool.
    assert.deepEqual(await call(state, "feature_factory_context", {}, { sessionID: "ses_9", agent: "run-orchestrator" }),
      { sessionID: "ses_9", agent: "run-orchestrator", cli, skill: join(pkg, "skills", "feature", "SKILL.md") });
  });

  it("refuses to load on a host that does not create agents, and keeps a project's own model and prompt", async () => {
    const { ctx } = fakeHost({ createsOnUpdate: false });
    await assert.rejects(() => plugin.setup(ctx), /the host did not register agents feature-factory, run-orchestrator, .*unsupported/u);

    // A project's own definition keeps its model and prompt; permissions stay derived, and the binding is re-appended.
    const project = { id: "work-reviewer", name: "work-reviewer", system: "Project reviewer prompt.", model: { providerID: "acme", id: "big" } };
    const definitions = agentDefinitions({ root, cli, models: MODELS, existing: (id) => (id === "work-reviewer" ? project : undefined),
      options: { profiles: { builder: { model: "anthropic/claude-sonnet-5", variant: "high" } } } });
    const reviewer = definitions.get("work-reviewer");
    assert.equal(reviewer.system.startsWith("Project reviewer prompt.\n\n"), true);
    assert.deepEqual(reviewer.model, { providerID: "acme", id: "big" });
    assert.equal(reviewer.permissions.find((rule) => rule.action === "edit").effect, "deny");
    // A profile selects a model by role; a string with no provider selects nothing rather than a wrong model.
    assert.deepEqual(definitions.get("backend-builder").model, { providerID: "anthropic", id: "claude-sonnet-5", variant: "high" });
    assert.deepEqual([modelRef("sonnet"), modelRef("anthropic/"), modelRef("/x")], [undefined, undefined, undefined]);

    // Effort survives without a configured model: it attaches to the host default, which offers it.
    const house = MODELS[0];
    assert.deepEqual(resolvedModel({ profile: { variant: "high" }, effort: "medium", models: MODELS, defaultModel: house }),
      { providerID: "opencode", id: "house", variant: "high" }, "an effort-only profile applies its variant");
    assert.deepEqual(resolvedModel({ effort: "xhigh", models: MODELS, defaultModel: house }),
      { providerID: "opencode", id: "house", variant: "xhigh" }, "the declared effort applies with no profile at all");
    assert.equal(resolvedModel({ models: MODELS, defaultModel: house }), undefined, "nothing to apply leaves the agent on the default, unpinned");
    // A project's model keeps its own variant first; otherwise the profile's applies to it.
    assert.deepEqual(resolvedModel({ existing: { model: { providerID: "anthropic", id: "claude-sonnet-5" } }, profile: { variant: "max" }, effort: "low", models: MODELS }),
      { providerID: "anthropic", id: "claude-sonnet-5", variant: "max" });
    assert.deepEqual(resolvedModel({ existing: { model: { providerID: "anthropic", id: "claude-sonnet-5", variant: "low" } }, profile: { variant: "max" }, models: MODELS }),
      { providerID: "anthropic", id: "claude-sonnet-5", variant: "low" });
    // A variant the chosen model does not offer is dropped rather than sent.
    assert.deepEqual(resolvedModel({ existing: { model: { providerID: "acme", id: "big" } }, effort: "high", models: MODELS }), { providerID: "acme", id: "big" });
    const fromDefault = agentDefinitions({ root, cli, models: MODELS, defaultModel: house });
    assert.deepEqual(fromDefault.get("feature-factory").model, { providerID: "opencode", id: "house", variant: "xhigh" }, "the drivers keep their xhigh effort");
  });

  it("starts a background run once, answers its gate, and refuses everything else without effects", async () => {
    const { ctx, state } = fakeHost();
    await plugin.setup(ctx);
    const caller = { sessionID: "ses_primary", agent: "feature-factory" };
    for (const [input, context, reason] of [
      [{ operation: "start", runId: "Bad Id", request: "x" }, caller, "invalid_run_id"],
      [{ operation: "stop", runId: "42" }, caller, "invalid_operation"],
      [{ operation: "start", runId: "42", request: "  " }, caller, "missing_request"],
      [{ operation: "answer", runId: "42", decision: "yes" }, caller, "invalid_decision"],
      [{ operation: "answer", runId: "42", decision: "changes:  " }, caller, "invalid_decision"],
      [{ operation: "start", runId: "42", request: "x" }, { sessionID: "s", agent: "work-reviewer" }, "unauthorized_agent"],
    ]) {
      assert.equal(rejection(input.operation, input, context), reason);
      assert.deepEqual(await call(state, "feature_background", input, context), { status: "rejected", operation: input.operation, reason });
    }
    assert.equal(state.sessions.size, 0, "a refusal creates nothing");
    assert.deepEqual(await call(state, "feature_background", { operation: "answer", runId: "42", decision: "approve" }, caller),
      { status: "not_backgrounded", operation: "answer", runId: "42" });

    const started = await call(state, "feature_background", { operation: "start", runId: "42", request: "--autonomous #42" }, caller);
    assert.deepEqual(started, { status: "dispatched", operation: "start", runId: "42", sessionID: "ses_1" });
    assert.deepEqual(state.switched.at(-1), { sessionID: "ses_1", agent: "run-orchestrator" });
    assert.match(state.prompts.at(-1).text, /expected canonical run ID is "42"[\s\S]*--autonomous #42$/u);
    assert.deepEqual(await call(state, "feature_background", { operation: "start", runId: "42", request: "again" }, caller),
      { status: "existing", operation: "start", runId: "42", sessionID: "ses_1" });
    assert.equal(state.sessions.size, 1, "a second start creates no second session");

    assert.deepEqual(await call(state, "feature_background", { operation: "answer", runId: "42", decision: "changes: tighten AC2" }, caller),
      { status: "dispatched", operation: "answer", runId: "42", sessionID: "ses_1" });
    assert.deepEqual(state.prompts.at(-1), { sessionID: "ses_1", text: "changes: tighten AC2" }, "an answer sends the decision and nothing else");

    // A lookup the host cannot answer is unknown and changes nothing: no second session, and the answer
    // is not mistaken for a run that was never backgrounded.
    const get = ctx.session.get;
    ctx.session.get = async () => { throw new Error("service restarting"); };
    const prompts = state.prompts.length;
    for (const input of [{ operation: "start", runId: "42", request: "x" }, { operation: "answer", runId: "42", decision: "approve" }]) {
      assert.deepEqual(await call(state, "feature_background", input, caller),
        { status: "unknown", operation: input.operation, runId: "42", stage: "lookup", outcome: "service restarting" });
    }
    assert.deepEqual([state.sessions.size, state.prompts.length], [1, prompts], "a transient lookup failure creates and prompts nothing");
    ctx.session.get = get;
    assert.equal((await call(state, "feature_background", { operation: "answer", runId: "42", decision: "approve" }, caller)).sessionID, "ses_1", "the original association is kept");

    // Only the host's own not-found removes an association, so a start then creates a fresh session.
    state.sessions.delete("ses_1");
    assert.equal((await call(state, "feature_background", { operation: "start", runId: "42", request: "x" }, caller)).sessionID, "ses_2");

    // A session whose driver could not be selected is never associated: it is removed, and the next start
    // creates a working one rather than reporting an inert `existing`.
    const switchAgent = ctx.session.switchAgent;
    ctx.session.switchAgent = async () => { throw new Error("agent unavailable"); };
    assert.deepEqual(await call(state, "feature_background", { operation: "start", runId: "43", request: "x" }, caller),
      { status: "unknown", operation: "start", runId: "43", stage: "switch", sessionID: "ses_3", outcome: "agent unavailable" });
    assert.deepEqual([state.removed, state.sessions.has("ses_3")], [["ses_3"], false]);
    assert.deepEqual(await call(state, "feature_background", { operation: "answer", runId: "43", decision: "stop" }, caller),
      { status: "not_backgrounded", operation: "answer", runId: "43" }, "no decision reaches a session without its driver");
    ctx.session.switchAgent = switchAgent;

    // A start whose request was not admitted stays unstarted: an answer is refused, and the next start
    // re-admits the request to that same session instead of reporting it `existing`.
    const prompt = ctx.session.prompt;
    ctx.session.prompt = async () => { throw new Error("host down"); };
    assert.deepEqual(await call(state, "feature_background", { operation: "start", runId: "44", request: "y" }, caller),
      { status: "unknown", operation: "start", runId: "44", stage: "prompt", sessionID: "ses_4", outcome: "host down" });
    ctx.session.prompt = prompt;
    assert.deepEqual(await call(state, "feature_background", { operation: "answer", runId: "44", decision: "approve" }, caller),
      { status: "rejected", operation: "answer", runId: "44", reason: "not_started", sessionID: "ses_4" });
    assert.deepEqual(await call(state, "feature_background", { operation: "start", runId: "44", request: "y" }, caller),
      { status: "dispatched", operation: "start", runId: "44", sessionID: "ses_4" });
    assert.deepEqual(await call(state, "feature_background", { operation: "start", runId: "44", request: "y" }, caller),
      { status: "existing", operation: "start", runId: "44", sessionID: "ses_4" });
  });

  it("offers a palette jump only for runs that hold a session", () => {
    const routes = [];
    const commands = runCommands([
      { valid: true, run_id: "42", session: "ses_7", next: "gate:story" },
      { valid: true, run_id: "43", session: null },
      { valid: false, run_id: "44", session: "ses_8" },
    ], { navigate: (route) => routes.push(route) });
    assert.deepEqual(commands.map((command) => [command.id, command.title, command.palette]),
      [["feature-factory.open.42", "Feature Factory: open run 42 (next: gate:story)", true]]);
    commands[0].run();
    assert.deepEqual(routes, [{ type: "session", sessionID: "ses_7" }]);
  });
});
