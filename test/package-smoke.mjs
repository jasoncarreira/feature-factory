import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specializedAgents = [
  "backend-builder",
  "codebase-researcher",
  "design-interpreter",
  "frontend-builder",
  "implementation-validator",
  "security-reviewer",
  "spec-writer",
  "story-reader",
  "story-writer",
  "test-verifier",
  "work-decomposer",
  "work-reviewer",
];

test("packed package installs and exposes release surfaces", () => {
  const temp = mkdtempSync(join(tmpdir(), "feature-factory-pack-"));
  const packDir = join(temp, "pack");
  const consumer = join(temp, "consumer");
  const home = join(temp, "home");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  mkdirSync(home, { recursive: true });

  try {
    rmSync(join(root, "dist"), { recursive: true, force: true });

    const pack = npmJson(["pack", "--json", "--pack-destination", packDir], { cwd: root, env: packEnv(temp) });
    const metadata = Array.isArray(pack) ? pack[0] : pack;
    assert.ok(metadata, "npm pack should return package metadata");

    const files = packedFiles(metadata);
    assertIncludes(files, "LICENSE");
    assertIncludes(files, "README.md");
    assertIncludes(files, "dist/tui.js");
    assertIncludes(files, "src/plugin.js");
    assertIncludes(files, "src/cli.js");
    assertIncludes(files, "src/tui-data.js");
    assertIncludes(files, "assets/command/feature.md");
    assertIncludes(files, "assets/skills/feature/SKILL.md");
    for (const agent of specializedAgents) assertIncludes(files, `assets/agent/${agent}.md`);
    assert.ok(files.some((file) => /^src\/.+\.js$/.test(file)), "package should include source JavaScript");
    assert.ok(!files.includes("src/tui.jsx"), "package should not include raw TUI JSX source");

    const tarball = packedTarball(metadata, packDir);
    assert.ok(existsSync(tarball), `expected tarball at ${tarball}`);

    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "feature-factory-consumer", type: "module", private: true }, null, 2));
    npm(["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: consumer, env: isolatedEnv(home) });

    verifyImportSurfaces(consumer, home);
    verifyExportMap(consumer);
    verifyCliInstallIdempotence(consumer, home);
    verifyInstalledPlugin(consumer, home);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function packedFiles(metadata) {
  assert.ok(Array.isArray(metadata.files), "npm pack metadata should include files");
  return metadata.files.map((file) => file.path.replace(/\\/g, "/")).sort();
}

function assertIncludes(files, expected) {
  assert.ok(files.includes(expected), `package should include ${expected}`);
}

function packedTarball(metadata, packDir) {
  const candidates = [metadata.filename, metadata.path].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = isAbsolute(candidate) ? candidate : join(packDir, basename(candidate));
    if (existsSync(resolved)) return resolved;
  }
  const tarballs = readdirSync(packDir).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "expected exactly one packed tarball");
  return join(packDir, tarballs[0]);
}

function verifyImportSurfaces(consumer, home) {
  nodeModule(
    `
      const root = await import("opencode-feature-factory");
      const server = await import("opencode-feature-factory/server");
      const tui = await import("opencode-feature-factory/tui");
      await import("opencode-feature-factory/cli");
      const telemetry = await import(${JSON.stringify(pathToFileURL(join(consumer, "node_modules", "opencode-feature-factory", "src", "telemetry.js")).href)});
      if (typeof root.default !== "function") throw new Error("root export should be plugin function");
      if (root.default !== server.default) throw new Error("server export should match root plugin");
      if (tui.default?.id !== "opencode-feature-factory") throw new Error("tui export should expose plugin id");
      if (typeof telemetry.withSpan !== "function") throw new Error("telemetry helper should import from installed package");
    `,
    { cwd: consumer, env: isolatedEnv(home) },
  );
}

function verifyExportMap(consumer) {
  const pkg = JSON.parse(readFileSync(join(consumer, "node_modules", "opencode-feature-factory", "package.json"), "utf8"));
  assert.equal(pkg.exports["./tui"], "./dist/tui.js");
}

function verifyCliInstallIdempotence(consumer, home) {
  const cli = join(consumer, "node_modules", ".bin", "feature-factory");
  const help = execFileSync(cli, ["--help"], { cwd: consumer, env: isolatedEnv(home), encoding: "utf8" });
  assert.match(help, /doctor \[--local\] \[--profiles\] \[--telemetry\]/u);
  assert.match(help, /--parent-span-id ID/u);
  assert.match(help, /--traceparent VALUE/u);
  assert.match(help, /--tracestate VALUE/u);
  execFileSync(cli, ["install"], { cwd: consumer, env: isolatedEnv(home), encoding: "utf8" });
  execFileSync(cli, ["install"], { cwd: consumer, env: isolatedEnv(home), encoding: "utf8" });

  const config = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8"));
  assert.equal(config.plugin.filter((entry) => entry === "opencode-feature-factory").length, 1);
}

function verifyInstalledPlugin(consumer, home) {
  nodeModule(
    `
      const assert = await import("node:assert/strict");
      const plugin = (await import("opencode-feature-factory")).default;
      const tui = (await import("opencode-feature-factory/tui")).default;
      const cfg = {};
      const instance = await plugin({}, {});
      instance.config(cfg);

      assert.default.equal(cfg.command.feature.agent, "feature-factory");
      assert.default.ok(cfg.command.feature.template.includes("# /feature"));
      assert.default.equal(cfg.agent["feature-factory"].mode, "primary");
      for (const agent of ${JSON.stringify(specializedAgents)}) {
        assert.default.ok(cfg.agent[agent], agent);
      }
      assert.default.equal(Object.keys(cfg.agent).length, 13);
      const expectedSkillsPath = ${JSON.stringify(realpathSync(resolve(consumer, "node_modules", "opencode-feature-factory", "assets", "skills")))};
      assert.default.ok(
        cfg.skills.paths.includes(expectedSkillsPath),
        "expected cfg.skills.paths to include installed package skills path " + expectedSkillsPath,
      );

      const registrations = [];
      await tui.tui({
        slots: { register(registration) { registrations.push(registration); } },
        theme: { current: {} },
      });
      assert.default.equal(registrations.length, 1);
      assert.default.equal(registrations[0].order, 450);
      assert.default.equal(typeof registrations[0].slots.sidebar_content, "function");
    `,
    { cwd: consumer, env: isolatedEnv(home) },
  );
}

function npm(args, options) {
  const [command, commandArgs] = npmCommand(args);
  execFileSync(command, commandArgs, { stdio: "pipe", encoding: "utf8", ...options });
}

function npmJson(args, options) {
  const [command, commandArgs] = npmCommand(args);
  const stdout = execFileSync(command, commandArgs, { stdio: "pipe", encoding: "utf8", ...options });
  return JSON.parse(stdout);
}

function npmCommand(args) {
  if (process.env.npm_execpath) return [process.execPath, [process.env.npm_execpath, ...args]];
  return ["npm", args];
}

function nodeModule(source, options) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], { stdio: "pipe", encoding: "utf8", ...options });
}

function isolatedEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(home, ".npm"),
  };
}

function packEnv(temp) {
  return {
    ...process.env,
    HOME: process.env.HOME,
    npm_config_cache: join(temp, "npm-cache"),
  };
}
