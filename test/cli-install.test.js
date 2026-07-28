import { spawnSync } from "./helpers/git-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { SANCTIONED_GLOBAL_FEATURE_SKILL } from "../src/global-definitions.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const cli = join(repo, "src", "cli.js");
const FRAGMENTED_SECRET_VARIANTS = [
  ["mixed", "Q7M4-Z9N2_C8V5.B1X6:L3K0 P7R2-T9Y4_U8I5"],
  ["uneven-1", "Q7-M4Z9N_2C8.V5B1X6:L3K 0P7R2-T9Y4_U8I5"],
  ["uneven-2", "Q-7M4_Z9N2C.8V5:B1X6L 3K0-P7R2T_9Y4U8-I5"],
  ["control-1", "Q7M4\u001bZ9N2_C8V5.B1X6:L3K0 P7R2-T9Y4_U8I5"],
  ["control-2", "Q7M4-Z9N2\u202eC8V5.B1X6:L3K0\tP7R2-T9Y4_U8I5"],
  ["long-fragments", "Q7M4Z9N-2C8V5_B1X6L3.K0P7R2:T9Y4U8I5"],
  ["fragmented-bearer-path", "Bearer/Q7M4Z9N/2C8V5/B1X6L3/K0P7R2/T9Y4U8I5"],
];

