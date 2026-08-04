// Discovery and projection, against real directories.
//
// This package cannot spawn a process, so locating the control plane is filesystem reasoning and
// the cases that matter are structural: a linked worktree, an unreadable record, several runs at
// once. All three are built here rather than mocked, because the bug in each would be in the
// path handling that a mock would replace.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTROL_PLANE } from "feature-factory";
import { findControlPlane, listRuns, pollRuns, repositoryRoots } from "../observe/runs.js";
import { registerAgents } from "../plugin/config.js";
import plugin from "../plugin/index.js";
import { renderLines } from "../tui/lines.js";
import { runCommands } from "../tui/commands.js";
import { ORDER, SLOT } from "../tui/sidebar-config.js";
import { LEGACY_RUN_MANIFESTS } from "../../../test/fixtures/legacy-run-manifests.js";

const RUN = (overrides = {}) => ({
  version: 1, run_id: "app-1", issue_key: null, branch: "feature/app-1", worktree: ".",
  created_at: "2026-07-30T12:00:00.000Z", updated_at: "2026-07-30T12:00:00.000Z",
  status: "running", mode: "interactive", max_parallel_slices: 3, max_retries: 3,
  gates: {}, steps: [], slices: [], validator: null, terminal_result: null, pr_url: null,
  ...overrides,
});

