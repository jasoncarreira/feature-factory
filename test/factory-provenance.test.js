import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { persistFactoryRunCreatedEnv, persistFactoryRunResumeEnv, recordReviewDispatchProvenance } from "../src/factory.js";
import { spawnSync } from "./helpers/git-fixture.js";

describe("effective prompt provenance", () => {
  it("records creation and review dispatch hashes without persisting dynamic prompt text", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-provenance-"));
    const runId = "provenance-run";
    const runDir = join(repo, ".opencode", "factory", runId);
    const dynamicPrompt = "review exact current brief; private operator context stays raw-free";
    const promptHash = `sha256:${createHash("sha256").update(dynamicPrompt).digest("hex")}`;
    const pluginOptions = { profiles: { "work-reviewer": { model: "test/reviewer", variant: "high" } }, prMode: "draft" };
    try {
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "Test"]);
      writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "fixture"]);
      mkdirSync(runDir, { recursive: true });
      writeJson(join(runDir, "run.json"), {
        schema_version: 1,
        run_id: runId,
        status: "running",
        branch: "main",
        worktree: repo,
        gates: {},
      });

      await persistFactoryRunCreatedEnv(runId, { cwd: repo, pluginOptions, now: "2026-07-14T12:00:00.000Z" });
      await recordReviewDispatchProvenance(runId, {
        agent: "work-reviewer",
        subject: "spec-writer",
        attempt: 1,
        promptHash,
        promptBytes: Buffer.byteLength(dynamicPrompt),
      }, { cwd: repo, pluginOptions, now: "2026-07-14T12:01:00.000Z" });
      await persistFactoryRunResumeEnv(runId, { cwd: repo, pluginOptions, now: "2026-07-14T12:02:00.000Z" });

      const run = readJson(join(runDir, "run.json"));
      assert.equal(run.provenance.created.event, "created");
      assert.equal(run.provenance.last_resumed.event, "resumed");
      assert.equal(run.provenance.resume_count, 1);
      assert.equal(run.provenance.review_dispatches.length, 1);
      assert.equal(run.provenance.review_dispatches[0].dispatch.prompt_hash, promptHash);
      assert.equal(run.provenance.created.runtime.configured_models["work-reviewer"], "test/reviewer");
      assert.equal(run.provenance.review_dispatches[0].runtime.model.configured, "test/reviewer");
      assert.equal(run.provenance.review_dispatches[0].runtime.model.actual_source, "unavailable");
      assert.equal(typeof run.provenance.created.runtime.git.dirty, "boolean");
      assert.equal(JSON.stringify(run).includes(dynamicPrompt), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects provenance through an intermediate repo-seeded skill symlink", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-provenance-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "factory-provenance-outside-"));
    const runId = "provenance-symlink";
    try {
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "Test"]);
      writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "fixture"]);
      mkdirSync(join(repo, ".opencode", "factory", runId), { recursive: true });
      writeJson(join(repo, ".opencode", "factory", runId, "run.json"), {
        schema_version: 1,
        run_id: runId,
        status: "running",
        branch: "main",
        worktree: repo,
        gates: {},
      });
      mkdirSync(join(outside, "feature"), { recursive: true });
      writeFileSync(join(outside, "feature", "SKILL.md"), "outside\n", "utf8");
      writeFileSync(join(outside, "feature", "SCHEMA.md"), "outside\n", "utf8");
      symlinkSync(outside, join(repo, ".opencode", "skills"), "dir");

      await assert.rejects(
        persistFactoryRunCreatedEnv(runId, { cwd: repo, now: "2026-07-14T12:00:00.000Z" }),
        /repo-seeded feature skill must use a real path/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function git(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
