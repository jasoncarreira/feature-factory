import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const repo = new URL("..", import.meta.url).pathname;
const cli = join(repo, "src", "cli.js");

describe("feature-factory install", () => {
  it("configures the plugin without warning when no global feature skill exists", () => {
    const home = tempHome();

    try {
      const proc = runInstall(home);

      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /configured opencode plugin:/);
      assert.match(proc.stdout, /restart opencode for plugin changes to take effect/);
      assert.equal(proc.stderr, "");
      assert.match(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8"), /opencode-feature-factory/);
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
});

function runInstall(home) {
  return spawnSync(process.execPath, [cli, "install", "--local"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
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
