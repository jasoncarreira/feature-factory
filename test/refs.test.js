import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveArtifactRef, resolveSteeringRef } from "../src/refs.js";

describe("durable refs", () => {
  it("rejects write refs through symlinked ancestors outside the durable root", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-refs-"));
    const outside = mkdtempSync(join(tmpdir(), "feature-factory-refs-outside-"));
    const runDir = join(repo, ".opencode", "factory", "run");
    try {
      mkdirSync(join(runDir, "artifacts"), { recursive: true });
      symlinkSync(outside, join(runDir, "artifacts", "sub"), "dir");

      assert.throws(
        () => resolveArtifactRef(runDir, "artifacts/sub/x.json", { mustExist: false }),
        /must stay under/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolves steering refs only under the steering durable root", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-steering-refs-"));
    const runDir = join(repo, ".opencode", "factory", "run");
    try {
      mkdirSync(join(runDir, "steering"), { recursive: true });
      const resolved = resolveSteeringRef(runDir, "steering/pending.json", { mustExist: false });
      assert.equal(resolved.ref, "steering/pending.json");
      assert.throws(() => resolveSteeringRef(runDir, "../run.json", { mustExist: false }), /must not contain/u);
      assert.throws(() => resolveSteeringRef(runDir, "gates/answer", { mustExist: false }), /stay under steering/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
