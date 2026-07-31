// What actually ships.
//
// This is a workspace-level release check rather than either package's unit test, because it is
// about tarballs and the two are only importable together. It lives here so `npm test` runs it and
// neither package's suite has to know how the other is published.
//
// It exists because all three release blockers in one review round were invisible to 99 passing
// tests: the opencode package's `files` omitted `observe/`, which both of its entrypoints import,
// so installing it failed outright; and the factory package's `files` omitted `agents/`, so the
// documented agent chain could not be run by a consumer. The predecessor had a pack smoke test that
// would have caught exactly this, and deleting it in the same change that broke the manifests is
// what let all three through.
//
// Tarballs are extracted rather than `npm install`ed on purpose: the opencode package depends on a
// `feature-factory` version that is not published yet, so a real install would go to the registry
// and fail for a reason that has nothing to do with what is being tested. Extracting proves the one
// thing that matters here — that the packed file set resolves.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["feature-factory", "opencode-feature-factory"];

function pack(name, destination) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination],
    { cwd: join(root, "packages", name), encoding: "utf8" });
  const [metadata] = JSON.parse(output);
  return { tarball: join(destination, metadata.filename), files: metadata.files.map((file) => file.path) };
}

// One consumer with both packages extracted into node_modules, so `import "opencode-feature-factory"`
// can resolve `feature-factory` the way a real installation would.
function consumerWith(packed, dir) {
  const modules = join(dir, "node_modules");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
  for (const [name, { tarball }] of Object.entries(packed)) {
    const target = join(modules, name);
    mkdirSync(target, { recursive: true });
    // The tarball's single top-level `package/` directory is stripped.
    execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components", "1"]);
  }
  return modules;
}

describe("what actually ships", () => {
  it("packs every file the entrypoints and the docs require", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-files-"));
    try {
      const factory = pack("feature-factory", dir);
      const opencode = pack("opencode-feature-factory", dir);

      // The skill is useless without the agents it dispatches, and both READMEs promise them.
      for (const required of ["skill/SKILL.md", "bin/factory.js", "state/index.js", "README.md", "LICENSE"]) {
        assert.ok(factory.files.includes(required), `feature-factory must ship ${required}`);
      }
      const agents = factory.files.filter((file) => file.startsWith("agents/"));
      assert.equal(agents.length, 11, `feature-factory must ship all eleven agents, packed ${agents.length}`);

      // observe/ is not an entrypoint, which is exactly why it was left out: both entrypoints
      // import it, and nothing that only reads `exports` would notice.
      for (const required of ["plugin/index.js", "tui/index.js", "observe/runs.js", "README.md", "LICENSE"]) {
        assert.ok(opencode.files.includes(required), `opencode-feature-factory must ship ${required}`);
      }

      // Tests are not a release artifact. Shipping them doubles the tarball and invites a consumer
      // to run a suite against their own repository.
      for (const { files } of [factory, opencode]) {
        assert.deepEqual(files.filter((file) => file.includes("test/")), []);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports every declared entrypoint from the packed tarballs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-import-"));
    try {
      const packed = { "feature-factory": pack("feature-factory", dir), "opencode-feature-factory": pack("opencode-feature-factory", dir) };
      const modules = consumerWith(packed, dir);

      for (const name of PACKAGES) {
        const manifest = JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8"));
        // Every path the manifest advertises, not just the root — a subpath export that does not
        // resolve is as broken as a missing main, and only reachable by importing it.
        for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
          if (typeof target !== "string" || !target.endsWith(".js")) continue;
          const resolved = join(modules, name, target.replace(/^\.\//u, ""));
          await assert.doesNotReject(() => import(pathToFileURL(resolved).href),
            `${name}${subpath === "." ? "" : subpath.slice(1)} must import from the packed tarball`);
        }
      }

      // The host rejects a TUI entry that is not a default *object* carrying a `tui` hook, before any
      // of the module's own code runs — so a wrong shape produces no sidebar and no error anyone
      // here would see. It was wrong, and only a review against opencode's loader caught it.
      const sidebar = await import(pathToFileURL(join(modules, "opencode-feature-factory", "tui", "index.js")).href);
      assert.equal(typeof sidebar.default, "object", "the TUI entry must default-export an object");
      assert.equal(typeof sidebar.default.tui, "function", "the TUI entry's object must carry a tui() hook");

      // The plugin root must be a function returning a hook object. It registers none today, and
      // that is deliberate — but it must still load and return something the host can accept.
      const root = await import(pathToFileURL(join(modules, "opencode-feature-factory", "plugin", "index.js")).href);
      assert.equal(typeof root.default, "function", "the plugin root must default-export a function");
      assert.deepEqual(await root.default({}), {}, "the plugin registers no hooks; say so by returning none");

      // The read-only surface a consumer is promised, resolved through the packed factory.
      const state = await import(pathToFileURL(join(modules, "feature-factory", "state", "index.js")).href);
      for (const named of ["readRun", "readRunUnchecked", "nextAction", "validateRun"]) {
        assert.equal(typeof state[named], "function", `feature-factory must export ${named}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ships a CLI that runs from the packed tarball", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-cli-"));
    try {
      const packed = { "feature-factory": pack("feature-factory", dir) };
      const modules = consumerWith(packed, dir);
      const manifest = JSON.parse(readFileSync(join(modules, "feature-factory", "package.json"), "utf8"));
      const bin = join(modules, "feature-factory", manifest.bin.factory);
      const help = execFileSync("node", [bin, "--help"], { encoding: "utf8" });
      assert.match(help, /factory init <run-id>/u, "the packed CLI must run and print usage");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
