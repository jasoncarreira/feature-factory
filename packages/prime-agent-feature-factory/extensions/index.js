import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

// Bare-specifier resolution is correct when this file is imported by Node, and it is not ours to control
// when a host loads it some other way. Prime Agent now loads extensions through jiti, rooted at the
// HOST's own module URL, and a bare `feature-factory` is then looked up from the host's directory rather
// than from this package -- where the dependency this package declares is not installed. So bare
// resolution is attempted first, and a walk up from this file's own location is the fallback: this
// package declares `feature-factory` as a dependency, so a package manager put it either beside this
// package or in a parent `node_modules`, and that is a fact about the install rather than about whoever
// is doing the importing.
function resolveFromOwnPath() {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, "node_modules", "feature-factory");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

export function factoryResources(resolve = createRequire(import.meta.url).resolve, findBeside = resolveFromOwnPath) {
  let entry;
  try {
    entry = resolve("feature-factory");
  } catch (cause) {
    const fallback = findBeside();
    if (fallback) return resourcesFor(fallback);
    // The host reports "Failed to load extension" and the resolver's bare "Cannot find module
    // 'feature-factory'", which together tell an operator nothing about what to do. Observed on a global
    // install whose dependency was present and resolvable when the same specifier was resolved directly
    // from this file's path -- so the interesting case is not a missing package but a host that loads this
    // file from somewhere other than where it was installed, and the message has to be able to say so.
    throw new Error(
      `prime-agent-feature-factory could not resolve its 'feature-factory' dependency from `
      + `${fileURLToPath(import.meta.url)}. Reinstall the adapter so the dependency is installed beside it `
      + `(npm install -g prime-agent-feature-factory), and check that the host loads this extension from `
      + `its installed path rather than a copy, since resolution is relative to this file.`,
      { cause },
    );
  }
  // `resolve` yields the package's main module, one level below the package root.
  return resourcesFor(dirname(dirname(entry)));
}

function resourcesFor(root) {
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
