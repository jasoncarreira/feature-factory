import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkg, "bin", "factory.js");

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

function factory(repository, ...args) {
  return JSON.parse(execFileSync("node", [cli, ...args, "--repo", repository, "--json"], { encoding: "utf8" }));
}

function refSha(repository, ref) {
  const result = spawnSync("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 128) return null;
  throw new Error(result.stderr.trim() || `could not inspect ${ref}`);
}

function treeInventory(root) {
  const inventory = [];
  const walk = (path, relativePath) => {
    const metadata = lstatSync(path);
    const entry = {
      path: relativePath,
      type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "regular" : metadata.isSymbolicLink() ? "symlink" : "unsupported",
      mode: metadata.mode & 0o7777,
    };
    if (entry.type === "regular") entry.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (entry.type === "symlink") entry.target = readlinkSync(path);
    if (entry.type === "unsupported") throw new Error(`unsupported entry ${relativePath}`);
    inventory.push(entry);
    if (entry.type === "directory") {
      for (const child of readdirSync(path)) walk(join(path, child), relativePath === "." ? child : join(relativePath, child));
    }
  };
  walk(root, ".");
  return inventory.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function branchInventory(run, sandbox) {
  const branches = [run.branch, ...run.slices
    .filter((slice) => slice.status !== "merged" && slice.branch !== null)
    .map((slice) => slice.branch)];
  const refs = new Map();
  for (const branch of branches) {
    const ref = `refs/heads/${branch}`;
    const sha = refSha(sandbox, ref);
    if (!sha) throw new Error(`missing source ${ref}`);
    if (refs.has(ref) && refs.get(ref) !== sha) throw new Error(`duplicate source ${ref}`);
    refs.set(ref, sha);
  }
  return [...refs].map(([ref, sha]) => ({ ref, sha })).sort((left, right) => left.ref.localeCompare(right.ref));
}

function cleanupReason(phase, error, sandbox) {
  const message = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/gu, " ").trim() || "unknown error";
  const location = phase === "remove" ? `residual sandbox at ${sandbox}` : `sandbox retained at ${sandbox}`;
  return `cleanup ${phase} failed: ${message}; ${location}`;
}

function removalGuard(operator, container, sandbox) {
  for (const path of [container, sandbox]) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`not a real directory: ${path}`);
  }
  const canonicalOperator = realpathSync(operator);
  const canonicalContainer = realpathSync(container);
  const canonicalSandbox = realpathSync(sandbox);
  if (canonicalContainer !== container || canonicalSandbox !== sandbox) throw new Error("canonical path mismatch");
  if (dirname(canonicalSandbox) !== canonicalContainer) throw new Error("canonical parent mismatch");
  if (["/", canonicalOperator].includes(canonicalSandbox)) throw new Error("refusing destructive root");
}

