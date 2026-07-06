import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryRoots, findFactoryRoots, readRuns } from "../src/tui-data.js";

describe("TUI factory scanner", () => {
  it("finds runs in the current repo factory", () => {
    const repo = tempDir();
    writeRun(repo, "direct", { status: "running", updated_at: "2026-07-05T00:00:00Z" });

    const roots = findFactoryRoots(repo);
    const runs = readRuns(roots);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].run_id, "direct");
    cleanup(repo);
  });

  it("finds runs in nested repos under the session directory", () => {
    const workspace = tempDir();
    const nested = join(workspace, "nested-repo");
    mkdirSync(nested, { recursive: true });
    writeRun(nested, "nested", { status: "needs-human", updated_at: "2026-07-05T00:00:00Z" });

    const roots = findFactoryRoots(workspace);
    const runs = readRuns(roots);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].run_id, "nested");
    assert.equal(runs[0].status, "needs-human");
    cleanup(workspace);
  });

  it("deduplicates worktree and directory roots", () => {
    const repo = tempDir();
    writeRun(repo, "same", { status: "running", updated_at: "2026-07-05T00:00:00Z" });

    const roots = factoryRoots({ state: { path: { worktree: repo, directory: repo } } });

    assert.equal(roots.length, 1);
    cleanup(repo);
  });

  it("projects review tier summary fields from durable run.json", () => {
    const repo = tempDir();
    writeRun(repo, "strict-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      review_tier: { selected: "strict", source: "default" },
    });
    writeRun(repo, "legacy-run", { status: "running", updated_at: "2026-07-04T00:00:00Z" });

    const runs = readRuns(findFactoryRoots(repo));
    const strictRun = runs.find((run) => run.run_id === "strict-run");
    const legacyRun = runs.find((run) => run.run_id === "legacy-run");

    assert.equal(strictRun.review_tier, "strict");
    assert.equal(strictRun.review_tier_source, "default");
    assert.equal(legacyRun.review_tier, null);
    assert.equal(legacyRun.review_tier_source, null);
    cleanup(repo);
  });

  it("projects the current slice or step beside gate state", () => {
    const repo = tempDir();
    writeRun(repo, "slice-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [
        { id: "done", status: "merged", attempts: 1 },
        { id: "docs-authority-contract", status: "running", attempts: 2 },
      ],
      steps: [{ agent: "work-decomposer", status: "running", attempts: 1 }],
    });
    writeRun(repo, "step-run", {
      status: "running",
      updated_at: "2026-07-04T00:00:00Z",
      steps: [{ agent: "spec-writer", status: "running", attempts: 2 }],
    });

    const runs = readRuns(findFactoryRoots(repo));
    const sliceRun = runs.find((run) => run.run_id === "slice-run");
    const stepRun = runs.find((run) => run.run_id === "step-run");

    assert.equal(sliceRun.gate, "story");
    assert.equal(sliceRun.current, "docs-authority-contract running a2");
    assert.equal(stepRun.current, "spec-writer running a2");
    cleanup(repo);
  });
});

function tempDir() {
  return mkdtempSync(join(tmpdir(), "feature-factory-tui-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeRun(repo, id, input) {
  const dir = join(repo, ".opencode", "factory", id);
  mkdirSync(dir, { recursive: true });
  const run = {
    run_id: id,
    status: input.status,
    updated_at: input.updated_at,
    gates: { story: { status: "pending" } },
  };
  if (input.review_tier !== undefined) run.review_tier = input.review_tier;
  if (input.slices !== undefined) run.slices = input.slices;
  if (input.steps !== undefined) run.steps = input.steps;
  writeFileSync(
    join(dir, "run.json"),
    `${JSON.stringify(run, null, 2)}\n`,
  );
}
