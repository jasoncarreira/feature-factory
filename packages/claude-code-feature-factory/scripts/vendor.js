// Copy the factory into this plugin: the CLI and its modules to vendor/feature-factory, and the
// specialist agents to agents/, where Claude Code registers a plugin's subagents. The agents are copied
// with their tool lists rewritten for Claude Code; everything else is byte for byte.
//
// The plugin carries the CLI rather than depending on it. A marketplace install fetches this package
// and installs its dependencies only from a lockfile shipped beside package.json, which npm never
// publishes, and an install loaded in place installs nothing at all. The factory has no dependencies
// of its own, so a copy of exactly what it publishes is the whole of it, and the copy is the version
// this plugin was built with: the two cannot drift apart.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withDeniedTools } from "./agent-tools.js";

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const factory = resolve(plugin, "..", "feature-factory");

function replace(target, fill) {
  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    fill(temporary);
    rmSync(target, { recursive: true, force: true });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const manifest = JSON.parse(readFileSync(join(factory, "package.json"), "utf8"));
replace(join(plugin, "vendor", "feature-factory"), (into) => {
  for (const entry of [...manifest.files, "package.json"]) {
    if (!existsSync(join(factory, entry))) throw new Error(`feature-factory publishes ${entry}, which is missing`);
    cpSync(join(factory, entry), join(into, entry), { recursive: true });
  }
});
// Each agent's `tools:` allowlist becomes a `disallowedTools:` denylist, so specialists inherit the
// project's MCP servers; agent-tools.js says why and what is denied.
replace(join(plugin, "agents"), (into) => {
  for (const entry of readdirSync(join(factory, "agents")).filter((name) => name.endsWith(".md"))) {
    writeFileSync(join(into, entry), withDeniedTools(readFileSync(join(factory, "agents", entry), "utf8")));
  }
});