function completedHandoff(fixture, options = {}) {
  const { operator, container, sandbox, archive, runId } = fixture;
  if (fixture.legacy) {
    factory(operator, "terminal", runId, "completed", "--reason", "draft-pr-recorded");
    return { status: factory(operator, "status", runId), phases: ["terminal"] };
  }
  if (options.status && options.status !== "completed" || options.deadLock) return { phases: [] };
  factory(sandbox, "terminal", runId, "completed", "--reason", "draft-pr-recorded");
  const phases = ["terminal"];
  const run = JSON.parse(readFileSync(join(sandbox, ".factory", runId, "run.json"), "utf8"));
  let refs;
  try {
    refs = branchInventory(run, sandbox);
    const missing = [];
    const collisions = [];
    for (const source of refs) {
      const destination = refSha(operator, source.ref);
      if (destination === null) missing.push(source);
      else if (destination !== source.sha) collisions.push(source.ref);
    }
    if (collisions.length) throw new Error(`destination ref collision ${collisions.join(", ")}`);
    if (options.fail === "fetch") throw new Error("injected fetch failure");
    if (missing.length) git(operator, "fetch", "--atomic", "--no-tags", sandbox, ...missing.map(({ ref }) => `${ref}:${ref}`));
    phases.push("fetch");
  } catch (error) {
    const reason = cleanupReason("fetch", error, sandbox);
    factory(sandbox, "terminal", runId, "completed", "--reason", reason);
    return { reason, phases, refs: refs ?? [] };
  }
  const plane = join(sandbox, ".factory", runId);
  let sourceInventory;
  try {
    if (existsSync(archive)) throw new Error(`archive exists at ${archive}`);
    if (options.fail === "archive") throw new Error("injected archive failure");
    sourceInventory = treeInventory(plane);
    mkdirSync(dirname(archive), { recursive: true });
    cpSync(plane, archive, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    phases.push("archive");
  } catch (error) {
    const reason = cleanupReason("archive", error, sandbox);
    factory(sandbox, "terminal", runId, "completed", "--reason", reason);
    return { reason, phases, refs };
  }
  try {
    if (options.fail === "verify") writeFileSync(join(archive, "artifacts", "payload.txt"), "changed after archive\n");
    for (const source of refs) assert.equal(refSha(operator, source.ref), source.sha);
    const archivedStatus = factory(operator, "status", runId);
    assert.equal(archivedStatus.status, "completed");
    assert.equal(archivedStatus.terminal_result.reason, "draft-pr-recorded");
    assert.deepEqual(treeInventory(archive), sourceInventory);
    phases.push("verify");
  } catch (error) {
    const reason = cleanupReason("verify", error, sandbox);
    factory(sandbox, "terminal", runId, "completed", "--reason", reason);
    return { reason, phases, refs, sourceInventory };
  }
  try {
    removalGuard(operator, container, options.removePath ?? sandbox);
    if (options.fail === "remove") throw new Error("injected remove failure");
    rmSync(sandbox, { recursive: true });
    phases.push("remove");
  } catch (error) {
    const reason = cleanupReason("remove", error, sandbox);
    factory(operator, "terminal", runId, "completed", "--reason", reason);
    return { reason, phases, refs, sourceInventory, status: factory(operator, "status", runId) };
  }
  return { phases, refs, sourceInventory, status: factory(operator, "status", runId) };
}

function createFixture(label, { legacy = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `factory-terminal-${label}-`)));
  const operator = join(root, "operator");
  const container = join(root, ".operator.factory-sandboxes");
  const runId = `handoff-${label}`;
  const sandbox = join(container, runId);
  const archive = join(operator, ".factory", runId);
  mkdirSync(operator);
  git(operator, "init", "--quiet", "--initial-branch=main");
  git(operator, "config", "user.name", "Factory Test");
  git(operator, "config", "user.email", "factory@example.test");
  writeFileSync(join(operator, "base.txt"), "base\n");
  git(operator, "add", "base.txt");
  git(operator, "commit", "--quiet", "-m", "base");
  if (legacy) {
    factory(operator, "init", runId, "--branch", `feature/${runId}`, "--pr-base", "main");
    return { root, operator, container, sandbox, archive, runId, legacy: true };
  }
  mkdirSync(container);
  git(root, "clone", "--quiet", "--local", operator, sandbox);
  git(sandbox, "config", "user.name", "Factory Test");
  git(sandbox, "config", "user.email", "factory@example.test");
  git(sandbox, "switch", "--quiet", "-c", `feature/${runId}`);
  writeFileSync(join(sandbox, "feature.txt"), "feature\n");
  git(sandbox, "add", "feature.txt");
  git(sandbox, "commit", "--quiet", "-m", "feature");
  const featureSha = git(sandbox, "rev-parse", "HEAD");
  git(sandbox, "switch", "--quiet", "-c", `factory/${runId}/open`);
  writeFileSync(join(sandbox, "slice.txt"), "open slice\n");
  git(sandbox, "add", "slice.txt");
  git(sandbox, "commit", "--quiet", "-m", "open slice");
  const openSha = git(sandbox, "rev-parse", "HEAD");
  git(sandbox, "branch", `factory/${runId}/merged`, featureSha);
  git(sandbox, "switch", "--quiet", `feature/${runId}`);
  factory(sandbox, "init", runId, "--branch", `feature/${runId}`, "--pr-base", "main");
  const plane = join(sandbox, ".factory", runId);
  const runPath = join(plane, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const slice = (id, status, branch, baseRef, mergeCommit = null) => ({
    id, stack: "backend", depends_on: [], status, worktree: status === "pending" ? null : sandbox,
    branch, attempts: 1, paths: [`${id}.txt`], test_plan: [], base_ref: baseRef,
    evidence_ref: null, review_ref: null, merge_commit: mergeCommit,
  });
  run.slices = [
    slice("merged", "merged", `factory/${runId}/merged`, featureSha, featureSha),
    slice("open", "running", `factory/${runId}/open`, featureSha),
    slice("unstarted", "pending", null, null),
  ];
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(plane, "artifacts", "payload.txt"), "archive payload\n");
  chmodSync(join(plane, "artifacts", "payload.txt"), 0o640);
  mkdirSync(join(plane, "artifacts", "nested"));
  writeFileSync(join(plane, "artifacts", "nested", "detail.txt"), "nested\n");
  symlinkSync("payload.txt", join(plane, "artifacts", "payload-link"));
  const worktrees = join(sandbox, ".factory", "worktrees", runId, "open");
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(join(worktrees, "excluded.txt"), "not archived\n");
  return { root, operator, container, sandbox, archive, runId, legacy: false, featureSha, openSha };
}

