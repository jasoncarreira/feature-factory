import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFileSync } from "./helpers/git-fixture.js";
import { executeCheckedVerificationArtifact } from "../src/test-execution.js";

describe("checked verification artifact execution", () => {
  it("executes the exact current artifact command and publishes a current closed receipt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "verification-artifact-"));
    try {
      git(repo, ["init", "-b", "slice-branch"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "Test"]);
      writeFileSync(join(repo, "README.md"), "fixture\n");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "fixture"]);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const runDir = join(repo, ".opencode", "factory", "artifact-run");
      for (const directory of ["plan", "reviews", "evidence"]) mkdirSync(join(runDir, directory), { recursive: true });
      const plan = {
        slices: [{ id: "slice", stack: "backend", paths: ["README.md"], depends_on: [], acceptance: ["works"], test_plan: ["node --version"] }],
        integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
        delivery_envelope: {
          schema_version: 1,
          delivery_units: [{
            id: "slice-unit", slice_id: "slice",
            invariant_families: [{ id: "slice-family", description: "Slice behavior" }],
            obligations: [{ id: "slice-obligation", description: "Verify behavior", invariant_family_id: "slice-family", verification_artifact_id: "slice-tests" }],
            verification_artifacts: [{ id: "slice-tests", test_plan_index: 0, test_plan_entry: "node --version" }],
          }],
        },
      };
      writeJson(join(runDir, "plan", "slices.json"), plan);
      const review = { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] };
      writeJson(join(runDir, "reviews", "work-decomposer.json"), review);
      writeJson(join(runDir, "run.json"), {
        schema_version: 1, run_id: "artifact-run", status: "running", branch: "slice-branch", worktree: repo, gates: {},
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["README.md"], effective_paths: ["README.md"], status: "running", attempts: 1, branch: "slice-branch", worktree: repo }],
        steps: [{
          agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
          acceptance: {
            artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
            review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
          },
        }],
      });

      const result = await executeCheckedVerificationArtifact(runDir, "slice", "slice-tests", { env: process.env });
      assert.equal(result.receipt.subject, "slice");
      assert.equal(result.receipt.attempt, 1);
      assert.equal(result.receipt.head_sha, head);
      assert.equal(result.receipt.verification_artifact_id, "slice-tests");
      assert.deepEqual(result.receipt.probe, {
        type: "verification-artifact", verification_artifact_id: "slice-tests", test_plan_index: 0,
        test_plan_entry: "node --version", program: "node", args: ["--version"],
      });
      assert.equal(result.receipt.status, "pass");
      assert.deepEqual(result.receipt.result, { type: "verification-result", outcome: "pass", summary: "Verification artifact command passed" });
      assert.equal(hashFile(join(runDir, result.authority.receipt_ref)), result.receipt_hash);

      const replay = await executeCheckedVerificationArtifact(runDir, "slice", "slice-tests", { env: process.env });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, result.receipt);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
