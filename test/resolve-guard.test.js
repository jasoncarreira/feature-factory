// Executable negative control for tools/resolve-guard.mjs.
//
// The guard exists to turn a silent false green into a loud failure, and its own failure
// is silent by definition: ordinary CI installs the workspace correctly, so every other
// test here stays green if the hook is deleted from the scripts, stops covering
// `require()`, or misidentifies the importer. Nothing but this file would notice.
//
// So this builds the run-217 shape on disk — an inner workspace with no node_modules,
// nested under a parent that has the owned package in ITS node_modules — and drives the
// real guard file through it. The positive control matters as much as the negative one:
// a guard that always throws would satisfy the escape rows and be worthless.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const guardSource = join(repoRoot, "tools", "resolve-guard.mjs");
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const write = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };

// parent/node_modules/feature-factory  <- what the upward walk finds
// parent/inner/                        <- the "sandbox": owned package, no node_modules
function buildEscapeFixture() {
  const parent = mkdtempSync(join(tmpdir(), "ff-guard-"));
  temps.push(parent);
  const inner = join(parent, "inner");

  write(join(parent, "node_modules", "feature-factory", "package.json"),
    JSON.stringify({ name: "feature-factory", version: "0.0.0", main: "index.js" }));
  write(join(parent, "node_modules", "feature-factory", "index.js"),
    "module.exports = { origin: 'parent-checkout' };\n");

  write(join(inner, "package.json"), JSON.stringify({
    name: "inner-workspace", private: true, type: "module",
    workspaces: ["packages/feature-factory"],
  }));
  write(join(inner, "packages", "feature-factory", "package.json"),
    JSON.stringify({ name: "feature-factory", version: "0.0.0", main: "index.js" }));
  write(join(inner, "packages", "feature-factory", "index.js"),
    "module.exports = { origin: 'inner-workspace' };\n");

  // the real guard, not a paraphrase of it
  mkdirSync(join(inner, "tools"), { recursive: true });
  cpSync(guardSource, join(inner, "tools", "resolve-guard.mjs"));

  write(join(inner, "probe.mjs"),
    "const m = await import('feature-factory');\nconsole.log('RESOLVED', m.default.origin);\n");
  write(join(inner, "probe.cjs"),
    "console.log('RESOLVED', require('feature-factory').origin);\n");
  return inner;
}

const runProbe = (inner, probe) => spawnSync(
  process.execPath, ["--import", "./tools/resolve-guard.mjs", probe],
  { cwd: inner, encoding: "utf8" });

describe("resolve guard — a dependency escape must be loud", () => {
  it("fires for import and require on escape, and stays silent once installed", () => {
    const inner = buildEscapeFixture();

    // Negative control: uninstalled, so the bare specifier escapes to the parent checkout.
    for (const probe of ["probe.mjs", "probe.cjs"]) {
      const r = runProbe(inner, probe);
      const output = `${r.stdout}${r.stderr}`;
      assert.notEqual(r.status, 0, `${probe}: the escape must fail the process, not resolve`);
      assert.match(output, /outside the workspace root/u, `${probe}: must name the escape`);
      assert.match(output, /npm ci/u, `${probe}: must name the remedy`);
      assert.doesNotMatch(output, /RESOLVED parent-checkout/u,
        `${probe}: the parent's copy must never load`);
    }

    // Positive control: install the workspace link and the same probes must pass. Without
    // this, a guard that threw unconditionally would satisfy every row above.
    mkdirSync(join(inner, "node_modules"), { recursive: true });
    symlinkSync(join(inner, "packages", "feature-factory"),
      join(inner, "node_modules", "feature-factory"), "dir");
    for (const probe of ["probe.mjs", "probe.cjs"]) {
      const r = runProbe(inner, probe);
      assert.equal(r.status, 0, `${probe} installed: ${r.stderr}`);
      assert.match(r.stdout, /RESOLVED inner-workspace/u,
        `${probe} installed: must load the in-tree copy`);
    }
  });

  it("stays wired into every test script that runs node --test", () => {
    // The guard is only enforcement where it is invoked. Deleting the flag from a script
    // is the cheapest way to lose it, and nothing else in the suite would fail.
    const manifests = [
      "package.json",
      "packages/feature-factory/package.json",
      "packages/opencode-feature-factory/package.json",
    ];
    for (const manifest of manifests) {
      const { scripts = {} } = JSON.parse(readFileSync(join(repoRoot, manifest), "utf8"));
      for (const [name, body] of Object.entries(scripts)) {
        if (!body.includes("node --test") && !body.includes("--test ")) continue;
        assert.match(body, /--import [^ ]*resolve-guard\.mjs/u,
          `${manifest} script '${name}' runs node --test without the resolve guard`);
      }
    }
  });
});
