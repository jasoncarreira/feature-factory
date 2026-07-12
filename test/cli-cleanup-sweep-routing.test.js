import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, it } from "node:test";

const cli = resolve("src/cli.js");

describe("cleanup sweep CLI routing", () => {
  it("routes preview before generic options, renders exactly one report, and copies its exit code", () => {
    const repo = repository();
    try {
      const result = spawnSync(process.execPath, [cli, "factory", "cleanup", "--all", "--dry-run", "--repo", repo, "--json"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.mode, "preview");
      assert.equal(report.status, "previewed");
      assert.equal(result.stdout.trim().split("\n").filter((line) => line.startsWith("{")).length, 1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("emits one fixed grammar error with no stdout or repository inspection output", () => {
    const result = spawnSync(process.execPath, [cli, "factory", "cleanup", "--all", "--force", "--dry-run"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "error: invalid cleanup sweep command\n");
  });

  it("publishes the exact preview and digest execution usage forms", () => {
    const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.match(result.stdout, /factory cleanup --all --dry-run \[--repo PATH\] \[--json\]/u);
    assert.match(result.stdout, /factory cleanup --all --digest ff-cleanup-v1\.<repository-sha256>\.<envelope-sha256> \[--repo PATH\] \[--json\]/u);
  });
});

function repository() {
  const path = mkdtempSync(join(tmpdir(), "cleanup-sweep-cli-"));
  execFileSync("git", ["init", "-q", path]);
  return path;
}