function sourceFiles(directory = pkg, found = []) {
  for (const entry of readdirSync(directory)) {
    if ([".git", "node_modules"].includes(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if ([".js", ".mjs", ".cjs", ".json"].some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

test("AC10-AC13/AC20 completed handoff fetches, archives, verifies, and only then removes the sandbox", () => {
  const skill = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
  const start = skill.indexOf("## Step 7 — Summary and completed sandbox handoff");
  const end = skill.indexOf("## Resuming", start);
  assert.ok(start >= 0 && end > start, "AC10 completed handoff section must precede resume behavior");
  const handoff = skill.slice(start, end);
  const required = (fragment) => {
    const index = handoff.indexOf(fragment);
    assert.notEqual(index, -1, `AC10-AC13 completed handoff contract is missing: ${fragment}`);
    return index;
  };
  for (const fragment of [
    "stop heartbeats and require that no agent remains active",
    'factory terminal "$R" completed --reason "draft-pr-recorded" --repo "$RUN_REPO"',
    "status is not `merged` and whose recorded branch is non-null",
    "Exclude merged slices even if their local\nbranches still exist, and exclude null slice branches.",
    "Inspect all destinations first, and if any collision exists run\nno fetch at all.",
    'git -C "$O" fetch --atomic --no-tags "$S"',
    "Never add `--force`, a leading `+`, tags, one fetch per branch, or a push.",
    "require `A` to be absent",
    "Never overwrite, merge with, or\ndelete an existing `A`.",
    "`W` is outside `P`; do not copy slice worktrees",
    "containing `.` and\nevery descendant",
    "relative path, type, and permission mode",
    "SHA-256 of its bytes",
    "symbolic link records its link target",
    "absence of missing or extra archive entries",
    "require parsed status `completed` with reason exactly `draft-pr-recorded`",
    "cleanup <fetch|archive|verify> failed: <single-line error>; sandbox retained at <S>",
    "stops every later phase, leaves `S` in place",
    "Require `S` and\n`C` to be real directories rather than symbolic links",
    "require the canonical parent of `S` to\nequal canonical `C`",
    "Refuse `/`, `O`, or any path not exactly the deterministic sandbox.",
    "cleanup remove failed: <single-line error>; residual sandbox at <S>",
    "update the\ncompleted result in the archive",
    "make the final status read from `O`",
    "A legacy run selected at `RUN_REPO=\"$O\"` keeps its prior local behavior",
    "never fetch from, archive, or remove a supposed sandbox",
    "`blocked`, `partial`,\n`needs-human`, and nonterminal dead-lock runs only report their sandbox paths and remain untouched",
    "no handoff journal, replay protocol, retry loop,\nintermediate archive plane, tombstone, or cleanup state machine",
  ]) required(fragment);
  const ordered = [
    "stop heartbeats",
    'factory terminal "$R" completed --reason "draft-pr-recorded"',
    "### Completed sandbox branch inventory and fetch",
    "Preflight every destination",
    'fetch --atomic --no-tags "$S"',
    "### Completed sandbox archive",
    "require `A` to be absent",
    "copy the complete live plane `P`",
    "### Completed sandbox verification and removal",
    "verify every inventoried operator ref",
    "compare the complete source and archive inventories",
    "Only after all ref and archive verification succeeds",
    "recursively remove `S`",
    "make the final status read from `O`",
  ].map(required);
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right), "AC10 handoff phases must be strictly ordered");
  assert.equal((handoff.match(/fetch --atomic --no-tags/gu) ?? []).length, 1, "AC10 documents one atomic fetch shape");
  assert.doesNotMatch(handoff, /fetch[^\n]*(?:--force|\+refs\/heads)/u);
  assert.doesNotMatch(handoff, /factory\s+(?:cleanup|replay|retry)|cleanup\.(?:json|lock)|archive-(?:stage|tombstone)/u);

  const fixtures = [];
  try {
    const success = createFixture("success");
    fixtures.push(success);
    const completed = completedHandoff(success);
    assert.deepEqual(completed.phases, ["terminal", "fetch", "archive", "verify", "remove"], "AC10 all gates must complete in order");
    assert.equal(existsSync(success.sandbox), false, "AC10 verified sandbox must be removed");
    assert.equal(completed.status.terminal_result.reason, "draft-pr-recorded");
    assert.deepEqual(completed.refs.map(({ ref }) => ref), [
      `refs/heads/factory/${success.runId}/open`, `refs/heads/feature/${success.runId}`,
    ], "AC10 inventory must select the feature and only nonmerged non-null slice refs");
    assert.equal(refSha(success.operator, `refs/heads/feature/${success.runId}`), success.featureSha);
    assert.equal(refSha(success.operator, `refs/heads/factory/${success.runId}/open`), success.openSha);
    assert.equal(refSha(success.operator, `refs/heads/factory/${success.runId}/merged`), null, "AC10 merged slice refs must not be fetched");
    assert.ok(completed.sourceInventory.some((entry) => entry.type === "directory" && entry.path === "artifacts/nested"));
    assert.ok(completed.sourceInventory.some((entry) => entry.type === "symlink" && entry.target === "payload.txt"));
    assert.ok(completed.sourceInventory.some((entry) => entry.type === "regular" && entry.mode === 0o640 && entry.sha256));
    assert.equal(existsSync(join(success.archive, "..", "worktrees")), false, "AC10 W must not enter the archive");

    const collision = createFixture("collision");
    fixtures.push(collision);
    git(collision.operator, "branch", `feature/${collision.runId}`, "main");
    const collided = completedHandoff(collision);
    assert.deepEqual(collided.phases, ["terminal"], "AC10 collision preflight must fail before any fetch");
    assert.match(collided.reason, new RegExp(`^cleanup fetch failed: destination ref collision refs/heads/feature/${collision.runId}; sandbox retained at `, "u"));
    assert.equal(refSha(collision.operator, `refs/heads/factory/${collision.runId}/open`), null, "AC10 collision must prevent an earlier missing ref from being fetched");
    assert.equal(existsSync(collision.archive), false);
    assert.equal(existsSync(collision.sandbox), true, "AC12 fetch failure must retain S");

    for (const phase of ["fetch", "archive", "verify"]) {
      const failed = createFixture(`failed-${phase}`);
      fixtures.push(failed);
      const result = completedHandoff(failed, { fail: phase });
      assert.match(result.reason, new RegExp(`^cleanup ${phase} failed: [^\\r\\n]+; sandbox retained at ${failed.sandbox.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
      assert.equal(existsSync(failed.sandbox), true, `AC12 ${phase} failure must retain S`);
      assert.equal(result.phases.includes("remove"), false, `AC12 ${phase} failure must stop removal`);
      if (phase === "fetch") assert.equal(result.phases.includes("archive"), false);
      if (phase === "archive") assert.equal(result.phases.includes("verify"), false);
    }

    const existingArchive = createFixture("archive-collision");
    fixtures.push(existingArchive);
    mkdirSync(existingArchive.archive, { recursive: true });
    writeFileSync(join(existingArchive.archive, "owner.txt"), "preexisting\n");
    const archiveCollision = completedHandoff(existingArchive);
    assert.match(archiveCollision.reason, /^cleanup archive failed: archive exists at /u);
    assert.equal(readFileSync(join(existingArchive.archive, "owner.txt"), "utf8"), "preexisting\n", "AC10 archive collision must not overwrite or merge");

    const removeFailure = createFixture("remove-failure");
    fixtures.push(removeFailure);
    const residual = completedHandoff(removeFailure, { fail: "remove" });
    assert.deepEqual(residual.phases, ["terminal", "fetch", "archive", "verify"], "AC12 remove can run only after verified archive");
    assert.equal(residual.reason, `cleanup remove failed: injected remove failure; residual sandbox at ${removeFailure.sandbox}`);
    assert.equal(residual.status.terminal_result.reason, residual.reason, "AC12 remove failure must be recorded via O");
    assert.equal(existsSync(removeFailure.sandbox), true);

    const guarded = createFixture("guarded");
    fixtures.push(guarded);
    const escaped = completedHandoff(guarded, { removePath: guarded.operator });
    assert.match(escaped.reason, /^cleanup remove failed: /u);
    assert.equal(existsSync(guarded.sandbox), true, "AC10 destructive guard must retain a mismatched target");
    assert.equal(existsSync(guarded.operator), true, "AC10 destructive guard must never remove O");

    const retained = createFixture("retained");
    fixtures.push(retained);
    for (const status of ["blocked", "partial", "needs-human"]) {
      assert.deepEqual(completedHandoff(retained, { status }).phases, [], `AC11 ${status} must not start handoff`);
    }
    assert.deepEqual(completedHandoff(retained, { deadLock: true }).phases, [], "AC13 dead nonterminal run must not start handoff");
    assert.equal(existsSync(retained.sandbox), true);

    const legacy = createFixture("legacy", { legacy: true });
    fixtures.push(legacy);
    const local = completedHandoff(legacy);
    assert.deepEqual(local.phases, ["terminal"]);
    assert.equal(local.status.terminal_result.reason, "draft-pr-recorded");
    assert.equal(existsSync(legacy.operator), true, "AC10 legacy completion must preserve O");
    assert.equal(existsSync(legacy.container), false, "AC10 legacy completion must not create or clean a sandbox");

    const files = sourceFiles();
    const productionLines = files.filter((path) => !path.includes(`${pkg}/test/`))
      .reduce((total, path) => total + readFileSync(path, "utf8").split("\n").length, 0);
    const sites = files.filter((path) => path.endsWith(".test.js"))
      .reduce((total, path) => total + (readFileSync(path, "utf8").match(/^\s*(?:it|test)\(/gmu)?.length ?? 0), 0);
    assert.equal(productionLines, 2665, "AC20 production must remain exactly 2665 lines");
    assert.equal(sites, 87, "AC20 factory test sites must be exactly 87");
  } finally {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
  }
});
