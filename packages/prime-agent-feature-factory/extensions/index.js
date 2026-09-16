import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

// Bare-specifier resolution is correct when this file is imported by Node, and it is not ours to control
// when a host loads it some other way.
//
// Observed: Prime Agent failed to load this extension with "Cannot find module 'feature-factory'" on an
// install where the dependency was present, and where the same specifier resolved from this file's own
// path under Node by both import and require. A path walk finds it in that layout, and the operator
// confirmed a build carrying this fallback starts where the same install previously failed.
//
// Suspected, not proven: Prime loads extensions through jiti created with the HOST's module URL as its
// root, so a bare specifier is looked up from Prime's directory rather than from this package. Three
// reproductions of that loader shape here all resolved successfully, so the mechanism is the best
// explanation for the observations rather than an established cause -- and the fallback is worth having
// either way, because which resolver is asking is the host's business while where a package manager put
// a declared dependency is not.
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
