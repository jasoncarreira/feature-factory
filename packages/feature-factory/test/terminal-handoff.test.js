import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initFresh, seedLegacyRun } from "./init-fixture.js";

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

function inspectRef(repository, ref) {
  const existence = spawnSync("git", ["-C", repository, "show-ref", "--verify", "--quiet", ref], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (existence.status === 1) return { exists: false, sha: null };
  if (existence.status !== 0) throw new Error(existence.stderr.trim() || `could not inspect ${ref}`);
  const peeled = spawnSync("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  return { exists: true, sha: peeled.status === 0 ? peeled.stdout.trim() : null };
}

function refSha(repository, ref) {
  return inspectRef(repository, ref).sha;
}

function pathEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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
    const source = inspectRef(sandbox, ref);
    if (!source.exists) throw new Error(`missing source ${ref}`);
    if (!source.sha) throw new Error(`source is not a commit ${ref}`);
    if (refs.has(ref) && refs.get(ref) !== source.sha) throw new Error(`duplicate source ${ref}`);
    refs.set(ref, source.sha);
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
  const events = [];
  const invoke = (repository, command, ...args) => {
    events.push({ command, repository });
    return factory(repository, command, ...args);
  };
  if (options.status && options.status !== "completed" || options.deadLock) return { phases: [], events };
  const selectedRepository = fixture.legacy ? operator : sandbox;
  const preflightRun = JSON.parse(readFileSync(join(selectedRepository, ".factory", runId, "run.json"), "utf8"));
  if (!preflightRun.pr_url) return { phases: [], events, refusal: "draft PR is not recorded" };
  const activeStep = preflightRun.steps.some((step) => step.status === "running");
  const activeSlice = preflightRun.slices.some((slice) => ["running", "review"].includes(slice.status));
  if (options.heartbeatActive || options.agentActive || activeStep || activeSlice) {
    return { phases: [], events, refusal: "handoff is not quiescent" };
  }
  if (fixture.legacy) {
    invoke(operator, "terminal", runId, "completed", "--reason", "draft-pr-recorded");
    return { status: invoke(operator, "status", runId), phases: ["terminal"], events };
  }
  invoke(sandbox, "terminal", runId, "completed", "--reason", "draft-pr-recorded");
  const phases = ["terminal"];
  const run = JSON.parse(readFileSync(join(sandbox, ".factory", runId, "run.json"), "utf8"));
  let refs;
  let fetchInvocations = 0;
  const sandboxFailure = (phase, error) => {
    const reason = cleanupReason(phase, error, sandbox);
    invoke(sandbox, "terminal", runId, "completed", "--reason", reason);
    const persisted = JSON.parse(readFileSync(join(sandbox, ".factory", runId, "run.json"), "utf8"));
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.terminal_result?.status, "completed");
    assert.equal(persisted.terminal_result?.reason, reason);
    return { reason, persisted };
  };
  try {
    refs = branchInventory(run, sandbox);
    const missing = [];
    const collisions = [];
    for (const source of refs) {
      const destination = inspectRef(operator, source.ref);
      if (!destination.exists) missing.push(source);
      else if (!destination.sha || destination.sha !== source.sha) collisions.push(source.ref);
    }
    if (collisions.length) throw new Error(`destination ref collision ${collisions.join(", ")}`);
    if (options.fail === "fetch") throw new Error("injected fetch failure");
    if (missing.length) {
      git(operator, "fetch", "--atomic", "--no-tags", sandbox, ...missing.map(({ ref }) => `${ref}:${ref}`));
      fetchInvocations += 1;
    }
    phases.push("fetch");
  } catch (error) {
    const failure = sandboxFailure("fetch", error);
    return { ...failure, phases, refs: refs ?? [], fetchInvocations, events };
  }
  const plane = join(sandbox, ".factory", runId);
  let sourceInventory;
  try {
    const archiveParent = dirname(archive);
    let parent = pathEntry(archiveParent);
    if (parent === null) {
      mkdirSync(archiveParent);
      parent = pathEntry(archiveParent);
    }
    if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error(`archive parent is not a real directory ${archiveParent}`);
    if (pathEntry(archive) !== null) throw new Error(`archive exists at ${archive}`);
    if (options.fail === "archive") throw new Error("injected archive failure");
    sourceInventory = treeInventory(plane);
    cpSync(plane, archive, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    phases.push("archive");
  } catch (error) {
    const failure = sandboxFailure("archive", error);
    return { ...failure, phases, refs, fetchInvocations, events };
  }
  try {
    if (options.fail === "verify") writeFileSync(join(archive, "artifacts", "payload.txt"), "changed after archive\n");
    for (const source of refs) assert.equal(refSha(operator, source.ref), source.sha);
    const archivedStatus = invoke(operator, "status", runId);
    assert.equal(archivedStatus.status, "completed");
    assert.equal(archivedStatus.terminal_result.reason, "draft-pr-recorded");
    assert.deepEqual(treeInventory(archive), sourceInventory);
    phases.push("verify");
  } catch (error) {
    const failure = sandboxFailure("verify", error);
    return { ...failure, phases, refs, sourceInventory, fetchInvocations, events };
  }
  try {
    removalGuard(operator, container, options.removePath ?? sandbox);
    if (options.fail === "remove") throw new Error("injected remove failure");
    rmSync(sandbox, { recursive: true });
    phases.push("remove");
  } catch (error) {
    const reason = cleanupReason("remove", error, sandbox);
    invoke(operator, "terminal", runId, "completed", "--reason", reason);
    return { reason, phases, refs, sourceInventory, fetchInvocations, events, status: invoke(operator, "status", runId) };
  }
  return { phases, refs, sourceInventory, fetchInvocations, events, status: invoke(operator, "status", runId) };
}

function createFixture(label, { legacy = false, mode = "interactive", openStatus = "blocked", runningStep = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `factory-terminal-${label}-`)));
  const operator = join(root, "operator");
  const container = join(operator, ".factory-sandboxes");
  const runId = `handoff-${label}`;
  let sandbox = join(container, runId);
  const archive = join(operator, ".factory", runId);
  mkdirSync(operator);
  git(operator, "init", "--quiet", "--initial-branch=main");
  git(operator, "config", "user.name", "Factory Test");
  git(operator, "config", "user.email", "factory@example.test");
  writeFileSync(join(operator, "base.txt"), "base\n");
  writeFileSync(join(operator, ".gitignore"), ".factory/\n/.factory-sandboxes/\n");
  git(operator, "add", "base.txt", ".gitignore");
  git(operator, "commit", "--quiet", "-m", "base");
  if (legacy) {
    const initialized = seedLegacyRun(operator, runId, { branch: `feature/${runId}`, pr_base: "main", mode });
    const runPath = join(initialized.runDir, "run.json");
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    run.pr_url = `https://example.test/${runId}`;
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
    return { root, operator, container, sandbox, archive, runId, legacy: true };
  }
  const featureBranch = `feature/${runId}`;
  const featureRef = `refs/heads/${featureBranch}`;
  git(operator, "remote", "add", "origin", operator);
  assert.equal(inspectRef(operator, featureRef).exists, false);
  const seedHead = git(operator, "rev-parse", "main^{commit}");
  const initialized = initFresh(operator, [runId, "--branch", featureBranch, "--pr-base", "main", "--mode", mode]);
  sandbox = initialized.repository;
  assert.equal(sandbox, join(container, runId));
  assert.equal(inspectRef(operator, featureRef).exists, false);
  git(sandbox, "config", "user.name", "Factory Test");
  git(sandbox, "config", "user.email", "factory@example.test");
  const operatorPush = git(operator, "remote", "get-url", "--push", "origin");
  git(sandbox, "config", "--replace-all", "remote.origin.pushurl", operatorPush);
  assert.equal(git(operator, "remote", "get-url", "--push", "origin"), git(sandbox, "remote", "get-url", "--push", "origin"));
  assert.equal(inspectRef(operator, featureRef).exists, false);
  assert.equal(git(sandbox, "symbolic-ref", "--quiet", "--short", "HEAD"), featureBranch);
  assert.equal(git(sandbox, "rev-parse", `${featureRef}^{commit}`), seedHead);
  assert.equal(git(sandbox, "rev-parse", "HEAD^{commit}"), seedHead);
  assert.equal(inspectRef(operator, featureRef).exists, false);
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
  git(sandbox, "switch", "--quiet", featureBranch);
  const plane = initialized.runDir;
  const runPath = join(plane, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  run.pr_url = `https://example.test/${runId}`;
  const slice = (id, status, branch, baseRef, mergeCommit = null) => ({
    id, stack: "backend", depends_on: [], status, worktree: status === "pending" ? null : sandbox,
    branch, attempts: 1, paths: [`${id}.txt`], test_plan: [], base_ref: baseRef,
    evidence_ref: null, review_ref: null, merge_commit: mergeCommit,
  });
  run.slices = [
    slice("merged", "merged", `factory/${runId}/merged`, featureSha, featureSha),
    slice("open", openStatus, `factory/${runId}/open`, featureSha),
    slice("unstarted", "pending", null, null),
  ];
  if (runningStep) run.steps = [{ agent: "backend-builder", status: "running", attempts: 1, review_ref: null, evidence_ref: null }];
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

test("AC10-AC13/AC20 completed handoff fetches, archives, verifies, and only then removes the sandbox", () => {
  // mimir 1483, as a negative control: a run that published nothing may not claim `completed`. Built inline
  // rather than through createFixture, because every fixture there is deliberately post-publication -- the
  // legacy path writes a `pr_url` outright -- and the defect only exists before a PR is recorded.
  const bareRoot = realpathSync(mkdtempSync(join(tmpdir(), "factory-terminal-bare-")));
  const bare = join(bareRoot, "operator");
  mkdirSync(bare);
  git(bare, "init", "--quiet", "--initial-branch=main");
  git(bare, "config", "user.name", "Factory Test");
  git(bare, "config", "user.email", "factory@example.test");
  writeFileSync(join(bare, ".gitignore"), ".factory/\n/.factory-sandboxes/\n");
  git(bare, "add", ".gitignore");
  git(bare, "commit", "--quiet", "-m", "base");
  const bareSandbox = initFresh(bare, ["bare-run", "--pr-base", "main", "--mode", "autonomous"]).repository;
  const refused = spawnSync("node", [cli, "terminal", "bare-run", "completed", "--reason", "nothing-shipped", "--repo", bareSandbox, "--json"], { encoding: "utf8" });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /terminal completed requires a recorded pr_url/u);
  assert.equal(factory(bareSandbox, "status", "bare-run").status, "running", "a refused terminalization leaves the run running");
  assert.equal(factory(bareSandbox, "terminal", "bare-run", "blocked", "--reason", "nothing-shipped").status, "blocked");

  // A parked run's control plane was archived nowhere: the completed handoff is the only thing that archives
  // it, and it is entered only for `completed`. So `needs-human` -- the state that by definition waits for
  // outside intervention -- was the one state with no durable copy, and mimir chainlink 1521 lost an accepted
  // brief, a ratified ten-slice plan and four review verdicts when a controller swept a parked sandbox.
  //
  // Instruction, not code: `sandbox-lifecycle` forbids copy and delete primitives in this CLI, and archiving
  // is already a driver step -- the completed archive is prose too. A first attempt put this in `terminal`
  // with `cpSync`/`rmSync` and that ban rejected it, correctly.
  //
  // ROUTING and ORDERING, not presence. Review of the first attempt caught why: the section sat inside
  // `## Step 7`, whose entry conditions are post-draft-PR and whose first transition is `completed`, so no
  // park path ever reached it. Prose nobody reaches is worse than none, because it reads as coverage.
  const parkPolicy = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
  const modesStart = parkPolicy.indexOf("## Operating modes");
  const modesEnd = parkPolicy.indexOf("## Autonomous mode");
  assert.ok(modesStart >= 0 && modesEnd > modesStart);
  const enterAt = parkPolicy.indexOf("Enter the parked stop with factory terminal R needs-human");
  const routeAt = parkPolicy.indexOf("Immediately after recording a `needs-human` terminalization, and before reporting the park to the operator,");
  const reportAt = parkPolicy.indexOf("Report top-level needs-human as parked with its reason");
  const sectionAt = parkPolicy.indexOf("### Parked control-plane snapshot");
  assert.ok(enterAt >= 0 && routeAt > enterAt && reportAt > routeAt,
    "the snapshot must be required after entering the park and before reporting it");
  assert.ok(sectionAt > modesStart && sectionAt < modesEnd,
    "the mechanics must live inside Operating modes, not inside a completed-only step");
  assert.ok(sectionAt < parkPolicy.indexOf("### Completed sandbox archive"));
  assert.match(parkPolicy, /A park\s+is not reported until that snapshot is published or its failure is recorded in the report\./u,
    "the park report must depend on the snapshot, or the routing is advisory");

  // Failure-safe publication, pinned as commit-point phases rather than as a flat rule. Two review rounds
  // shaped this. First: "replaces its own prior snapshot" permitted delete-then-copy, so a failed second
  // park could erase the last known-good evidence. Then the staged version still contradicted itself --
  // after staging is renamed onto the canonical path the old snapshot IS `.prior-$R`, so "leave the previous
  // snapshot exactly as it was" and "remove this procedure's prior path" were mutually impossible, and a
  // partial removal could not be undone. The rule only closes if the rename is named as the commit point.
  const parkSection = parkPolicy.slice(sectionAt, parkPolicy.indexOf("At every interactive gate"));
  for (const fragment of [
    "**Publication has exactly one commit point: the rename that puts a verified staging tree onto the canonical\npath.**",
    "$O/.factory/.parked/.staging-$R",
    "A residual\n   `$O/.factory/.parked/.prior-$R` is the trace of an earlier publication whose cleanup did not finish",
    "remove it before staging, and if that removal fails, report it and stop without\n   touching the canonical snapshot",
    "require exact equality. An unverified staging tree is never published",
    "rename `.prior-$R` back onto the canonical path and report: nothing was\n   committed",
    "**Before the commit point, no publication has occurred.**",
    "restoring it from `.prior-$R` when it had already been moved",
    "**After the commit point, the published snapshot is authoritative and is never rolled back.**",
    "report a cleanup warning naming the\n   residual path and leave the published snapshot exactly as committed",
    "A later park removes that residual\n   at preflight, as step 1 requires",
    "`.staging-$R` and `.prior-$R` cannot be run ids",
    "It never touches `S`",
    "does not prevent or undo the park",
    "Do not\npublish one for `blocked` or `partial`",
  ]) {
    assert.ok(parkSection.includes(fragment), `the parked-snapshot contract must state: ${fragment}`);
  }
  // The phases must be ordered, and the two failure rules must be stated relative to the commit point --
  // a flat "on any failure" rule is what was contradictory.
  const phases = ["**Preflight.**", "**Stage.**", "**Verify.**", "**Commit.**",
    "**Before the commit point,", "**After the commit point,"];
  let phaseCursor = -1;
  for (const phase of phases) {
    const at = parkSection.indexOf(phase);
    assert.ok(at > phaseCursor, `publication phases must be ordered; ${phase} is out of place`);
    phaseCursor = at;
  }
  assert.doesNotMatch(parkSection, /replaces its own prior snapshot/u,
    "unstaged replacement must not return: it can destroy the last good snapshot on a failed park");
  assert.doesNotMatch(parkSection, /On any failure in 1 through 3, leave the previous snapshot exactly as it was/u,
    "the flat failure rule must not return: it is unimplementable once staging has been committed");

  // ROUTING, take two. 0.8.2 required the snapshot and it did not fire on the first real park: eleven
  // one-line rules say a run parks and defer to the shared semantics, and the snapshot was appended to those
  // semantics as a sentence rather than being a step of an ordered sequence those rules enter. The parked
  // stop is now numbered, and the numbering is what a driver walking a list actually follows.
  const seqLead = parkPolicy.indexOf("**The parked stop is one ordered sequence, and every rule in this document that says a run parks enters");
  assert.ok(seqLead >= 0, "the parked stop must be introduced as one ordered sequence every park rule enters");
  const stepPositions = ["1. Enter the parked stop with factory terminal R needs-human",
    "2. Immediately after recording a `needs-human` terminalization",
    "3. Report top-level needs-human as parked with its reason"].map((step) => parkPolicy.indexOf(step));
  assert.ok(stepPositions.every((at, index) => at > (index === 0 ? seqLead : stepPositions[index - 1])),
    `the three park steps must be numbered and ordered: ${stepPositions.join(", ")}`);
  assert.match(parkPolicy, /A park that completes only step 1 is an unreported park with no recovery evidence/u,
    "the sequence must say what a partial park leaves behind, or step 2 reads as optional");
  assert.match(parkPolicy, /qualified status\s+reports `park_snapshot` as the published path, or `null` when no snapshot exists/u,
    "the contract must name how an outside observer verifies step 2");

  // And the observable half, live: a park with no snapshot on disk reports null rather than nothing at all.
  // This is what would have caught 0.8.2's miss without waiting for a real run to need the snapshot.
  const obsRoot = realpathSync(mkdtempSync(join(tmpdir(), "factory-terminal-obs-")));
  const obsOperator = join(obsRoot, "operator");
  mkdirSync(obsOperator);
  git(obsOperator, "init", "--quiet", "--initial-branch=main");
  git(obsOperator, "config", "user.name", "Factory Test");
  git(obsOperator, "config", "user.email", "factory@example.test");
  writeFileSync(join(obsOperator, ".gitignore"), ".factory/\n/.factory-sandboxes/\n");
  git(obsOperator, "add", ".gitignore");
  git(obsOperator, "commit", "--quiet", "-m", "base");
  const obsSandbox = initFresh(obsOperator, ["obs-run", "--pr-base", "main", "--mode", "autonomous"]).repository;
  assert.equal(factory(obsSandbox, "status", "obs-run", "--json").park_snapshot, null,
    "a running run reports no park snapshot");
  factory(obsSandbox, "terminal", "obs-run", "needs-human", "--reason", "parked without a snapshot");
  assert.equal(factory(obsSandbox, "status", "obs-run", "--json").park_snapshot, null,
    "a park whose snapshot was skipped must report null, not silence");
  // The observation must prove the publication HAPPENED, not that a pathname exists and not that one file
  // was copied. Three versions of this were wrong and each was caught in review. `existsSync` reported a
  // snapshot from an earlier park as this park's evidence. Matching only `run.json` proved one file was
  // copied after the current terminalization -- a driver that created the directory and copied that file
  // first, or an interrupted copy, still read as published; the test for it constructed exactly that shape,
  // so the test demonstrated the hole rather than catching it. The property is inventory equality, which is
  // what the publication contract already requires.
  const published = join(obsOperator, ".factory", ".parked", "obs-run");
  const livePlane = join(obsSandbox, ".factory", "obs-run");
  const snapshotOf = (parked) => factory(obsSandbox, "status", "obs-run", "--json").park_snapshot;
  mkdirSync(published, { recursive: true });
  cpSync(join(livePlane, "run.json"), join(published, "run.json"));
  assert.equal(snapshotOf(), null,
    "a directory holding only a current run.json is not a published snapshot");
  cpSync(livePlane, published, { recursive: true });
  assert.equal(snapshotOf(), published,
    "a complete publication is reported by path, so a controller can verify it without guessing");
  // A missing artifact, with run.json still matching: the case the manifest-only check accepted.
  const workflowCopy = join(published, "WORKFLOW.md");
  const workflowBytes = readFileSync(workflowCopy);
  rmSync(workflowCopy);
  assert.equal(snapshotOf(), null, "a publication missing an artifact is not complete, even with a current run.json");
  writeFileSync(workflowCopy, Buffer.concat([workflowBytes, Buffer.from("x")]));
  assert.equal(snapshotOf(), null, "a resized artifact is not a faithful copy of the plane");
  writeFileSync(workflowCopy, workflowBytes);
  assert.equal(snapshotOf(), published, "restoring the artifact restores the observation");
  // Stale: published for an earlier park, the plane has since moved on.
  const staleManifest = JSON.parse(readFileSync(join(livePlane, "run.json"), "utf8"));
  writeFileSync(join(published, "run.json"), `${JSON.stringify({ ...staleManifest, updated_at: "2026-01-01T00:00:00.000Z" }, null, 2)}\n`);
  assert.equal(snapshotOf(), null, "a snapshot from an earlier park is not this park's evidence");
  // Neither a file, a symlink, nor a symlinked parent component is a published snapshot. `lstat` on the
  // final entry alone follows intermediate components, so every component is checked.
  rmSync(published, { recursive: true, force: true });
  writeFileSync(published, "not a snapshot\n");
  assert.equal(snapshotOf(), null, "a file at the canonical path is not a published snapshot");
  rmSync(published, { force: true });
  symlinkSync(livePlane, published);
  assert.equal(snapshotOf(), null, "a symlink at the canonical path is not a published snapshot");
  // Moved aside rather than removed: `rmSync` without `recursive` throws EISDIR on a symlink to a directory,
  // and with `recursive` it would follow the link into the live plane and delete it.
  renameSync(published, join(obsRoot, "discarded-symlink"));
  const elsewhere = join(obsRoot, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  cpSync(livePlane, join(elsewhere, "obs-run"), { recursive: true });
  rmSync(join(obsOperator, ".factory", ".parked"), { recursive: true, force: true });
  symlinkSync(elsewhere, join(obsOperator, ".factory", ".parked"));
  assert.equal(snapshotOf(), null, "a symlinked parent component is not a published snapshot path");

  const skill = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
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
    "stop the heartbeat loop and wait for any heartbeat call already\nin flight to return",
    "no dispatched agent call remains in flight",
    "require no step with status `running` and no slice with status `running` or `review`",
    "without terminalizing, fetching, archiving, or removing\nanything",
    'factory terminal "$R" completed --reason "draft-pr-recorded" --repo "$RUN_REPO"',
    "status is not `merged` and whose recorded branch is non-null",
    "Exclude merged slices even if their local\nbranches still exist, and exclude null slice branches.",
    "Test exact ref existence independently from\ncommit peeling: only a ref proven absent is eligible for fetch.",
    "An existing ref that cannot peel to a commit, or whose commit differs from its source SHA",
    "Inspect all destinations first, and if any collision exists run no fetch at\nall.",
    'git -C "$O" fetch --atomic --no-tags "$S"',
    "Never add `--force`, a leading `+`, tags, one fetch per branch, or a push.",
    "inspect `O/.factory` with a non-following metadata read",
    "create that one directory non-recursively and inspect it again",
    "Never use recursive directory creation for this parent.",
    "Then inspect `A` itself without following links and require no directory entry at all.",
    "A dangling\nsymbolic link at `A`, a live symbolic link, a file, or a directory is an archive collision.",
    "Never write through a symlinked parent, overwrite, merge with, or delete an existing `A`.",
    "do not copy slice worktrees or any other part of `S` into the archive",
    "containing `.` and\nevery descendant",
    "relative path, type, and permission mode",
    "SHA-256 of its bytes",
    "symbolic link records its link target",
    "absence of missing or extra archive entries",
    'factory status "$R" --json --repo "$O"',
    "never with `RUN_REPO` or `S`",
    "Require parsed status `completed` with reason exactly `draft-pr-recorded`",
    "cleanup <fetch|archive|verify> failed: <single-line error>; sandbox retained at <S>",
    'factory terminal "$R" completed --reason "$CLEANUP_REASON" --repo "$S"',
    "require persisted status `completed` and reason\nexactly equal to `CLEANUP_REASON`",
    "stops every later phase, leaves `S` in place",
    "Require `S` and\n`C` to be real directories rather than symbolic links",
    "require the canonical parent of `S` to\nequal canonical `C`",
    "Refuse `/`, `O`, or any path not exactly the deterministic sandbox.",
    "cleanup remove failed: <single-line error>; residual sandbox at <S>",
    "update the\ncompleted result in the archive with the following command",
    'factory terminal "$R" completed --reason "$CLEANUP_REASON" --repo "$O"',
    "make the final read with the following command",
    "A legacy run selected at `RUN_REPO=\"$O\"` keeps\nits prior local behavior",
    "never fetch from,\narchive, or remove a supposed sandbox",
    "Completed handoff remains final, while top-level needs-human is parked and requires explicit factory resume.",
    "`blocked`, `partial`, and nonterminal dead-lock runs only report their sandbox paths and remain untouched",
    "no handoff journal, replay protocol, retry loop,\nintermediate archive plane, tombstone, or cleanup state machine",
  ]) required(fragment);
  const statusAtOperator = [...handoff.matchAll(/factory status "\$R" --json --repo "\$O"/gu)].map((match) => match.index);
  assert.equal(statusAtOperator.length, 2, "AC10 archive verification and final status must both explicitly target O");
  const ordered = [
    "stop the heartbeat loop",
    "no dispatched agent call remains in flight",
    'factory terminal "$R" completed --reason "draft-pr-recorded"',
    "### Completed sandbox branch inventory and fetch",
    "Preflight every destination",
    'fetch --atomic --no-tags "$S"',
    "### Completed sandbox archive",
    "inspect `O/.factory` with a non-following metadata read",
    "inspect `A` itself without following links",
    "Copy the complete live plane `P`",
    "### Completed sandbox verification and removal",
    "verify every inventoried operator ref",
    'factory status "$R" --json --repo "$O"',
    "compare the complete source and archive inventories",
    "Only after all ref and archive verification succeeds",
    "recursively remove `S`",
    "make the final read with the following command",
  ].map(required);
  ordered.push(statusAtOperator[1]);
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right), "AC10 handoff phases must be strictly ordered");
  assert.equal((handoff.match(/fetch --atomic --no-tags/gu) ?? []).length, 1, "AC10 documents one atomic fetch shape");
  assert.doesNotMatch(handoff, /fetch[^\n]*(?:--force|\+refs\/heads)/u);
  assert.doesNotMatch(handoff, /factory\s+(?:cleanup|replay|retry)|cleanup\.(?:json|lock)|archive-(?:stage|tombstone)/u);

  const autonomousStart = skill.indexOf("## Autonomous mode");
  const autonomousEnd = skill.indexOf("## Step 0", autonomousStart);
  const autonomous = skill.slice(autonomousStart, autonomousEnd);
  for (const fragment of [
    "The draft PR is the last externally publishing side effect an autonomous run",
    "the mandatory local completed handoff in Step 7 still follows and\n  is required in every mode",
    "terminalize, fetch the permitted local refs, archive and verify the control\n  plane, and remove only the guarded sandbox",
    "Autonomous mode never merges an external PR or performs\n  unrelated work after PR recording.",
  ]) assert.match(autonomous, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `AC10 autonomous contract is missing: ${fragment}`);
  assert.doesNotMatch(autonomous, /Creating the draft PR is the last side effect an autonomous run may perform/u,
    "AC10 autonomous mode must permit the mandatory local completed handoff after publication");

  const bootstrapStart = skill.indexOf("During bootstrap and active sandbox\nexecution");
  const bootstrapEnd = skill.indexOf("### Resume or collision", bootstrapStart);
  const operatorBoundary = skill.slice(bootstrapStart, bootstrapEnd);
  for (const fragment of [
    "During bootstrap and active sandbox\nexecution, do not switch, reset, clean, stash, create a branch or worktree, write Git configuration, or\ninitialize factory state directly in `O`.",
    "The only operator-checkout operations before the completed\nhandoff are reads and the Step 6 forge command.",
    "The explicit Step 7 exclusion applies only after the\ndraft PR is recorded",
    "guarded local-ref fetch, archive, verification, and deterministic sandbox\nremoval remain the sole completed-handoff exception to bootstrap/refusal state preservation.",
  ]) assert.ok(operatorBoundary.includes(fragment), `AC10 operator boundary is missing: ${fragment}`);

  const sharedModeRule = "After draft PR recording, `interactive`, `headless`, and `autonomous` modes all enter this same mandatory\nlocal completed handoff.";
  assert.ok(handoff.includes(sharedModeRule), "AC10 all modes must enter the same local completed handoff after PR recording");
  assert.ok(handoff.includes("perform only the terminalize, local-ref fetch, archive, verification, and guarded sandbox-removal\nsequence below"),
    "AC10 autonomous post-PR exception must be limited to the local completed handoff sequence");
  assert.ok(handoff.includes("with no external PR merge or unrelated work after PR recording"),
    "AC10 autonomous post-PR exception must prohibit external PR merge and unrelated work");

  const fixtures = [];
  try {
    const active = createFixture("active", { openStatus: "running" });
    fixtures.push(active);
    const activeResult = completedHandoff(active);
    assert.deepEqual(activeResult.phases, [], "AC10 running slice must refuse before terminalization");
    assert.deepEqual(activeResult.events, [], "AC10 refused quiescence gate must execute no factory command");
    const activeRun = JSON.parse(readFileSync(join(active.sandbox, ".factory", active.runId, "run.json"), "utf8"));
    assert.equal(activeRun.status, "running");
    assert.equal(activeRun.terminal_result, null);
    assert.equal(refSha(active.operator, `refs/heads/feature/${active.runId}`), null);
    assert.equal(pathEntry(active.archive), null);
    assert.equal(existsSync(active.sandbox), true);

    const heartbeat = createFixture("heartbeat");
    fixtures.push(heartbeat);
    const heartbeatResult = completedHandoff(heartbeat, { heartbeatActive: true });
    assert.deepEqual(heartbeatResult.phases, [], "AC10 active heartbeat must refuse before terminalization");
    assert.deepEqual(heartbeatResult.events, []);
    assert.equal(JSON.parse(readFileSync(join(heartbeat.sandbox, ".factory", heartbeat.runId, "run.json"), "utf8")).status, "running");
    assert.equal(refSha(heartbeat.operator, `refs/heads/feature/${heartbeat.runId}`), null);
    assert.equal(pathEntry(heartbeat.archive), null);
    assert.equal(existsSync(heartbeat.sandbox), true);

    const activeAgent = createFixture("active-agent", { runningStep: true });
    fixtures.push(activeAgent);
    assert.deepEqual(completedHandoff(activeAgent).events, [], "AC10 running agent step must refuse before terminalization");

    const modeTable = ["interactive", "headless", "autonomous"].map((mode) => {
      const fixture = createFixture(`mode-${mode}`, { mode });
      fixtures.push(fixture);
      const recorded = JSON.parse(readFileSync(join(fixture.sandbox, ".factory", fixture.runId, "run.json"), "utf8"));
      assert.equal(recorded.mode, mode, `AC10 ${mode} fixture must preserve its admitted mode`);
      assert.equal(recorded.pr_url, `https://example.test/${fixture.runId}`, `AC10 ${mode} handoff must follow PR recording`);
      const result = completedHandoff(fixture, { heartbeatActive: false, agentActive: false });
      assert.deepEqual(result.phases, ["terminal", "fetch", "archive", "verify", "remove"],
        `AC10 ${mode} must enter the same mandatory local completed handoff`);
      assert.deepEqual(result.events, [
        { command: "terminal", repository: fixture.sandbox },
        { command: "status", repository: fixture.operator },
        { command: "status", repository: fixture.operator },
      ], `AC10 ${mode} must terminalize through S and verify and finish through O`);
      assert.equal(existsSync(fixture.sandbox), false, `AC10 ${mode} verified sandbox must be removed`);
      return { mode, fixture, result };
    });
    const { fixture: success, result: completed } = modeTable[0];
    assert.equal(completed.fetchInvocations, 1);
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
    assert.equal(collided.fetchInvocations, 0);
    assert.deepEqual(collided.events, [
      { command: "terminal", repository: collision.sandbox },
      { command: "terminal", repository: collision.sandbox },
    ]);
    assert.equal(collided.persisted.status, "completed");
    assert.equal(collided.persisted.terminal_result.reason, collided.reason);

    const nonCommit = createFixture("non-commit");
    fixtures.push(nonCommit);
    const blobPath = join(nonCommit.root, "blob.txt");
    writeFileSync(blobPath, "not a commit\n");
    const blobSha = git(nonCommit.operator, "hash-object", "-w", blobPath);
    const nonCommitRef = `refs/heads/feature/${nonCommit.runId}`;
    const looseRef = join(nonCommit.operator, ".git", ...nonCommitRef.split("/"));
    mkdirSync(dirname(looseRef), { recursive: true });
    writeFileSync(looseRef, `${blobSha}\n`);
    assert.deepEqual(inspectRef(nonCommit.operator, nonCommitRef), { exists: true, sha: null });
    const nonCommitCollision = completedHandoff(nonCommit);
    assert.deepEqual(nonCommitCollision.phases, ["terminal"]);
    assert.equal(nonCommitCollision.fetchInvocations, 0, "AC10 existing non-commit ref must collide before fetch");
    assert.match(nonCommitCollision.reason, /destination ref collision/u);
    assert.equal(refSha(nonCommit.operator, `refs/heads/factory/${nonCommit.runId}/open`), null);
    assert.equal(existsSync(nonCommit.sandbox), true);

    const equal = createFixture("equal");
    fixtures.push(equal);
    const equalRefs = [`refs/heads/factory/${equal.runId}/open`, `refs/heads/feature/${equal.runId}`];
    git(equal.operator, "fetch", "--atomic", "--no-tags", equal.sandbox, ...equalRefs.map((ref) => `${ref}:${ref}`));
    const alreadyEqual = completedHandoff(equal);
    assert.deepEqual(alreadyEqual.phases, ["terminal", "fetch", "archive", "verify", "remove"]);
    assert.equal(alreadyEqual.fetchInvocations, 0, "AC10 equal existing refs must be omitted from fetch");
    assert.deepEqual(alreadyEqual.refs.map(({ ref }) => ref), equalRefs);

    const failurePhases = new Map([
      ["fetch", ["terminal"]],
      ["archive", ["terminal", "fetch"]],
      ["verify", ["terminal", "fetch", "archive"]],
    ]);
    for (const phase of failurePhases.keys()) {
      const failed = createFixture(`failed-${phase}`);
      fixtures.push(failed);
      const result = completedHandoff(failed, { fail: phase });
      assert.match(result.reason, new RegExp(`^cleanup ${phase} failed: [^\\r\\n]+; sandbox retained at ${failed.sandbox.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
      assert.equal(existsSync(failed.sandbox), true, `AC12 ${phase} failure must retain S`);
      assert.equal(result.phases.includes("remove"), false, `AC12 ${phase} failure must stop removal`);
      assert.deepEqual(result.phases, failurePhases.get(phase), `AC12 ${phase} failure must stop every later phase`);
      const persisted = JSON.parse(readFileSync(join(failed.sandbox, ".factory", failed.runId, "run.json"), "utf8"));
      assert.equal(persisted.status, "completed", `AC12 ${phase} failure must persist completed status in S`);
      assert.equal(persisted.terminal_result.status, "completed");
      assert.equal(persisted.terminal_result.reason, result.reason, `AC12 ${phase} failure must persist exact reason in S`);
      assert.deepEqual(result.events.filter(({ command }) => command === "terminal"), [
        { command: "terminal", repository: failed.sandbox },
        { command: "terminal", repository: failed.sandbox },
      ], `AC12 ${phase} initial and failure terminal transitions must both target S`);
    }

    const symlinkedParent = createFixture("symlink-parent");
    fixtures.push(symlinkedParent);
    const parentTarget = join(symlinkedParent.root, "archive-parent-target");
    mkdirSync(parentTarget);
    writeFileSync(join(parentTarget, "sentinel.txt"), "untouched\n");
    symlinkSync(parentTarget, dirname(symlinkedParent.archive));
    const parentRefusal = completedHandoff(symlinkedParent);
    assert.match(parentRefusal.reason, /^cleanup archive failed: archive parent is not a real directory /u);
    assert.deepEqual(readdirSync(parentTarget), ["sentinel.txt"], "AC10 symlinked parent must receive no archive write");
    assert.equal(existsSync(symlinkedParent.sandbox), true);

    const danglingArchive = createFixture("dangling-archive");
    fixtures.push(danglingArchive);
    mkdirSync(dirname(danglingArchive.archive));
    const danglingTarget = join(danglingArchive.root, "missing-archive-target");
    symlinkSync(danglingTarget, danglingArchive.archive);
    assert.equal(existsSync(danglingArchive.archive), false);
    assert.ok(pathEntry(danglingArchive.archive)?.isSymbolicLink());
    const danglingCollision = completedHandoff(danglingArchive);
    assert.match(danglingCollision.reason, /^cleanup archive failed: archive exists at /u);
    assert.ok(pathEntry(danglingArchive.archive)?.isSymbolicLink(), "AC10 dangling archive link must not be overwritten");
    assert.equal(pathEntry(danglingTarget), null);

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
    assert.deepEqual(residual.events, [
      { command: "terminal", repository: removeFailure.sandbox },
      { command: "status", repository: removeFailure.operator },
      { command: "terminal", repository: removeFailure.operator },
      { command: "status", repository: removeFailure.operator },
    ], "AC12 removal failure update and final status must explicitly execute against O");
    assert.equal(existsSync(removeFailure.sandbox), true);

    const guarded = createFixture("guarded");
    fixtures.push(guarded);
    writeFileSync(join(guarded.operator, "operator-sentinel.txt"), "operator must survive\n");
    const escaped = completedHandoff(guarded, { removePath: guarded.operator });
    assert.match(escaped.reason, /^cleanup remove failed: /u);
    assert.equal(existsSync(guarded.sandbox), true, "AC10 destructive guard must retain a mismatched target");
    assert.equal(existsSync(guarded.operator), true, "AC10 destructive guard must never remove O");
    assert.equal(readFileSync(join(guarded.operator, "operator-sentinel.txt"), "utf8"), "operator must survive\n",
      "AC10 the protected O sentinel survives a rejected removal target");

    // Exercise every canonical removal guard against a fresh temp fixture.  These use the actual
    // handoff up to removal where possible, then verify a protected file remains; they are not path
    // arithmetic assertions that could pass while `rm -rf` is pointed at the wrong directory.
    const symlinkedContainer = createFixture("remove-symlink-container");
    fixtures.push(symlinkedContainer);
    const containerTarget = join(symlinkedContainer.root, "container-target");
    renameSync(symlinkedContainer.container, containerTarget);
    symlinkSync(containerTarget, symlinkedContainer.container, "dir");
    const containerSentinel = join(containerTarget, symlinkedContainer.runId, "container-sentinel.txt");
    writeFileSync(containerSentinel, "container survives\n");
    const rejectedContainer = completedHandoff(symlinkedContainer);
    assert.deepEqual(rejectedContainer.phases, ["terminal", "fetch", "archive", "verify"],
      "AC10 a symlinked C reaches no removal phase");
    assert.match(rejectedContainer.reason, /^cleanup remove failed: not a real directory: /u);
    assert.equal(readFileSync(containerSentinel, "utf8"), "container survives\n",
      "AC10 symlinked C sentinel survives the rejected removal");

    const symlinkedSandbox = createFixture("remove-symlink-sandbox");
    fixtures.push(symlinkedSandbox);
    const sandboxTarget = join(symlinkedSandbox.container, "sandbox-target");
    renameSync(symlinkedSandbox.sandbox, sandboxTarget);
    symlinkSync(sandboxTarget, symlinkedSandbox.sandbox, "dir");
    const sandboxSentinel = join(sandboxTarget, "sandbox-sentinel.txt");
    writeFileSync(sandboxSentinel, "sandbox survives\n");
    const rejectedSandbox = completedHandoff(symlinkedSandbox);
    assert.deepEqual(rejectedSandbox.phases, ["terminal", "fetch", "archive", "verify"],
      "AC10 a symlinked S reaches no removal phase");
    assert.match(rejectedSandbox.reason, /^cleanup remove failed: not a real directory: /u);
    assert.equal(readFileSync(sandboxSentinel, "utf8"), "sandbox survives\n",
      "AC10 symlinked S sentinel survives the rejected removal");

    const canonicalMismatch = createFixture("remove-canonical-mismatch");
    fixtures.push(canonicalMismatch);
    const canonicalSentinel = join(canonicalMismatch.sandbox, "canonical-sentinel.txt");
    writeFileSync(canonicalSentinel, "canonical survives\n");
    const alias = `${canonicalMismatch.sandbox}/../${canonicalMismatch.runId}`;
    const rejectedCanonical = completedHandoff(canonicalMismatch, { removePath: alias });
    assert.deepEqual(rejectedCanonical.phases, ["terminal", "fetch", "archive", "verify"]);
    assert.match(rejectedCanonical.reason, /^cleanup remove failed: canonical path mismatch/u,
      "AC10 lexical S aliases must fail the exact canonical S guard");
    assert.equal(readFileSync(canonicalSentinel, "utf8"), "canonical survives\n");

    const wrongParent = createFixture("remove-wrong-parent");
    fixtures.push(wrongParent);
    const wrongContainer = join(wrongParent.root, "wrong-container");
    mkdirSync(wrongContainer);
    const wrongParentSentinel = join(wrongParent.sandbox, "wrong-parent-sentinel.txt");
    writeFileSync(wrongParentSentinel, "wrong parent survives\n");
    assert.throws(() => removalGuard(wrongParent.operator, wrongContainer, wrongParent.sandbox), /canonical parent mismatch/u,
      "AC10 S whose physical parent is not C must be refused");
    assert.equal(readFileSync(wrongParentSentinel, "utf8"), "wrong parent survives\n");

    const rootRefusal = createFixture("remove-root-refusal");
    fixtures.push(rootRefusal);
    const rootSentinel = join(rootRefusal.sandbox, "root-guard-sentinel.txt");
    const operatorRootSentinel = join(rootRefusal.operator, "operator-root-guard-sentinel.txt");
    writeFileSync(rootSentinel, "root guard survives\n");
    writeFileSync(operatorRootSentinel, "operator root guard survives\n");
    // Supply the candidate's real parent as C so neither exact-path nor parent validation can
    // short-circuit the destructive-root guard.  removalGuard has no delete operation; the sentinel
    // checks prove these direct guard probes leave both safe fixture targets untouched.
    assert.throws(() => removalGuard(rootRefusal.operator, dirname(rootRefusal.operator), rootRefusal.operator),
      (error) => error.message === "refusing destructive root",
      "AC10 O must reach and be refused by the explicit destructive-root guard");
    assert.throws(() => removalGuard(rootRefusal.operator, "/", "/"),
      (error) => error.message === "refusing destructive root",
      "AC10 filesystem root must reach and be refused by the explicit destructive-root guard");
    assert.equal(readFileSync(rootSentinel, "utf8"), "root guard survives\n");
    assert.equal(readFileSync(operatorRootSentinel, "utf8"), "operator root guard survives\n");

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

  } finally {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
  }
});
