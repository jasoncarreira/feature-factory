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
import { CONTROL_PLANE } from "feature-factory";
import { findControlPlane, listRuns, pollRuns, repositoryRoots, selectActiveRun } from "../observe/runs.js";
import { renderLines } from "../tui/lines.js";
import { ORDER, SLOT } from "../tui/sidebar-config.js";

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
  const dir = join(root, ".factory", runId);
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
      assert.equal(findControlPlane(join(root, "src", "deep", "deeper")).repo, root);
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

      assert.equal(findControlPlane(linked).repo, root, "a slice worktree must resolve to the main repo");
      assert.deepEqual(repositoryRoots(linked), [linked, root], "itself first, then the main repository");
      assert.equal(pollRuns(linked).active.run_id, "app-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("never looks above the repository, even when an ancestor has a .factory", () => {
    // Found by opening the sidebar for real: `~/.factory` exists — another tool's — so walking up for
    // the first ancestor with a control plane matched the home directory and rendered its `skills/`
    // subfolder as a broken run. The rename from `.claude/factory` to `.factory` made it likely; a
    // two-segment path rarely exists by accident in a home directory, a single dotfile does.
    const outer = mkdtempSync(join(tmpdir(), "ff-tui-ancestor-"));
    try {
      // An ancestor that looks like a control plane, and a repository beneath it that has none.
      mkdirSync(join(outer, CONTROL_PLANE, "skills"), { recursive: true });
      const inner = join(outer, "repo");
      mkdirSync(join(inner, ".git"), { recursive: true });
      mkdirSync(join(inner, "src"), { recursive: true });

      assert.deepEqual(repositoryRoots(join(inner, "src")), [inner], "the repository bounds the search");
      assert.equal(findControlPlane(join(inner, "src")).repo, null,
        "an ancestor's .factory is not this repository's control plane");
      assert.deepEqual(pollRuns(join(inner, "src")),
        { repo: null, runs: [], active: null, searched: [inner] });
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  it("tries every location the host reports, and says which it checked", () => {
    // The host's TUI state carries four paths — `state`, `config`, `worktree`, `directory` — and
    // which one holds the run is not ours to decide. Passing only `directory` rendered "no runs"
    // through an entire live run whose control plane was under `worktree`, and a bare "no runs" gave
    // no way to tell a wrong directory from a broken plugin. Both halves are fixed here: try the
    // candidates in order, and report where you looked when you find nothing.
    const withRun = repo("candidate-b");
    const without = repo("candidate-a");
    try {
      seedRun(withRun, "app-1", RUN());

      const found = pollRuns([without, withRun]);
      assert.equal(found.repo, withRun, "the second candidate wins when the first has no control plane");
      assert.equal(found.active.run_id, "app-1");
      assert.deepEqual(found.searched, [without, withRun], "in order, first hit last");

      const empty = pollRuns([without]);
      assert.equal(empty.repo, null);
      assert.deepEqual(renderLines(empty), ["no runs", `searched ${without}`],
        "an empty sidebar names the directory, because that is the whole diagnosis");

      // A single string still works — every other caller passes one.
      assert.equal(pollRuns(withRun).repo, withRun);
    } finally {
      rmSync(withRun, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    }
  });

  it("prefers a linked worktree's own control plane over the main repository's", () => {
    // Found during a real run, and caused by the previous fix. A slice worktree has no control plane
    // of its own, so it must resolve to the main repository — but a linked worktree used as the
    // *project* root does have one, because `factory init` writes to the directory it runs in.
    // Resolving only to the main repository reported "no runs" while a valid run sat in the worktree.
    const main = repo("linked-own");
    const linked = mkdtempSync(join(tmpdir(), "ff-tui-linked-own-"));
    try {
      writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
      seedRun(main, "in-main", RUN({ run_id: "in-main" }));
      seedRun(linked, "in-worktree", RUN({ run_id: "in-worktree" }));

      assert.equal(findControlPlane(linked).repo, linked, "the worktree's own run is the one being driven");
      assert.equal(pollRuns(linked).active.run_id, "in-worktree");

      // And with nothing of its own, it still falls back — the slice-worktree case.
      rmSync(join(linked, CONTROL_PLANE), { recursive: true, force: true });
      assert.equal(findControlPlane(linked).repo, main, "a slice worktree resolves to the main repository");
      assert.equal(pollRuns(linked).active.run_id, "in-main");
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("does not report a directory without a manifest as a broken run", () => {
    // The other half of the same sighting: `skills` has no run.json, and it was rendered as
    // `skills INVALID` with an ENOENT. A directory with no manifest is not a failed run; it is not a
    // run. A manifest that exists and does not parse still is.
    const root = repo("no-manifest");
    try {
      mkdirSync(join(root, CONTROL_PLANE, "skills"), { recursive: true });
      mkdirSync(join(root, CONTROL_PLANE, "processes"), { recursive: true });
      assert.deepEqual(listRuns(root), [], "directories without a manifest are not runs");

      seedRun(root, "app-1", RUN());
      assert.deepEqual(listRuns(root).map((run) => run.run_id), ["app-1"],
        "and a real run alongside them is still found");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores a malformed or ordinary .git rather than guessing a root", () => {
    const stray = mkdtempSync(join(tmpdir(), "ff-tui-stray-"));
    try {
      writeFileSync(join(stray, ".git"), "not a gitdir pointer\n");
      assert.equal(findControlPlane(stray).repo, null, "a malformed pointer is not a repository root");
      writeFileSync(join(stray, ".git"), "gitdir: /nowhere/useful\n");
      assert.equal(findControlPlane(stray).repo, null, "a pointer that is not under .git/worktrees is refused");
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
      const dir = join(root, ".factory", "app-1");
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
      assert.match(text, /slices 1\/2 merged/u);
      assert.match(text, /be-two {2}running \(attempt 2\)/u, "a retried slice shows its attempt");
      // Derived by the factory package, so the sidebar cannot disagree with `factory status`, and
      // marked because an undecided gate is what an operator acts on. One line, not two: the mark
      // used to be a separate `>> gate brief is waiting on you`, which restated `next` and claimed
      // more than the state knows — a gate is `pending` from the moment its stage opens, so it read
      // "waiting on you" while the artifact was still being written.
      assert.match(text, />> next: gate:brief/u, "the actionable line must stand out");
      assert.equal(text.match(/brief/gu).length, 1, "the waiting gate is reported once, not twice");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("says so when there is no control plane at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "ff-tui-empty-"));
    try {
      // Outside a repository there is no candidate root at all, so there is nothing to name — one
      // line, unlike the in-a-repository-but-no-control-plane case above.
      assert.deepEqual(pollRuns(empty), { repo: null, runs: [], active: null, searched: [] });
      assert.deepEqual(renderLines(pollRuns(empty)), ["no runs"], "one line when there is no root to report");
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
      assert.deepEqual(source.lines(), ["no runs"]);
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

    // The other half, and the one that actually cost a sidebar. The predecessor's note on this:
    // "a factory cleanup deleting run state mid-tick — exactly the transition to 'no current runs' —
    // could propagate an exception into the host interval or slot render and freeze the sidebar
    // until restart." Guarding the scan is not enough, because publishing writes a signal and the
    // host's reconciler runs downstream of that write, inside this callback. A throw there leaves
    // the last frame on screen with the timer still ticking — indistinguishable from a dead plugin.
    let ticks = 0;
    const brittle = createLineSource({
      cwd: "/repo", intervalMs: 60_000,
      poll: () => ({ repo: "/repo", runs: [], active: null, searched: ["/repo"] }),
      onLines: () => { ticks += 1; throw new Error("reconciler blew up"); },
    });
    try {
      assert.equal(ticks, 1, "the first publish is attempted");
      assert.doesNotThrow(() => brittle.refresh(), "a failed publish must not reach the host's interval");
      assert.equal(ticks, 2, "and the loop keeps publishing after one throws");
      // A control plane that exists and holds nothing: one line, no `searched` — that is reported
      // only when no control plane was found at all.
      assert.deepEqual(brittle.lines(), ["no runs"], "the scan result is still current");
    } finally { brittle.stop(); }
  });
});

describe("the host registration contract", () => {
  // Two wrong adapters passed every test before this: one with the wrong outer shape, one that called
  // `api.render`/`api.update` — neither exists — and registered no slot at all. A shape check cannot
  // tell a real host API from an invented one, so this asserts what the adapter *calls on the api*.
  //
  // Imported from tui/dist, because that is the artifact the host loads. Testing the JSX source would
  // pass while a broken build shipped.
  // Shaped like the host, and deliberately *without* the fields the adapter used to read. `options`
  // carries no directory in reality, so a fake that supplied one would have let the wrong source pass.
  function fakeApi(directory = "/nowhere-at-all") {
    const calls = { registered: [], disposers: [] };
    return {
      calls,
      state: { path: { directory, worktree: `${directory}/wt` } },
      theme: { current: { warning: "amber" } },
      lifecycle: { onDispose(fn) { calls.disposers.push(fn); } },
      slots: { register(config) { calls.registered.push(config); } },
    };
  }

  it("registers a sidebar_content slot, from the built bundle", async () => {
    const entry = (await import("../tui/dist/index.js")).default;
    assert.equal(typeof entry, "object", "the host requires a default object, not a function");
    assert.equal(typeof entry.tui, "function", "carrying a tui() hook");

    const api = fakeApi();
    entry.tui(api, { intervalMs: 60_000 });
    assert.equal(api.calls.registered.length, 1, "content is contributed by registering a slot");
    assert.equal(typeof api.calls.registered[0].slots?.[SLOT], "function",
      `the panel must contribute to ${SLOT}; any other name contributes nothing`);
    // The host renders MCP and LSP itself, so `order` cannot place the panel below them — the slot
    // choice does. Asserted so a silent revert to sidebar_content is visible.
    assert.equal(ORDER, 450, "100 was too low: the host's MCP and LSP sections sort between 100 and 450");

    // Ordering and the header are host-facing and invisible to renderLines, so they are asserted from
    // the registration and the built bundle rather than by rendering.
    assert.equal(api.calls.registered[0].order, ORDER,
      "the order must place the panel after the host's internal sections");

    // The slot is deliberately NOT invoked: its intrinsic elements need a live OpenTUI renderer, so
    // calling it here fails with "No renderer found". That is the honest boundary of this suite —
    // whether the component paints is a dogfood question, and the machinery it depends on is tested
    // in ./poll.js.
  });

  it("takes the directory and theme from the host, not from plugin options", async () => {
    // Both were read from `options`, which OpenCode never populates with either. The directory then
    // fell back to `process.cwd()` — the host process, not the repository — so the sidebar would have
    // reported "no control plane found" forever, indistinguishable from a broken slot. Asserted by
    // source text because the component cannot be instantiated to observe its props.
    const bundle = readFileSync(new URL("../tui/dist/index.js", import.meta.url), "utf8");
    assert.match(bundle, /api\.state\.path\.directory/u,
      "the working directory must come from api.state.path.directory");
    assert.match(bundle, /ctx\.theme|theme:\s*\w+\.theme/u, "the theme must come from the slot context");
    assert.equal(/options\.directory|options\.cwd|options\.theme/u.test(bundle), false,
      "options is user configuration; it carries neither the directory nor the theme");
    // And the theme is read through `.current`, so a theme change recolours instead of being frozen
    // at mount by a one-time spread.
    assert.match(bundle, /theme\?\.current|theme\.current/u, "the theme must be read reactively");
    assert.match(bundle, /Feature Factory/u, "the panel carries its own header; the host's sidebar_title is the session's");
  });

  it("holds its state in the hook and recreates the subtree, so a change reaches the screen", async () => {
    // The structure, asserted because every wrong version of it passed this suite. Holding the signal
    // inside the component is reactively correct and painted only its first frame: the host invokes
    // the slot once, and a `<For>` reconciling text nodes in place inside that child never reached the
    // screen. So the signals live in the hook, the *slot function* reads them — giving the host
    // something to re-run — and a keyed `Show` on a monotonic counter recreates the subtree instead of
    // reconciling it. All three are invisible to renderLines and cannot be rendered here, so they are
    // asserted from the built bundle, the same boundary the directory and theme use.
    const bundle = readFileSync(new URL("../tui/dist/index.js", import.meta.url), "utf8");
    assert.match(bundle, /createSignal\(\[\], \{ equals: false \}\)/u,
      "the lines signal lives in the hook, and does not suppress equal-looking updates");
    assert.match(bundle, /keyed/u, "a keyed Show is what recreates the subtree; without it nothing repaints");
    assert.match(bundle, /setVersion|version/u, "a monotonic value must exist for the keyed Show to key on");

    // And the poll is started by the hook, not by the component, so it is running before the slot is
    // ever invoked — and it is handed to the host's own disposal hook rather than a component cleanup.
    const api = fakeApi();
    (await import("../tui/dist/index.js")).default.tui(api, { intervalMs: 60_000 });
    assert.equal(api.calls.disposers.length, 1, "the poll must be registered for host disposal");
    assert.doesNotThrow(() => api.calls.disposers[0](), "and disposing it must not throw");
  });

  it("keeps the reactive shell out of the bundle so the host's solid instance is used", async () => {
    // Module identity, not version equality: bundling solid would give the sidebar its own reactive
    // graph, which repaints nothing and looks exactly like the bug this replaced.
    // One bundle, one file. It was three with content-hashed chunk names, which meant a stale build
    // could leave a file this test read instead of the current one.
    const dist = readdirSync(new URL("../tui/dist/", import.meta.url));
    assert.deepEqual(dist, ["index.js"], "the sidebar must build to exactly one file");
    const bundle = readFileSync(new URL("../tui/dist/index.js", import.meta.url), "utf8");
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

describe("registering the workflow with the host", () => {
  // The gap that made a dogfood run fail: the operator was left to install a skill and eleven agents
  // by hand, and when they had not, the run loaded a stale skill from a previous era and began
  // reverse-engineering how to hand-write run.json. Registration through the `config` hook removes the
  // install step entirely — and writes nothing, so it needs no exemption from the boundary test.
  async function configured(options = {}) {
    const plugin = (await import("../plugin/index.js")).default;
    const hooks = await plugin({}, options);
    const cfg = {};
    await hooks.config(cfg);
    return cfg;
  }

  it("registers the command, the skill path, and every agent the skill dispatches", async () => {
    const cfg = await configured();
    assert.equal(cfg.command.feature.agent, "feature-factory", "the command runs as the orchestrator");

    // The host discovers a skill from a directory, so the path must be the one the package ships.
    assert.equal(cfg.skills.paths.length, 1);
    assert.match(cfg.skills.paths[0], /feature-factory\/skills$/u);
    const shipped = readdirSync(new URL("../../feature-factory/agents/", import.meta.url))
      .filter((entry) => entry.endsWith(".md")).map((entry) => entry.replace(/\.md$/u, ""));
    for (const name of shipped) {
      assert.ok(cfg.agent[name], `${name} must be registered, or a task call for it fails`);
    }
    assert.equal(Object.keys(cfg.agent).length, shipped.length + 1, "the agents plus one orchestrator");
  });

  it("translates Claude Code frontmatter into an opencode agent", async () => {
    const cfg = await configured();
    const agent = cfg.agent["backend-builder"];
    // The prose is host-agnostic; the frontmatter is not. `mode` and `permission` are opencode's.
    assert.equal(agent.mode, "subagent");
    assert.equal(agent.permission.edit, "allow");
    assert.ok(agent.description.length > 40, "the folded description block must be parsed, not dropped");
    assert.ok(agent.prompt.includes("Stay in your lane"), "the body becomes the prompt");
    assert.equal(agent.prompt.startsWith("---"), false, "frontmatter must not leak into the prompt");
    // `model: sonnet` is Claude Code's, not an opencode model id, so it must not be passed through.
    assert.equal(agent.model, undefined, "a foreign model id would fail to resolve");
  });

  it("derives each agent's permissions from the tools it declares", async () => {
    // Flattening this was a real defect: every subagent got `edit: allow`, including
    // `implementation-validator`, whose prompt says "Read-only: no edits, no commits", and
    // `work-reviewer` — so a reviewer could modify the code it was judging. Separating the party
    // being judged from the party judging is the premise of the chain.
    const cfg = await configured();
    const editors = Object.entries(cfg.agent)
      .filter(([name, agent]) => name !== "feature-factory" && agent.permission.edit === "allow")
      .map(([name]) => name).sort();
    assert.deepEqual(editors, ["backend-builder", "frontend-builder", "test-verifier"],
      "only the agents that write code may edit; a judge with edit rights can make its subject pass");

    // And the ones that declare no shell get none, so a reader cannot run a build.
    for (const name of ["spec-writer", "story-writer", "story-reader", "design-interpreter"]) {
      assert.equal(cfg.agent[name].permission.bash, "deny", `${name} declares no Bash`);
    }
    assert.equal(cfg.agent["work-reviewer"].permission.bash, "allow",
      "a reviewer may run the tests it judges, but not change them");
  });

  it("resolves a model through agent, then role, then default, then one-for-all", async () => {
    // Ported from the predecessor, which had a better vocabulary than the tier map I first wrote.
    // Against a real configuration, five of seven roles were uniform and the two that were not are
    // exactly what the per-agent level exists for — and a new agent inherits its role rather than
    // needing a new entry.
    const cfg = await configured({ profiles: {
      "work-reviewer": { model: "exact/agent" },
      reviewer: { model: "by/role", variant: "xhigh" },
      default: { model: "the/default" },
    }, profile: { model: "one/for-all" } });

    assert.equal(cfg.agent["work-reviewer"].model, "exact/agent", "the agent's own entry wins");
    assert.equal(cfg.agent["implementation-validator"].model, "by/role", "then its role");
    assert.equal(cfg.agent["implementation-validator"].variant, "xhigh", "role sets variant too");
    assert.equal(cfg.agent["spec-writer"].model, "the/default", "then the default");

    const only = await configured({ profile: { model: "one/for-all" } });
    assert.equal(only.agent["spec-writer"].model, "one/for-all", "then a single profile for everything");
  });

  it("uses the agent's declared effort when no profile sets a variant", async () => {
    // The agent knows how hard its own job is; a profile may still override it.
    const bare = await configured();
    assert.equal(bare.agent["spec-writer"].variant, "xhigh", "spec-writer declares xhigh");
    assert.equal(bare.agent["story-reader"].variant, "low", "story-reader declares low");
    assert.equal(bare.agent["spec-writer"].model, undefined, "and no model is invented");

    const overridden = await configured({ profiles: { planning: { variant: "medium" } } });
    assert.equal(overridden.agent["spec-writer"].variant, "medium", "a profile overrides the declaration");
  });

  it("declares a role for every agent, so none falls through to the default", async () => {
    // The role lives in frontmatter rather than a table here, because a table drifts from the agent
    // set — an agent with no role would silently skip the role level of the chain.
    const dir = new URL("../../feature-factory/agents/", import.meta.url);
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const text = readFileSync(new URL(file, dir), "utf8");
      assert.match(text, /^role:\s*\S+/mu, `${file} must declare a role`);
    }
  });

  it("lets a project configure agents without being overwritten", async () => {
    // The host merges a repository's opencode.json before this hook runs, so anything already in the
    // config is the project's choice and must win. This used to assign unconditionally, which
    // discarded it silently — the reason per-project configuration appeared impossible.
    const plugin = (await import("../plugin/index.js")).default;
    const hooks = await plugin({}, { profiles: {
      default: { model: "vendor/default" },
      "work-reviewer": { model: "vendor/from-profile" },
    } });
    const cfg = { agent: { "work-reviewer": { model: "project/choice", variant: "low" } } };
    await hooks.config(cfg);
    assert.equal(cfg.agent["work-reviewer"].model, "project/choice", "the project outranks profile and default");
    assert.equal(cfg.agent["work-reviewer"].variant, "low");
    assert.equal(cfg.agent["spec-writer"].model, "vendor/default", "agents it did not mention keep the default");
  });

  it("refuses to let configuration grant a judge edit rights or delegation", async () => {
    // Model and effort are preferences. Who may edit is not: a reviewer that can change the code it
    // judges breaks the separation the chain is built on, and a delegating subagent makes the tree
    // unbounded. Configuration cannot reach either.
    const plugin = (await import("../plugin/index.js")).default;
    const hooks = await plugin({}, {});
    const cfg = { agent: { "implementation-validator": { permission: { edit: "allow", task: "allow" } } } };
    await hooks.config(cfg);
    assert.equal(cfg.agent["implementation-validator"].permission.edit, "deny");
    assert.equal(cfg.agent["implementation-validator"].permission.task, "deny");
  });

  it("lets an operator profile set the model but never grant delegation", async () => {
    // One level of orchestration is a property of the chain. An operator's profile may choose models —
    // theirs already does — but a subagent that can dispatch turns the tree unbounded.
    const cfg = await configured({ profiles: {
      "work-reviewer": { model: "openai/gpt-5.6-sol", permission: { task: "allow" } },
    } });
    assert.equal(cfg.agent["work-reviewer"].model, "openai/gpt-5.6-sol", "profiles set the model");
    assert.equal(cfg.agent["work-reviewer"].permission.task, "deny", "and cannot re-enable delegation");
    assert.equal(cfg.agent["feature-factory"].permission.task, "allow", "only the orchestrator delegates");
  });
});
