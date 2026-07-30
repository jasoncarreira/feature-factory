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

const WRITE_PRIMITIVES = [
  "withRunJsonLock", "writeProtectedJsonAtomic", "writeProtectedFileAtomic",
  "writeFileSync", "writeFile", "renameSync", "coordinateRunJsonTransition", "transition(",
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

  it("names the factory package without an opencode prefix", () => {
    const factory = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    assert.equal(/opencode/u.test(factory.name), false,
      "a host-agnostic package must not be named after one host");
  });
});
