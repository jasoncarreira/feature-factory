import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as envSnapshot from "../src/env-snapshot.js";
import * as factory from "../src/factory.js";
import { spawnSync } from "./helpers/git-fixture.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("provenance deletion", () => {
  it("retains lifecycle diagnostics without provenance collectors or records", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-provenance-deletion-"));
    const runId = "provenance-deletion";
    const runDir = join(repo, ".opencode", "factory", runId);
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
        schema_version: 1,
        run_id: runId,
        status: "running",
        gates: {},
      }, null, 2)}\n`, "utf8");

      assert.equal(Object.hasOwn(envSnapshot, "collectEffectiveProvenance"), false);
      assert.equal(Object.hasOwn(factory, "recordReviewDispatchProvenance"), false);

      await factory.persistFactoryRunCreatedEnv(runId, { cwd: repo, pluginOptions: {}, now: "2026-07-14T12:00:00.000Z" });
      await factory.persistFactoryRunResumeEnv(runId, { cwd: repo, pluginOptions: {}, now: "2026-07-14T12:01:00.000Z" });

      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.equal(Object.hasOwn(run, "provenance"), false);
      assert.equal(run.debug_snapshot.created_with.event, "run-created");
      assert.equal(run.debug_snapshot.last_resumed_with.event, "run-resumed");
      assert.equal(run.debug_snapshot.resume_count, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not expose the provenance alias or review-dispatch command", () => {
    for (const args of [["factory", "provenance"], ["factory", "provenance", "review-dispatch", "run"]]) {
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unknown factory command: provenance/u);
    }
  });
});
