// Discovery and projection, against real directories.
//
// This package cannot spawn a process, so locating the control plane is filesystem reasoning and
// the cases that matter are structural: a linked worktree, an unreadable record, several runs at
// once. All three are built here rather than mocked, because the bug in each would be in the
// path handling that a mock would replace.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlPlaneCandidates, findControlPlane, listRuns, pollRuns, selectActiveRun } from "../observe/runs.js";
import { renderLines } from "../tui/lines.js";

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

describe("the poll loop", () => {
  it("renders immediately, refreshes on demand, and stops without hanging the process", async () => {
    const { createLineSource } = await import("../tui/poll.js");
    let polls = 0;
    const snapshot = { repo: "/repo", runs: [], active: null };
    const seen = [];
    const source = createLineSource({
      cwd: "/repo", intervalMs: 1000, onLines: (lines) => seen.push(lines),
      poll: () => { polls += 1; return snapshot; },
    });
    try {
      assert.equal(polls, 1, "the first render happens immediately, not on the first tick");
      assert.equal(seen.length, 1, "and is published to the consumer");
      source.refresh();
      assert.equal(polls, 2);
      assert.deepEqual(source.lines(), ["/repo", "no runs recorded"]);
    } finally { source.stop(); }
  });

  it("turns a scan failure into content rather than throwing into the render loop", async () => {
    const { createLineSource } = await import("../tui/poll.js");
    const source = createLineSource({
      cwd: "/repo", intervalMs: 60_000,
      poll: () => { throw new Error("state vanished mid-tick"); },
    });
    try {
      assert.deepEqual(source.lines(), ["sidebar error: state vanished mid-tick"]);
    } finally { source.stop(); }
  });
});

describe("the host registration contract", () => {
  // Two wrong adapters passed every test before this: one with the wrong outer shape, one that called
  // `api.render`/`api.update` — neither exists — and registered no slot at all. A shape check cannot
  // tell a real host API from an invented one, so this asserts what the adapter *calls on the api*.
  //
  // Imported from tui/dist, because that is the artifact the host loads. Testing the JSX source would
  // pass while a broken build shipped.
  function fakeApi() {
    const calls = { registered: [], disposers: [] };
    return {
      calls,
      slots: { register(config) { calls.registered.push(config); } },
      lifecycle: { onDispose(fn) { calls.disposers.push(fn); } },
    };
  }

  it("registers a sidebar_content slot, from the built bundle", async () => {
    const entry = (await import("../tui/dist/index.js")).default;
    assert.equal(typeof entry, "object", "the host requires a default object, not a function");
    assert.equal(typeof entry.tui, "function", "carrying a tui() hook");

    const api = fakeApi();
    entry.tui(api, { directory: "/nowhere-at-all", intervalMs: 60_000 });
    assert.equal(api.calls.registered.length, 1, "content is contributed by registering a slot");
    assert.equal(typeof api.calls.registered[0].slots?.sidebar_content, "function",
      "the slot must be named sidebar_content; any other name contributes nothing");

    // The slot is deliberately NOT invoked. Its intrinsic elements need a live OpenTUI renderer, so
    // calling it here fails with "No renderer found" — the honest boundary of what this suite can
    // prove. Whether the component actually paints is a dogfood question, and the reactive machinery
    // it depends on is tested in ./poll.js instead.
  });

  it("keeps the reactive shell out of the bundle so the host's solid instance is used", async () => {
    // Module identity, not version equality: bundling solid would give the sidebar its own reactive
    // graph, which repaints nothing and looks exactly like the bug this replaced.
    // Every built file, concatenated. The chunk name is content-hashed, so naming one would break on
    // the next source edit — and worse, would pass by reading a file that no longer holds the shell.
    const dist = new URL("../tui/dist/", import.meta.url);
    const bundle = readdirSync(dist)
      .filter((entry) => entry.endsWith(".js"))
      .map((entry) => readFileSync(new URL(entry, dist), "utf8"))
      .join("\n");
    assert.match(bundle, /from ?"solid-js"/u, "solid-js must stay an import, not be inlined");
    assert.match(bundle, /@opentui\/solid/u, "the jsx runtime must stay an import");
    assert.equal(/function createSignal\(/u.test(bundle), false, "solid's implementation must not be inlined");

    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const peer of ["solid-js", "@opentui/solid"]) {
      assert.ok(manifest.peerDependencies?.[peer], `${peer} must be a peer dependency, not a bundled copy`);
      assert.equal(manifest.dependencies?.[peer], undefined, `${peer} must not also be a direct dependency`);
    }
  });
});
