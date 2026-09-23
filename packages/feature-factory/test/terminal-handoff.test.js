import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initFresh, seedLegacyRun } from "./init-fixture.js";
import { RUN_JSON_LOCK_DIR, withRunJsonLock } from "../core/run-lock.js";
import { dispatchRestore } from "../bin/restore.js";

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
    branch, attempts: status === "blocked" ? run.max_retries : 1, extra_attempts: 0, paths: [`${id}.txt`], test_plan: [], base_ref: baseRef,
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

test("AC10-AC13/AC20 completed handoff fetches, archives, verifies, and only then removes the sandbox", async () => {
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
    "require exact equality, excluding only plane-root `factory.lock` and\n   `run-json.lock`.",
    "either name below the plane root is run state and must match.",
    "rename `.prior-$R` back onto the canonical path and report: nothing was\n   committed",
    "**Before the commit point, no publication has occurred.**",
    "restoring it from `.prior-$R` when it had already been moved",
    "**After the commit point, the published snapshot is authoritative and is never rolled back.**",
    "report a cleanup warning naming the\n   residual path and leave the published snapshot exactly as committed",
    "A later park removes that residual\n   at preflight, as step 1 requires",
    "`.staging-$R` and `.prior-$R` cannot be run ids",
    "It never touches `S`",
    "does not prevent or undo the park",
    "Do not publish snapshots for",
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

  // Instruction, not automatic publication: a refused resume may already have refreshed the contract.
  const recoveryRule = "A refreshed workflow or recorded bootstrap failure can make the previous snapshot stale.";
  const checkRecoveryRule = (source) => assert.ok(source.includes(recoveryRule), "refused resume must route to snapshot recovery");
  checkRecoveryRule(parkPolicy);
  assert.throws(() => checkRecoveryRule(parkPolicy.replace(recoveryRule, "")), /snapshot recovery/u);
  const restoreRules = [
    "A snapshot is a restore input, not a live run",
    '`factory restore "$R" --repo "$O" --fr' + 'om "$RESTORE_REF" --json`',
    "remains parked and lockless, aligns and rechecks the operator's effective push target",
    "proves every preserved merged-slice Git and evidence binding",
    "omits prior-generation\ncanonical verifier records",
    "reports `reset_slices` and `invalidated`",
    "`park_snapshot` becomes `null`",
    "Never substitute a local branch, a bare commit, a",
    "inspect `status.restore`, and start the same ownership sequence below.",
  ];
  const checkRestoreRules = (source) => {
    for (const fragment of restoreRules) if (!source.includes(fragment)) throw new Error(`restore-contract: ${fragment}`);
  };
  checkRestoreRules(parkPolicy);
  for (const fragment of restoreRules) assert.throws(() => checkRestoreRules(parkPolicy.replace(fragment, "")),
    /restore-contract/u, `restore contract fragment must be load-bearing: ${fragment}`);

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
  // Length is not content and length is not mode. Comparing sizes accepted both of the next two shapes,
  // and both are reachable: a one-character edit inside a fixed-width timestamp keeps the length, and a
  // copy made by a driver with a different umask keeps the bytes. The publication contract requires the
  // whole entry -- path, type, mode, digest -- so the observation compares the whole entry.
  const sameSizeDrift = Buffer.from(workflowBytes);
  sameSizeDrift[sameSizeDrift.length - 1] ^= 0x20;
  writeFileSync(workflowCopy, sameSizeDrift);
  assert.equal(snapshotOf(), null, "an artifact of the plane's length holding different bytes is not a faithful copy");
  writeFileSync(workflowCopy, workflowBytes);
  const liveMode = lstatSync(join(livePlane, "WORKFLOW.md")).mode & 0o7777;
  chmodSync(workflowCopy, liveMode ^ 0o004);
  assert.equal(snapshotOf(), null, "an artifact whose mode drifted from the plane is not a faithful copy");
  chmodSync(workflowCopy, liveMode);
  assert.equal(snapshotOf(), published, "restoring the artifact restores the observation");
  // Refusal AFTER refreshing the staged contract: another state command holds the manifest lock.
  // Progress is preserved, but the old snapshot is honestly stale until the driver republishes it.
  writeFileSync(join(livePlane, "WORKFLOW.md"), "# Previous packaged workflow\n");
  cpSync(livePlane, published, { recursive: true });
  assert.equal(snapshotOf(), published);
  factory(obsSandbox, "lock", "obs-run", "claim", "--session", "snapshot-owner");
  const parkedBytes = readFileSync(join(livePlane, "run.json"));
  const resumeAt = new Date(Date.parse(JSON.parse(parkedBytes).updated_at) + 1).toISOString();
  // The parent owns the contended lock; file-backed stderr keeps pipe lifetime out of the lock proof.
  const refusalPath = join(obsRoot, "resume-refusal.txt");
  await withRunJsonLock(livePlane, async () => {
    const refusalFd = openSync(refusalPath, "w");
    let refused;
    try {
      refused = spawnSync(process.execPath, [cli, "resume", "obs-run", "--session", "snapshot-owner",
        "--now", resumeAt, "--repo", obsSandbox, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", refusalFd] });
    } finally { closeSync(refusalFd); }
    assert.notEqual(refused.status, 0);
  });
  assert.match(readFileSync(refusalPath, "utf8"), /timed out waiting for run.json lock/u);
  assert.deepEqual(readFileSync(join(livePlane, "run.json")), parkedBytes);
  assert.equal(readFileSync(join(livePlane, "WORKFLOW.md"), "utf8"), "# Previous packaged workflow\n",
    "the command-wide run lock refuses resume before its contract-refresh side effect");
  assert.ok(existsSync(published), "the current snapshot is retained, not deleted");
  assert.equal(snapshotOf(), published, "a pre-effect refusal leaves the existing snapshot current");
  writeFileSync(join(livePlane, "WORKFLOW.md"), workflowBytes);
  const staging = join(obsOperator, ".factory", ".parked", ".staging-obs-run");
  const prior = join(obsOperator, ".factory", ".parked", ".prior-obs-run");
  cpSync(livePlane, staging, { recursive: true });
  const withoutHeartbeat = (entries) => entries.filter((entry) => entry.path !== "factory.lock");
  assert.deepEqual(withoutHeartbeat(treeInventory(staging)), withoutHeartbeat(treeInventory(livePlane)));
  renameSync(published, prior);
  renameSync(staging, published);
  rmSync(prior, { recursive: true });
  assert.equal(snapshotOf(), published, "republishing restores current recovery evidence");
  factory(obsSandbox, "lock", "obs-run", "release", "--session", "snapshot-owner");
  assert.equal(snapshotOf(), published);

  // The root directory is an entry too. An inventory of descendants only walks INTO the root without ever
  // recording it, so a snapshot whose own directory mode differs from the plane's compared equal -- and the
  // publication contract inventories `.` and every descendant, so that copy fails the verification the
  // snapshot is supposed to have passed. Caught in review.
  const liveRootMode = lstatSync(livePlane).mode & 0o7777;
  chmodSync(published, liveRootMode ^ 0o004);
  assert.equal(snapshotOf(), null, "a snapshot whose own directory mode drifted from the plane is not a faithful copy");
  chmodSync(published, liveRootMode);
  assert.equal(snapshotOf(), published, "restoring the root mode restores the observation");
  // THE HEARTBEAT. Every case above publishes and reads back with nothing touching the plane in between,
  // which is why three review rounds and a real park all missed this: the plane carries `factory.lock`,
  // whose whole job is to change on a timer. Comparing it made a snapshot invalid within one heartbeat --
  // a live park published a byte-correct plane and `status` said `park_snapshot: null` eleven seconds
  // later, copy at `heartbeat_at` 23:28:25 against a plane at 23:28:36. The field exists to answer "did
  // the driver publish it" and it answered "no" about a snapshot that was sitting right there.
  const liveLock = join(livePlane, "factory.lock");
  const lockRecord = (heartbeat) => `${JSON.stringify({ session: "ses_probe", run_id: "obs-run", branch: null, claimed_at: "2026-09-11T22:01:54.328Z", heartbeat_at: heartbeat }, null, 2)}\n`;
  writeFileSync(liveLock, lockRecord("2026-09-11T23:28:25.920Z"));
  writeFileSync(join(published, "factory.lock"), lockRecord("2026-09-11T23:28:25.920Z"));
  assert.equal(snapshotOf(), published, "a plane carrying a lock still reports its published snapshot");
  writeFileSync(liveLock, lockRecord("2026-09-11T23:28:36.538Z"));
  assert.equal(snapshotOf(), published,
    "a heartbeat after the copy must not invalidate the snapshot; the lock is liveness, not run state");
  // Scoped to the plane ROOT lock by exact path, not by name. A substring or basename test would excuse a
  // `factory.lock` anywhere in the tree, so a nested one is planted and must still be compared.
  mkdirSync(join(livePlane, "nested"), { recursive: true });
  mkdirSync(join(published, "nested"), { recursive: true });
  writeFileSync(join(livePlane, "nested", "factory.lock"), "durable\n");
  writeFileSync(join(published, "nested", "factory.lock"), "durable\n");
  assert.equal(snapshotOf(), published, "an identical nested lock-named file leaves the snapshot valid");
  writeFileSync(join(published, "nested", "factory.lock"), "drifted\n");
  assert.equal(snapshotOf(), null, "a lock-named file below the plane root is run state and must still match");
  writeFileSync(join(published, "nested", "factory.lock"), "durable\n");
  // Scoped to the lock, and to the lock at the plane root: everything else still has to match.
  writeFileSync(workflowCopy, Buffer.concat([workflowBytes, Buffer.from("x")]));
  assert.equal(snapshotOf(), null, "excluding the lock must not excuse any other drift");
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


  // Issue #343: a canonical park snapshot is a recovery input, not merely readable evidence. Restore
  // creates a new sandbox generation from an exact remote-tracking feature ref. It never imports the
  // old owner, never resumes, and reports work whose branch-local state could not survive the loss.
  const restoreRoot = realpathSync(mkdtempSync(join(tmpdir(), "factory-restore-")));
  const restoreOperator = join(restoreRoot, "operator");
  mkdirSync(restoreOperator);
  git(restoreOperator, "init", "--quiet", "--initial-branch=main");
  git(restoreOperator, "config", "user.name", "Factory Test");
  git(restoreOperator, "config", "user.email", "factory@example.test");
  writeFileSync(join(restoreOperator, ".gitignore"), ".factory/\n/.factory-sandboxes/\n");
  writeFileSync(join(restoreOperator, "base.txt"), "base\n");
  mkdirSync(join(restoreOperator, "workspace"));
  writeFileSync(join(restoreOperator, "workspace", "base.txt"), "nested integration worktree\n");
  git(restoreOperator, "add", ".gitignore", "base.txt", "workspace/base.txt");
  git(restoreOperator, "commit", "--quiet", "-m", "base");
  const restoreRemote = join(restoreRoot, "remote.git");
  mkdirSync(restoreRemote);
  git(restoreRemote, "init", "--bare", "--quiet");
  git(restoreOperator, "remote", "add", "origin", restoreRemote);
  const restoreRun = "restore-parked";
  const restoreFixture = initFresh(restoreOperator, [restoreRun, "--pr-base", "main", "--worktree", "workspace",
    "--mode", "autonomous", "--now", "2026-09-21T16:00:00Z"]);
  const lostSandbox = restoreFixture.repository;
  writeFileSync(join(lostSandbox, "survived.txt"), "pushed work\n");
  git(lostSandbox, "add", "survived.txt");
  git(lostSandbox, "commit", "--quiet", "-m", "pushed work");
  const restoredHead = git(lostSandbox, "rev-parse", "HEAD");
  const remoteFeatureRef = `refs/remotes/origin/feature/${restoreRun}`;
  git(lostSandbox, "push", "--quiet", restoreRemote, `HEAD:refs/heads/feature/${restoreRun}`);
  git(restoreOperator, "fetch", "--quiet", "origin", `refs/heads/feature/${restoreRun}:${remoteFeatureRef}`);
  const lostRunPath = join(restoreFixture.runDir, "run.json");
  const lostRun = JSON.parse(readFileSync(lostRunPath, "utf8"));
  lostRun.slices = [
    { id: "merged-code", stack: "backend", depends_on: [], status: "pending", worktree: null, branch: null,
      attempts: 1, extra_attempts: 0, paths: ["survived.txt"], test_plan: [], base_ref: null, evidence_ref: null, review_ref: null, merge_commit: null },
    { id: "lost-review", stack: "backend", depends_on: [], status: "review", worktree: join(lostSandbox, ".factory", "worktrees", restoreRun, "lost-review"),
      branch: `factory/${restoreRun}/lost-review`, attempts: 2, extra_attempts: 0, paths: ["lost.txt"], test_plan: [], base_ref: restoredHead,
      evidence_ref: null, review_ref: null, merge_commit: null },
  ];
  const staleHead = git(restoreOperator, "rev-parse", "main");
  lostRun.gates.pre_pr = { status: "approved", at: "2026-09-21T16:00:30.000Z", artifact: null, reviewed_head: staleHead };
  lostRun.validator = { verdict: "GO", report: "artifacts/validation-report.md", reviewed_head: staleHead, loops: 1 };
  lostRun.steps = [{ agent: "test-verifier", status: "accepted", attempts: 1,
    review_ref: "reviews/test-verifier.json", evidence_ref: "evidence/test-verifier.json" }];
  const lostPlan = Buffer.from(`${JSON.stringify({ slices: lostRun.slices.map(({ id, stack, depends_on, paths, test_plan }) => ({ id, stack, depends_on, paths, test_plan })) }, null, 2)}\n`);
  writeFileSync(join(restoreFixture.runDir, "plan", "slices.json"), lostPlan);
  lostRun.plan_digest = `sha256:${createHash("sha256").update(lostPlan).digest("hex")}`;
  writeFileSync(join(restoreFixture.runDir, "reviews", "test-verifier.json"), `${JSON.stringify({ reviewed_commit: staleHead })}\n`);
  writeFileSync(join(restoreFixture.runDir, "evidence", "test-verifier.json"), `${JSON.stringify({ commit: staleHead })}\n`);
  writeFileSync(lostRunPath, `${JSON.stringify(lostRun, null, 2)}\n`);
  factory(lostSandbox, "terminal", restoreRun, "needs-human", "--reason", "host recovery required", "--now", "2026-09-21T16:01:00Z");
  writeFileSync(join(restoreFixture.runDir, "factory.lock"), "stale owner must not return\n");
  mkdirSync(join(restoreFixture.runDir, "nested"));
  writeFileSync(join(restoreFixture.runDir, "nested", "factory.lock"), "durable nested state\n");
  symlinkSync("nested/factory.lock", join(restoreFixture.runDir, "lock-link"));
  const restoreSnapshot = join(restoreOperator, ".factory", ".parked", restoreRun);
  mkdirSync(dirname(restoreSnapshot), { recursive: true });
  cpSync(restoreFixture.runDir, restoreSnapshot, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  assert.equal(factory(lostSandbox, "status", restoreRun).park_snapshot, restoreSnapshot);
  const sourceBeforeRestore = treeInventory(restoreSnapshot);
  const sourceWorkflowBytes = readFileSync(join(restoreSnapshot, "WORKFLOW.md"));
  const sourceRunBytes = readFileSync(join(restoreSnapshot, "run.json"));
  rmSync(lostSandbox, { recursive: true });
  const bareCommit = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", restoredHead, "--now", "2026-09-21T16:02:00Z", "--json"], { encoding: "utf8" });
  assert.equal(bareCommit.status, 1);
  assert.match(bareCommit.stderr, /--from must name exact branch/u);
  assert.equal(existsSync(lostSandbox), false);
  git(restoreOperator, "update-ref", "-d", remoteFeatureRef);
  const missingRef = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z", "--json"], { encoding: "utf8" });
  assert.equal(missingRef.status, 1);
  assert.match(missingRef.stderr, /restore feature ref .* is absent or unobservable/u);
  assert.equal(existsSync(lostSandbox), false, "a ref refusal happens before reserving the destination");
  git(restoreOperator, "fetch", "--quiet", "origin", `refs/heads/feature/${restoreRun}:${remoteFeatureRef}`);
  git(restoreRemote, "update-ref", `refs/heads/feature/${restoreRun}`, staleHead);
  const staleRemote = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z", "--json"], { encoding: "utf8" });
  assert.equal(staleRemote.status, 1);
  assert.match(staleRemote.stderr, /does not match branch .* as advertised by remote/u);
  assert.equal(existsSync(lostSandbox), false, "a stale remote-tracking ref refuses before destination reservation");
  git(restoreRemote, "update-ref", `refs/heads/feature/${restoreRun}`, restoredHead);
  const escapingLink = join(restoreSnapshot, "artifacts", "escaping-link"), bounce = join(restoreRoot, "snapshot-bounce");
  symlinkSync(restoreSnapshot, bounce);
  symlinkSync(relative(dirname(escapingLink), join(bounce, "nested", "factory.lock")), escapingLink);
  const escapingRestore = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z", "--json"], { encoding: "utf8" });
  assert.equal(escapingRestore.status, 1);
  assert.match(escapingRestore.stderr, /park snapshot symlink .* escapes the control plane/u);
  assert.equal(existsSync(join(lostSandbox, ".factory", restoreRun, "run.json")), false);
  rmSync(lostSandbox, { recursive: true });
  unlinkSync(escapingLink);
  unlinkSync(bounce);
  await assert.rejects(() => dispatchRestore([restoreRun], {
    repo: restoreOperator, from: remoteFeatureRef, now: "2026-09-21T16:02:00Z",
  }, { beforeManifest: ({ runDir }) => writeFileSync(join(runDir, "artifacts", "raced.txt"), "intervening write\n") }),
  (error) => error?.cause?.message === "restored control plane changed before manifest publication; run.json was not published");
  assert.equal(existsSync(join(lostSandbox, ".factory", restoreRun, "run.json")), false,
    "an intervening writer is caught at the manifest commit boundary");
  rmSync(lostSandbox, { recursive: true });
  const competingRun = join(restoreOperator, ".factory", restoreRun);
  await assert.rejects(() => dispatchRestore([restoreRun], {
    repo: restoreOperator, from: remoteFeatureRef, now: "2026-09-21T16:02:00Z",
  }, { beforeManifest: () => { mkdirSync(competingRun); writeFileSync(join(competingRun, "run.json"), "{}\n"); } }),
  (error) => error?.cause?.message.includes("live run manifest appeared"));
  assert.equal(existsSync(join(lostSandbox, ".factory", restoreRun, "run.json")), false,
    "a competing live manifest prevents publication of a second generation");
  rmSync(lostSandbox, { recursive: true });
  rmSync(competingRun, { recursive: true });
  const restoreFence = join(dirname(restoreSnapshot), `.grant-retry-${restoreRun}.json`);
  await assert.rejects(() => dispatchRestore([restoreRun], {
    repo: restoreOperator, from: remoteFeatureRef, now: "2026-09-21T16:02:00Z",
  }, { beforeManifest: () => writeFileSync(restoreFence, "{}\n") }),
  (error) => error?.cause?.message === "restore refuses an interrupted retry-grant transaction");
  assert.equal(existsSync(join(lostSandbox, ".factory", restoreRun, "run.json")), false,
    "a fence published after restore qualification still prevents manifest authority");
  rmSync(lostSandbox, { recursive: true }); unlinkSync(restoreFence);
  await assert.rejects(() => dispatchRestore([restoreRun], {
    repo: restoreOperator, from: remoteFeatureRef, now: "2026-09-21T16:02:00Z",
  }, { beforeManifest: () => writeFileSync(join(restoreSnapshot, "WORKFLOW.md"), Buffer.concat([sourceWorkflowBytes, Buffer.from("changed\n")])) }),
  (error) => error?.cause?.message === "park snapshot changed while restore was running; run.json was not published");
  assert.equal(existsSync(join(lostSandbox, ".factory", restoreRun, "run.json")), false);
  rmSync(lostSandbox, { recursive: true });
  writeFileSync(join(restoreSnapshot, "WORKFLOW.md"), sourceWorkflowBytes);
  await assert.rejects(() => dispatchRestore([restoreRun], {
    repo: restoreOperator, from: remoteFeatureRef, now: "2026-09-21T16:02:00Z",
  }, { beforeManifest: () => git(restoreRemote, "update-ref", `refs/heads/feature/${restoreRun}`, staleHead) }),
  (error) => error?.cause?.message.includes("does not match branch"));
  git(restoreRemote, "update-ref", `refs/heads/feature/${restoreRun}`, restoredHead);
  rmSync(lostSandbox, { recursive: true });
  await assert.rejects(() => dispatchRestore([restoreRun], {
    repo: restoreOperator, from: remoteFeatureRef, now: "2026-09-21T16:02:00Z",
  }, { beforeManifest: ({ sandbox }) => git(sandbox, "remote", "set-url", "--push", "origin", sandbox) }),
  (error) => error?.cause?.message.includes("does not match operator target"));
  rmSync(lostSandbox, { recursive: true });
  await assert.rejects(() => dispatchRestore([restoreRun], {
    repo: restoreOperator, from: remoteFeatureRef, now: "2026-09-21T16:02:00Z",
  }, { beforeManifest: ({ sandbox }) => writeFileSync(join(sandbox, "base.txt"), "dirty\n") }),
  (error) => error?.cause?.message === "restored feature worktree changed while restore was running");
  rmSync(lostSandbox, { recursive: true });
  const blockedAtMax = JSON.parse(sourceRunBytes), exhaustedAttempt = blockedAtMax.max_retries;
  const retryReviewRef = `reviews/lost-review.attempt-${exhaustedAttempt}.json`;
  const retryEvidenceRef = `evidence/lost-review.attempt-${exhaustedAttempt}.json`;
  const retryReviewBytes = Buffer.from(`${JSON.stringify({ subject: "lost-review", reviewer: "work-reviewer",
    verdict: "REJECT", attempt: exhaustedAttempt, reviewed_commit: restoredHead, findings: ["still failing"],
    required_fixes: ["repair the bounded defect"], checked_against: ["brief"] }, null, 2)}
`);
  const retryEvidenceBytes = Buffer.from(`${JSON.stringify({ subject: "lost-review", run_id: restoreRun,
    attempt: exhaustedAttempt, base_ref: restoredHead, commit: restoredHead, status: "completed",
    worktree_clean: true, files_changed: ["lost.txt"], diff_observed: true,
    tests: { observed: false, exit: null, skipped_reason: "approved empty test plan" },
    observed_by: "orchestrator", review_ready: true }, null, 2)}
`);
  writeFileSync(join(restoreSnapshot, retryReviewRef), retryReviewBytes);
  writeFileSync(join(restoreSnapshot, retryEvidenceRef), retryEvidenceBytes);
  blockedAtMax.retry_extensions = [{ scope: "slice", slice_id: "lost-review", base_ref: restoredHead, attempt: exhaustedAttempt + 1,
    previous_limit: exhaustedAttempt, new_limit: exhaustedAttempt + 1,
    previous_max_retries: exhaustedAttempt, max_retries: exhaustedAttempt,
    session: "prior-operator", reason: "one prior bounded repair", at: "2026-09-21T16:01:30.000Z",
    snapshot_digest: `sha256:${"0".repeat(64)}`, review_ref: retryReviewRef,
    review_sha256: `sha256:${createHash("sha256").update(retryReviewBytes).digest("hex")}`,
    evidence_ref: retryEvidenceRef,
    evidence_sha256: `sha256:${createHash("sha256").update(retryEvidenceBytes).digest("hex")}` }];
  blockedAtMax.slices[1] = { ...blockedAtMax.slices[1], status: "blocked", attempts: exhaustedAttempt + 1, extra_attempts: 1 };
  writeFileSync(join(restoreSnapshot, "run.json"), `${JSON.stringify(blockedAtMax, null, 2)}
`);
  const restoreAttempt = () => spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z", "--json"], { encoding: "utf8" });
  rmSync(join(restoreSnapshot, retryEvidenceRef));
  let invalidRetryRestore = restoreAttempt();
  assert.equal(invalidRetryRestore.status, 1);
  assert.match(invalidRetryRestore.stderr, /must be a contained regular file/u);
  assert.equal(existsSync(lostSandbox), false, "missing retry archive refuses before destination reservation");
  writeFileSync(join(restoreSnapshot, retryEvidenceRef), retryEvidenceBytes);
  rmSync(join(restoreSnapshot, retryReviewRef));
  symlinkSync("test-verifier.json", join(restoreSnapshot, retryReviewRef));
  invalidRetryRestore = restoreAttempt();
  assert.equal(invalidRetryRestore.status, 1);
  assert.match(invalidRetryRestore.stderr, /must be a contained regular file/u);
  rmSync(join(restoreSnapshot, retryReviewRef));
  writeFileSync(join(restoreSnapshot, retryReviewRef), retryReviewBytes);
  for (const [name, change] of [
    ["wrong review subject", { review: { subject: "other-slice" } }],
    ["wrong evidence attempt", { evidence: { attempt: exhaustedAttempt - 1 } }],
    ["approving review", { review: { verdict: "APPROVE" } }],
    ["commit mismatch", { evidence: { commit: staleHead } }],
    ["base mismatch", { evidence: { base_ref: staleHead } }],
  ]) {
    const reviewBytes = Buffer.from(`${JSON.stringify({ ...JSON.parse(retryReviewBytes.toString("utf8")), ...(change.review ?? {}) }, null, 2)}\n`);
    const evidenceBytes = Buffer.from(`${JSON.stringify({ ...JSON.parse(retryEvidenceBytes.toString("utf8")), ...(change.evidence ?? {}) }, null, 2)}\n`);
    const candidate = structuredClone(blockedAtMax), audit = candidate.retry_extensions[0];
    audit.review_sha256 = `sha256:${createHash("sha256").update(reviewBytes).digest("hex")}`;
    audit.evidence_sha256 = `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`;
    writeFileSync(join(restoreSnapshot, retryReviewRef), reviewBytes);
    writeFileSync(join(restoreSnapshot, retryEvidenceRef), evidenceBytes);
    writeFileSync(join(restoreSnapshot, "run.json"), `${JSON.stringify(candidate, null, 2)}\n`);
    invalidRetryRestore = restoreAttempt();
    assert.equal(invalidRetryRestore.status, 1, name);
    assert.match(invalidRetryRestore.stderr, /does not bind its rejected attempt archives/u, name);
    assert.equal(existsSync(lostSandbox), false, `${name} refuses before destination reservation`);
  }
  const baseReboundEvidence = Buffer.from(`${JSON.stringify({ ...JSON.parse(retryEvidenceBytes.toString("utf8")), base_ref: staleHead }, null, 2)}
`);
  const baseRebound = structuredClone(blockedAtMax);
  baseRebound.retry_extensions[0].base_ref = staleHead;
  baseRebound.retry_extensions[0].evidence_sha256 = `sha256:${createHash("sha256").update(baseReboundEvidence).digest("hex")}`;
  writeFileSync(join(restoreSnapshot, retryEvidenceRef), baseReboundEvidence);
  writeFileSync(join(restoreSnapshot, "run.json"), `${JSON.stringify(baseRebound, null, 2)}
`);
  invalidRetryRestore = restoreAttempt();
  assert.equal(invalidRetryRestore.status, 1);
  assert.match(invalidRetryRestore.stderr, /base_ref: does not match retry extension history/u,
    "an audit and archive cannot jointly rewrite the slice's immutable base");
  writeFileSync(join(restoreSnapshot, retryReviewRef), retryReviewBytes);
  writeFileSync(join(restoreSnapshot, retryEvidenceRef), retryEvidenceBytes);
  writeFileSync(join(restoreSnapshot, "run.json"), `${JSON.stringify(blockedAtMax, null, 2)}\n`);
  const blockedRestored = factory(restoreOperator, "restore", restoreRun, "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z");
  const blockedRestoredState = JSON.parse(readFileSync(join(blockedRestored.run_dir, "run.json"), "utf8"));
  const preservedBlocked = blockedRestoredState.slices[1];
  assert.deepEqual({ status: preservedBlocked.status, attempts: preservedBlocked.attempts, extra_attempts: preservedBlocked.extra_attempts },
    { status: "blocked", attempts: blockedAtMax.max_retries + 1, extra_attempts: 1 });
  assert.deepEqual(blockedRestoredState.retry_extensions, blockedAtMax.retry_extensions, "restore preserves retry authorization history");
  assert.deepEqual({ worktree: preservedBlocked.worktree, branch: preservedBlocked.branch,
    evidence_ref: preservedBlocked.evidence_ref, review_ref: preservedBlocked.review_ref },
  { worktree: null, branch: null, evidence_ref: null, review_ref: null });
  assert.equal(blockedRestored.reset_slices.includes("lost-review"), false, "restore never reopens a terminal blocked slice");
  factory(blockedRestored.sandbox_path, "lock", restoreRun, "claim", "--session", "restore-operator", "--branch", `feature/${restoreRun}`);
  const blockedRestoreBytes = readFileSync(join(blockedRestored.run_dir, "run.json"));
  const unqualifiedGrant = spawnSync(process.execPath, [cli, "grant-retry", restoreRun, "lost-review",
    "--scope", "slice", "--reason", "restored state lacks retry proof", "--session", "restore-operator",
    "--repo", blockedRestored.sandbox_path, "--now", "2026-09-21T16:03:00Z", "--json"], { encoding: "utf8" });
  assert.equal(unqualifiedGrant.status, 1);
  assert.match(unqualifiedGrant.stderr, /requires slice 'lost-review' recorded review and evidence/u);
  assert.deepEqual(readFileSync(join(blockedRestored.run_dir, "run.json")), blockedRestoreBytes,
    "an unqualified restored blocked slice refuses without mutation");
  rmSync(lostSandbox, { recursive: true });
  rmSync(join(restoreSnapshot, retryReviewRef));
  rmSync(join(restoreSnapshot, retryEvidenceRef));
  writeFileSync(join(restoreSnapshot, "run.json"), sourceRunBytes);

  const overBound = JSON.parse(sourceRunBytes);
  overBound.slices[1] = { ...overBound.slices[1], status: "blocked", attempts: overBound.max_retries + 1 };
  writeFileSync(join(restoreSnapshot, "run.json"), `${JSON.stringify(overBound, null, 2)}
`);
  const overBoundRestore = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z", "--json"], { encoding: "utf8" });
  assert.equal(overBoundRestore.status, 1);
  assert.match(overBoundRestore.stderr, /run\.slices\[1\]\.attempts: cannot exceed effective retry limit/u);
  assert.equal(existsSync(lostSandbox), false, "an over-bound legacy snapshot refuses before destination reservation");
  writeFileSync(join(restoreSnapshot, "run.json"), sourceRunBytes);

  const noVerifierRow = JSON.parse(sourceRunBytes);
  noVerifierRow.steps = [];
  writeFileSync(join(restoreSnapshot, "run.json"), `${JSON.stringify(noVerifierRow, null, 2)}\n`);
  const evidenceOnly = factory(restoreOperator, "restore", restoreRun, "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z");
  assert.ok(evidenceOnly.invalidated.includes("step:test-verifier"), "orphan canonical verifier evidence is invalidated");
  assert.equal(existsSync(join(evidenceOnly.run_dir, "evidence", "test-verifier.json")), false);
  rmSync(lostSandbox, { recursive: true });
  writeFileSync(join(restoreSnapshot, "run.json"), sourceRunBytes);
  const restored = factory(restoreOperator, "restore", restoreRun, "--from", remoteFeatureRef, "--now", "2026-09-21T16:02:00Z");
  assert.equal(restored.feature_commit, restoredHead);
  assert.equal(git(restored.sandbox_path, "remote", "get-url", "--push", "origin"),
    git(restoreOperator, "remote", "get-url", "--push", "origin"), "restore qualifies the effective push target before publication");
  assert.deepEqual(restored.reset_slices, ["lost-review"]);
  assert.deepEqual(restored.invalidated, ["gate:pre_pr", "validator", "step:test-verifier"]);
  assert.equal(existsSync(join(restored.run_dir, "evidence", "test-verifier.json")), false, "prior-generation verifier evidence is excluded");
  assert.equal(existsSync(join(restored.run_dir, "reviews", "test-verifier.json")), false, "its verifier review is excluded with it");
  assert.equal(existsSync(join(restored.run_dir, "factory.lock")), false, "the dead owner is not restored");
  assert.equal(readFileSync(join(restored.run_dir, "nested", "factory.lock"), "utf8"), "durable nested state\n");
  assert.equal(readlinkSync(join(restored.run_dir, "lock-link")), "nested/factory.lock", "a contained symlink stays a symlink");
  assert.deepEqual(treeInventory(restoreSnapshot), sourceBeforeRestore, "restore never mutates its source snapshot");
  const restoredRun = JSON.parse(readFileSync(join(restored.run_dir, "run.json"), "utf8"));
  assert.equal(restoredRun.status, "needs-human");
  assert.equal(restoredRun.worktree, "workspace", "a supported nested integration worktree remains bound");
  assert.equal(restoredRun.terminal_result.reason, "host recovery required");
  assert.deepEqual(restoredRun.slices[1], { ...lostRun.slices[1], status: "pending", worktree: null, branch: null,
    base_ref: null, evidence_ref: null, review_ref: null, merge_commit: null });
  const restoredStatus = factory(restored.sandbox_path, "status", restoreRun);
  assert.equal(restoredStatus.park_snapshot, null, "the transformed generation does not claim byte identity with its source");
  const sourceInventoryText = sourceBeforeRestore.map((entry) => {
    const type = { directory: "d", regular: "f", symlink: "l" }[entry.type];
    const payload = entry.type === "regular" ? ` ${entry.sha256}` : entry.type === "symlink" ? ` ${entry.target}` : "";
    return `${entry.path} ${type} ${entry.mode.toString(8)}${payload}`;
  }).sort();
  assert.deepEqual(restoredStatus.restore, {
    version: 1, run_id: restoreRun, restored_at: "2026-09-21T16:02:00.000Z",
    source_snapshot: restoreSnapshot,
    source_inventory: `sha256:${createHash("sha256").update(JSON.stringify(sourceInventoryText)).digest("hex")}`,
    feature_ref: remoteFeatureRef, feature_commit: restoredHead, reset_slices: ["lost-review"],
    invalidated: ["gate:pre_pr", "validator", "step:test-verifier"], previous_restore: null,
  });
  assert.deepEqual(JSON.parse(readFileSync(restored.restore_record, "utf8")), restoredStatus.restore,
    "status reports the exact durable restore record");
  const reorderedRecord = Object.fromEntries(Object.entries(restoredStatus.restore).reverse());
  writeFileSync(restored.restore_record, `${JSON.stringify(reorderedRecord, null, 2)}\n`);
  assert.equal(factory(restored.sandbox_path, "status", restoreRun).restore.feature_commit, restoredHead,
    "restore record validation treats JSON key order as non-semantic");
  writeFileSync(restored.restore_record, `${JSON.stringify({ ...reorderedRecord, invalidated: ["unknown"] }, null, 2)}\n`);
  const malformedRestore = spawnSync(process.execPath, [cli, "status", restoreRun, "--repo", restored.sandbox_path, "--json"], { encoding: "utf8" });
  assert.equal(malformedRestore.status, 1);
  assert.match(malformedRestore.stderr, /restore record .* is malformed/u);
  writeFileSync(restored.restore_record, `${JSON.stringify({ ...reorderedRecord, previous_restore: {} }, null, 2)}\n`);
  const malformedChain = spawnSync(process.execPath, [cli, "status", restoreRun, "--repo", restored.sandbox_path, "--json"], { encoding: "utf8" });
  assert.equal(malformedChain.status, 1);
  assert.match(malformedChain.stderr, /restore record .* is malformed/u);
  writeFileSync(restored.restore_record, `${JSON.stringify(reorderedRecord, null, 2)}\n`);
  assert.equal(restoredStatus.gates.pre_pr.status, "pending");
  assert.equal(restoredStatus.validator, null);
  assert.deepEqual(restoredStatus.steps.find((step) => step.agent === "test-verifier"),
    { agent: "test-verifier", status: "running", attempts: 1 });
  assert.equal(restoredStatus.lock, "absent");
  factory(restored.sandbox_path, "lock", restoreRun, "claim", "--session", "restore-owner");
  factory(restored.sandbox_path, "resume", restoreRun, "--session", "restore-owner", "--now", "2026-09-21T16:03:00Z");
  assert.equal(factory(restored.sandbox_path, "status", restoreRun).status, "running");
  const destinationBeforeCollision = treeInventory(restored.sandbox_path);
  const collision = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:04:00Z", "--json"], { encoding: "utf8" });
  assert.equal(collision.status, 1);
  assert.match(collision.stderr, /restore sandbox destination .* already exists/u);
  assert.deepEqual(treeInventory(restored.sandbox_path), destinationBeforeCollision,
    "a collision refusal does not change the existing generation");
  rmSync(restored.sandbox_path, { recursive: true });
  const reboundRun = JSON.parse(readFileSync(join(restoreSnapshot, "run.json"), "utf8"));
  reboundRun.steps = [{ agent: "spec-writer", status: "accepted", attempts: 1,
    review_ref: "reviews/spec-writer.json", evidence_ref: null }];
  reboundRun.validator = { verdict: "GO", report: "artifacts/validation.md", reviewed_head: restoredHead, loops: 0 };
  const planningReview = { subject: "spec-writer", reviewer: "work-reviewer", verdict: "APPROVE", attempt: 1,
    reviewed_commit: "0".repeat(40), findings: [], required_fixes: [], checked_against: ["story"] };
  const validatorReview = { ...planningReview, subject: "implementation-validator", verdict: "GO", reviewed_commit: restoredHead };
  writeFileSync(join(restoreSnapshot, "run.json"), `${JSON.stringify(reboundRun, null, 2)}\n`);
  writeFileSync(join(restoreSnapshot, "reviews", "spec-writer.json"), `${JSON.stringify(planningReview, null, 2)}\n`);
  writeFileSync(join(restoreSnapshot, "reviews", "implementation-validator.json"), `${JSON.stringify(validatorReview, null, 2)}\n`);
  const rebound = factory(restoreOperator, "restore", restoreRun, "--from", remoteFeatureRef, "--now", "2026-09-21T16:05:00Z");
  const reboundStatus = factory(rebound.sandbox_path, "status", restoreRun);
  assert.equal(reboundStatus.steps[0].status, "accepted", "planning review survives without a code-SHA ancestry rule");
  assert.equal(reboundStatus.validator.reviewed_head, restoredHead, "validator survives only with its exact review binding");
  rmSync(rebound.sandbox_path, { recursive: true });
  planningReview.subject = "other-subject";
  writeFileSync(join(restoreSnapshot, "reviews", "spec-writer.json"), `${JSON.stringify(planningReview, null, 2)}\n`);
  const unapprovedStep = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:06:00Z", "--json"], { encoding: "utf8" });
  assert.equal(unapprovedStep.status, 1);
  assert.match(unapprovedStep.stderr, /step 'spec-writer' review does not approve its restored attempt/u);
  assert.equal(existsSync(join(restored.sandbox_path, ".factory", restoreRun, "run.json")), false);
  rmSync(restored.sandbox_path, { recursive: true });
  planningReview.subject = "spec-writer";
  writeFileSync(join(restoreSnapshot, "reviews", "spec-writer.json"), `${JSON.stringify(planningReview, null, 2)}\n`);
  git(restoreOperator, "switch", "--quiet", "--detach", restoredHead);
  writeFileSync(join(restoreOperator, ".gitignore"), `.factory-sandboxes/\n.factory/\n!.factory/\n.factory/*\n!.factory/${restoreRun}/\n.factory/${restoreRun}/*\n!.factory/${restoreRun}/run.json\n`);
  git(restoreOperator, "add", ".gitignore");
  git(restoreOperator, "commit", "--quiet", "-m", "unignore restored manifest");
  const unignoredHead = git(restoreOperator, "rev-parse", "HEAD");
  git(restoreOperator, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/feature/${restoreRun}`);
  git(restoreOperator, "switch", "--quiet", "main");
  const unignoredManifest = spawnSync(process.execPath, [cli, "restore", restoreRun, "--repo", restoreOperator,
    "--from", remoteFeatureRef, "--now", "2026-09-21T16:07:00Z", "--json"], { encoding: "utf8" });
  assert.equal(unignoredManifest.status, 1);
  assert.match(unignoredManifest.stderr, /requires '.factory\/restore-parked\/run.json' to be ignored/u);
  assert.ok(unignoredHead, "the refusal is against a real advertised descendant commit");

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
    "Recording the pull request is the last externally publishing side effect an\n  autonomous run may perform.",
    "autonomous does not imply draft, and `pr_draft: false` is a supported",
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
    "The explicit Step 7 exclusion applies only after the\npull request is recorded",
    "guarded local-ref fetch, archive, verification, and deterministic sandbox\nremoval remain the sole completed-handoff exception to bootstrap/refusal state preservation.",
  ]) assert.ok(operatorBoundary.includes(fragment), `AC10 operator boundary is missing: ${fragment}`);

  // The wording moved off "draft" deliberately: `pr_draft: false` publishes ready-for-review, and prose
  // asserting a draft unconditionally is what made an agent read autonomous as draft-only and park.
  const sharedModeRule = "After the pull request is recorded -- draft or ready for review, as `pr_draft`\nselected -- `interactive`, `headless`, and `autonomous` modes all enter this same mandatory\nlocal completed handoff.";
  assert.ok(handoff.includes(sharedModeRule), "AC10 all modes must enter the same local completed handoff after PR recording");
  assert.ok(handoff.includes("perform only the terminalize, local-ref fetch, archive, verification, and guarded sandbox-removal\nsequence below"),
    "AC10 autonomous post-PR exception must be limited to the local completed handoff sequence");
  assert.ok(handoff.includes("with no external PR merge or unrelated work after PR recording"),
    "AC10 autonomous post-PR exception must prohibit external PR merge and unrelated work");

  // ENFORCEMENT, not instruction, and derived from the code rather than from a list of banned phrases.
  // Three releases running, the executable block was right and prose restating its decision drifted:
  // 0.8.4 the option prefix, 0.8.5 the init invocation, and here PR publication. The block selects
  // `gh pr create --draft` on `PR_DRAFT=true` and plain `gh pr create` otherwise, so `pr_draft: false`
  // is fully supported -- but prose asserted "the draft PR" unconditionally in eight places, one of them
  // putting "draft" and "autonomous" in a single clause. An agent read autonomous as draft-only, found
  // the run's `pr_draft: false`, and parked on a contradiction between two instructions it must obey.
  //
  // The rule: for every selector a fenced block branches on, prose naming one of its outcomes must also
  // name the selector, so an outcome reads as chosen rather than fixed.
  //
  // The first version of this FAILED OPEN, which is the same defect it exists to catch. The extractor is
  // a regex over shell, not a shell parser, so rewriting the condition as `[[ ... ]]` or `${PR_DRAFT}`
  // made it discover nothing -- and with nothing discovered every prose check below was skipped and the
  // whole guard passed while proving nothing. Caught in review. Two changes close it: the extractor
  // recognises the forms this file can plausibly use, and KNOWN_SELECTORS must still be discovered, so a
  // rewrite the extractor cannot read fails loudly and is fixed in the extractor rather than silently
  // tolerated. It remains a heuristic over shell text; the known-selector assertion is what makes an
  // unreadable rewrite fail closed instead of open.
  const SELECTOR_FORMS = /(?:if\s+\[{1,2}\s+|case\s+|elif\s+\[{1,2}\s+)"?\$\{?(\w+)\}?"?/gu;
  // Outcome vocabulary per selector. Listed only when the phrase names an outcome: "draft a ticket" is a
  // different word sense and is deliberately absent.
  const OUTCOME_WORDS = { PR_DRAFT: [/draft PR\b/iu, /\bdraft publication\b/iu, /PR is a draft\b/iu] };
  // Selectors this file is known to branch on. Discovery of each is asserted, so an equivalent rewrite
  // cannot quietly empty the set.
  const KNOWN_SELECTORS = ["PR_DRAFT"];

  const outcomeViolations = (markdown) => {
    const blocks = [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)].map(([, body]) => body);
    const selectors = new Set();
    for (const body of blocks) for (const [, name] of body.matchAll(SELECTOR_FORMS)) selectors.add(name);
    const undeclared = [...selectors].filter((name) => !OUTCOME_WORDS[name]);
    const missing = KNOWN_SELECTORS.filter((name) => !selectors.has(name));
    const prose = markdown.replace(/```[a-z]*\n[\s\S]*?```/gu, "");
    const unqualified = [];
    for (const [name, patterns] of Object.entries(OUTCOME_WORDS)) {
      if (!selectors.has(name)) continue;
      // By paragraph, not by line. These documents hard-wrap at about a hundred columns, so a correctly
      // qualified sentence routinely puts the selector on the line above the outcome -- checking lines
      // reported those as violations. A paragraph is also the unit a reader actually takes in, which is
      // the property being guarded: that the outcome does not READ as fixed.
      for (const paragraph of prose.split(/\n\s*\n/u)) {
        if (patterns.some((pattern) => pattern.test(paragraph)) && !new RegExp(name, "iu").test(paragraph)) {
          unqualified.push(paragraph.split("\n").find((line) => patterns.some((pattern) => pattern.test(line)))?.trim() ?? paragraph.trim());
        }
      }
    }
    return { undeclared, missing, unqualified };
  };

  const canonical = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
  const live = outcomeViolations(canonical);
  assert.deepEqual(live.missing, [],
    `the extractor no longer discovers a known branch selector, which would skip every prose check below and pass: ${live.missing.join(", ")}`);
  assert.deepEqual(live.undeclared, [],
    `a fenced block branches on a selector with no declared outcome vocabulary, so prose about it is unguarded: ${live.undeclared.join(", ")}`);
  assert.deepEqual(live.unqualified, [],
    `prose states a branch outcome as if it were fixed; name the selector so it reads as chosen:\n  ${live.unqualified.join("\n  ")}`);

  // EVERY shipped document this package owns, prose AND fenced examples. 0.8.6 scoped this rule to
  // WORKFLOW.md, which is why an unconditional `gh pr create --draft` sat unread in README.md; the first
  // widening then listed two of eleven specialist prompts and still stripped fences, so an audit found a
  // `DRAFT PR` chain diagram surviving in two files. Both misses were the inventory, not the rule.
  //
  // WHAT THIS CANNOT DO, stated because an overstated guard is worse than a narrow one. It matches tokens
  // in a block; it does not parse English and cannot tell whether a qualifier GOVERNS the outcome. These
  // pass and should not: "Read PR_DRAFT for logging. Always publish a draft PR." and "With PR_DRAFT=false,
  // always publish a draft PR." These fail and should not: "Never assume the result is a draft PR."
  // Proximity is the property being checked. It catches the shape every defect in this series actually
  // took -- an outcome stated with no selector anywhere near it -- and nothing subtler.
  const agentsDir = join(pkg, "agents");
  const owned = [
    // The canonical workflow itself. Its prose is scanned above, but its FENCES were not, which is how a
    // `DRAFT PR` chain diagram survived in it -- the same miss as README's, in the document the rule is
    // derived from. Its prose is excluded below to avoid double-reporting what `live` already covers.
    ["WORKFLOW.md", join(pkg, "WORKFLOW.md")],
    ["README.md", resolve(pkg, "..", "..", "README.md")],
    ["OPERATING.md", resolve(pkg, "..", "..", "OPERATING.md")],
    ["feature-factory/README.md", join(pkg, "README.md")],
    ...readdirSync(agentsDir).filter((name) => name.endsWith(".md")).map((name) => [`agents/${name}`, join(agentsDir, name)]),
  ];
  assert.ok(owned.length >= 14, `the document inventory looks truncated at ${owned.length}; every agent prompt must be covered`);
  for (const [label, path] of owned) {
    const text = readFileSync(path, "utf8");
    const found = outcomeViolations(`${canonical}\n${text}`).unqualified;
    const own = found.filter((line) => !live.unqualified.includes(line));
    assert.deepEqual(own, [],
      `${label} states a branch outcome as if it were fixed; name the selector so it reads as chosen:\n  ${own.join("\n  ")}`);
    // Fences too, which the prose scan strips -- the shape the README defect actually took.
    const inFences = text.split(/\n\s*\n/u)
      .filter((block) => /gh pr create --draft|\bDRAFT PR\b/u.test(block) && !/PR_DRAFT|pr_draft/iu.test(block));
    assert.deepEqual(inFences, [],
      `${label} shows an unconditional draft outcome in an example; show the choice or name pr_draft beside it:\n  ${inFences.join("\n  ")}`);
  }

  // The controls are table-driven rather than run by hand, so the guard's own failure modes stay proven.
  // The `missing` row is the one review added: it is the rewrite that used to switch the guard off.
  const guardBlock = '```sh\nif [ "$PR_DRAFT" = true ]; then\n  gh pr create --draft\nelse\n  gh pr create\nfi\n```\n';
  for (const [name, markdown, expected] of [
    ["clean baseline", `${guardBlock}\nPublication follows PR_DRAFT.\n`, { undeclared: [], missing: [], unqualifiedCount: 0 }],
    ["unconditional outcome claim", `${guardBlock}\nAn autonomous run always finishes with a draft PR.\n`, { undeclared: [], missing: [], unqualifiedCount: 1 }],
    ["qualified outcome claim", `${guardBlock}\nWith PR_DRAFT true the draft PR is published.\n`, { undeclared: [], missing: [], unqualifiedCount: 0 }],
    ["unrelated word sense", `${guardBlock}\nThe story agent may draft a ticket.\n`, { undeclared: [], missing: [], unqualifiedCount: 0 }],
    ["selector rewritten as [[ ]]", `${guardBlock.replace('if [ "$PR_DRAFT"', 'if [[ "$PR_DRAFT"')}\nAn autonomous run always finishes with a draft PR.\n`, { undeclared: [], missing: [], unqualifiedCount: 1 }],
    ["selector rewritten as ${}", `${guardBlock.replace('"$PR_DRAFT"', '"${PR_DRAFT}"')}\nAn autonomous run always finishes with a draft PR.\n`, { undeclared: [], missing: [], unqualifiedCount: 1 }],
    ["selector absent entirely", "No fenced block here.\nAn autonomous run always finishes with a draft PR.\n", { undeclared: [], missing: ["PR_DRAFT"], unqualifiedCount: 0 }],
    ["new selector, no vocabulary", `\`\`\`sh\nif [ "$PR_SQUASH" = true ]; then :; fi\n\`\`\`\n${guardBlock}`, { undeclared: ["PR_SQUASH"], missing: [], unqualifiedCount: 0 }],
  ]) {
    const got = outcomeViolations(markdown);
    assert.deepEqual(got.undeclared, expected.undeclared, `guard control '${name}': undeclared selectors`);
    assert.deepEqual(got.missing, expected.missing, `guard control '${name}': undiscovered known selectors`);
    assert.equal(got.unqualified.length, expected.unqualifiedCount, `guard control '${name}': unqualified prose lines`);
  }

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

  // `factory snapshot` publishes the parked control-plane snapshot. Bound to this site rather than a new
  // one: the park sequence it completes is what this test already covers. Built inline because these need
  // a plane whose status is `needs-human`, which the handoff fixtures above deliberately are not.
  const { dispatchSnapshot } = await import("../bin/snapshot.js");
  const snapRoot = realpathSync(mkdtempSync(join(tmpdir(), "factory-snapshot-")));
  try {
    const runId = "chainlink-snap";
    // Seeded through the shared fixture so the manifest is schema-valid: publication now applies the same
    // `validateRun` the restore side does, so a hand-rolled stub would prove only that the check exists.
    const { runDir: plane } = seedLegacyRun(snapRoot, runId, { status: "running" });
    // A parked run carries its terminal result -- the schema requires one for `needs-human` -- so the
    // fixture writes a real parked manifest rather than a stub the validation would reject for the
    // wrong reason.
    const manifest = (status, id = runId) => writeFileSync(join(plane, "run.json"), JSON.stringify({
      ...seededRun, run_id: id, status,
      terminal_result: status === "needs-human" ? { status: "needs-human", reason: "budget" } : null,
    }, null, 2));
    const seededRun = JSON.parse(readFileSync(join(plane, "run.json"), "utf8"));
    writeFileSync(join(plane, "artifacts", "brief.md"), "brief\n");
    symlinkSync("brief.md", join(plane, "artifacts", "brief-link"));
    writeFileSync(join(plane, "factory.lock"), JSON.stringify({ heartbeat_at: "one" }));
    mkdirSync(join(plane, "nested"));
    writeFileSync(join(plane, "nested", "run-json.lock"), "durable nested state\n");

    // Refused on a live plane: a snapshot of a running run records a moment no resume can return to.
    manifest("running");
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /requires a parked run/u,
      "a live plane must not be recorded as recovery evidence");
    assert.equal(existsSync(join(snapRoot, ".factory", ".parked", runId)), false, "a refusal publishes nothing");

    manifest("needs-human");
    let staleSeamGuarded = false;
    const first = await dispatchSnapshot([runId], { repo: snapRoot }, { beforeCommit: async () => {
      const ownerPath = join(plane, RUN_JSON_LOCK_DIR, "owner.json"), original = readFileSync(ownerPath);
      const owner = JSON.parse(original); owner.acquired_at = "2000-01-01T00:00:00.000Z";
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
      try {
        await assert.rejects(() => withRunJsonLock(plane, async () => {}, { timeoutMs: 20, staleLockMs: 1 }), /timed out/u);
        staleSeamGuarded = true;
      } finally { writeFileSync(ownerPath, original); }
    } });
    assert.equal(staleSeamGuarded, true, "the snapshot lock cannot expire at the pre-rename seam");
    const canonical = join(snapRoot, ".factory", ".parked", runId);
    assert.equal(first.park_snapshot, canonical);
    assert.equal(factory(snapRoot, "status", runId).park_snapshot, canonical,
      "legacy live planes observe the snapshot they publish");
    assert.equal(readFileSync(join(canonical, "artifacts", "brief.md"), "utf8"), "brief\n");
    assert.equal(lstatSync(join(canonical, "artifacts", "brief-link")).isSymbolicLink(), true,
      "symlinks are copied as symlinks, not followed");
    assert.equal(existsSync(join(canonical, "factory.lock")), false,
      "the plane-root session lock is not copied");
    assert.equal(existsSync(join(canonical, "run-json.lock")), false,
      "the plane-root transition lock is not copied");
    assert.equal(readFileSync(join(canonical, "nested", "run-json.lock"), "utf8"), "durable nested state\n",
      "a similarly named nested entry remains durable state");

    // The exclusion is what makes publication survive a heartbeat landing mid-copy. Control: the lock now
    // differs from the one present at the first publication, and publication still succeeds.
    writeFileSync(join(plane, "factory.lock"), JSON.stringify({ heartbeat_at: "two" }));
    writeFileSync(join(plane, "artifacts", "brief.md"), "revised\n");
    const second = await dispatchSnapshot([runId], { repo: snapRoot });
    assert.equal(second.residual, null, "a completed publication reports no residual");
    assert.equal(readFileSync(join(canonical, "artifacts", "brief.md"), "utf8"), "revised\n",
      "the second publication replaced the canonical snapshot");
    assert.equal(existsSync(join(snapRoot, ".factory", ".parked", `.prior-${runId}`)), false,
      "the prior copy is cleaned up after the commit point");
    assert.equal(existsSync(join(snapRoot, ".factory", ".parked", `.staging-${runId}`)), false,
      "no staging tree survives a completed publication");

    // Preflight: a residual staging tree stops before anything is staged, because publishing over an
    // unknown residual would make the rollback path ambiguous.
    mkdirSync(join(snapRoot, ".factory", ".parked", `.staging-${runId}`), { recursive: true });
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /residual staging tree/u);
    rmSync(join(snapRoot, ".factory", ".parked", `.staging-${runId}`), { recursive: true, force: true });

    const priorPath = join(snapRoot, ".factory", ".parked", `.prior-${runId}`);
    writeFileSync(priorPath, "unsafe residual\n");
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /residual .* has an unsafe type/u);
    assert.equal(readFileSync(priorPath, "utf8"), "unsafe residual\n", "an unsafe prior is preserved, not cleaned up");
    rmSync(priorPath);
    const fencePath = join(snapRoot, ".factory", ".parked", `.grant-retry-${runId}.json`);
    writeFileSync(fencePath, "{malformed");
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /could not reconcile retry-grant transaction/u);
    assert.equal(readFileSync(fencePath, "utf8"), "{malformed", "an unresolved fence is preserved exactly");
    rmSync(fencePath);
    const stagingFencePath = `${fencePath}.staging`;
    writeFileSync(stagingFencePath, "{partial");
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }),
      (error) => /staging fence is malformed/u.test(`${error.message} ${error.cause?.message ?? ""}`));
    assert.equal(readFileSync(stagingFencePath, "utf8"), "{partial", "a partial staging fence is preserved exactly");
    rmSync(stagingFencePath);

    // A valid residual `.prior-$R` beside a qualified canonical is completed-publication cleanup.
    mkdirSync(priorPath, { recursive: true });
    assert.equal((await dispatchSnapshot([runId], { repo: snapRoot })).park_snapshot, canonical);
    assert.equal(existsSync(priorPath), false,
      "preflight removes the residual rather than publishing around it");

    // The publication gate is an inventory comparison, so control the comparison rather than contriving a
    // failed copy: trees differing only in the plane-root lock must compare equal, and trees differing in
    // any real file must not. A publication that could not tell those apart would publish a partial copy
    // and report a path an operator would trust.
    const { inventory } = await import("../bin/restore.js");
    const liveness = new Set(["factory.lock", "run-json.lock"]);
    const twin = join(snapRoot, "twin");
    cpSync(plane, twin, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(twin, "factory.lock"), JSON.stringify({ heartbeat_at: "different" }));
    assert.equal(inventory(twin, liveness), inventory(plane, liveness),
      "a differing plane-root lock must not fail the comparison");
    writeFileSync(join(twin, "artifacts", "brief.md"), "diverged\n");
    assert.notEqual(inventory(twin, liveness), inventory(plane, liveness),
      "a differing tracked file must fail the comparison");

    // Publication must accept only what `restore` will later read; every gap here publishes recovery
    // evidence its one consumer rejects. Each refusal must also leave the last good snapshot exactly as
    // it was, because a refusal that damaged it would be worse than the evidence it declined to write.
    const good = readFileSync(join(plane, "run.json"));
    const intact = (why) => {
      assert.equal(readFileSync(join(canonical, "artifacts", "brief.md"), "utf8"), "revised\n", why);
      assert.equal(existsSync(join(snapRoot, ".factory", ".parked", `.staging-${runId}`)), false, why);
    };

    // First review finding: restore refuses a symlinked or redirecting parked manifest.
    const elsewhere = join(snapRoot, "elsewhere.json");
    writeFileSync(elsewhere, good);
    rmSync(join(plane, "run.json"));
    symlinkSync(elsewhere, join(plane, "run.json"));
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /must be a regular file/u,
      "a symlinked manifest must not be published");
    assert.equal(existsSync(join(plane, RUN_JSON_LOCK_DIR)), false,
      "an unsafe source is refused before writing a transition lock");
    intact("a symlinked manifest damages nothing");
    rmSync(join(plane, "run.json"));

    // Second finding, the same asymmetry one layer down: checking only `status` let a manifest restore
    // rejects as invalid, or one naming another run, reach `.parked/<requested>`.
    writeFileSync(join(plane, "run.json"), JSON.stringify({ run_id: runId, status: "needs-human" }));
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /is not a valid run/u,
      "a manifest the restore schema rejects must not be published");
    intact("an invalid manifest damages nothing");

    manifest("needs-human", "chainlink-other");
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /names 'chainlink-other'/u,
      "a manifest naming another run must not be published under this one");
    intact("a mismatched manifest damages nothing");
    writeFileSync(join(plane, "run.json"), good);

    // Third review finding: qualifying the live plane and copying it later leaves a window. A manifest
    // replaced in between is copied into staging, and inventory equality still passes because both trees
    // then hold the same unvalidated bytes -- so equality alone cannot catch it. The copy seam stands in
    // for that race deterministically: it performs the real copy, then swaps the staged manifest for one
    // restore would reject.
    const { copySnapshot } = await import("../bin/restore.js");
    // The source is replaced, not the staged copy: that is the race, and it is why inventory equality
    // cannot catch it -- both trees end up holding the same unvalidated bytes and compare equal.
    const swap = (replacement) => (source, target, skipped) => {
      writeFileSync(join(source, "run.json"), replacement);
      copySnapshot(source, target, skipped);
    };
    await assert.rejects(
      () => dispatchSnapshot([runId], { repo: snapRoot }, { copy: swap(JSON.stringify({ run_id: runId, status: "needs-human" })) }),
      /staged run manifest for '.*' is not a valid run/u,
      "a manifest swapped in after qualification must not be published");
    intact("a swapped-in invalid manifest damages nothing");
    writeFileSync(join(plane, "run.json"), good);
    await assert.rejects(
      () => dispatchSnapshot([runId], { repo: snapRoot }, { copy: swap(JSON.stringify({ ...seededRun, run_id: "chainlink-other", status: "needs-human", terminal_result: { status: "needs-human", reason: "b" } })) }),
      /staged run manifest names 'chainlink-other'/u,
      "a swapped-in manifest naming another run must not be published");
    intact("a swapped-in mismatched manifest damages nothing");
    writeFileSync(join(plane, "run.json"), good);

    const sandboxPlane = join(snapRoot, ".factory-sandboxes", runId, ".factory", runId);
    mkdirSync(dirname(sandboxPlane), { recursive: true });
    cpSync(plane, sandboxPlane, { recursive: true, verbatimSymlinks: true });
    await assert.rejects(() => dispatchSnapshot([runId], { repo: snapRoot }), /ambiguous live manifests/u);
    assert.equal(factory(snapRoot, "status", runId).park_snapshot, null,
      "ambiguous live planes never qualify a snapshot");
    rmSync(plane, { recursive: true });
    assert.equal((await dispatchSnapshot([runId], { repo: snapRoot })).park_snapshot, canonical,
      "the public operator-root invocation publishes a sandbox live plane");
    await assert.rejects(() => dispatchSnapshot([runId], { repo: join(snapRoot, "absent") }), /is not observable/u);
    await assert.rejects(() => dispatchSnapshot([], { repo: snapRoot }), /exactly one valid run id/u);
  } finally {
    rmSync(snapRoot, { recursive: true, force: true });
  }
});