describe("feature-factory install", () => {
  it("configures the plugin without warning when no global feature skill exists", () => {
    const home = tempHome();
    const bin = join(home, "bin");

    try {
      mkdirSync(bin, { recursive: true });
      symlinkSync(cli, join(bin, "feature-factory"));
      const proc = runInstall(home, { PATH: `${bin}${delimiter}${process.env.PATH}` });

      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /configured opencode plugin:/);
      assert.deepEqual(installIdentity(proc.stdout), {
        source: realpathSync(cli),
        version: "0.2.1",
        hash: hashFile(cli),
      });
      assert.match(proc.stdout, /restart opencode for plugin changes to take effect/);
      assert.equal(proc.stderr, "");
      const config = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8"));
      assert.deepEqual(config.plugin, [pathToFileURL(repo).href]);
    } finally {
      cleanup(home);
    }
  });

  it("collapses duplicate string/tuple registrations to one entry, preserving tuple options", () => {
    const home = tempHome();
    const configPath = join(home, ".config", "opencode", "opencode.jsonc");
    const spec = pathToFileURL(repo).href;
    const legacySpec = pathToFileURL(join(repo, "src", "plugin.js")).href;

    try {
      // Pre-existing duplicates: plain string first, tuple with options second,
      // stale legacy-local spec third, plus an unrelated plugin that must survive.
      writeFile(configPath, JSON.stringify({
        plugin: [spec, [spec, { prMode: "draft" }], legacySpec, "unrelated-plugin"],
      }));

      const proc = runInstall(home);

      assert.equal(proc.status, 0, proc.stderr);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      // Exactly one registration remains; the tuple wins so its options survive.
      assert.deepEqual(config.plugin, [[spec, { prMode: "draft" }], "unrelated-plugin"]);
    } finally {
      cleanup(home);
    }
  });

  it("warns loudly when a global feature skill may shadow the plugin skill", () => {
    const home = tempHome();
    const skillPath = join(home, ".config", "opencode", "skills", "feature", "SKILL.md");

    try {
      writeFile(skillPath, "---\nname: feature\n---\n\n# Old Feature\n");

      const proc = runInstall(home);

      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stderr, /WARNING: existing global feature skill detected/);
      assert.match(proc.stderr, /shadow or conflict with the plugin's current feature workflow/);
      assert.match(proc.stderr, new RegExp(escapeRegExp(skillPath)));
      assert.match(proc.stderr, /repo-seeded \.opencode\/skills\/feature\/SKILL\.md/);
    } finally {
      cleanup(home);
    }
  });

  it("accepts exact packaged and sanctioned global feature skills", () => {
    for (const [name, contents] of [
      ["packaged", readFileSync(join(repo, "assets", "skills", "feature", "SKILL.md"))],
      ["delegator", SANCTIONED_GLOBAL_FEATURE_SKILL],
    ]) {
      const home = tempHome();
      try {
        writeFile(join(home, ".config", "opencode", "skills", "feature", "SKILL.md"), contents);
        const proc = runInstall(home);
        assert.equal(proc.status, 0, proc.stderr);
        assert.doesNotMatch(proc.stderr, /global feature skill/u, name);
      } finally {
        cleanup(home);
      }
    }
  });

  it("warns when stale global agent definitions may shadow plugin agents", () => {
    const home = tempHome();
    const researcher = join(home, ".config", "opencode", "agent", "codebase-researcher.md");
    const reviewer = join(home, ".config", "opencode", "agents", "work-reviewer.md");

    try {
      writeFile(researcher, "---\nmode: subagent\n---\n\n# Old Researcher\n");
      writeFile(reviewer, "---\nmode: subagent\n---\n\n# Old Reviewer\n");

      const proc = runInstall(home);

      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stderr, /WARNING: existing global feature-factory agent definitions detected/);
      assert.match(proc.stderr, /can shadow the plugin's current prompts/);
      assert.match(proc.stderr, new RegExp(escapeRegExp(researcher)));
      assert.match(proc.stderr, new RegExp(escapeRegExp(reviewer)));
      assert.match(proc.stderr, /exact copies of the current plugin-owned agent definitions/);
    } finally {
      cleanup(home);
    }
  });

  it("accepts exact global agent definitions", () => {
    const home = tempHome();
    const agent = "codebase-researcher.md";
    try {
      writeFile(
        join(home, ".config", "opencode", "agent", agent),
        readFileSync(join(repo, "assets", "agent", agent)),
      );
      const proc = runInstall(home);
      assert.equal(proc.status, 0, proc.stderr);
      assert.doesNotMatch(proc.stderr, /global feature-factory agent definitions/u);
    } finally {
      cleanup(home);
    }
  });

  it("warns for stale agent definitions under OPENCODE_CONFIG_DIR", () => {
    const home = tempHome();
    const configDir = join(home, "effective-opencode");
    const agent = join(configDir, "agents", "codebase-researcher.md");
    try {
      writeFile(agent, "stale researcher\n");
      const proc = runInstall(home, { OPENCODE_CONFIG_DIR: configDir });
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stderr, /existing global feature-factory agent definitions/u);
      assert.match(proc.stderr, new RegExp(escapeRegExp(agent), "u"));
    } finally {
      cleanup(home);
    }
  });

  for (const definition of [
    { name: "skill", segments: ["skills", "feature", "SKILL.md"], warning: /existing global feature skill/u },
    { name: "agent", segments: ["agents", "codebase-researcher.md"], warning: /existing global feature-factory agent definitions/u },
  ]) {
    it(`warns for a stale ${definition.name} under XDG_CONFIG_HOME`, () => {
      const home = tempHome();
      const xdg = join(home, "xdg");
      const stale = join(xdg, "opencode", ...definition.segments);
      try {
        writeFile(stale, `stale ${definition.name}\n`);
        const proc = runInstall(home, { XDG_CONFIG_HOME: xdg });
        assert.equal(proc.status, 0, proc.stderr);
        assert.match(proc.stderr, definition.warning);
        assert.match(proc.stderr, new RegExp(escapeRegExp(stale), "u"));
      } finally {
        cleanup(home);
      }
    });
  }

  it("diagnoses unsupported OpenCode config overrides without exposing their values", () => {
    const home = tempHome();
    const secret = "github_pat_123456789012345678901234567890";
    try {
      const proc = runInstall(home, {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { "feature-factory": { prompt: secret } } }),
      });
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stderr, /unsupported OpenCode config override detected/u);
      assert.match(proc.stderr, /Unset OPENCODE_CONFIG_CONTENT for feature-factory operation/u);
      assert.doesNotMatch(`${proc.stdout}${proc.stderr}`, new RegExp(secret, "u"));
    } finally {
      cleanup(home);
    }
  });

  it("terminal-encodes both conflict path lists under a hostile HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "feature-factory-install-\u001B]0;pwned\u0007-"));
    const skill = join(home, ".config", "opencode", "skills", "feature", "SKILL.md");
    const agent = join(home, ".config", "opencode", "agent", "codebase-researcher.md");
    try {
      writeFile(skill, "old skill\n");
      writeFile(agent, "old agent\n");
      const proc = runInstall(home);
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stderr, /existing global feature skill/u);
      assert.match(proc.stderr, /existing global feature-factory agent definitions/u);
      assert.equal((proc.stderr.match(/\\u001B/g) || []).length >= 2, true);
      assert.doesNotMatch(`${proc.stdout}${proc.stderr}`, /[\u001B\u0007\u009B]/u);
    } finally {
      cleanup(home);
    }
  });

  it("renders hostile CLI source and version through bounded identity fields", () => {
    const home = tempHome();
    const packageRoot = join(home, "visible\u001B]0;pwned\u0007", "node_modules", "opencode-feature-factory");
    const effectiveCli = join(packageRoot, "src", "cli.js");
    const bin = join(home, "bin");
    try {
      writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-feature-factory", version: "9.9.9\u001B[2J" }));
      writeFile(effectiveCli, "#!/bin/sh\nexit 0\n");
      chmodSync(effectiveCli, 0o755);
      mkdirSync(bin, { recursive: true });
      symlinkSync(effectiveCli, join(bin, "feature-factory"));

      const proc = runInstall(home, { PATH: `${bin}${delimiter}${process.env.PATH}` });

      assert.equal(proc.status, 0, proc.stderr);
      assert.deepEqual(installIdentity(proc.stdout), {
        source: realpathSync(effectiveCli).replace(/[\u001B\u0007]/gu, "?"),
        version: "9.9.9?[2J",
        hash: hashFile(effectiveCli),
      });
      assert.doesNotMatch(proc.stdout, /[\u001B\u0007\u009B]/u);
    } finally {
      cleanup(home);
    }
  });

  it("redacts mixed, uneven, and control-interrupted high-entropy CLI credentials from install output", () => {
    for (const [name, fragmented] of FRAGMENTED_SECRET_VARIANTS) {
      const home = tempHome();
      const packageRoot = join(home, `home ${fragmented}`);
      const effectiveCli = join(packageRoot, "feature-factory");
      const bin = join(home, "bin");
      try {
        writeFile(join(packageRoot, "package.json"), JSON.stringify({
          name: "opencode-feature-factory",
          version: `feature-factory 1.2.3 ${fragmented}`,
        }));
        writeFile(effectiveCli, "#!/bin/sh\nexit 0\n");
        chmodSync(effectiveCli, 0o755);
        mkdirSync(bin, { recursive: true });
        symlinkSync(effectiveCli, join(bin, "feature-factory"));

        const proc = runInstall(home, { PATH: `${bin}${delimiter}${process.env.PATH}` });

        assert.equal(proc.status, 0, proc.stderr);
        assert.deepEqual(installIdentity(proc.stdout), {
          source: "[redacted]",
          version: "[redacted]",
          hash: hashFile(effectiveCli),
        }, name);
        assert.equal(`${proc.stdout}${proc.stderr}`.includes(fragmented), false, name);
      } finally {
        cleanup(home);
      }
    }
  });

  it("redacts Basic credentials from install and both conflict path outputs", () => {
    const parent = tempHome();
    const secret = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
    const home = join(parent, `home Authorization: Basic ${secret},visible`);
    const skill = join(home, ".config", "opencode", "skills", "feature", "SKILL.md");
    const agent = join(home, ".config", "opencode", "agent", "codebase-researcher.md");
    try {
      writeFile(skill, "old skill\n");
      writeFile(agent, "old agent\n");
      const proc = runInstall(home);
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /updated: .*Authorization: Basic \[redacted\],visible/u);
      assert.match(proc.stderr, /existing global feature skill/u);
      assert.match(proc.stderr, /existing global feature-factory agent definitions/u);
      assert.equal((proc.stderr.match(/Authorization: Basic \[redacted\]/gu) || []).length, 2);
      assert.doesNotMatch(`${proc.stdout}${proc.stderr}`, new RegExp(secret, "u"));
    } finally {
      cleanup(parent);
    }
  });
});

function runInstall(home, env = {}) {
  return spawnSync(process.execPath, [cli, "install", "--local"], {
    cwd: repo,
    env: { ...process.env, ...env, HOME: home },
    encoding: "utf8",
  });
}

function installIdentity(stdout) {
  const prefix = "feature-factory CLI: ";
  const line = stdout.split("\n").find((value) => value.startsWith(prefix));
  assert.ok(line, "install output must report CLI identity");
  return JSON.parse(line.slice(prefix.length));
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "feature-factory-install-home-"));
}

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