function repo(name) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ff-tui-${name}-`)));
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

// The container convention necessarily exists twice: the skill's shell *creates* it, and
// `observe/runs.js` *reads* it, and the packages cannot share the value — this one may not import the
// factory package for a path and may not spawn git. This helper used to be a third copy, which meant
// the tests could agree with the reader while both drifted from the skill. It is now derived from the
// skill's own formula, so every test that seeds a sandbox couples all three: if the skill and the
// reader disagree, seeding lands somewhere discovery does not look and those tests fail.
//
// Drift here is silent and asymmetric — the run works, the sidebar reports "no runs" — which cost two
// separate debugging rounds before the container even existed.
const CONTAINER_FORMULA = (() => {
  const skill = readFileSync(new URL("../../feature-factory/skills/feature/SKILL.md", import.meta.url), "utf8");
  const formula = /^C\s*=\s*(\S+)\s*$/mu.exec(skill)?.[1];
  if (!formula) throw new Error("SKILL.md must state the sandbox container path as `C = <formula>`");
  return formula;
})();

function sandboxContainer(root) {
  const match = /^O\/(.+)$/u.exec(CONTAINER_FORMULA);
  if (!match) throw new Error("SKILL.md sandbox container formula must have the form `O/<relative-path>`");
  return join(root, match[1]);
}

function searchedLocations(...roots) {
  return roots.flatMap((root) => [join(root, CONTROL_PLANE), sandboxContainer(root)])
    .sort((left, right) => left.localeCompare(right));
}

function seedRun(root, runId, run) {
  const dir = join(root, ".factory", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return dir;
}

function seedRunBytes(root, runId, bytes) {
  const dir = join(root, ".factory", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), bytes);
  return dir;
}

function seedSandbox(root, runId, run) {
  const sandbox = join(sandboxContainer(root), runId);
  return { sandbox, dir: seedRun(sandbox, runId, run) };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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
    const linked = realpathSync(mkdtempSync(join(tmpdir(), "ff-tui-linked-")));
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
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "ff-tui-ancestor-")));
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
        { repo: null, runs: [], active: null, searched: searchedLocations(inner) });
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
      assert.deepEqual(found.searched, searchedLocations(without, withRun),
        "[AC7] every accepted root contributes both bounded checked locations");

      const empty = pollRuns([without]);
      assert.equal(empty.repo, null);
      assert.deepEqual(renderLines(empty), ["no runs", ...searchedLocations(without).map((path) => `searched ${path}`)],
        "[AC7] an empty sidebar names every bounded checked location");

      // A single string still works — every other caller passes one.
      assert.equal(pollRuns(withRun).repo, withRun);
    } finally {
      rmSync(withRun, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    }
  });

  it("unions a linked worktree's own and main control planes [AC6, AC15]", () => {
    // Found during a real run, and caused by the previous fix. A slice worktree has no control plane
    // of its own, so it must resolve to the main repository — but a linked worktree used as the
    // *project* root does have one, because `factory init` writes to the directory it runs in.
    // Resolving only to the main repository reported "no runs" while a valid run sat in the worktree.
    const main = repo("linked-own");
    const linked = realpathSync(mkdtempSync(join(tmpdir(), "ff-tui-linked-own-")));
    try {
      writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
      seedRun(main, "in-main", RUN({ run_id: "in-main", updated_at: "2026-07-30T11:00:00.000Z" }));
      seedRun(linked, "in-worktree", RUN({ run_id: "in-worktree", updated_at: "2026-07-30T13:00:00.000Z" }));

      assert.equal(findControlPlane(linked).repo, linked, "[AC6] legacy lookup still accepts the worktree's own plane");
      assert.equal(pollRuns(linked).active.run_id, "in-worktree", "[AC15] the newest valid live run headlines");
      assert.deepEqual(pollRuns(linked).runs.map((run) => run.run_id), ["in-worktree", "in-main"],
        "[AC6] own and linked-main manifests remain in the canonical union");

      // And with nothing of its own, it still falls back — the slice-worktree case.
      rmSync(join(linked, CONTROL_PLANE), { recursive: true, force: true });
      assert.equal(findControlPlane(linked).repo, main, "[AC6] a slice worktree resolves to the main repository");
      assert.equal(pollRuns(linked).active.run_id, "in-main", "[AC6] linked-main fallback remains discoverable");
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

  it("reads the container the skill creates, stated once and derived here", () => {
    // Names the coupling the other tests rely on implicitly. The skill is the authority — it is what
    // the orchestrator runs — so discovery is required to agree with it, not the reverse. If the
    // formula changes in SKILL.md and `sandboxContainer()` in observe/runs.js does not follow, a run
    // creates its sandbox where nothing looks and the sidebar reports "no runs" while it works.
    const root = repo("convention");
    try {
      const container = sandboxContainer(root);
      assert.equal(container, join(root, ".factory-sandboxes"),
        "the skill's formula must still resolve to the documented shape");

      const seeded = seedSandbox(root, "conv-1", RUN({ run_id: "conv-1" }));
      assert.equal(dirname(seeded.sandbox), container, "seeding uses the skill-derived container");
      assert.deepEqual(pollRuns(root).runs.map((run) => run.run_id), ["conv-1"],
        "discovery must read the container the skill creates");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("discovers only literal direct in-repository sandbox manifests [AC5, AC6, AC7]", () => {
    const root = repo("in-repository");
    const container = sandboxContainer(root);
    const linkedTarget = realpathSync(mkdtempSync(join(tmpdir(), "ff-tui-linked-sandbox-")));
    try {
      seedRun(root, "same-id", RUN({ run_id: "same-id", updated_at: "2026-07-30T10:00:00.000Z" }));
      const sandbox = seedSandbox(root, "same-id",
        RUN({ run_id: "same-id", updated_at: "2026-07-30T11:00:00.000Z" }));
      seedSandbox(root, "wrong-dir", RUN({ run_id: "actual-id" }));
      seedRun(join(container, "nested", "deeper"), "deep", RUN({ run_id: "deep" }));
      seedRun(linkedTarget, "linked-run", RUN({ run_id: "linked-run" }));
      symlinkSync(linkedTarget, join(container, "linked-run"), "dir");

      const snapshot = pollRuns(root);
      assert.deepEqual(snapshot.runs.map((run) => [run.run_id, run.source, run.valid]), [
        ["same-id", "sandbox", true],
        ["same-id", "local", true],
        ["wrong-dir", "sandbox", false],
      ], "[AC5, AC6] same-ID manifests remain distinct while deep and symlink children are rejected");

        // The container itself, not a child. `readdirSync` resolves a symlinked container, so
        // traversal crosses it before any Dirent is examined — which is exactly why the linked
        // *child* above was already rejected while a linked container was followed. A pre-existing
        // `<repo>/.factory-sandboxes -> elsewhere` made the sidebar enumerate another directory and
        // report its manifests as this repository's runs, recreating the unrelated-control-plane
        // failure the derived location exists to prevent.
        const foreign = realpathSync(mkdtempSync(join(tmpdir(), "ff-tui-foreign-")));
        const swapped = repo("swapped-container");
        try {
          seedRun(join(foreign, "foreign-run"), "foreign-run", RUN({ run_id: "foreign-run" }));
          symlinkSync(foreign, sandboxContainer(swapped), "dir");
          assert.deepEqual(pollRuns(swapped).runs.map((run) => run.run_id), [],
            "[AC7] a symlinked sandbox container is refused rather than followed");
        } finally {
          rmSync(swapped, { recursive: true, force: true });
          rmSync(foreign, { recursive: true, force: true });
        }
      assert.equal(snapshot.runs[0].sandbox_path, sandbox.sandbox,
        "[AC5] a sandbox record carries its absolute sandbox path");
      assert.equal(snapshot.runs[0].manifest_path, realpathSync(join(sandbox.dir, "run.json")),
        "[AC6] a record carries its canonical manifest path");
      assert.equal(snapshot.runs[1].sandbox_path, null, "[AC6] a legacy local record remains local");
      assert.match(snapshot.runs[2].error, /does not match sandbox directory/u,
        "[AC5] a run_id mismatch is invalid rather than accepted");
      assert.deepEqual(snapshot.searched, searchedLocations(root),
        "[AC7] the local plane and one literal in-repository container are the complete search set");
    } finally {
      rmSync(container, { recursive: true, force: true });
      rmSync(linkedTarget, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a malformed or ordinary .git rather than guessing a root", () => {
    const stray = realpathSync(mkdtempSync(join(tmpdir(), "ff-tui-stray-")));
    try {
      writeFileSync(join(stray, ".git"), "not a gitdir pointer\n");
      assert.equal(findControlPlane(stray).repo, null, "a malformed pointer is not a repository root");
      writeFileSync(join(stray, ".git"), "gitdir: /nowhere/useful\n");
      assert.equal(findControlPlane(stray).repo, null, "a pointer that is not under .git/worktrees is refused");
    } finally { rmSync(stray, { recursive: true, force: true }); }
  });
});

describe("run projection", () => {
  it("prioritizes an older gate-waiting run without requiring a lock or session", () => {
    const root = repo("gate-priority");
    try {
      seedRun(root, "ordinary-newer", RUN({
        run_id: "ordinary-newer", issue_key: "APP-2", updated_at: "2026-07-30T12:00:00.000Z",
      }));
      const waiting = seedSandbox(root, "waiting-older", RUN({
        run_id: "waiting-older", issue_key: "APP-1", updated_at: "2026-07-30T11:00:00.000Z",
        gates: { story: { status: "pending", at: null, artifact: null } },
      }));

      const snapshot = pollRuns(root);
      assert.deepEqual(snapshot.runs.map((run) => run.run_id), ["ordinary-newer", "waiting-older"]);
      assert.equal(snapshot.active, snapshot.runs[1], "the explicit active run may differ from the first sorted run");
      assert.equal(snapshot.active.awaiting_gate, "story");
      assert.equal(snapshot.active.deadLock, false, "a missing lock does not prevent gate priority");
      assert.equal(snapshot.active.session, null, "a missing session does not prevent gate priority");
      assert.deepEqual(renderLines(snapshot), [
        "waiting-older  APP-1",
        "running  interactive  feature/app-1",
        ">> next: gate:story",
        `sandbox: ${waiting.sandbox}`,
        "ordinary-newer  APP-2",
        "next: gate:story",
      ]);
      assert.deepEqual(runCommands(snapshot.runs, { navigate() {} }).map((command) => command.value), [],
        "visible sessionless runs remain unavailable for navigation");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prioritizes a gate-waiting nonterminal over a newer terminal run", () => {
    const root = repo("gate-over-terminal");
    try {
      seedRun(root, "terminal-newer", RUN({
        run_id: "terminal-newer", status: "completed", updated_at: "2026-07-30T13:00:00.000Z",
      }));
      seedRun(root, "waiting-older", RUN({
        run_id: "waiting-older", updated_at: "2026-07-30T11:00:00.000Z",
        gates: { brief: { status: "pending", at: null, artifact: null } },
      }));

      const snapshot = pollRuns(root);
      assert.equal(snapshot.active.run_id, "waiting-older");
      assert.deepEqual(renderLines(snapshot), [
        "waiting-older",
        "running  interactive  feature/app-1",
        ">> next: gate:story",
        "(1 other run)",
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prefers the live run and keeps terminal ones listed", () => {
    const root = repo("several");
    try {
      seedRun(root, "old-1", RUN({
        run_id: "old-1", status: "completed", updated_at: "2026-07-30T09:00:00.000Z",
      }));
      seedRun(root, "app-2", RUN({
        run_id: "app-2", updated_at: "2026-07-30T08:00:00.000Z", pr_base: "integration",
      }));

      const snapshot = pollRuns(root);
      const { runs, active } = snapshot;
      assert.equal(runs.length, 2);
      assert.deepEqual(runs.map((run) => [run.run_id, run.valid]), [["app-2", true], ["old-1", true]],
        "[AC6, AC15] valid live records precede valid terminal records");
      // Newer by timestamp, but terminal: it must not become the headline.
      assert.equal(runs[0].run_id, "app-2", "[AC15] valid live ordering precedes terminal recency");
      assert.equal(active.run_id, "app-2", "the still-running run is the active one");
      assert.equal(runs.find((run) => run.run_id === "old-1").terminal, true);
      assert.deepEqual(renderLines(snapshot), [
        "app-2", "running  interactive  feature/app-1", "next: gate:story", "(1 other run)",
      ], "the recorded PR base does not change sidebar rendering");

      // And with nothing live, the fallback features the newest *terminal* run. It is reported, not
      // featured: one line, no branch, mode, next action or terminal reason. Shaped like a run in
      // progress it never went away and read as though something were still happening.
      rmSync(join(root, CONTROL_PLANE, "app-2"), { recursive: true, force: true });
      const dead = pollRuns(root);
      assert.equal(dead.active.run_id, "old-1", "with nothing live, the newest run is still shown");
      assert.deepEqual(renderLines(dead), ["old-1  completed"],
        "a finished run is one line, not the full in-progress block");

      // A completed run that produced a PR carries the URL, because that is the thing worth clicking.
      seedRun(root, "old-2", RUN({
        run_id: "old-2", status: "completed", updated_at: "2026-07-30T10:00:00.000Z",
        pr_url: "https://example.test/pr/7",
      }));
      assert.deepEqual(renderLines(pollRuns(root)),
        ["old-2  completed  https://example.test/pr/7", "(1 other run)"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps legacy and invalid records visible without mutating them", () => {
    const root = repo("broken");
    const archives = repo("archives");
    try {
      const dir = join(root, ".factory", "app-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.json"), "{ not json\n");

      const legacy = (overrides = {}) => {
        const { issue_key, ...run } = RUN();
        return { ...run, jira_key: issue_key, ...overrides };
      };
      const invalidRecords = [
        ["dual-null", RUN({ run_id: "dual-null", jira_key: null })],
        ["dual-equal", RUN({ run_id: "dual-equal", issue_key: "same", jira_key: "same" })],
        ["dual-different", RUN({ run_id: "dual-different", issue_key: "new", jira_key: "old" })],
        ["legacy-v2", legacy({ run_id: "legacy-v2", version: 2 })],
        ["legacy-type", legacy({ run_id: "legacy-type", jira_key: 183 })],
        ["unknown-key", RUN({ run_id: "unknown-key", unrelated: true })],
      ];
      for (const [runId, run] of invalidRecords) seedRun(root, runId, run);

      const invalidBytes = new Map(["app-1", ...invalidRecords.map(([runId]) => runId)].map((runId) => {
        const path = join(root, CONTROL_PLANE, runId, "run.json");
        return [path, readFileSync(path)];
      }));
      const invalidSnapshot = pollRuns(root);
      const { runs } = invalidSnapshot;
      assert.equal(runs.length, invalidRecords.length + 1, "every invalid run must still appear");
      assert.equal(runs.every((run) => !run.valid), true);
      const invalidText = renderLines(invalidSnapshot).join("\n");
      for (const run of runs) {
        assert.match(invalidText, new RegExp(`${run.run_id}  INVALID`, "u"));
        assert.ok(invalidText.includes(run.error));
      }
      for (const [path, bytes] of invalidBytes) assert.deepEqual(readFileSync(path), bytes);

      for (const record of LEGACY_RUN_MANIFESTS) seedRunBytes(archives, record.id, record.bytes);
      let archiveSnapshot;
      for (let poll = 0; poll < 2; poll += 1) {
        archiveSnapshot = pollRuns(archives);
        assert.equal(archiveSnapshot.runs.length, LEGACY_RUN_MANIFESTS.length);
        assert.equal(archiveSnapshot.runs.every((run) => run.valid), true);
        for (const record of LEGACY_RUN_MANIFESTS) {
          const projected = archiveSnapshot.runs.find((run) => run.run_id === record.id);
          assert.ok(projected, `${record.source} must remain visible`);
          assert.equal(projected.issue_key, record.id === "183" ? "183" : null);
          assert.equal(Object.hasOwn(projected, "jira_key"), false);
          assert.deepEqual(readFileSync(join(archives, CONTROL_PLANE, record.id, "run.json")), record.bytes,
            `${record.source} must retain its exact bytes after poll ${poll + 1}`);
        }
      }
      const run183 = archiveSnapshot.runs.find((run) => run.run_id === "183");
      assert.match(renderLines({ repo: archives, runs: [run183], active: run183 })[0], /^183  183  completed\b/u);
    } finally {
      rmSync(archives, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders global precedence, dead sandboxes, and every invalid manifest [AC6, AC7, AC13, AC15]", () => {
    const root = repo("global-render");
    const container = sandboxContainer(root);
    const originalNow = Date.now;
    const now = Date.parse("2026-07-30T13:00:00.000Z");
    const staleOwner = (runId) => ({
      session: `ses_0365a2c98ffe9AGxEQrTVs4yE${runId.length}`, pid: 7, run_id: runId, branch: null,
      claimed_at: "2026-07-30T10:00:00.000Z", heartbeat_at: "2026-07-30T11:00:00.000Z",
    });
    try {
      Date.now = () => now;
      const primary = seedSandbox(root, "live-primary",
        RUN({ run_id: "live-primary", updated_at: "2026-07-30T12:00:00.000Z" }));
      writeFileSync(join(primary.dir, "factory.lock"), JSON.stringify(staleOwner("live-primary")));
      const dead = seedSandbox(root, "live-dead",
        RUN({ run_id: "live-dead", updated_at: "2026-07-30T11:00:00.000Z" }));
      writeFileSync(join(dead.dir, "factory.lock"), JSON.stringify(staleOwner("live-dead")));
      seedRun(root, "other-live", RUN({ run_id: "other-live", updated_at: "2026-07-30T10:00:00.000Z" }));
      const terminal = seedSandbox(root, "terminal-new",
        RUN({ run_id: "terminal-new", status: "completed", updated_at: "2026-07-30T13:00:00.000Z" }));
      const invalidLocalDup = seedRun(root, "dup", RUN({ run_id: "dup", unexpected: true,
        updated_at: "2030-07-30T12:00:00.000Z" }));
      const invalidSandboxDup = seedSandbox(root, "dup", RUN({ run_id: "dup", unexpected: true,
        updated_at: "2031-07-30T12:00:00.000Z" }));
      const invalidNewer = seedRun(root, "newer-invalid", RUN({ run_id: "newer-invalid", unexpected: true,
        updated_at: "2032-07-30T12:00:00.000Z" }));

      // Polling is read-only even when it reads both a live sandbox and a stale/dead one.  Snapshot
      // manifests and unrelated sentinels before polling twice so a future cleanup/write hidden in a
      // projection path cannot pass merely because the rendered values look right.
      const primarySentinel = join(primary.sandbox, "read-only-primary.sentinel");
      const deadSentinel = join(dead.sandbox, "read-only-dead.sentinel");
      writeFileSync(primarySentinel, "live sandbox survives polling\n");
      writeFileSync(deadSentinel, "dead sandbox survives polling\n");
      const readOnlyBefore = new Map([
        [join(primary.dir, "run.json"), readFileSync(join(primary.dir, "run.json"), "utf8")],
        [join(dead.dir, "run.json"), readFileSync(join(dead.dir, "run.json"), "utf8")],
        [primarySentinel, readFileSync(primarySentinel, "utf8")],
        [deadSentinel, readFileSync(deadSentinel, "utf8")],
      ]);

      const snapshot = pollRuns(root);
      const repeatedSnapshot = pollRuns(root);
      assert.equal(repeatedSnapshot.active.run_id, "live-primary", "[AC5, AC13] repeat polling retains the live sandbox");
      assert.equal(repeatedSnapshot.runs.find((run) => run.run_id === "live-dead")?.deadLock, true,
        "[AC13] repeat polling retains the stale/dead sandbox");
      for (const [path, contents] of readOnlyBefore) {
        assert.equal(readFileSync(path, "utf8"), contents, `[AC5, AC13] polling must not mutate ${path}`);
      }
      assert.equal(snapshot.active.run_id, "live-primary",
        "[AC15] a valid live run headlines ahead of newer terminal and invalid records");
      assert.deepEqual(snapshot.runs.map((run) => [run.run_id, run.valid, run.terminal]), [
        ["live-primary", true, false],
        ["live-dead", true, false],
        ["other-live", true, false],
        ["terminal-new", true, true],
        ["dup", false, false],
        ["dup", false, false],
        ["newer-invalid", false, false],
      ], "[AC6, AC15] records use live, terminal, then deterministic invalid precedence");

      const lines = renderLines(snapshot);
      assert.deepEqual(lines.slice(0, 5), [
        "live-primary", "running  interactive  feature/app-1", "next: gate:story",
        `sandbox: ${primary.sandbox}`, "lock: stale (dead; sandbox retained)",
      ], "[AC13] the primary sandbox path and dead lock follow the full live block");
      assert.deepEqual(lines.slice(5, 10), [
        "live-dead  lock: stale (dead; sandbox retained)",
        `sandbox: ${dead.sandbox}`,
        "next: gate:story",
        "other-live",
        "next: gate:story",
      ], "every secondary nonterminal is explicit in valid-live order with its projected next action");
      const invalids = snapshot.runs.filter((run) => !run.valid);
      assert.deepEqual(lines.filter((line) => line.startsWith("at ")), invalids.map((run) => `at ${run.manifest_path}`),
        "[AC6, AC7] every invalid canonical path is rendered in deterministic order");
      for (const invalid of invalids) {
        assert.ok(lines.includes(invalid.error), "[AC6] every invalid record retains its existing error text");
      }
      const expectedInvalidPaths = [
        { run_id: "dup", manifest_path: realpathSync(join(invalidLocalDup, "run.json")) },
        { run_id: "dup", manifest_path: realpathSync(join(invalidSandboxDup.dir, "run.json")) },
        { run_id: "newer-invalid", manifest_path: realpathSync(join(invalidNewer, "run.json")) },
      ].sort((left, right) => left.run_id.localeCompare(right.run_id) || left.manifest_path.localeCompare(right.manifest_path));
      const expectedInvalidBlocks = expectedInvalidPaths.flatMap(({ run_id, manifest_path }) => {
        const invalid = invalids.find((run) => run.run_id === run_id && run.manifest_path === manifest_path);
        assert.ok(invalid?.error, `[AC6, AC7] ${manifest_path} must remain an explicit invalid record`);
        return [`${run_id}  INVALID`, `at ${manifest_path}`, invalid.error];
      });
      const firstInvalid = lines.indexOf(`${expectedInvalidPaths[0].run_id}  INVALID`);
      assert.deepEqual(lines.slice(firstInvalid, firstInvalid + expectedInvalidBlocks.length), expectedInvalidBlocks,
        "[AC6, AC7] every local/sandbox invalid renders as one adjacent ID/path/error block in deterministic ID/path order");
      assert.equal(lines.at(-1), "(1 other run)",
        "[AC13, AC15] only secondary terminal records are collapsed into the count");

      rmSync(primary.sandbox, { recursive: true, force: true });
      rmSync(dead.sandbox, { recursive: true, force: true });
      rmSync(join(root, CONTROL_PLANE, "other-live"), { recursive: true, force: true });
      const terminalSnapshot = pollRuns(root);
      assert.equal(terminalSnapshot.active.run_id, "terminal-new",
        "[AC15] a valid terminal record headlines when no valid live record exists");
      assert.deepEqual(renderLines(terminalSnapshot).slice(0, 2), [
        "terminal-new  completed", `sandbox: ${terminal.sandbox}`,
      ], "[AC6, AC15] compact terminal fallback retains its sandbox path");

      rmSync(terminal.sandbox, { recursive: true, force: true });
      const invalidSnapshot = pollRuns(root);
      const invalidLines = renderLines(invalidSnapshot);
      assert.equal(invalidSnapshot.active.valid, false, "[AC6] an invalid record is selected only without valid records");
      assert.deepEqual(invalidLines.filter((line) => line.startsWith("at ")),
        invalidSnapshot.runs.map((run) => `at ${run.manifest_path}`),
        "[AC6, AC7] invalid-only duplicate IDs render each canonical manifest path exactly once");
      assert.equal(invalidLines.some((line) => /other run/u.test(line)), false,
        "[AC6, AC15] invalid records are never collapsed into the other-run count");
    } finally {
      Date.now = originalNow;
      rmSync(container, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces the waiting gate, the slice tally, and the next action", () => {
    const root = repo("render");
    try {
      seedRun(root, "app-1", RUN({
        issue_key: "APP-1",
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

      // A retrying step, which slices always showed and steps never did. The fraction is the point:
      // a spec-writer on round 2 of 3 looked identical to round 1, so there was no sign of a loop
      // about to exhaust max_retries and block the run. Silent on the first attempt, because there
      // `next:` already names the step and a restatement is what made the old gate line noise.
      const stepped = (attempts) => renderLines({
        repo: root, runs: [1],
        active: { ...pollRuns(root).active, max_retries: 3,
          step: { agent: "spec-writer", status: "rejected", attempts } },
      }).join("\n");
      assert.match(stepped(2), /spec-writer {2}rejected \(attempt 2\/3\)/u, "a retry shows its round and the bound");
      // Narrowed to the step deliberately: a retried *slice* in this fixture already prints
      // "(attempt 2)", so a bare /attempt/ here passes for the wrong reason.
      assert.doesNotMatch(stepped(1), /spec-writer/u, "the first attempt adds nothing next: does not already say");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("renders a recursively frozen synthetic snapshot repeatedly without mutation", () => {
    const active = {
      run_id: "waiting", valid: true, terminal: false, manifest_path: "/repo/waiting/run.json",
      issue_key: "APP-1", status: "running", mode: "interactive", branch: "feature/waiting",
      step: null, max_retries: 3, slice_total: 0, slices: [], validator: null, pr_url: null,
      terminal_result: null, awaiting_gate: "brief", next: "gate:brief", sandbox_path: null, deadLock: false,
    };
    const snapshot = deepFreeze({
      repo: "/repo",
      active,
      searched: ["/repo/.factory"],
      runs: [
        {
          run_id: "ordinary", valid: true, terminal: false, manifest_path: "/repo/ordinary/run.json",
          issue_key: null, next: "step:builder", sandbox_path: null, deadLock: false,
        },
        active,
        {
          run_id: "stale", valid: true, terminal: false, manifest_path: "/repo/stale/run.json",
          issue_key: "APP-3", awaiting_gate: "review", next: "gate:review",
          sandbox_path: "/repo/sandboxes/stale", deadLock: true,
        },
        { run_id: "done", valid: true, terminal: true, manifest_path: "/repo/done/run.json" },
        { run_id: "broken", valid: false, manifest_path: "/repo/broken/run.json", error: "bad manifest" },
      ],
    });
    const before = structuredClone(snapshot);
    const expected = [
      "waiting  APP-1",
      "running  interactive  feature/waiting",
      ">> next: gate:brief",
      "ordinary",
      "next: step:builder",
      "stale  lock: stale (dead; sandbox retained)",
      "sandbox: /repo/sandboxes/stale",
      "next: gate:review",
      "broken  INVALID",
      "at /repo/broken/run.json",
      "bad manifest",
      "(1 other run)",
    ];

    assert.deepEqual(renderLines(snapshot), expected);
    assert.deepEqual(renderLines(snapshot), expected);
    assert.deepEqual(snapshot, before);
  });

  it("says so when there is no control plane at all", () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "ff-tui-empty-")));
    try {
      // This once asserted a bare "no runs", on the reasoning that outside a repository there is no
      // root to name. That was exactly backwards, and it cost a debugging round: a session left
      // pointing at a worktree that had been removed under it rendered a bare "no runs" —
      // indistinguishable from a plugin that failed to load. The case with no repository is the one
      // where naming the directory matters most, because it means the host is somewhere unexpected.
      assert.deepEqual(pollRuns(empty), { repo: null, runs: [], active: null, searched: [empty] });
      assert.deepEqual(renderLines(pollRuns(empty)), ["no runs", `searched ${empty}`],
        "a directory outside any repository must still say which directory it was");
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
      assert.deepEqual(brittle.lines(), ["no runs", "searched /repo"],
        "[AC7] the scan result retains its checked location");
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

  it("offers a jump to the session that owns each run", async () => {
    // The association was already on disk and nothing surfaced it: `factory lock` records the
    // claiming session beside the manifest, and the host can navigate to a session by id. So this is
    // a projection plus a route call — no process, no write.
    const navigations = [];
    const commands = runCommands([
      { run_id: "app-1", valid: true, session: "ses_0365a2c98ffe9AGxEQrTVs4yEy", next: "gate:story" },
      // No session: the lock was released, so there is nothing to open and offering it would
      // navigate nowhere. A run whose lock holds an unnavigable label projects `null` and lands here
      // too, which is why this consumer needs no shape check of its own.
      { run_id: "app-2", valid: true, session: null, next: "gate:brief" },
      // Unreadable manifests are shown in the sidebar but cannot be jumped to.
      { run_id: "app-3", valid: false, session: "ses_03661f9adffeU2xTChAwIH9rWR", next: null },
    ], { navigate: (name, params) => navigations.push([name, params]) });

    assert.deepEqual(commands.map((command) => command.value), ["feature-factory.open.app-1"],
      "only a valid run with a recorded session can be opened");
    assert.match(commands[0].description, /gate:story/u, "the palette says which run needs attention");
    commands[0].onSelect();
    assert.deepEqual(navigations, [["session", { sessionID: "ses_0365a2c98ffe9AGxEQrTVs4yEy" }]],
      "selecting it navigates to that session, by id");
  });

  it("projects only a session the host can navigate to, not an invented label", () => {
    // The defect this closes: `$SESSION_ID` was referenced five times in the skill and defined
    // nowhere, so runs composed labels like `opencode-163-20260803`, the lock recorded them, and the
    // sidebar offered a jump to a string naming no session. Narrowing the projection makes an
    // unidentified run offer no jump rather than a broken one — including every run recorded before
    // the integration exported the real id.
    const root = repo("session-shape");
    const lock = (session) => JSON.stringify({
      session, pid: 1, run_id: "app-1", branch: null,
      claimed_at: "2026-07-30T12:00:00.000Z", heartbeat_at: new Date().toISOString(),
    });
    const dir = seedRun(root, "app-1", RUN());

    writeFileSync(join(dir, "factory.lock"), lock("ses_0365a2c98ffe9AGxEQrTVs4yEy"));
    assert.equal(pollRuns(root).active.session, "ses_0365a2c98ffe9AGxEQrTVs4yEy",
      "a host-issued id is projected");

    for (const label of ["opencode-163-20260803", "SESSION-A", "session-unknown-163", "ses_", ""]) {
      writeFileSync(join(dir, "factory.lock"), lock(label));
      assert.equal(pollRuns(root).active.session, null,
        `an unnavigable session (${JSON.stringify(label)}) offers no jump`);
    }
  });

  it("exports the real session id into shell calls, and nothing when there is none", async () => {
    // Verified against opencode 1.18.11 before this was written: the `shell.env` hook is honoured and
    // carries a `ses_`-prefixed id. Absent must export nothing rather than a placeholder — writing a
    // placeholder is how the lock came to hold labels in the first place.
    const hooks = await plugin({}, {});
    const shellEnv = hooks["shell.env"];
    assert.equal(typeof shellEnv, "function", "the integration exports the session id to shell calls");

    const withSession = { env: {} };
    await shellEnv({ sessionID: "ses_0365a2c98ffe9AGxEQrTVs4yEy", cwd: "/repo" }, withSession);
    assert.deepEqual(withSession.env, { FACTORY_SESSION_ID: "ses_0365a2c98ffe9AGxEQrTVs4yEy" });

    // `sessionID` is optional in the hook's own signature, so every absent shape must stay silent.
    for (const input of [{ cwd: "/repo" }, { sessionID: undefined }, { sessionID: "" }]) {
      const output = { env: {} };
      await shellEnv(input, output);
      assert.deepEqual(output.env, {}, `no placeholder for ${JSON.stringify(input)}`);
    }
  });

  it("reads the fixed process-free lock contract [AC13]", () => {
    const root = repo("session");
    const originalNow = Date.now;
    const now = Date.parse("2026-07-30T12:30:00.000Z");
    try {
      Date.now = () => now;
      const dir = seedRun(root, "app-1", RUN());
      // A host-issued id, because that is what a lock now holds and the only thing the sidebar will
      // offer to open. The fixture used to carry `SESSION-Z`, which modelled the invented labels the
      // skill produced while `$SESSION_ID` was undefined — and asserted that a label was projected.
      const owner = (heartbeat_at) => ({
        session: "ses_03661f9e0ffeiAbZLdMQSm8xvd", pid: 1, run_id: "app-1", branch: null,
        claimed_at: "2026-07-30T12:00:00.000Z", heartbeat_at,
      });
      assert.equal(pollRuns(root).active.session, null, "[AC13] a missing factory.lock is absent");
      writeFileSync(join(dir, "not-factory.lock"), JSON.stringify(owner("2026-07-30T11:59:59.999Z")));
      assert.equal(pollRuns(root).active.deadLock, false, "[AC13] only the literal factory.lock filename is read");

      writeFileSync(join(dir, "factory.lock"), JSON.stringify(owner("2026-07-30T12:00:00.000Z")));
      assert.equal(pollRuns(root).active.session, "ses_03661f9e0ffeiAbZLdMQSm8xvd",
        "[AC13] the six-key owner is projected");
      assert.equal(pollRuns(root).active.deadLock, false, "[AC13] age equal to 30 minutes remains fresh");
      writeFileSync(join(dir, "factory.lock"), JSON.stringify(owner("2026-07-30T11:59:59.999Z")));
      assert.equal(pollRuns(root).active.deadLock, true, "[AC13] age greater than 30 minutes is stale");
      writeFileSync(join(dir, "factory.lock"), JSON.stringify(owner("2026-07-30T12:30:00.001Z")));
      assert.equal(pollRuns(root).active.deadLock, false, "[AC13] a future heartbeat remains fresh");

      writeFileSync(join(dir, "factory.lock"), JSON.stringify({ ...owner("2026-07-30T12:00:00.000Z"), extra: true }));
      assert.equal(pollRuns(root).active.session, null, "[AC13] keys outside the fixed six-key contract are absent");
      writeFileSync(join(dir, "factory.lock"), "{ not json");
      assert.equal(pollRuns(root).active.session, null, "[AC13] a malformed lock is absent, not fatal");

      writeFileSync(join(dir, "run.json"), `${JSON.stringify(RUN({ status: "completed" }), null, 2)}\n`);
      writeFileSync(join(dir, "factory.lock"), JSON.stringify(owner("2026-07-30T11:59:59.999Z")));
      assert.equal(pollRuns(root).active.deadLock, false, "[AC13] terminal runs are never dead locks");
    } finally {
      Date.now = originalNow;
      rmSync(root, { recursive: true, force: true });
    }
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
  async function configured(options = {}, cfg = {}) {
    const plugin = (await import("../plugin/index.js")).default;
    const hooks = await plugin({}, options);
    await hooks.config(cfg);
    return cfg;
  }

  it("root plugin exposes only a host-callable default factory", async () => {
    const moduleNamespace = await import("opencode-feature-factory");
    assert.deepEqual(Object.keys(moduleNamespace), ["default"]);
    for (const factory of Object.values(moduleNamespace)) {
      assert.equal(typeof factory, "function");
      const hooks = await factory({});
      assert.equal(typeof hooks.config, "function");
    }
  });

  it("keeps workflow registration and generated TUI polling loadable for a parseable run missing steps", async () => {
    const root = repo("invalid-load");
    const calls = { registered: [], disposers: [] };
    try {
      try {
        const run = RUN({ run_id: "invalid-load" });
        delete run.steps;
        const dir = seedRun(root, "invalid-load", run);
        const manifestPath = realpathSync(join(dir, "run.json"));
        let snapshot;
        assert.doesNotThrow(() => { snapshot = pollRuns(root); });
        assert.equal(snapshot.runs.length, 1);
        const [record] = snapshot.runs;
        assert.equal(record.run_id, "invalid-load");
        assert.equal(record.valid, false);
        assert.match(record.error, /steps/u);
        // readRunUnchecked output must pass validateRunForRead in project before nextAction.
        assert.equal(Object.hasOwn(record, "next"), false);

        const lines = renderLines(snapshot);
        assert.ok(lines.includes("invalid-load  INVALID"));
        assert.ok(lines.includes(`at ${manifestPath}`));
        assert.ok(lines.includes(record.error));

        const cfg = await configured();
        assert.equal(cfg.command.feature.agent, "feature-factory");
        assert.deepEqual(Object.keys(cfg.command), ["feature"]);
        assert.equal(cfg.skills.paths.length, 1);
        assert.match(cfg.skills.paths[0], /feature-factory\/skills$/u);
        const expectedAgents = [
          "backend-builder", "codebase-researcher", "design-interpreter", "frontend-builder",
          "implementation-validator", "spec-writer", "story-reader", "story-writer",
          "test-verifier", "work-decomposer", "work-reviewer",
        ].sort();
        assert.deepEqual(Object.keys(cfg.agent)
          .filter((name) => !["feature-factory", "run-orchestrator"].includes(name)).sort(), expectedAgents);
        assert.equal(Object.hasOwn(cfg.agent, "feature-factory"), true);
        assert.equal(Object.hasOwn(cfg.agent, "run-orchestrator"), true);
        assert.equal(Object.keys(cfg.agent).length, 13);

        const api = {
          state: { path: { directory: root, worktree: root } },
          theme: { current: { warning: "amber" } },
          lifecycle: { onDispose(dispose) { calls.disposers.push(dispose); } },
          slots: { register(config) { calls.registered.push(config); } },
        };
        const entry = (await import("../tui/dist/index.js")).default;
        assert.doesNotThrow(() => entry.tui(api, { intervalMs: 60_000 }));
        assert.equal(calls.registered.length, 1);
        assert.equal(typeof calls.registered[0].slots?.[SLOT], "function");
        assert.equal(calls.disposers.length, 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      for (const dispose of calls.disposers) dispose();
    }
  });

  const CONTROLLED_PERMISSION_KEYS = ["edit", "bash", "webfetch", "task"];
  // The child's delegation grant is target-scoped, so its policy value is a map rather than "allow".
  // `task` accepts a pattern map — verified on the running host through this plugin path — and a flat
  // "allow" resolves to `pattern: "*"`, which bounds nothing: it would permit a child to invoke
  // itself, the primary, or a peer orchestrator with only prompt text in the way. `*: "deny"` is
  // required because every resolved agent starts from a `* -> allow` wildcard, so an omitted entry
  // grants delegation. Asserting this map is what makes the bounded tree checkable; asserting the
  // prompt's wording only proves the sentence is present, not that the host will refuse the call.
  const CHILD_TASK_GRANT = Object.freeze({
    "story-reader": "allow", "story-writer": "allow", "codebase-researcher": "allow",
    "design-interpreter": "allow", "spec-writer": "allow", "work-decomposer": "allow",
    "work-reviewer": "allow", "test-verifier": "allow", "implementation-validator": "allow",
    "backend-builder": "allow", "frontend-builder": "allow",
    "*": "deny",
  });
  const FACTORY_PERMISSION_POLICY = {
    "backend-builder": ["allow", "allow", "deny", "deny"],
    "codebase-researcher": ["deny", "allow", "deny", "deny"],
    "design-interpreter": ["deny", "deny", "deny", "deny"],
    "frontend-builder": ["allow", "allow", "deny", "deny"],
    "implementation-validator": ["deny", "allow", "deny", "deny"],
    "spec-writer": ["deny", "deny", "deny", "deny"],
    "story-reader": ["deny", "deny", "deny", "deny"],
    "story-writer": ["deny", "deny", "deny", "deny"],
    "test-verifier": ["allow", "allow", "deny", "deny"],
    "work-decomposer": ["deny", "allow", "deny", "deny"],
    "work-reviewer": ["deny", "allow", "deny", "deny"],
    "feature-factory": ["allow", "allow", "allow", "allow"],
    "run-orchestrator": ["allow", "allow", "allow", CHILD_TASK_GRANT],
  };

  function controlledPermissions(permission) {
    return Object.fromEntries(CONTROLLED_PERMISSION_KEYS.map((key) => [key, permission[key]]));
  }

  function expectedPermissions(values) {
    return Object.fromEntries(CONTROLLED_PERMISSION_KEYS.map((key, index) => [key, values[index]]));
  }

  function oppositePermissions(values) {
    return Object.fromEntries(CONTROLLED_PERMISSION_KEYS.map((key, index) => [
      key, values[index] === "allow" ? "deny" : "allow",
    ]));
  }

  it("documents safe per-repository agent overrides", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const sectionStart = readme.indexOf("### Per-repository overrides");
    assert.notEqual(sectionStart, -1, "the published configuration guide must have a per-repository section");
    const section = readme.slice(sectionStart, readme.indexOf("\n## ", sectionStart));
    const normalized = section.replace(/\s+/gu, " ");
    const example = /```jsonc\s+([\s\S]*?)```/u.exec(section)?.[1] ?? "";

    assert.match(normalized, /opencode\.json/u);
    assert.match(normalized, /agent\.<name>\.model/u);
    assert.match(normalized, /agent\.<name>\.variant/u);
    assert.match(example, /"agent"/u);
    assert.match(example, /"model"/u);
    assert.match(example, /"variant"/u);

    const targeted = "For a targeted repository model or effort (`variant`) override, configure "
      + "`agent.<name>.model` and/or `agent.<name>.variant` in that repository's `opencode.json`.";
    const hostMerge = "OpenCode merges this file into `cfg` before the plugin runs; the plugin does not read "
      + "`opencode.json` itself.";
    const warning = "**Warning:** Project-level plugin `profiles` replace the plugin's configured `profiles`; "
      + "they are not partially merged. Supplying only part of `profiles` drops omitted entries and can silently "
      + "make unmentioned agents fall back to OpenCode defaults.";
    const recommendation = "Use the targeted `agent` override above instead.";
    for (const passage of [targeted, hostMerge, warning, recommendation]) assert.ok(normalized.includes(passage));
    assert.ok(normalized.indexOf(recommendation) > normalized.indexOf(warning),
      "the targeted override recommendation must follow the partial-profiles warning");
  });

  it("registers the command, the skill path, and every agent the skill dispatches", async () => {
    const cfg = await configured();
    assert.deepEqual(Object.keys(cfg.command), ["feature"]);
    assert.equal(cfg.command.feature.agent, "feature-factory", "the command runs as the orchestrator");
    assert.equal(cfg.command.feature.description,
      "Take a feature, ticket or idea end to end: story, spec, decomposition, parallel build, "
      + "integration, gates, draft PR. Syntax: /feature [--background] [--autonomous | --headless] "
      + "<ticket key | feature idea>; no mode flag is interactive.");
    assert.match(cfg.command.feature.template, /Request: \$ARGUMENTS/u,
      "the host must transport the raw invocation to the skill");
    assert.match(cfg.agent["feature-factory"].description, /Persisted run mode is the sole gate authority/u);
    for (const passage of [
      "Only a case-sensitive exact `--background` first non-whitespace token is the selector",
      "consume the token and exactly one separator character and preserve every remaining code unit",
      "A later, repeated, near-miss, differently-cased, punctuated, or mode-preceded background token is request content",
      "missing /feature request; no run created.",
      "missing /feature request after --background; no session or run created.",
      "Apply the loaded skill's maximal mode-prefix algorithm to a derivation copy while forwarding admitted bytes unchanged",
      "Background is placement, never a mode",
      "unresolvable issue reference: <unchanged reference>",
      "ambiguous ticket keys: <sorted lowercase keys>; no session or run created.",
      "ambiguous branch ticket keys: <sorted lowercase keys>; no session or run created.",
      "cannot derive a canonical run id; no session or run created.",
      "Call only `feature_background` with operation `start`, the canonical run ID, and the unchanged inner request",
      "asynchronous admission only, never execution or completion",
      "explicit `<canonical-run-id> approve`, `<canonical-run-id> stop`, or `<canonical-run-id> changes: <verbatim feedback>`",
      "Call only `feature_background` operation `answer`",
      "never mutate locally, dispatch a fresh child, use delivery, steer, queue, wait, or treat admittedSeq as execution proof",
      "Persisted `run.json.mode` is immutable and is the sole gate authority on resume",
      "In `interactive`, persist and present the pending gate and wait for a real human",
      "In `headless`, preserve terminal `needs-human`",
      "In `autonomous`, decide only when the existing preconditions authorize the decision",
    ]) assert.ok(cfg.agent["feature-factory"].prompt.includes(passage), passage);
    for (const passage of [
      "Persisted `run.json.mode` is the sole gate authority",
      "`interactive` persists and presents a pending gate and waits for a real human",
      "`headless` preserves terminal `needs-human`",
      "`autonomous` decides only when existing preconditions authorize",
      "Inability to ask never changes the persisted mode",
    ]) assert.ok(cfg.command.feature.template.includes(passage), passage);
    for (const passage of [
      "Only exact case-sensitive `--background` as the first non-whitespace token selects background placement",
      "consume exactly one separator character, and preserve every remaining inner code unit",
      "Any later, repeated, near-miss, differently-cased, punctuated, or mode-preceded background token is request content",
      "preserve forwarded bytes unchanged",
      "Background is never a mode",
      "Do not call the tool or client and do not inspect or initialize a manifest, call factory, claim a lock, dispatch a task, create a sandbox, or drive a stage",
      "invoke only `feature_background` operation `start` with that run ID and unchanged inner request",
      "HTTP 204 means admission only, not execution or completion",
      "Invoke only `feature_background` operation `answer` with the exact decision bytes",
      "Never dispatch a fresh child, mutate a gate locally, use delivery, steer, queue, wait, or treat admittedSeq as execution proof",
    ]) assert.ok(cfg.command.feature.template.includes(passage), passage);
    assert.equal(Object.hasOwn(cfg.command, "feature-fanout"), false);

    const child = cfg.agent["run-orchestrator"];
    assert.equal(child.mode, "subagent");
    assert.deepEqual(controlledPermissions(child.permission),
      expectedPermissions(FACTORY_PERMISSION_POLICY["run-orchestrator"]));
    // The bound stated as the host will enforce it. Every agent the child may reach is named, and
    // the three it must never reach are denied by the catch-all rather than by the prompt.
    assert.equal(child.permission.task["*"], "deny", "an unnamed target must be refused by the host");
    for (const forbidden of ["run-orchestrator", "feature-factory"]) {
      assert.ok(child.permission.task[forbidden] === undefined,
        `${forbidden} must not be granted; it falls to the * deny`);
    }
    for (const name of [
      "story-reader", "story-writer", "codebase-researcher", "design-interpreter", "spec-writer",
      "work-decomposer", "work-reviewer", "test-verifier", "implementation-validator", "backend-builder",
      "frontend-builder",
    ]) assert.ok(child.prompt.includes(`\`${name}\``), `${name} must be a named child target`);
    for (const passage of [
      "bounded run-orchestrator for exactly one background feature-factory session",
      "A start turn contains the tool's control text followed by one unchanged invocation-request text part",
      "A later answer turn in this same session contains exactly one unchanged decision text part",
      "apply the skill's maximal exact-leading-token inner mode admission to a derivation copy of the unchanged request",
      "a later or repeated `--background` token remains request content",
      "Require exact equality with the expected canonical run ID in the control text",
      "For fresh initialization, only exact standalone leading `--autonomous` and `--headless` tokens select those modes",
      "Background is not a mode",
      "persisted `run.json.mode` is immutable and authoritative",
      "Enter the existing Step 0 unchanged",
      "only the deterministic existing sandbox path `O/.factory-sandboxes/<R>`",
      "Use this session's real `FACTORY_SESSION_ID` as `SESSION_ID`",
      "factory status \"$R\" --json --repo \"$RUN_REPO\"",
      "continue only from `status.next`/`nextAction`",
      "never initialize another path, invent isolation, create another orchestration layer, or hand-write `run.json`",
      "task permission is target-scoped by the host",
      "refused by the host, not merely discouraged here",
      "It may observe builders it dispatched; builders never observe themselves",
      "In `interactive`, perform the orderly pending-gate park",
      "In `headless`, preserve terminal `needs-human`",
      "In `autonomous`, decide only under the existing autonomous preconditions and continue through existing Step 7",
      "Story gate `story` -> `artifacts/story.md`",
      "Brief gate `brief` -> `artifacts/technical-brief.md`",
      "Pre-PR gate `pre_pr` -> `gates/pre_pr.md`",
      "current validator verdict when applicable, the acceptance-criterion/test table, the feature-branch diff and PR-base summary, migration and flag callouts, and remaining risks",
      "factory gate \"$R\" pre_pr pending --artifact gates/pre_pr.md --repo \"$RUN_REPO\"",
      "await every in-flight specialized task call and stop heartbeat calls",
      "factory gate \"$R\" \"$GATE\" pending --artifact \"$ARTIFACT\" --repo \"$RUN_REPO\"",
      "manifest records the named gate pending with `ARTIFACT`",
      "factory lock \"$R\" release --session \"$SESSION_ID\" --repo \"$RUN_REPO\"",
      "verify that session no longer holds the lock",
      "Run: <R>\nRun repository: <RUN_REPO>\nOutcome: parked-pending-gate\nGate: <GATE>\nArtifact: <run-relative ARTIFACT>\nStatus: pending",
      "Run: <R>\nRun repository: <RUN_REPO>\nOutcome: retained-lock-error\nGate: <GATE>\nArtifact: <run-relative ARTIFACT>\nStatus: pending\nLock: retained\nError: <actual error>",
      "accept in this same session only one sole-part decision exactly equal to `approve`, `stop`, or `changes: <verbatim feedback>`",
      "Refuse every other answer before mutation",
      "Do not infer a run or gate from delivery metadata, use steer or queue behavior, or treat admittedSeq as proof",
      "verify a nonterminal persisted mode `interactive` run with exactly one pending gate",
      "factory lock \"$R\" claim --session \"$SESSION_ID\" --repo \"$RUN_REPO\"",
      "If refusal follows claim, release this session first",
      "factory gate \"$R\" \"$GATE\" approved --repo \"$RUN_REPO\"",
      "factory gate \"$R\" \"$GATE\" changes --repo \"$RUN_REPO\"",
      "keep feedback verbatim in task context, add no run key",
      "factory gate \"$R\" \"$GATE\" stop --repo \"$RUN_REPO\"",
      "`next: stopped-at-gate:<GATE>`",
      "`Outcome: stopped-at-gate`",
      "do not terminalize it or invite another resume",
      "resume solely from `status.next`",
      "Never initialize a replacement or repeat completed stages except the intentional changes loop",
      "release this same session's lock again",
      "`needs-human` with reason `headless run reached a human gate`",
      "After Step 7 archives or removes a completed sandbox, query and report the canonical post-completion repository selected by Step 7",
      "Report only existing status, terminal result, and PR URL; add no durable fields",
    ]) assert.ok(child.prompt.includes(passage), passage);
    assert.doesNotMatch(child.prompt, /Outcome: pending-gate/u);
    assert.doesNotMatch(child.prompt, /decision child/u);
    assert.deepEqual(Object.keys(child).sort(), ["description", "mode", "permission", "prompt", "variant"]);
    const registrationSource = readFileSync(new URL("../plugin/config.js", import.meta.url), "utf8");
    for (const mechanism of [
      /\bfetch\s*\(/u,
      /\bJSON\.parse\s*\(/u,
      /\b(?:spawn|execFile|fork)\s*\(/u,
      /\bnew\s+(?:Worker|WebSocket)\b/u,
      /node:child_process|child_process/u,
      /\b(?:coordinator|report)\s*:/u,
    ]) assert.doesNotMatch(registrationSource, mechanism);

    const scope = { project: { id: "project-1" }, directory: "/repo", worktree: "/repo/🔥" };
    const context = (overrides = {}) => ({
      sessionID: "starter-session", messageID: "message-1", agent: "feature-factory",
      directory: scope.directory, worktree: scope.worktree, ...overrides,
    });
    const resultOf = async (definition, args, overrides) => JSON.parse(
      await definition.execute(args, context(overrides)),
    );
    const request = "  --autonomous Build café  ";
    const title = `feature-factory:issue-210@${Buffer.from(scope.worktree, "utf8").toString("base64url")}`;
    const calls = { list: [], create: [], prompt: [] };
    const client = { session: {
      async list(options) { calls.list.push(options); return { data: [] }; },
      async create(options) { calls.create.push(options); return { data: { id: "session-new", title } }; },
      async promptAsync(options) {
        calls.prompt.push(options);
        return { data: { admittedSeq: 99 }, response: { status: 204 } };
      },
    } };
    const hooks = await plugin({ client, ...scope });
    assert.deepEqual(Object.keys(hooks.tool), ["feature_background"]);
    const background = hooks.tool.feature_background;
    assert.deepEqual(Object.keys(background.args).sort(), ["decision", "operation", "request", "runId"]);
    assert.equal(Object.hasOwn(background.args, "root"), false);
    assert.equal(Object.hasOwn(background.args, "mode"), false);
    const started = await resultOf(background, { operation: "start", runId: "issue-210", request });
    assert.deepEqual(started, {
      status: "dispatched", operation: "start", runId: "issue-210", title, sessionId: "session-new",
    });
    assert.deepEqual(calls.list, [{ query: { directory: scope.directory } }]);
    assert.deepEqual(calls.create, [{ query: { directory: scope.directory }, body: { title } }]);
    assert.deepEqual(calls.prompt, [{
      path: { id: "session-new" },
      query: { directory: scope.directory },
      body: {
        agent: "run-orchestrator",
        parts: [
          { type: "text", text: `Drive exactly one feature-factory run as the bounded run-orchestrator. Load and follow the feature skill. The expected canonical run ID is "issue-210". The captured host worktree is "${scope.worktree}". Independently derive the same run ID before any factory command, then enter existing Step 0. This session alone initializes or resumes the run, owns factory commands, claims and releases its lock, and continues from status.next/nextAction. Treat the next text part as the unchanged invocation request.` },
          { type: "text", text: request },
        ],
      },
    }]);

    const associationCalls = { create: 0, prompt: [] };
    const associationClient = { session: {
      async list(options) {
        assert.deepEqual(options, { query: { directory: scope.directory } });
        return { data: [
          { id: "other", title: `${title}-suffix` },
          { id: "match-1", title },
          { id: "match-2", title },
        ] };
      },
      async create() { associationCalls.create += 1; return { data: { id: "wrong" } }; },
      async promptAsync(options) { associationCalls.prompt.push(options); return { response: { status: 204 } }; },
    } };
    const association = (await plugin({ client: associationClient, ...scope })).tool.feature_background;
    assert.deepEqual(await resultOf(association,
      { operation: "start", runId: "issue-210", request: "request" }), {
      status: "existing", operation: "start", runId: "issue-210", title,
      sessionIds: ["match-1", "match-2"],
    });
    assert.equal(associationCalls.create, 0);
    assert.deepEqual(associationCalls.prompt, []);
    assert.deepEqual(await resultOf(association,
      { operation: "answer", runId: "issue-210", decision: "approve" }, { messageID: "answer-ambiguous" }), {
      status: "ambiguous", operation: "answer", runId: "issue-210", title,
      sessionIds: ["match-1", "match-2"],
    });

    const answerCalls = [];
    const answerClient = { session: {
      async list() { return { data: [{ id: "same-session", title }] }; },
      async create() { throw new Error("create must not be called for answer"); },
      async promptAsync(options) { answerCalls.push(options); return { response: { status: 204 } }; },
    } };
    const answerTool = (await plugin({ client: answerClient, ...scope })).tool.feature_background;
    const decision = "changes:  preserve these bytes  ";
    assert.deepEqual(await resultOf(answerTool,
      { operation: "answer", runId: "issue-210", decision }), {
      status: "dispatched", operation: "answer", runId: "issue-210", title, sessionId: "same-session",
    });
    assert.deepEqual(answerCalls, [{
      path: { id: "same-session" }, query: { directory: scope.directory },
      body: { agent: "run-orchestrator", parts: [{ type: "text", text: decision }] },
    }]);
    const absentTool = (await plugin({ client: { session: {
      async list() { return { data: [] }; },
    } }, ...scope })).tool.feature_background;
    assert.deepEqual(await resultOf(absentTool,
      { operation: "answer", runId: "issue-210", decision: "stop" }), {
      status: "not_backgrounded", operation: "answer", runId: "issue-210", title,
    });

    const zeroCalls = { count: 0 };
    const untouchedClient = { session: {
      async list() { zeroCalls.count += 1; return { data: [] }; },
      async create() { zeroCalls.count += 1; return { data: { id: "bad" } }; },
      async promptAsync() { zeroCalls.count += 1; return { response: { status: 204 } }; },
    } };
    const guarded = (await plugin({ client: untouchedClient, ...scope })).tool.feature_background;
    for (const [args, overrides, reason] of [
      [{ operation: "start", runId: "Bad", request: "x" }, {}, "invalid_run_id"],
      [{ operation: "start", runId: 123, request: "x" }, {}, "invalid_run_id"],
      [{ operation: "start", runId: "valid", request: " \n\t" }, {}, "missing_request"],
      [{ operation: "answer", runId: "valid", decision: "Approve" }, {}, "invalid_decision"],
      [{ operation: "answer", runId: "valid", decision: "changes:   " }, {}, "invalid_decision"],
      [{ operation: "later", runId: "valid" }, {}, "invalid_operation"],
      [{ operation: "start", runId: "valid", request: "x" }, { agent: "run-orchestrator" }, "unauthorized_agent"],
      [{ operation: "start", runId: "valid", request: "x" }, { directory: "/other" }, "directory_mismatch"],
      [{ operation: "start", runId: "valid", request: "x" }, { worktree: "/other" }, "worktree_mismatch"],
    ]) {
      const rejectedResult = await resultOf(guarded, args, overrides);
      assert.equal(rejectedResult.status, "rejected");
      assert.equal(rejectedResult.reason, reason);
    }
    const invalidScope = (await plugin({ client: untouchedClient, project: { id: "" },
      directory: scope.directory, worktree: scope.worktree })).tool.feature_background;
    assert.equal((await resultOf(invalidScope,
      { operation: "start", runId: "valid", request: "x" })).reason, "invalid_plugin_scope");
    assert.equal(zeroCalls.count, 0);

    async function unknownCase(session, args = { operation: "start", runId: "issue-210", request: "x" }) {
      const definition = (await plugin({ client: { session }, ...scope })).tool.feature_background;
      return resultOf(definition, args);
    }
    for (const [session, stage] of [
      [{ async list() { return { error: { code: "list" } }; } }, "list"],
      [{ async list() { return {}; } }, "list"],
      [{ async list() { return { data: {} }; } }, "list"],
      [{ async list() { return { data: [{ id: "", title }] }; } }, "list"],
      [{ async list() { throw new Error("list throw"); } }, "list"],
      [{ async list() { return { data: [] }; }, async create() { return { error: { code: "create" } }; } }, "create"],
      [{ async list() { return { data: [] }; }, async create() { return { data: {} }; } }, "create"],
      [{ async list() { return { data: [] }; }, async create() { throw new Error("create throw"); } }, "create"],
      [{ async list() { return { data: [] }; }, async create() { return { data: { id: "new" } }; },
        async promptAsync() { return { error: { code: "prompt" }, response: { status: 204 } }; } }, "prompt_async"],
      [{ async list() { return { data: [] }; }, async create() { return { data: { id: "new" } }; },
        async promptAsync() { return { response: { status: 200 }, data: { admittedSeq: 1 } }; } }, "prompt_async"],
      [{ async list() { return { data: [] }; }, async create() { return { data: { id: "new" } }; },
        async promptAsync() { return { data: { admittedSeq: 1 } }; } }, "prompt_async"],
      [{ async list() { return { data: [] }; }, async create() { return { data: { id: "new" } }; },
        async promptAsync() { throw new Error("prompt throw"); } }, "prompt_async"],
    ]) {
      const outcome = await unknownCase(session);
      assert.equal(outcome.status, "unknown");
      assert.equal(outcome.stage, stage);
      assert.doesNotThrow(() => JSON.stringify(outcome));
    }

    const complex = { absent: undefined, big: 12n, nan: Number.NaN, symbol: Symbol("s"), callable() {} };
    complex.problem = new Error("broken", { cause: new TypeError("cause") });
    complex.when = new Date(0);
    complex.self = complex;
    complex.repeated = complex.problem;
    const encodedResult = await unknownCase({ async list() { return { error: complex }; } });
    assert.equal(encodedResult.outcome.absent.$type, "undefined");
    assert.deepEqual(encodedResult.outcome.big, { $type: "bigint", value: "12" });
    assert.equal(encodedResult.outcome.nan.$type, "nonfinite");
    assert.equal(encodedResult.outcome.symbol.$type, "symbol");
    assert.equal(encodedResult.outcome.callable.$type, "function");
    assert.equal(encodedResult.outcome.problem.$type, "error");
    assert.equal(encodedResult.outcome.problem.cause.$type, "error");
    assert.equal(encodedResult.outcome.when.$type, "nonplain");
    assert.equal(encodedResult.outcome.self.$type, "reference");
    assert.equal(encodedResult.outcome.repeated.$type, "reference");
    const thrownResult = await unknownCase({ async list() { throw "verbatim thrown"; } });
    assert.equal(thrownResult.outcome, "verbatim thrown");

    let releaseShared;
    let sharedLists = 0;
    let sharedCreates = 0;
    let sharedPrompts = 0;
    const sharedClient = { session: {
      async list() { sharedLists += 1; await new Promise((resolve) => { releaseShared = resolve; }); return { data: [] }; },
      async create() { sharedCreates += 1; return { data: { id: "shared" } }; },
      async promptAsync() { sharedPrompts += 1; return { response: { status: 204 } }; },
    } };
    const sharedTool = (await plugin({ client: sharedClient, ...scope })).tool.feature_background;
    const sharedFirst = resultOf(sharedTool, { operation: "start", runId: "shared", request: "first" });
    const sharedSecond = resultOf(sharedTool,
      { operation: "start", runId: "shared", request: "second" }, { messageID: "message-2" });
    await Promise.resolve();
    assert.equal(sharedLists, 1);
    releaseShared();
    assert.deepEqual(await sharedSecond, await sharedFirst);
    assert.deepEqual([sharedCreates, sharedPrompts], [1, 1]);

    const answerWaiters = [];
    const concurrentAnswerClient = { session: {
      async list() { return new Promise((resolve) => answerWaiters.push(resolve)); },
      async promptAsync() { return { response: { status: 204 } }; },
    } };
    const concurrentAnswer = (await plugin({ client: concurrentAnswerClient, ...scope })).tool.feature_background;
    const firstAnswer = resultOf(concurrentAnswer,
      { operation: "answer", runId: "issue-210", decision: "approve" });
    const secondAnswer = await resultOf(concurrentAnswer,
      { operation: "answer", runId: "issue-210", decision: "stop" }, { messageID: "message-2" });
    assert.equal(secondAnswer.reason, "operation_in_flight");
    answerWaiters[0]({ data: [{ id: "same", title }] });
    assert.equal((await firstAnswer).status, "dispatched");

    const distinctWaiters = [];
    let distinctCreate = 0;
    const distinctClient = { session: {
      async list() { return new Promise((resolve) => distinctWaiters.push(resolve)); },
      async create() { distinctCreate += 1; return { data: { id: `distinct-${distinctCreate}` } }; },
      async promptAsync() { return { response: { status: 204 } }; },
    } };
    const distinctTool = (await plugin({ client: distinctClient, ...scope })).tool.feature_background;
    const distinctA = resultOf(distinctTool, { operation: "start", runId: "run-a", request: "a" });
    const distinctB = resultOf(distinctTool,
      { operation: "start", runId: "run-b", request: "b" }, { messageID: "message-b" });
    await Promise.resolve();
    assert.equal(distinctWaiters.length, 2);
    for (const resolve of distinctWaiters) resolve({ data: [] });
    assert.equal((await distinctA).status, "dispatched");
    assert.equal((await distinctB).status, "dispatched");

    let uncertainLists = 0;
    const uncertainClient = { session: {
      async list() { uncertainLists += 1; return { error: { attempt: uncertainLists } }; },
    } };
    const uncertainTool = (await plugin({ client: uncertainClient, ...scope })).tool.feature_background;
    const uncertainArgs = { operation: "start", runId: "uncertain", request: "x" };
    const uncertainFirst = await resultOf(uncertainTool, uncertainArgs);
    assert.deepEqual(await resultOf(uncertainTool, uncertainArgs), uncertainFirst);
    assert.equal(uncertainLists, 1);
    assert.equal((await resultOf(uncertainTool, uncertainArgs, { messageID: "later-human-message" })).status, "unknown");
    assert.equal(uncertainLists, 2);
    const reloaded = await plugin({ client: uncertainClient, ...scope });
    assert.equal(uncertainLists, 2);
    assert.deepEqual(Object.keys(reloaded.tool), ["feature_background"]);

    // The host discovers a skill from a directory, so the path must be the one the package ships.
    assert.equal(cfg.skills.paths.length, 1);
    assert.match(cfg.skills.paths[0], /feature-factory\/skills$/u);
    const shipped = readdirSync(new URL("../../feature-factory/agents/", import.meta.url))
      .filter((entry) => entry.endsWith(".md")).map((entry) => entry.replace(/\.md$/u, ""));
    for (const name of shipped) {
      assert.ok(cfg.agent[name], `${name} must be registered, or a task call for it fails`);
    }
    const registered = registerAgents({ agent: {} });
    assert.deepEqual(registered.sort(), shipped.sort(), "only the eleven packaged specialists are returned");
    assert.equal(registered.length, 11);
    assert.equal(Object.keys(cfg.agent).length, shipped.length + 2, "eleven specialists plus both run drivers");
    assert.deepEqual(Object.keys(cfg.agent).sort(), ["feature-factory", "run-orchestrator", ...shipped].sort());
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

  it("enforces the complete controlled-permission policy for every factory agent", async () => {
    const cfg = await configured();
    assert.deepEqual(Object.keys(cfg.agent).sort(), Object.keys(FACTORY_PERMISSION_POLICY).sort());
    for (const [name, values] of Object.entries(FACTORY_PERMISSION_POLICY)) {
      assert.deepEqual(controlledPermissions(cfg.agent[name].permission), expectedPermissions(values), name);
    }
  });

  it("resolves subagent model and variant through every precedence tier", async () => {
    const options = {
      profile: { model: "global/model", variant: "global-variant" },
      profiles: {
        default: { model: "default/model", variant: "default-variant" },
        reviewer: { model: "reviewer/model", variant: "reviewer-variant" },
        "work-reviewer": { model: "named/model", variant: "named-variant" },
      },
    };
    const cfg = await configured(options);
    assert.deepEqual(
      { model: cfg.agent["work-reviewer"].model, variant: cfg.agent["work-reviewer"].variant },
      { model: "named/model", variant: "named-variant" },
    );
    assert.deepEqual(
      { model: cfg.agent["implementation-validator"].model,
        variant: cfg.agent["implementation-validator"].variant },
      { model: "reviewer/model", variant: "reviewer-variant" },
    );
    assert.deepEqual(
      { model: cfg.agent["run-orchestrator"].model, variant: cfg.agent["run-orchestrator"].variant },
      { model: "default/model", variant: "default-variant" },
    );
    assert.deepEqual(
      { model: cfg.agent["spec-writer"].model, variant: cfg.agent["spec-writer"].variant },
      { model: "default/model", variant: "default-variant" },
    );

    const globalOnly = await configured({ profile: { model: "only/global", variant: "only-global-variant" } });
    assert.deepEqual(
      { model: globalOnly.agent["story-reader"].model, variant: globalOnly.agent["story-reader"].variant },
      { model: "only/global", variant: "only-global-variant" },
    );

    const merged = await configured(options, { agent: { "work-reviewer": {
      model: "project/model", variant: "project-variant",
    } } });
    assert.deepEqual(
      { model: merged.agent["work-reviewer"].model, variant: merged.agent["work-reviewer"].variant },
      { model: "project/model", variant: "project-variant" },
    );
    assert.deepEqual(
      { model: merged.agent["implementation-validator"].model,
        variant: merged.agent["implementation-validator"].variant },
      { model: "reviewer/model", variant: "reviewer-variant" },
    );
    assert.deepEqual(
      { model: merged.agent["spec-writer"].model, variant: merged.agent["spec-writer"].variant },
      { model: "default/model", variant: "default-variant" },
    );
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

  it("preserves the orchestrator baseline and profile precedence", async () => {
    const bare = await configured();
    assert.equal(bare.agent["feature-factory"].model, undefined);
    assert.equal(bare.agent["feature-factory"].variant, "xhigh");
    assert.equal(bare.agent["run-orchestrator"].model, undefined);
    assert.equal(bare.agent["run-orchestrator"].variant, "xhigh");
    assert.equal(bare.agent["run-orchestrator"].mode, "subagent");
    assert.deepEqual(controlledPermissions(bare.agent["feature-factory"].permission),
      expectedPermissions(FACTORY_PERMISSION_POLICY["feature-factory"]));
    assert.deepEqual(controlledPermissions(bare.agent["run-orchestrator"].permission),
      expectedPermissions(FACTORY_PERMISSION_POLICY["run-orchestrator"]));

    const tiers = {
      profile: { model: "orchestrator/global", variant: "orchestrator-global-variant" },
      default: { model: "orchestrator/default", variant: "orchestrator-default-variant" },
      planning: { model: "orchestrator/planning", variant: "orchestrator-planning-variant" },
      named: { model: "orchestrator/named", variant: "orchestrator-named-variant" },
    };
    const cases = [
      ["global", { profile: tiers.profile }, tiers.profile],
      ["default", { profile: tiers.profile, profiles: { default: tiers.default } }, tiers.default],
      ["planning", { profile: tiers.profile,
        profiles: { default: tiers.default, planning: tiers.planning } }, tiers.planning],
      ["named", { profile: tiers.profile,
        profiles: { default: tiers.default, planning: tiers.planning, "feature-factory": tiers.named } }, tiers.named],
    ];
    for (const [name, options, expected] of cases) {
      const cfg = await configured(options);
      assert.deepEqual(
        { model: cfg.agent["feature-factory"].model, variant: cfg.agent["feature-factory"].variant },
        expected,
        name,
      );
      const childExpected = name === "named" ? tiers.planning : expected;
      assert.deepEqual(
        { model: cfg.agent["run-orchestrator"].model, variant: cfg.agent["run-orchestrator"].variant },
        childExpected,
        `run-orchestrator ${name}`,
      );
    }

    const namedChild = await configured({ profiles: {
      planning: tiers.planning, "run-orchestrator": tiers.named,
    } });
    assert.deepEqual(
      { model: namedChild.agent["run-orchestrator"].model, variant: namedChild.agent["run-orchestrator"].variant },
      tiers.named,
    );
  });

  it("gives host-merged orchestrator preferences precedence without weakening its permissions", async () => {
    const options = {
      profile: { model: "global/model", variant: "global-variant" },
      profiles: {
        default: { model: "default/model", variant: "default-variant" },
        planning: { model: "planning/model", variant: "planning-variant" },
        "feature-factory": { model: "named/model", variant: "named-variant" },
      },
    };
    const cfg = await configured(options, { agent: { "feature-factory": {
      model: "project/model",
      variant: "project-variant",
      permission: { edit: "deny", bash: "deny", webfetch: "deny", task: "deny", "host-only": "ask" },
    }, "run-orchestrator": {
      model: "project/child",
      variant: "project-child-variant",
      description: "Project child description",
      prompt: "Project child prompt",
      mode: "primary",
      permission: { edit: "deny", bash: "deny", webfetch: "deny", task: "deny", "host-only": "opaque" },
    } } });
    assert.equal(cfg.agent["feature-factory"].model, "project/model");
    assert.equal(cfg.agent["feature-factory"].variant, "project-variant");
    assert.deepEqual(controlledPermissions(cfg.agent["feature-factory"].permission),
      expectedPermissions(FACTORY_PERMISSION_POLICY["feature-factory"]));
    assert.equal(cfg.agent["feature-factory"].permission["host-only"], "ask");
    assert.equal(cfg.agent["run-orchestrator"].model, "project/child");
    assert.equal(cfg.agent["run-orchestrator"].variant, "project-child-variant");
    assert.equal(cfg.agent["run-orchestrator"].description, "Project child description");
    assert.equal(cfg.agent["run-orchestrator"].prompt, "Project child prompt");
    assert.equal(cfg.agent["run-orchestrator"].mode, "subagent");
    assert.deepEqual(controlledPermissions(cfg.agent["run-orchestrator"].permission),
      expectedPermissions(FACTORY_PERMISSION_POLICY["run-orchestrator"]));
    assert.equal(cfg.agent["run-orchestrator"].permission["host-only"], "opaque");
  });

  it("holds controlled permissions against hostile project configuration", async () => {
    const projectAgent = {
      model: "project/external",
      variant: "external-variant",
      permission: { edit: "ask", bash: "allow", webfetch: "deny", task: "ask", "host-only": "opaque" },
      arbitrary: { retained: true },
    };
    const projectAgents = Object.fromEntries(Object.entries(FACTORY_PERMISSION_POLICY).map(([name, values]) => [
      name,
      { permission: { ...oppositePermissions(values), "host-only": "ask" } },
    ]));
    projectAgents["run-orchestrator"].mode = "primary";
    projectAgents["project-agent"] = structuredClone(projectAgent);

    const cfg = await configured({}, { agent: projectAgents });
    for (const [name, values] of Object.entries(FACTORY_PERMISSION_POLICY)) {
      assert.deepEqual(controlledPermissions(cfg.agent[name].permission), expectedPermissions(values), name);
      assert.equal(cfg.agent[name].permission["host-only"], "ask", name);
    }
    assert.equal(cfg.agent["run-orchestrator"].mode, "subagent");
    assert.equal(cfg.agent["feature-factory"].permission.task, "allow");
    for (const name of [
      "story-reader", "story-writer", "codebase-researcher", "design-interpreter", "spec-writer",
      "work-decomposer", "work-reviewer", "test-verifier", "implementation-validator", "backend-builder",
      "frontend-builder",
    ]) assert.equal(cfg.agent[name].permission.task, "deny", name);
    assert.deepEqual(cfg.agent["project-agent"], projectAgent);
  });

  it("ignores hostile permission values in every factory-owned named profile", async () => {
    const profiles = Object.fromEntries(Object.entries(FACTORY_PERMISSION_POLICY).map(([name, values], index) => [
      name,
      {
        model: `profile/${name}`,
        variant: `profile-variant-${index}`,
        permission: oppositePermissions(values),
      },
    ]));
    const cfg = await configured({ profiles });
    for (const [name, values] of Object.entries(FACTORY_PERMISSION_POLICY)) {
      assert.deepEqual(controlledPermissions(cfg.agent[name].permission), expectedPermissions(values), name);
    }
    assert.equal(cfg.agent["work-reviewer"].model, "profile/work-reviewer");
    assert.equal(cfg.agent["work-reviewer"].variant,
      `profile-variant-${Object.keys(FACTORY_PERMISSION_POLICY).indexOf("work-reviewer")}`);
    assert.equal(cfg.agent["feature-factory"].model, "profile/feature-factory");
    assert.equal(cfg.agent["feature-factory"].variant,
      `profile-variant-${Object.keys(FACTORY_PERMISSION_POLICY).indexOf("feature-factory")}`);
  });

  it("does not discover repository or foreign-product configuration files", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ff-registration-poison-")));
    const marker = "__ffForeignConfigPoison";
    const poison = `globalThis.${marker} = true;\nthrow new Error("FOREIGN_CONFIG_POISON");\n`;
    const foreignPaths = [
      "opencode.json",
      ".opencode/opencode.json",
      ".opencode/profiles.json",
      ".opencode/agents/foreign-poison.md",
      ".claude/settings.json",
      ".claude/profiles.json",
      ".claude/agents/foreign-poison.md",
      ".claude/config.mjs",
    ];
    try {
      delete globalThis[marker];
      mkdirSync(join(root, "agents"), { recursive: true });
      mkdirSync(join(root, "skills"), { recursive: true });
      writeFileSync(join(root, "agents", "safe-agent.md"), [
        "---", "name: safe-agent", "description: Safe package-owned agent", "effort: low",
        "role: research", "tools: Read", "---", "Safe prompt.", "",
      ].join("\n"));
      for (const relative of foreignPaths) {
        const path = join(root, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, poison);
      }

      const cfg = await configured({ root });
      assert.deepEqual(Object.keys(cfg.agent).sort(), ["feature-factory", "run-orchestrator", "safe-agent"]);
      assert.equal(cfg.skills.paths[0], join(root, "skills"));
      assert.equal(globalThis[marker], undefined);
      assert.doesNotMatch(JSON.stringify(cfg), /FOREIGN_CONFIG_POISON|__ffForeignConfigPoison/u);
    } finally {
      delete globalThis[marker];
      rmSync(root, { recursive: true, force: true });
    }
  });
});
