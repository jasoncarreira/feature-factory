// What actually ships.
//
// A workspace-level release check rather than either package's unit test, because it is about
// tarballs and the two are only meaningful together. It lives here so `npm test` runs it and neither
// package's suite has to know how the other is published.
//
// It exists because three release blockers in one review round were invisible to 99 passing tests:
// the opencode package's `files` omitted `observe/`, which both entrypoints import, so installing it
// failed outright; and the factory package's `files` omitted `agents/`, so a consumer could not run
// the chain its README documents. The predecessor had a pack smoke test that would have caught
// exactly that, and deleting it in the same change that broke the manifests is what let them through.
//
// **Runtime checks use a real `npm install` of the local tarballs.** An earlier version extracted
// them instead, justified in a comment by the claim that installing unpublished packages would go to
// the registry and fail. That claim was never tested and is false — npm resolves
// `feature-factory@0.1.0` from the sibling tarball on the same command line, writes the dependency,
// and creates the `.bin/factory` shim. Extraction is kept only for the file inventory, where no
// resolution is involved and an install would just be slower.
//
// Installing rather than extracting is what makes two contracts testable at all: **bare specifiers**
// exercise `exports` names and conditions, which importing a manifest's target path silently
// bypasses; and **`node_modules/.bin/factory`** is a symlink, which is the exact shape that broke the
// CLI's entry guard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["feature-factory", "opencode-feature-factory"];

function pack(name, destination) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination],
    { cwd: join(root, "packages", name), encoding: "utf8" });
  const [metadata] = JSON.parse(output);
  return { tarball: join(destination, metadata.filename), files: metadata.files.map((file) => file.path) };
}

// A consumer with both tarballs really installed. Both go on one command line so npm can satisfy the
// inter-package dependency locally instead of reaching for the registry.
function installConsumer(dir) {
  const packed = Object.fromEntries(PACKAGES.map((name) => [name, pack(name, dir)]));
  const consumer = join(dir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"),
    JSON.stringify({ name: "pack-consumer", type: "module", private: true }));
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund",
    ...PACKAGES.map((name) => packed[name].tarball)], { cwd: consumer, encoding: "utf8" });
  return { consumer, packed };
}

