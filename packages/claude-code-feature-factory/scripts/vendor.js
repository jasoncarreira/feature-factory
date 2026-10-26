// Copy the factory into this plugin: the CLI and its modules to vendor/feature-factory, and the
// specialist agents to agents/, where Claude Code registers a plugin's subagents.
//
// The plugin carries the CLI rather than depending on it. A marketplace install fetches this package
// and installs its dependencies only from a lockfile shipped beside package.json, which npm never
// publishes, and an install loaded in place installs nothing at all. The factory has no dependencies
// of its own, so a copy of exactly what it publishes is the whole of it, and the copy is the version
// this plugin was built with: the two cannot drift apart.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
replace(join(plugin, "agents"), (into) => {
  for (const entry of readdirSync(join(factory, "agents")).filter((name) => name.endsWith(".md"))) {
    cpSync(join(factory, "agents", entry), join(into, entry));
  }
});
