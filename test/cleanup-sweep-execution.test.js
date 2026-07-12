import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { executeCleanupSweep, previewCleanupSweep } from "../src/cleanup-sweep.js";

describe("cleanup sweep orchestration", () => {
  it("previews only the direct factory root with a repository-bound digest and no target mutation", async () => {
    const repo = repository();
    try {
      const report = await previewCleanupSweep({ cwd: repo, invocationId: "preview-test" });
      assert.equal(report.status, "previewed");
      assert.equal(report.repository.root_path, realpathSync(repo));
      assert.match(report.authorization.digest, /^ff-cleanup-v1\.[0-9a-f]{64}\.[0-9a-f]{64}$/u);
      assert.deepEqual(report.candidates, []);
      assert.equal(report.exit_code, 0);
      assert.deepEqual(report.confirmation.argv.slice(0, 6), ["feature-factory", "factory", "cleanup", "--all", "--digest", report.authorization.digest]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("refuses stale evidence before attempting a candidate lock", async () => {
    const repo = repository();
    try {
      const preview = await previewCleanupSweep({ cwd: repo, invocationId: "stale-preview" });
      mkdirSync(join(repo, ".opencode", "factory"), { recursive: true });
      writeFileSync(join(repo, ".opencode", "factory", "unexpected"), "not a run\n");
      let lockCalls = 0;
      const report = await executeCleanupSweep({
        cwd: repo,
        digest: preview.authorization.digest,
        invocationId: "stale-execute",
        acquireRunLock() { lockCalls += 1; throw new Error("must not acquire"); },
      });
      assert.equal(report.status, "refused");
      assert.equal(report.authorization.refusal_code, "DIGEST_STALE");
      assert.equal(report.exit_code, 1);
      assert.equal(lockCalls, 0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("rejects malformed execution digests before repository inspection", async () => {
    let gitCalls = 0;
    await assert.rejects(
      executeCleanupSweep({ digest: "bad", gitRunner() { gitCalls += 1; } }),
      /digest is malformed/u,
    );
    assert.equal(gitCalls, 0);
  });
});

function repository() {
  const path = mkdtempSync(join(tmpdir(), "cleanup-sweep-execution-"));
  execFileSync("git", ["init", "-q", path]);
  return path;
}
