// Discovery and projection, against real directories.
//
// This package cannot spawn a process, so locating the control plane is filesystem reasoning and
// the cases that matter are structural: a linked worktree, an unreadable record, several runs at
// once. All three are built here rather than mocked, because the bug in each would be in the
// path handling that a mock would replace.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlPlaneCandidates, findControlPlane, listRuns, pollRuns, selectActiveRun } from "../observe/runs.js";
import { renderLines } from "../tui/index.js";

const RUN = (overrides = {}) => ({
  version: 1, run_id: "app-1", jira_key: null, branch: "feature/app-1", worktree: ".",
  created_at: "2026-07-30T12:00:00.000Z", updated_at: "2026-07-30T12:00:00.000Z",
  status: "running", mode: "interactive", max_parallel_slices: 3, max_retries: 3,
  gates: {}, steps: [], slices: [], validator: null, terminal_result: null, pr_url: null,
  ...overrides,
});

function repo(name) {
  const root = mkdtempSync(join(tmpdir(), `ff-tui-${name}-`));
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

function seedRun(root, runId, run) {
  const dir = join(root, ".claude", "factory", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return dir;
}

describe("control-plane discovery", () => {
  it("finds the control plane from a nested directory", () => {
    const root = repo("nested");
    try {
      seedRun(root, "app-1", RUN());
      mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true });
      assert.equal(findControlPlane(join(root, "src", "deep", "deeper")), root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resolves a linked worktree to the main repository's control plane", () => {
    // The orchestrator makes one worktree per slice, and a linked worktree has no control plane of
    // its own — `.git` is a *file* pointing into the main repository. Without following it, opening
    // the sidebar while a slice worktree is the cwd shows no run, which is exactly when an operator
    // wants one. Nothing here may shell out to `git`, so the pointer is read as text.
    const root = repo("worktree-main");
    const linked = mkdtempSync(join(tmpdir(), "ff-tui-linked-"));
    try {
      seedRun(root, "app-1", RUN());
      writeFileSync(join(linked, ".git"), `gitdir: ${join(root, ".git", "worktrees", "slice-1")}\n`);

      assert.equal(findControlPlane(linked), root, "a slice worktree must resolve to the main repo");
      assert.ok(controlPlaneCandidates(linked).includes(root), "the main repo must be a candidate");
      assert.equal(pollRuns(linked).active.run_id, "app-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("ignores a malformed or ordinary .git rather than guessing a root", () => {
    const stray = mkdtempSync(join(tmpdir(), "ff-tui-stray-"));
    try {
      writeFileSync(join(stray, ".git"), "not a gitdir pointer\n");
      assert.equal(findControlPlane(stray), null, "a malformed pointer is not a repository root");
      writeFileSync(join(stray, ".git"), "gitdir: /nowhere/useful\n");
      assert.equal(findControlPlane(stray), null, "a pointer that is not under .git/worktrees is refused");
    } finally { rmSync(stray, { recursive: true, force: true }); }
  });
});

describe("run projection", () => {
  it("prefers the live run and keeps terminal ones listed", () => {
    const root = repo("several");
    try {
      seedRun(root, "old-1", RUN({
        run_id: "old-1", status: "completed", updated_at: "2026-07-30T09:00:00.000Z",
      }));
      seedRun(root, "app-2", RUN({ run_id: "app-2", updated_at: "2026-07-30T08:00:00.000Z" }));

      const { runs, active } = pollRuns(root);
      assert.equal(runs.length, 2);
      // Newer by timestamp, but terminal: it must not become the headline.
      assert.equal(runs[0].run_id, "old-1", "listing is newest first");
      assert.equal(active.run_id, "app-2", "the still-running run is the active one");
      assert.equal(runs.find((run) => run.run_id === "old-1").terminal, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports an unreadable record instead of omitting it", () => {
    const root = repo("broken");
    try {
      const dir = join(root, ".claude", "factory", "app-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.json"), "{ not json\n");

      const runs = listRuns(root);
      assert.equal(runs.length, 1, "a broken run must still appear");
      assert.equal(runs[0].valid, false);
      assert.match(renderLines({ repo: root, runs, active: selectActiveRun(runs) }).join("\n"), /INVALID/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("surfaces the waiting gate, the slice tally, and the next action", () => {
    const root = repo("render");
    try {
      seedRun(root, "app-1", RUN({
        jira_key: "APP-1",
        gates: { story: { status: "approved", at: "2026-07-30T12:00:00.000Z", artifact: null },
          brief: { status: "pending", at: null, artifact: null } },
        slices: [
          { id: "be-one", stack: "backend", depends_on: [], status: "merged", worktree: ".", branch: "s1",
            attempts: 1, paths: ["src/"], test_plan: ["t"], base_ref: "a".repeat(40),
            evidence_ref: null, review_ref: null, merge_commit: "b".repeat(40) },
          { id: "be-two", stack: "backend", depends_on: [], status: "running", worktree: ".", branch: "s2",
            attempts: 2, paths: ["lib/"], test_plan: ["t"], base_ref: "c".repeat(40),
            evidence_ref: null, review_ref: null, merge_commit: null },
        ],
      }));

      const text = renderLines(pollRuns(root)).join("\n");
      assert.match(text, /app-1  APP-1/u);
      assert.match(text, />> gate brief is waiting on you/u, "the actionable line must stand out");
      assert.match(text, /slices 1\/2 merged/u);
      assert.match(text, /be-two {2}running \(attempt 2\)/u, "a retried slice shows its attempt");
      // Derived by the factory package, so the sidebar cannot disagree with `factory status`.
      assert.match(text, /next: gate:brief/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("says so when there is no control plane at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "ff-tui-empty-"));
    try {
      assert.deepEqual(pollRuns(empty), { repo: null, runs: [], active: null });
      assert.match(renderLines(pollRuns(empty)).join("\n"), /no control plane found/u);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe("sidebar lifecycle", () => {
  it("refreshes on demand and stops cleanly, without touching the filesystem", async () => {
    const { createSidebar } = await import("../tui/index.js");
    let polls = 0;
    const snapshot = { repo: "/repo", runs: [], active: null };
    const sidebar = createSidebar({ cwd: "/repo", intervalMs: 1000, poll: () => { polls += 1; return snapshot; } });
    try {
      assert.equal(polls, 1, "the first render happens immediately, not on the first tick");
      sidebar.refresh();
      assert.equal(polls, 2);
      assert.deepEqual(sidebar.lines(), ["/repo", "no runs recorded"]);
    } finally { sidebar.stop(); }
  });
});
