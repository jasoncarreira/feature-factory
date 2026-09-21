import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
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

// Prime's valid child reasoning levels, copied from the host's THINKING_LEVELS. An unknown value fails
// `rlm.spawn` rather than being ignored, so an agent whose `effort` drifted outside this set must be
// dropped here instead of reaching the spawn: every agent declares one of low/medium/high/xhigh today,
// and all four are valid, but the frontmatter is prose and nothing else checks it.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Frontmatter is prose, and only three keys matter here. A full YAML parser would be a dependency this
// package does not have and does not need for `key: value` at the top of a known file.
function frontmatter(text) {
  const out = {};
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return out;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = /^([a-z_]+):[ \t]*(\S.*?)[ \t]*$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function usable(profile) {
  if (!profile || typeof profile !== "object") return null;
  return profile.model || profile.thinking ? profile : null;
}

// The same four levels the OpenCode plugin resolves, most specific first, because an operator
// configuring both hosts should not have to learn two vocabularies:
//
//   profiles[<agent>] -> profiles[<role>] -> profiles.default -> profile
//
// `role` comes from the agent's own frontmatter rather than a table here, so a new agent inherits its
// role without an entry. The declared `model` is NOT a source: "sonnet" and "opus" are tiers, while
// Prime requires an exact `provider/id` selector and fails the spawn on anything else.
export function profileFor(name, role, { profiles = {}, profile } = {}) {
  return usable(profiles[name]) ?? usable(role ? profiles[role] : null) ?? usable(profiles.default) ?? usable(profile) ?? {};
}

// What each specialist is spawned with. `thinking` defaults to the agent's declared `effort` because the
// agent knows how hard its own job is; a profile overrides it. `model` has no default: Prime's own
// `subagentDefaultModel` setting already covers "one model for every child", and an unavailable explicit
// selector fails the spawn closed, so this adapter pins one only where an operator asked for it.
export function dispatchProfiles(agentsDir, options = {}, read = readAgentFiles) {
  const out = {};
  for (const { name, role, effort } of read(agentsDir)) {
    const chosen = profileFor(name, role, options);
    const thinking = chosen.thinking ?? effort;
    // Only what `rlm.spawn` accepts. The driver spreads this entry straight into the call, and Prime
    // fails a spawn on an unknown keyword rather than ignoring it -- so `role`, which resolution needs
    // and the spawn does not, stays out of the value entirely instead of relying on the caller to strip
    // it. Adding a diagnostic key here would break the first dispatch of every run.
    out[name] = {};
    if (THINKING_LEVELS.includes(thinking)) out[name].thinking = thinking;
    if (chosen.model) out[name].model = chosen.model;
  }
  return out;
}

function readAgentFiles(agentsDir) {
  let entries;
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }
  const agents = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const meta = frontmatter(readFileSync(join(agentsDir, entry), "utf8"));
    agents.push({ name: meta.name ?? entry.slice(0, -3), role: meta.role, effort: meta.effort });
  }
  return agents;
}

export function primeSessionId(sessionFile, fallback = randomUUID()) {
  return `prime-agent:${sessionFile ? basename(sessionFile) : fallback}`;
}

// Prime registers an extension by path and calls the default export with `pi` alone -- there is no
// per-extension options object in `settings.json` or the package manifest. A configuration surface that
// only a direct call can reach is not configuration, so profiles are read from a file instead, project
// first and then global, with an explicit `options` argument still winning for tests and `-e` use.
export const PROFILE_CONFIG_PATH = join(".prime", "agent", "feature-factory.json");

export function readProfileConfig(cwd = process.cwd(), home = homedir(), read = readFileSync) {
  for (const base of [cwd, home]) {
    let bytes;
    try {
      bytes = read(join(base, PROFILE_CONFIG_PATH), "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      // A malformed file is reported and skipped rather than throwing: a typo in an optional profile
      // must not stop the extension registering, which would take /feature down with it.
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return {};
}

export default function featureFactoryExtension(pi, options = {}) {
  const resources = factoryResources(options.resolveFeatureFactory);
  // Resolved once at registration: the agent set and the operator's profiles are both fixed for the
  // life of the extension, and reading eleven files per dispatch would buy nothing.
  const configured = options.profiles || options.profile ? options : readProfileConfig();
  const dispatch = dispatchProfiles(resources.agents, configured);
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
    description: "Return the stable Prime session lock identity, the installed specialist-agent directory, and each specialist's spawn profile.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = sessionIdFor(ctx.sessionManager);
      const payload = { sessionId, agents: resources.agents, cli: resources.cli, dispatch };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
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
