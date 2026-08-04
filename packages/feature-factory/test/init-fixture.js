import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, validateRun } from "../state/schema.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "factory.js");

export function initFresh(operator, args) {
  const response = JSON.parse(execFileSync(process.execPath, [CLI, "init", ...args, "--repo", operator, "--json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  return {
    operator,
    repository: response.sandbox_path,
    sandboxPath: response.sandbox_path,
    runDir: response.run_dir,
    response,
  };
}

export function seedLegacyRun(repository, runId, overrides = {}) {
  const at = overrides.created_at ?? "2026-07-30T12:00:00.000Z";
  const run = {
    version: SCHEMA_VERSION,
    run_id: runId,
    issue_key: null,
    branch: `feature/${runId}`,
    worktree: ".",
    pr_base: `feature/${runId}`,
    created_at: at,
    updated_at: overrides.updated_at ?? at,
    status: "running",
    mode: "interactive",
    max_parallel_slices: 3,
    max_retries: 3,
    gates: {},
    steps: [],
    slices: [],
    validator: null,
    terminal_result: null,
    pr_url: null,
    plan_digest: null,
    ...overrides,
  };
  const omitPrBase = Object.hasOwn(overrides, "pr_base") && overrides.pr_base === undefined;
  if (omitPrBase) delete run.pr_base;
  validateRun(omitPrBase ? { ...run, pr_base: null } : run);
  const runDir = join(repository, ".factory", runId);
  for (const path of [runDir, ...["plan", "artifacts", "evidence", "reviews"].map((name) => join(runDir, name)), join(repository, ".factory", "worktrees", runId)]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return { repository, runDir, run };
}
