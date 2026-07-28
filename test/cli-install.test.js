import { spawnSync } from "./helpers/git-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const repo = resolve(new URL("..", import.meta.url).pathname);
const cli = join(repo, "src", "cli.js");

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
      assert.match(proc.stderr, /replace them with delegators that defer to the plugin-owned agents/);
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
