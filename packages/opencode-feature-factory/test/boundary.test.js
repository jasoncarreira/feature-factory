// The package boundary, asserted rather than intended.
//
// BUILD-PLAN-SMALL.md's contract: the factory is standalone with a CLI, the opencode
// integration depends on it and never writes state, and the dependency runs one way.
// Prose cannot hold that — the predecessor's plugin was read-only by convention and
// still reached mutation through imported dispatch-completion helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const opencodePkg = resolve(here, "..");
const packages = resolve(opencodePkg, "..");
const factoryPkg = join(packages, "feature-factory");

function sources(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (entry.endsWith(".js")) found.push(path);
  }
  return found;
}

// Finding 7: an opencode helper invoked the CLI through an aliased node:child_process
// import and the boundary test passed. Shelling out to the CLI is the *documented*
// escape hatch, but it must be visible, so process-spawning is listed here too and a
// legitimate use has to be added deliberately.
const WRITE_PRIMITIVES = [
  "withRunJsonLock", "writeProtectedJsonAtomic", "writeProtectedFileAtomic",
  "writeFileSync", "writeFile", "renameSync", "coordinateRunJsonTransition", "transition(",
  "node:child_process", "child_process", "execFile", "spawnSync", "spawn(", "exec(",
];

describe("package boundary", () => {
  it("gives the opencode package no way to write run state", () => {
    const offenders = [];
    for (const path of sources(opencodePkg)) {
      if (path.includes(`${opencodePkg}/test/`)) continue;
      const text = readFileSync(path, "utf8");
      for (const primitive of WRITE_PRIMITIVES) {
        if (text.includes(primitive)) offenders.push(`${path.slice(opencodePkg.length + 1)} :: ${primitive}`);
      }
    }
    assert.deepEqual(offenders, [], "the opencode package observes and renders; only the CLI writes");
  });

  it("consumes only the schema and the read-only reader", () => {
    const imported = new Set();
    for (const path of sources(opencodePkg)) {
      if (path.includes(`${opencodePkg}/test/`)) continue;
      const text = readFileSync(path, "utf8");
      for (const [, names] of text.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*["']feature-factory["']/gu)) {
        for (const name of names.split(",")) {
          const trimmed = name.trim().split(/\s+as\s+/u)[0];
          if (trimmed) imported.add(trimmed);
        }
      }
    }
    // Widening this list is the signal that the boundary is wrong, not that the
    // export surface is too small.
    // `transition` is deliberately absent: it no longer exists in the package root.
    const allowed = ["readRun", "readRunUnchecked", "validateRun", "SchemaError", "RUN_KEYS", "SCHEMA_VERSION"];
    const unexpected = [...imported].filter((name) => !allowed.includes(name));
    assert.deepEqual(unexpected, [], `unexpected imports from feature-factory: ${unexpected.join(", ")}`);
  });

  it("keeps the dependency one way", () => {
    const offenders = sources(factoryPkg)
      .filter((path) => /["']opencode-feature-factory["']|\.\.\/opencode-feature-factory/u.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(factoryPkg.length + 1));
    assert.deepEqual(offenders, [], "the factory package must not know the opencode package exists");
  });

  it("declares the dependency in the manifest, in that direction only", () => {
    const factory = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    const opencode = JSON.parse(readFileSync(join(opencodePkg, "package.json"), "utf8"));

    assert.equal(opencode.dependencies?.["feature-factory"], factory.version,
      "the opencode package pins the factory version it was built against");
    assert.deepEqual(Object.keys(factory.dependencies ?? {}), [],
      "the standalone package takes no dependency at all, so it installs and tests with no opencode present");
    assert.ok(factory.bin?.factory, "the factory package ships the CLI");
    assert.equal(opencode.bin, undefined, "the opencode package ships no CLI of its own");
  });

  it("does not expose a mutation entry point from the factory package root", () => {
    // Finding 6: state/index.js exported `transition` while package.json exposed that
    // module as the root, so the "read-only reader plus schema" public API handed out
    // mutation authority. The write path now lives in a module the manifest does not
    // export.
    const manifest = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    const root = manifest.exports?.["."] ?? manifest.main;
    const rootSource = readFileSync(join(factoryPkg, root.replace(/^\.\//u, "")), "utf8");
    assert.equal(/export\s+(async\s+)?function\s+transition\b/u.test(rootSource), false,
      "the package root must not export a write path");
    assert.equal(/coordinateRunJsonTransition/u.test(rootSource), false,
      "the package root must not reach the write core at all");
    const exported = Object.values(manifest.exports ?? {});
    assert.equal(exported.includes("./state/transition.js"), false,
      "the write path must not be reachable through any declared export");
  });

  it("names the factory package without an opencode prefix", () => {
    const factory = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    assert.equal(/opencode/u.test(factory.name), false,
      "a host-agnostic package must not be named after one host");
  });
});
