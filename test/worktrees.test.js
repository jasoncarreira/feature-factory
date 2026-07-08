import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deriveExpectedWorktreePath } from "../src/worktrees.js";

describe("worktree path derivation", () => {
  it("adds a stable hash suffix when branch slugs collide", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-worktrees-"));
    try {
      const first = deriveExpectedWorktreePath(repo, "feature/x");
      mkdirSync(first, { recursive: true });

      const second = deriveExpectedWorktreePath(repo, "feature-x");

      assert.equal(basename(first), "feature-x");
      assert.match(basename(second), /^feature-x-[0-9a-f]{8}$/u);
      assert.notEqual(second, first);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
