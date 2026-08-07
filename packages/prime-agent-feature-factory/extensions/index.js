import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

export function factoryResources(resolve = createRequire(import.meta.url).resolve) {
  const entry = resolve("feature-factory");
  const root = dirname(dirname(entry));
  return { agents: join(root, "agents"), cli: join(root, "bin", "factory.js") };
}

export function primeSessionId(sessionFile, fallback = randomUUID()) {
  return `prime-agent:${sessionFile ? basename(sessionFile) : fallback}`;
}

export default function featureFactoryExtension(pi, options = {}) {
  const resources = factoryResources(options.resolveFeatureFactory);
  const sessionIds = new WeakMap();

  function sessionIdFor(sessionManager) {
    const existing = sessionIds.get(sessionManager);
    if (existing) return existing;
    const sessionId = primeSessionId(sessionManager.getSessionFile());
    sessionIds.set(sessionManager, sessionId);
    return sessionId;
  }

  pi.registerTool({
    name: "feature_factory_context",
    label: "Feature Factory Context",
    description: "Return the stable Prime session lock identity and installed specialist-agent directory.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = sessionIdFor(ctx.sessionManager);
      return {
        content: [{ type: "text", text: JSON.stringify({ sessionId, agents: resources.agents, cli: resources.cli }) }],
        details: { sessionId, agents: resources.agents, cli: resources.cli },
      };
    },
  });

  pi.registerCommand("feature", {
    description: "Drive a request through feature-factory",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /feature [--autonomous | --headless] <request>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy; wait before starting a feature run.", "warning");
        return;
      }
      pi.sendUserMessage([
        {
          type: "text",
          text: "Load and follow the feature skill as the active run driver. Treat the next text part as the complete, unchanged /feature invocation arguments.",
        },
        { type: "text", text: args },
      ]);
    },
  });
}
