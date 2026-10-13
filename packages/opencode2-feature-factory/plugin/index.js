// OpenCode 2.0 integration for feature-factory. Read-only toward run state, by contract.
//
// The plugin registers the workflow with the host and writes nothing: the `/feature` command, the
// `feature` skill, the orchestrator and the eleven specialists, a context tool, and the background tool.
// Every run state change goes through the `factory` CLI, driven by the agents this registers.
//
// A plain `{ id, setup }` object rather than `Plugin.define(...)`: in 2.0 `define` returns its argument,
// and importing it would make `@opencode/plugin` a runtime dependency that can drift from the host.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinitions, cliBinding } from "./agents.js";
import { createBackgroundTool } from "./background.js";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_PATH = join(here, "skills", "feature", "SKILL.md");

// The installed factory package and its CLI, resolved through the factory's one export. A driver that
// has to find the CLI itself finds the wrong one.
export function factoryResources(resolve) {
  const entry = resolve ? resolve("feature-factory") : createRequire(import.meta.url).resolve("feature-factory");
  const root = dirname(dirname(entry));
  return { root, cli: join(root, "bin", "factory.js") };
}

// V2 domain reads return `{ location, data }`; tolerate a bare array too.
const rows = (value) => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []);

export function commandText(request, cli) {
  return [
    "Load the `feature` skill and run it as the primary orchestrator for this invocation.",
    `Request: ${request}`,
    "Apply the skill's admission before any effect: outer `--background` placement, then maximal exact-leading-token mode admission. Persisted `run.json.mode` is the sole gate authority.",
    cliBinding(cli),
  ].join("\n\n");
}

export function contextTool({ cli }) {
  return {
    name: "feature_factory_context",
    description: "Report this feature-factory session's id, the calling agent, and the factory CLI path.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      return { content: JSON.stringify({ sessionID: context.sessionID, agent: context.agent, cli, skill: SKILL_PATH }) };
    },
  };
}

export default {
  id: "feature-factory",
  async setup(ctx) {
    const { root, cli } = factoryResources();
    const definitions = agentDefinitions({ root, cli, options: ctx.options ?? {} });

    // `update` on an id the host does not hold creates the agent. That is how 2.0 registers an agent from
    // a plugin, since the editor has no `add`; it is verified below rather than trusted.
    await ctx.agent.transform((editor) => {
      for (const [id, definition] of agentDefinitions({ root, cli, options: ctx.options ?? {}, existing: (name) => editor.get(name) })) {
        editor.update(id, (draft) => Object.assign(draft, definition));
      }
    });
    const registered = new Set(rows(await ctx.agent.list()).map((agent) => agent.id ?? agent.name));
    const missing = [...definitions.keys()].filter((id) => !registered.has(id));
    if (missing.length) throw new Error(`feature-factory: the host did not register agents ${missing.join(", ")}; this OpenCode version is unsupported`);

    await ctx.skill.transform((editor) => {
      editor.add({
        id: "feature", name: "feature",
        description: "Take a feature, ticket or idea end to end through the durable feature-factory workflow.",
        path: SKILL_PATH,
        content: readFileSync(SKILL_PATH, "utf8"),
      });
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: "feature",
        description: "Take a feature, ticket or idea end to end: story, spec, decomposition, build, gates, PR. "
          + "Syntax: /feature [--background] [--autonomous | --headless] <ticket key | feature idea>.",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchAgent({ sessionID, agent: "feature-factory" });
          await ctx.session.prompt({ ...prompt, sessionID, text: commandText(prompt?.text ?? "", cli), delivery });
        },
      });
    });

    await ctx.tool.transform((editor) => {
      editor.add(contextTool({ cli }));
      editor.add(createBackgroundTool(ctx));
    });
  },
};
