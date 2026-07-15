import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { directFactoryRoot, factoryRootsForLookup } from "../src/factory-paths.js";

describe("factory root lookup safety", () => {
  it("skips an unsafe ancestor factory root without weakening direct writes", () => {
    const workspace = tempDir("workspace");
    const outside = tempDir("outside");
    const project = join(workspace, "project");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(outside, "factory"), { recursive: true });
    symlinkSync(outside, join(workspace, ".opencode"), "dir");
    try {
      const roots = factoryRootsForLookup(project);
      assert.ok(roots.includes(join(project, ".opencode", "factory")));
      assert.equal(roots.includes(join(workspace, ".opencode", "factory")), false);
    } finally {
      cleanup(workspace);
      cleanup(outside);
    }
  });

  it("returns no lookup root for an unsafe direct factory while strict writes reject it", () => {
    const project = tempDir("project");
    const outside = tempDir("outside");
    mkdirSync(join(outside, "factory"), { recursive: true });
    symlinkSync(outside, join(project, ".opencode"), "dir");
    try {
      assert.deepEqual(factoryRootsForLookup(project), []);
      assert.throws(() => directFactoryRoot(project), /\.opencode must be a real directory, not a symlink/u);
    } finally {
      cleanup(project);
      cleanup(outside);
    }
  });
});

function tempDir(label) {
  return realpathSync(mkdtempSync(join(tmpdir(), `factory-paths-${label}-`)));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