// Imports run inside the consumer so bare specifiers resolve through its node_modules, the way a
// dependent's code would. A subprocess is the only honest way to do that from here.
function importInConsumer(consumer, script) {
  return execFileSync("node", ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8" });
}

describe("what actually ships", () => {
  it("packs every file the entrypoints and the docs require", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-files-"));
    try {
      const factory = pack("feature-factory", dir);
      const opencode = pack("opencode-feature-factory", dir);

      // The skill is useless without the agents it dispatches, and both READMEs promise them.
      for (const required of ["skills/feature/SKILL.md", "bin/factory.js", "state/index.js", "README.md", "LICENSE"]) {
        assert.ok(factory.files.includes(required), `feature-factory must ship ${required}`);
      }
      const agents = factory.files.filter((file) => file.startsWith("agents/"));
      assert.equal(agents.length, 11, `feature-factory must ship all eleven agents, packed ${agents.length}`);

      // observe/ is not an entrypoint, which is exactly why it was left out: both entrypoints import
      // it, and nothing that only reads `exports` would notice.
      for (const required of ["plugin/index.js", "tui/dist/index.js", "observe/runs.js", "README.md", "LICENSE"]) {
        assert.ok(opencode.files.includes(required), `opencode-feature-factory must ship ${required}`);
      }
      // The host loads the built bundle and does not transform JSX, so shipping source instead of
      // output would fail at load with a syntax error.
      assert.deepEqual(opencode.files.filter((file) => file.endsWith(".jsx")), [],
        "raw JSX must not ship; the host cannot transform it");

      // Tests are not a release artifact. Shipping them doubles the tarball and invites a consumer to
      // run a suite against their own repository.
      for (const { files } of [factory, opencode]) {
        assert.deepEqual(files.filter((file) => file.includes("test/")), []);
      }

      const readme = readFileSync(join(root, "README.md"), "utf8");
      assert.deepEqual(readme.split(/\r?\n/u).filter((line) => line.startsWith("factory init <run-id>")), [
        "factory init <run-id> [--branch B] [--worktree W] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]",
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("installs from local tarballs and imports by bare specifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-install-"));
    try {
      const { consumer } = installConsumer(dir);

      // The dependency has to have resolved locally, or the install silently pulled something else.
      const manifest = JSON.parse(readFileSync(
        join(consumer, "node_modules", "opencode-feature-factory", "package.json"), "utf8"));
      const factory = JSON.parse(readFileSync(
        join(consumer, "node_modules", "feature-factory", "package.json"), "utf8"));
      assert.equal(manifest.dependencies["feature-factory"], factory.version,
        "the installed integration must be pinned to the installed factory");
      // The integration depends on the factory and nothing else. It registers a tool as a plain
      // object literal rather than through `@opencode-ai/plugin`'s `tool()` helper — that helper is a
      // pass-through, and depending on it would pin a host-coupled package into the packed graph for
      // no behaviour. Both host packages stay absent, so a consumer installs neither.
      for (const absent of ["@opencode-ai/plugin", "@opencode-ai/sdk"]) {
        assert.equal(manifest.dependencies[absent], undefined,
          `the integration must not depend on ${absent}; the host supplies it`);
      }

      // Bare specifiers, so `exports` names and conditions are exercised. Importing a manifest's
      // target path directly — which this test used to do — passes even when the export map is wrong.
      const output = importInConsumer(consumer, `
        const factory = await import("feature-factory");
        const plugin = await import("opencode-feature-factory");
        const tui = await import("opencode-feature-factory/tui");
        const missing = ["readRun", "readRunUnchecked", "nextAction", "validateRun"]
          .filter((name) => typeof factory[name] !== "function");
        if (missing.length) throw new Error("feature-factory is missing: " + missing.join(", "));
        if (typeof plugin.default !== "function") throw new Error("plugin root must default-export a function");
        if (typeof tui.default !== "object" || typeof tui.default.tui !== "function") {
          throw new Error("the tui entry must default-export an object carrying a tui() hook");
        }
        if (factory.transition !== undefined) throw new Error("the write path must not be exported");
        console.log("ok");
      `);
      assert.match(output, /^ok$/mu);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs the CLI through the installed .bin symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-bin-"));
    try {
      const { consumer } = installConsumer(dir);
      // `.bin/factory` is a symlink into the package. Invoking the real path instead — which this
      // test used to do — skips the one shape that broke the entry guard: `process.argv[1]` is the
      // symlink as typed while `import.meta.url` is resolved, so a naive comparison of the two makes
      // the CLI exit 0 having done nothing.
      const shim = join(consumer, "node_modules", ".bin", "factory");
      const help = execFileSync("node", [shim, "--help"], { cwd: consumer, encoding: "utf8" });
      assert.match(help, /factory init <run-id>/u, "the CLI must run through the shim and print usage");
      assert.match(help, /--issue KEY/u, "the packed CLI must advertise the active issue flag");
      assert.doesNotMatch(help, /--jira/u, "the packed CLI must not advertise the obsolete flag");

      execFileSync("node", [
        shim, "init", "packed-readme", "--branch", "feature/packed-readme", "--worktree", ".",
        "--pr-base", "main", "--issue", "ISSUE-214", "--mode", "headless", "--json",
      ], { cwd: consumer, encoding: "utf8" });
      const run = JSON.parse(readFileSync(join(consumer, ".factory", "packed-readme", "run.json"), "utf8"));
      assert.equal(run.issue_key, "ISSUE-214");
      assert.equal(Object.hasOwn(run, "jira_key"), false);

      // And it must actually do work through the shim, not merely print. `status` on an absent run
      // exercises argument parsing and the run-directory resolution.
      const status = execFileSync("node", [shim, "status", "nope", "--json"],
        { cwd: consumer, encoding: "utf8" });
      assert.match(status, /"valid": false/u, "the CLI must report an absent run rather than crash");

      // Executed *directly*, not through `node`. That is the only way the shebang and the executable
      // bit get exercised: npm sets the mode when packing a `bin` entry, and a tarball missing either
      // gives "permission denied" or "syntax error" on a machine where nobody thought to prefix node.
      const direct = execFileSync(shim, ["--help"], { cwd: consumer, encoding: "utf8" });
      assert.match(direct, /factory init <run-id>/u, "the shim must be directly executable");
      const source = readFileSync(join(consumer, "node_modules", "feature-factory", "bin", "factory.js"), "utf8");
      assert.match(source, /^#!\/usr\/bin\/env node\n/u, "and carry a shebang, or direct execution is a syntax error");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
