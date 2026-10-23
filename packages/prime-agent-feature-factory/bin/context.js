import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Bare-specifier resolution failed under Prime 0.9's extension loader on an install where the dependency
// was present beside this file ("Cannot find module 'feature-factory'"). Run by `node` it resolves, but
// where a package manager put a declared dependency is not ours to assume either way, so a path walk from
// this file's own location is the fallback.
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
    // The resolver's bare "Cannot find module 'feature-factory'" tells an operator nothing about what to
    // do, and the likely case is a copy of this file run from somewhere other than where it was installed.
    throw new Error(
      `prime-agent-feature-factory could not resolve its 'feature-factory' dependency from `
      + `${fileURLToPath(import.meta.url)}. Reinstall the adapter so the dependency is installed beside it `
      + `(npm install -g prime-agent-feature-factory), and run this script from `
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

// Profiles are read from a file, project first and then global: the skill runs this script with no
// options, so a file is the only configuration surface an operator can reach.
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
      // must not stop the context from printing, which would stop every run before it starts.
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return {};
}

// What the skill reads before any run effect: the installed specialist-agent directory, the factory CLI
// beside it, and each specialist's spawn profile. Prime 0.10 dropped JavaScript extensions, so this is
// a script the driver runs with `node` rather than a registered tool; the session identity it once
// carried now comes from the session itself (see SKILL.md), because no subprocess can know it.
export function context({ resolveFeatureFactory, ...options } = {}) {
  const resources = factoryResources(resolveFeatureFactory);
  const configured = options.profiles || options.profile ? options : readProfileConfig();
  return { agents: resources.agents, cli: resources.cli, dispatch: dispatchProfiles(resources.agents, configured) };
}

// Through the realpath: `import.meta.url` resolves symlinks and argv does not, so on a symlinked install
// (macOS /var -> /private/var, or a linked global prefix) a plain comparison is false and the script would
// exit 0 having printed nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(context())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
