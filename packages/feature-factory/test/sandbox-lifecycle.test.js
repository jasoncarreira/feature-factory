import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchInit } from "../bin/factory.js";
import { git as observeGit, observeTrackedCleanliness, proveInitContainment, runBootstrap } from "../observe/index.js";
import { dispatchInitPublication } from "../bin/init-publication.js";
import { FAMILY_CONTRACTS } from "../core/contracts.js";
import { initFresh, seedLegacyRun } from "./init-fixture.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(pkg, "bin", "factory.js");
// Node warns "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set" whenever both are present,
// and that warning lands on stderr, which the rows below compare with strict equality. Any host with a coloured
// UI exports FORCE_COLOR -- Prime Agent does -- so the suite would go red for a reason unrelated to what it
// tests. `effective-push`, `end-to-end` and `prompt-claims` already scrub it for the same reason; this file
// missed the convention, and run 291 paid for it: a slice whose implementation was green blocked on the
// `missing-control` row, could not repair a file outside its paths, and `blocked` is final.
// The deletion happens last, after every overlay is merged, because an earlier draft scrubbed a base object and
// then spread caller overlays over it -- so a row passing FORCE_COLOR through `extra` put it straight back. Both
// CLI spawns below build their environment here. A spawn that constructs `env` itself would not be covered:
// this is the one place the deletion happens, not a mechanism that stops a future caller from bypassing it.
function cliEnv(...overlays) {
  const env = Object.assign({}, process.env, ...overlays);
  delete env.FORCE_COLOR;
  return env;
}

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const NOW = "2026-08-04T12:00:00Z";

function git(repository, ...args) {
  return execFileSync(REAL_GIT, args, { cwd: repository, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
}

function operator(root, name, plant) {
  const repository = join(root, name);
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=main");
  git(repository, "config", "user.name", "Factory Test");
  git(repository, "config", "user.email", "factory@example.test");
  writeFileSync(join(repository, ".gitignore"), ".factory/\n.factory-sandboxes/\n");
  writeFileSync(join(repository, "tracked.txt"), `${name}\n`);
  git(repository, "add", ".gitignore", "tracked.txt");
  git(repository, "commit", "--quiet", "-m", "seed");
  if (plant) {
    plant(repository);
    git(repository, "add", "-f", ".");
    git(repository, "commit", "--quiet", "-m", "plant");
  }
  return repository;
}

function replaceIgnore(repository, bytes, tracked = true) {
  writeFileSync(join(repository, ".gitignore"), bytes);
  if (tracked) {
    git(repository, "add", ".gitignore");
    git(repository, "commit", "--quiet", "-m", "ignore policy");
  } else {
    git(repository, "rm", "--quiet", "--cached", ".gitignore");
    git(repository, "commit", "--quiet", "-m", "untrack ignore policy");
  }
}

function recorder(root) {
  const bin = join(root, "bin");
  const log = join(root, "git.jsonl");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "git");
  writeFileSync(path, `#!/usr/bin/env node
const { appendFileSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const clone = args[0] === "clone";
const destination = clone ? args.at(-1) : null;
appendFileSync(process.env.GIT_LOG, JSON.stringify({ args, cwd: process.cwd(), clone, exists: clone && (() => { try { statSync(destination); return true; } catch { return false; } })(), empty: clone && (() => { try { return readdirSync(destination).length === 0; } catch { return false; } })() }) + "\\n");
if (clone && process.env.FAIL_CLONE === "1") {
  const sentinel = destination + "/clone-failure-sentinel";
  writeFileSync(sentinel, "partial bytes stay\\n");
  const stats = statSync(sentinel);
  appendFileSync(process.env.GIT_LOG, JSON.stringify({ sentinel, dev: stats.dev, ino: stats.ino, mode: stats.mode, bytes: "partial bytes stay\\n" }) + "\\n");
  process.exit(42);
}
const probe = args.join(" ");
if (process.cwd() === process.env.MISMATCH_SANDBOX && probe === process.env.MISMATCH_PROBE) {
  process.stdout.write(process.env.MISMATCH_PATH + "\\n");
  process.exit(0);
}
const result = spawnSync(process.env.REAL_GIT, args, { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
if (clone && result.status === 0) {
  const snap = (path, bytes = false) => {
    const stats = lstatSync(path);
    return { path, dev: stats.dev, ino: stats.ino, mode: stats.mode, type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other", bytes: bytes ? readFileSync(path, "utf8") : null };
  };
  appendFileSync(process.env.GIT_LOG, JSON.stringify({ cloneSnapshot: { sandbox: snap(destination), tracked: snap(destination + "/tracked.txt", true), head: snap(destination + "/.git/HEAD", true) } }) + "\\n");
}
process.exit(result.status === null ? 1 : result.status);
`);
  chmodSync(path, 0o755);
  return { bin, log };
}

function invoke(repository, args, record, extra = {}) {
  const command = [CLI, ...args, ...(args.includes("--repo") ? [] : ["--repo", repository])];
  const result = spawnSync(process.execPath, command, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: cliEnv({ PATH: `${record.bin}:${process.env.PATH}`, GIT_LOG: record.log, REAL_GIT }, extra),
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? result.error?.message ?? "");
  return result.status === 0
    ? { ok: true, stdout, stderr, response: args.includes("--json") ? JSON.parse(stdout) : null }
    : { ok: false, stdout, stderr };
}

function events(record) {
  if (!existsSync(record.log)) return [];
  return readFileSync(record.log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function clones(record) {
  return events(record).filter((event) => event.clone);
}

function snapshot(path) {
  const stats = lstatSync(path);
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, bytes: readFileSync(join(path, "sentinel"), "utf8") };
}

function pathSnapshot(path, bytes = false) {
  const stats = lstatSync(path);
  return {
    path, dev: stats.dev, ino: stats.ino, mode: stats.mode,
    type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other",
    bytes: bytes ? readFileSync(path, "utf8") : null,
  };
}

function assertClonePreserved(record) {
  const before = events(record).find((event) => event.cloneSnapshot)?.cloneSnapshot;
  assert.ok(before);
  assert.deepEqual(pathSnapshot(before.sandbox.path), before.sandbox);
  assert.deepEqual(pathSnapshot(before.tracked.path, true), before.tracked);
  assert.deepEqual(pathSnapshot(before.head.path, true), before.head);
}

test("AC1/AC2/AC3/AC4/AC5/AC6/AC7/AC8 init creates and proves one retained local sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-lifecycle-"));
  try {
    const record = recorder(root);
    const source = operator(root, "operator ; no-shell");
    const runId = "sandbox-lifecycle";
    const sandbox = join(realpathSync(source), ".factory-sandboxes", runId);
    const result = invoke(source, ["init", runId, "--now", NOW, "--json"], record, { SHELL: "/bin/false" });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(Object.keys(result.response), ["run_id", "run_dir", "workflow", "sandbox_path", "branch", "worktree", "pr_base", "status", "mode"]);
    // The staged workflow is the file the skill reads, so assert the bytes rather than the key: a response
    // naming a path that does not exist would satisfy the shape above while leaving the driver with nothing
    // to read, which is the failure staging exists to remove.
    const staged = readFileSync(result.response.workflow, "utf8");
    assert.equal(staged, readFileSync(new URL("../WORKFLOW.md", import.meta.url), "utf8"),
      "the staged workflow must be an exact copy of the canonical one");
    assert.equal(result.response.workflow, join(result.response.run_dir, "WORKFLOW.md"));

    // Bootstrap runs repository-controlled commands before the workflow is staged, so a planted symlink at
    // the destination is the live attack: a plain copy would follow it and write outside the sandbox. The
    // protected writer rechecks the target immediately before the rename, so init refuses instead. And the
    // refusal must land BEFORE publication -- a published run whose init failed can never be re-initialized,
    // because init refuses to collide with an existing manifest.
    for (const [name, plant] of [
      ["symlink", "ln -s /tmp/ff-staging-escape .factory/$RUN/WORKFLOW.md"],
      ["directory", "mkdir -p .factory/$RUN/WORKFLOW.md"],
    ]) {
      const runId = `stage-${name}`;
      const command = `sh -c "mkdir -p .factory/${runId} && ${plant.replace("$RUN", runId)}"`;
      const source = operator(root, `stage-${name}-src`, (repository) => {
        writeFileSync(join(repository, ".factory.json"), `${JSON.stringify({
          resolve: "true", verify: "true", publish: "true", publishing_identity: "test",
          pr_draft: false, bootstrap: command, bootstrap_timeout_ms: 120000,
        }, null, 2)}\n`);
      });
      assert.throws(() => initFresh(source, [runId]), /./u, `${name}: init must refuse a planted staging target`);
      assert.equal(existsSync(join(source, ".factory-sandboxes", runId, ".factory", runId, "run.json")), false,
        `${name}: no manifest may be published when staging fails`);
    }
    assert.equal(result.response.sandbox_path, sandbox);
    assert.equal(result.response.run_dir, join(sandbox, ".factory", runId));
    assert.equal(realpathSync(sandbox), sandbox);
    const defaultRun = JSON.parse(readFileSync(join(result.response.run_dir, "run.json"), "utf8"));
    assert.equal(Object.hasOwn(defaultRun, "bootstrap_command"), false);
    assert.equal(defaultRun.pr_draft, true);
    const defaultJsonStatus = invoke(result.response.sandbox_path, ["status", runId, "--json"], record);
    assert.equal(defaultJsonStatus.response.pr_draft, true);
    const defaultPlainStatus = invoke(result.response.sandbox_path, ["status", runId], record);
    assert.match(defaultPlainStatus.stdout, /^pr_draft: true$/mu);
    assert.equal(clones(record).length, 1);
    assert.deepEqual(clones(record)[0].args, ["clone", "--local", "--", realpathSync(source), sandbox]);
    assert.deepEqual({ exists: clones(record)[0].exists, empty: clones(record)[0].empty }, { exists: true, empty: true });
    const objectId = git(source, "rev-parse", "HEAD:tracked.txt");
    const sourceObject = join(source, ".git", "objects", objectId.slice(0, 2), objectId.slice(2));
    const sandboxObject = join(sandbox, ".git", "objects", objectId.slice(0, 2), objectId.slice(2));
    assert.deepEqual({ dev: statSync(sandboxObject).dev, ino: statSync(sandboxObject).ino }, { dev: statSync(sourceObject).dev, ino: statSync(sourceObject).ino });
    for (const path of ["plan", "artifacts", "evidence", "reviews"]) assert.equal(realpathSync(join(result.response.run_dir, path)), join(result.response.run_dir, path));
    assert.equal(realpathSync(join(sandbox, ".factory", "worktrees", runId)), join(sandbox, ".factory", "worktrees", runId));
    assert.equal(runBootstrap(sandbox, "accepted\0command", 1000, { runner: () => { throw new TypeError("spawn rejected argv"); } }), null);
    let canonicalizationProbes = 0;
    const canonicalizationFailure = observeTrackedCleanliness(sandbox, { runner: (_command, args) => {
      canonicalizationProbes += 1;
      return { status: 0, stdout: args.includes("rev-parse") ? join(root, "missing-top-level") : "", stderr: "" };
    } });
    assert.deepEqual(canonicalizationFailure, { observed: false, entries: [] });
    assert.equal(canonicalizationProbes, 3, "all Git probes complete before top-level canonicalization is classified");
    assert.deepEqual(observeTrackedCleanliness(sandbox, { runner: () => { throw new Error("Git probe failed"); } }),
      { observed: false, entries: [] });

    const patternRows = [
      { name: "slash-absent", pattern: ".factory/", present: false },
      { name: "slash-present", pattern: ".factory/", present: true },
      { name: "plain-absent", pattern: ".factory", present: false },
      { name: "plain-present", pattern: ".factory", present: true },
    ];
    for (const row of patternRows) {
      const patternSource = operator(root, `pattern-${row.name}`);
      replaceIgnore(patternSource, `${row.pattern}\n/.factory-sandboxes/\n`);
      if (row.present) mkdirSync(join(patternSource, ".factory"));
      const patternRun = `pattern-${row.name}`;
      const patternResult = invoke(patternSource, ["init", patternRun, "--now", NOW], recorder(join(root, `pattern-${row.name}-recorder`)));
      assert.equal(patternResult.ok, true, `${row.name}: ${patternResult.stderr}`);
      assert.equal(existsSync(join(patternSource, ".factory-sandboxes", patternRun, ".factory", patternRun, "run.json")), true, row.name);
    }

    const ignoreRows = [
      { name: "missing-control", rootIgnore: "/.factory-sandboxes/\n", probe: ".factory/missing-control/run.json", line: ".factory/" },
      { name: "missing-sandbox", rootIgnore: ".factory/\n", probe: ".factory-sandboxes/", line: "/.factory-sandboxes/" },
      { name: "info-exclude", rootIgnore: "/.factory-sandboxes/\n", alternate: "info", probe: ".factory/info-exclude/run.json", line: ".factory/" },
      { name: "global-exclude", rootIgnore: "/.factory-sandboxes/\n", alternate: "global", probe: ".factory/global-exclude/run.json", line: ".factory/" },
      { name: "local-exclude", rootIgnore: "/.factory-sandboxes/\n", alternate: "local", probe: ".factory/local-exclude/run.json", line: ".factory/" },
      { name: "untracked-root", rootIgnore: ".factory/\n/.factory-sandboxes/\n", tracked: false, probe: ".factory/untracked-root/run.json", line: ".factory/" },
      { name: "nested-only", rootIgnore: ".factory/\n.factory-sandboxes/*/.factory/\n", probe: ".factory-sandboxes/", line: "/.factory-sandboxes/" },
      { name: "filename-only", rootIgnore: ".factory/\nrun.json\n", probe: ".factory-sandboxes/", line: "/.factory-sandboxes/" },
      // The control for the seam: this row hands FORCE_COLOR back through `extra`, which the previous draft
      // spread after the scrub. The strict stderr comparison below is the assertion -- if the deletion stopped
      // happening last, Node's NO_COLOR warning would be appended and this row alone would fail.
      { name: "overlay-restores-color", rootIgnore: "/.factory-sandboxes/\n", probe: ".factory/overlay-restores-color/run.json", line: ".factory/", forceColor: true },
    ];
    for (const row of ignoreRows) {
      const ignoreSource = operator(root, `ignore-${row.name}`);
      replaceIgnore(ignoreSource, row.rootIgnore, row.tracked !== false);
      const extra = { GIT_CONFIG_NOSYSTEM: "1", ...(row.forceColor ? { FORCE_COLOR: "1", NO_COLOR: "1" } : {}) };
      if (row.alternate === "info") writeFileSync(join(ignoreSource, ".git", "info", "exclude"), ".factory/\n");
      if (row.alternate === "local") {
        const excludes = join(root, `${row.name}.exclude`);
        writeFileSync(excludes, ".factory/\n");
        git(ignoreSource, "config", "core.excludesFile", excludes);
      }
      if (row.alternate === "global") {
        const home = join(root, `${row.name}-home`);
        const excludes = join(home, "global.exclude");
        mkdirSync(home);
        writeFileSync(excludes, ".factory/\n");
        writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${excludes}\n`);
        extra.HOME = home;
        extra.XDG_CONFIG_HOME = join(home, "xdg");
      }
      const ignoreRecord = recorder(join(root, `${row.name}-recorder`));
      const ignored = invoke(ignoreSource, ["init", row.name, "--now", NOW], ignoreRecord, extra);
      const canonical = realpathSync(ignoreSource);
      const ignoredSandbox = join(canonical, ".factory-sandboxes", row.name);
      assert.equal(ignored.ok, false, row.name);
      assert.equal(ignored.stdout, "", row.name);
      assert.equal(ignored.stderr, `factory init requires '${row.probe}' to be ignored by tracked root '.gitignore' in operator repository '${canonical}'; add exactly '${row.line}' to '${join(canonical, ".gitignore")}'; sandbox path '${ignoredSandbox}' was not created\n`, row.name);
      assert.match(ignored.stderr, new RegExp(`factory init requires '${row.probe.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'`, "u"), row.name);
      assert.match(ignored.stderr, new RegExp(`add exactly '${row.line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}' to '${join(canonical, ".gitignore").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'`, "u"), row.name);
      assert.match(ignored.stderr, new RegExp(`sandbox path '${ignoredSandbox.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}' was not created`, "u"), row.name);
      assert.equal(existsSync(join(canonical, ".factory-sandboxes")), false, row.name);
      assert.equal(clones(ignoreRecord).length, 0, row.name);
      assert.equal(git(ignoreSource, "branch", "--list", `feature/${row.name}`), "", row.name);
    }

    const failedSource = operator(root, "clone-failure");
    const failedRecord = recorder(join(root, "failure-recorder"));
    const failedSandbox = join(failedSource, ".factory-sandboxes", "clone-failure");
    const failed = invoke(failedSource, ["init", "clone-failure", "--now", NOW], failedRecord, { FAIL_CLONE: "1" });
    assert.equal(failed.ok, false);
    assert.match(failed.stderr, new RegExp(failedSandbox.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.equal(clones(failedRecord).length, 1);
    const planted = events(failedRecord).find((event) => event.sentinel);
    const retained = statSync(planted.sentinel);
    assert.deepEqual({ dev: retained.dev, ino: retained.ino, mode: retained.mode, bytes: readFileSync(planted.sentinel, "utf8") }, { dev: planted.dev, ino: planted.ino, mode: planted.mode, bytes: planted.bytes });
    assert.equal(existsSync(join(failedSandbox, ".factory", "clone-failure", "run.json")), false);

    const collisionSource = operator(root, "collision");
    const collisionRecord = recorder(join(root, "collision-recorder"));
    const collisionSandbox = join(collisionSource, ".factory-sandboxes", "collision");
    mkdirSync(collisionSandbox, { recursive: true });
    writeFileSync(join(collisionSandbox, "sentinel"), "collision stays\n");
    const collisionBefore = statSync(join(collisionSandbox, "sentinel"));
    const collision = invoke(collisionSource, ["init", "collision", "--now", NOW], collisionRecord);
    assert.equal(collision.ok, false);
    assert.match(collision.stderr, /already exists without a manifest/u);
    assert.equal(clones(collisionRecord).length, 0);
    assert.equal(statSync(join(collisionSandbox, "sentinel")).ino, collisionBefore.ino);

    const unsafeTarget = join(root, "unsafe-destination-target");
    mkdirSync(unsafeTarget);
    writeFileSync(join(unsafeTarget, "sentinel"), "unsafe target stays\n");
    for (const kind of ["file", "symlink"]) {
      const unsafeSource = operator(root, `destination-${kind}`);
      const unsafeRecord = recorder(join(root, `destination-${kind}-recorder`));
      const unsafeSandbox = join(realpathSync(unsafeSource), ".factory-sandboxes", `destination-${kind}`);
      mkdirSync(dirname(unsafeSandbox));
      if (kind === "file") writeFileSync(unsafeSandbox, "regular destination stays\n");
      else symlinkSync(unsafeTarget, unsafeSandbox);
      const before = kind === "file"
        ? { ...pathSnapshot(unsafeSandbox, true), target: null }
        : { ...pathSnapshot(unsafeSandbox), target: readlinkSync(unsafeSandbox) };
      const unsafe = invoke(unsafeSource, ["init", `destination-${kind}`, "--now", NOW], unsafeRecord);
      assert.equal(unsafe.ok, false);
      assert.match(unsafe.stderr, new RegExp(unsafeSandbox.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.match(unsafe.stderr, kind === "file" ? /regular file/u : /requires '.factory-sandboxes\//u);
      assert.equal(clones(unsafeRecord).length, 0);
      const after = kind === "file"
        ? { ...pathSnapshot(unsafeSandbox, true), target: null }
        : { ...pathSnapshot(unsafeSandbox), target: readlinkSync(unsafeSandbox) };
      assert.deepEqual(after, before);
      assert.equal(readFileSync(join(unsafeTarget, "sentinel"), "utf8"), "unsafe target stays\n");
    }

    const scalarCases = [
      { args: ["init"], positional: [], flags: {}, match: /exactly one <run-id>/u },
      { args: ["init", "one", "two"], positional: ["one", "two"], flags: {}, match: /exactly one <run-id>/u },
      { args: ["init", "Bad"], positional: ["Bad"], flags: {}, match: /run\.run_id/u },
      { args: ["init", "scalar", "--repo", " "], positional: ["scalar"], flags: { repo: " " }, match: /--repo/u },
      { args: ["init", "scalar", "--branch", ""], positional: ["scalar"], flags: { branch: "" }, match: /run\.branch/u },
      { args: ["init", "scalar", "--worktree", " "], positional: ["scalar"], flags: { worktree: " " }, match: /run\.worktree/u },
      { args: ["init", "scalar", "--pr-base", ""], positional: ["scalar"], flags: { prBase: "" }, match: /run\.pr_base/u },
      { args: ["init", "scalar", "--issue", ""], positional: ["scalar"], flags: { issue: "" }, match: /run\.issue_key/u },
      { args: ["init", "scalar", "--mode", "batch"], positional: ["scalar"], flags: { mode: "batch" }, match: /run\.mode/u },
      { args: ["init", "scalar", "--mode", "interactive", "--mode", "batch"], positional: ["scalar"], flags: { mode: "batch" }, match: /run\.mode/u },
      { args: ["init", "scalar", "--max-parallel-slices", "0"], positional: ["scalar"], flags: { maxParallelSlices: "0" }, match: /positive integer/u },
      { args: ["init", "scalar", "--max-retries", "1.5"], positional: ["scalar"], flags: { maxRetries: "1.5" }, match: /positive integer/u },
      { args: ["init", "scalar", "--max-retries", "9007199254740992"], positional: ["scalar"], flags: { maxRetries: "9007199254740992" }, match: /positive integer/u },
      { args: ["init", "scalar", "--now", ""], positional: ["scalar"], flags: { now: "" }, match: /ISO timestamp/u },
      { args: ["init", "scalar", "--now", "never"], positional: ["scalar"], flags: { now: "never" }, match: /ISO timestamp/u },
    ];
    for (const [index, row] of scalarCases.entries()) {
      const scalarSource = operator(root, `scalar-${index}`);
      const scalarRecord = recorder(join(root, `scalar-recorder-${index}`));
      const observed = invoke(scalarSource, row.args, scalarRecord);
      assert.equal(observed.ok, false, row.args.join(" "));
      assert.match(observed.stderr, row.match);
      assert.match(observed.stderr, /no sandbox path was derived or created/u);
      assert.equal(clones(scalarRecord).length, 0);
      assert.deepEqual(events(scalarRecord), []);
      assert.equal(existsSync(join(scalarSource, ".factory-sandboxes")), false);
      const seamCalls = [];
      const operations = new Proxy({}, {
        get(_target, property) {
          seamCalls.push(String(property));
          throw new Error(`effect seam accessed: ${String(property)}`);
        },
      });
      const originalCwd = process.cwd;
      let cwdCalls = 0;
      process.cwd = () => { cwdCalls += 1; throw new Error("cwd accessed"); };
      try {
        await assert.rejects(() => dispatchInit(row.positional, row.flags, operations), row.match);
      } finally {
        process.cwd = originalCwd;
      }
      assert.equal(cwdCalls, 0);
      assert.deepEqual(seamCalls, []);
    }

    const duplicateSource = operator(root, "duplicates");
    const duplicateRecord = recorder(join(root, "duplicate-recorder"));
    const duplicate = invoke(duplicateSource, [
      "init", "duplicates", "--mode", "bad", "--mode", "headless",
      "--max-retries", "0", "--max-retries", "2", "--now", "bad", "--now", NOW, "--json", "--json",
    ], duplicateRecord);
    assert.equal(duplicate.ok, true, duplicate.stderr);
    assert.equal(duplicate.response.mode, "headless");
    assert.equal(JSON.parse(readFileSync(join(duplicate.response.run_dir, "run.json"), "utf8")).max_retries, 2);

    const completeSource = operator(root, "complete-scalars");
    mkdirSync(join(completeSource, ".factory-sandboxes"));
    const completeRecord = recorder(join(root, "complete-recorder"));
    const completeHeadBefore = execFileSync(REAL_GIT, ["symbolic-ref", "HEAD"], { cwd: completeSource });
    const completeRefsBefore = execFileSync(REAL_GIT, ["for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)"], { cwd: completeSource });
    const complete = invoke(completeSource, [
      "init", "complete-scalars", "--branch", "custom/branch", "--worktree", ".", "--pr-base", "main",
      "--issue", "ISSUE-1", "--mode", "autonomous", "--max-parallel-slices", "1", "--max-retries", "1", "--now", NOW, "--json",
    ], completeRecord);
    const completeHeadAfter = execFileSync(REAL_GIT, ["symbolic-ref", "HEAD"], { cwd: completeSource });
    const completeRefsAfter = execFileSync(REAL_GIT, ["for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)"], { cwd: completeSource });
    assert.deepEqual(completeHeadAfter, completeHeadBefore);
    assert.deepEqual(completeRefsAfter, completeRefsBefore);
    assert.equal(complete.ok, true, complete.stderr);
    const completeRun = JSON.parse(readFileSync(join(complete.response.run_dir, "run.json"), "utf8"));
    assert.deepEqual({ branch: completeRun.branch, prBase: completeRun.pr_base, issue: completeRun.issue_key, mode: completeRun.mode, parallel: completeRun.max_parallel_slices }, {
      branch: "custom/branch", prBase: "main", issue: "ISSUE-1", mode: "autonomous", parallel: 1,
    });

    for (const policy of ["legacy", "sandbox", "both"]) {
      const policySource = operator(root, `policy-${policy}`);
      const policyRecord = recorder(join(root, `policy-recorder-${policy}`));
      const policyRun = `policy-${policy}`;
      const policySandbox = join(realpathSync(policySource), ".factory-sandboxes", policyRun);
      if (policy !== "sandbox") seedLegacyRun(policySource, policyRun, { branch: "main", pr_base: "main" });
      if (policy !== "legacy") {
        mkdirSync(policySandbox, { recursive: true });
        seedLegacyRun(policySandbox, policyRun, { branch: "main", pr_base: "main" });
      }
      const policyResult = invoke(policySource, ["init", policyRun, "--now", NOW], policyRecord);
      assert.equal(policyResult.ok, false);
      assert.match(policyResult.stderr, policy === "both" ? /ambiguous run/u : /already exists/u);
      assert.equal(clones(policyRecord).length, 0);
    }

    const external = join(root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "sentinel"), "external stays\n");
    const externalBefore = snapshot(external);
    const physicalCases = [
      { name: "factory-link", path: ".factory" },
      { name: "run-link", path: ".factory/run-link" },
      { name: "plan-link", path: ".factory/plan-link/plan" },
      { name: "artifacts-link", path: ".factory/artifacts-link/artifacts" },
      { name: "evidence-link", path: ".factory/evidence-link/evidence" },
      { name: "reviews-link", path: ".factory/reviews-link/reviews" },
      { name: "worktrees-link", path: ".factory/worktrees" },
      { name: "target-link", path: ".factory/worktrees/target-link" },
    ];
    for (const row of physicalCases) {
      const physicalSource = operator(root, `physical-${row.name}`, (repository) => {
        const path = join(repository, row.path);
        mkdirSync(dirname(path), { recursive: true });
        symlinkSync(external, path);
      });
      const physicalRecord = recorder(join(root, `physical-recorder-${row.name}`));
      const physical = invoke(physicalSource, ["init", row.name, "--now", NOW], physicalRecord);
      const physicalSandbox = join(physicalSource, ".factory-sandboxes", row.name);
      assert.equal(physical.ok, false, row.name);
      assert.match(physical.stderr, ["factory-link", "run-link"].includes(row.name)
        ? /requires '.factory\//u : /physical containment could not be proved/u);
      assert.match(physical.stderr, new RegExp(physicalSandbox.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.equal(clones(physicalRecord).length, ["factory-link", "run-link"].includes(row.name) ? 0 : 1);
      assert.equal(existsSync(join(physicalSandbox, ".factory", row.name, "run.json")), false);
      assert.deepEqual(snapshot(external), externalBefore);
      if (!["factory-link", "run-link"].includes(row.name)) assertClonePreserved(physicalRecord);
    }

    const escapeSource = operator(root, "worktree-escape", (repository) => symlinkSync(external, join(repository, "escape")));
    const escapeRecord = recorder(join(root, "escape-recorder"));
    const escape = invoke(escapeSource, ["init", "worktree-escape", "--worktree", "escape", "--pr-base", "main", "--now", NOW], escapeRecord);
    assert.equal(escape.ok, false);
    assert.match(escape.stderr, /physical containment could not be proved/u);
    assert.equal(clones(escapeRecord).length, 1);
    assert.deepEqual(snapshot(external), externalBefore);
    assertClonePreserved(escapeRecord);

    for (const [name, probe] of [["top-mismatch", "rev-parse --show-toplevel"], ["git-mismatch", "rev-parse --absolute-git-dir"], ["common-mismatch", "rev-parse --git-common-dir"]]) {
      const mismatchSource = operator(root, name);
      const mismatchRecord = recorder(join(root, `${name}-recorder`));
      const mismatchSandbox = join(realpathSync(mismatchSource), ".factory-sandboxes", name);
      const mismatch = invoke(mismatchSource, ["init", name, "--now", NOW], mismatchRecord, {
        MISMATCH_SANDBOX: mismatchSandbox, MISMATCH_PROBE: probe, MISMATCH_PATH: external,
      });
      assert.equal(mismatch.ok, false);
      assert.match(mismatch.stderr, /physical containment could not be proved/u);
      assert.equal(clones(mismatchRecord).length, 1);
      assert.equal(existsSync(join(mismatchSandbox, ".factory", name, "run.json")), false);
      assertClonePreserved(mismatchRecord);
    }

    const symlinkContainerSource = operator(root, "container-link");
    const symlinkContainerRecord = recorder(join(root, "container-recorder"));
    symlinkSync(external, join(symlinkContainerSource, ".factory-sandboxes"));
    const symlinkContainer = invoke(symlinkContainerSource, ["init", "container-link", "--now", NOW], symlinkContainerRecord);
    assert.equal(symlinkContainer.ok, false);
    assert.match(symlinkContainer.stderr, /requires '.factory-sandboxes\//u);
    assert.equal(clones(symlinkContainerRecord).length, 0);
    assert.deepEqual(snapshot(external), externalBefore);

    const fixtureSource = operator(root, "fixture");
    const fresh = initFresh(fixtureSource, ["fixture", "--now", NOW]);
    assert.equal(fresh.repository, fresh.sandboxPath);
    assert.equal(fresh.runDir, join(fresh.sandboxPath, ".factory", "fixture"));
    const legacySource = operator(root, "legacy");
    const legacy = seedLegacyRun(legacySource, "legacy", { branch: "main", pr_base: "main" });
    const legacyPath = join(legacy.runDir, "run.json");
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(legacyPath, "utf8")), "pr_draft"), false);
    const legacyJsonStatus = invoke(legacySource, ["status", "legacy", "--json"], recorder(join(root, "legacy-status-recorder")));
    assert.equal(legacyJsonStatus.response.pr_draft, true);
    const legacyPlainStatus = invoke(legacySource, ["status", "legacy"], recorder(join(root, "legacy-plain-recorder")));
    assert.match(legacyPlainStatus.stdout, /^pr_draft: true$/mu);
    const legacyTransition = invoke(legacySource, ["gate", "legacy", "story", "pending", "--now", NOW], recorder(join(root, "legacy-transition-recorder")));
    assert.equal(legacyTransition.ok, true, legacyTransition.stderr);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(legacyPath, "utf8")), "pr_draft"), false);
    const envelope = FAMILY_CONTRACTS.find(({ id }) => id === "envelope");
    assert.throws(() => envelope.validateTransition({ before: defaultRun, after: { ...defaultRun, pr_draft: false }, mode: "open" }), /envelope\.pr_draft is immutable/u);
    assert.equal(JSON.parse(readFileSync(legacyPath, "utf8")).run_id, "legacy");
    const missingBase = seedLegacyRun(legacySource, "legacy-missing-base", { branch: "main", pr_base: undefined });
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(missingBase.runDir, "run.json"), "utf8")), "pr_base"), false);
    const malformedRoot = join(root, "malformed-legacy");
    mkdirSync(malformedRoot);
    assert.throws(() => seedLegacyRun(malformedRoot, "malformed", { mode: "invalid", pr_base: undefined }), /run\.mode/u);
    assert.equal(existsSync(join(malformedRoot, ".factory")), false);

    const injectedInit = async (name, { branch = `feature/${name}`, base = "main", inject = () => null, prepare = () => null, publish = dispatchInitPublication } = {}) => {
      const sourceRepository = realpathSync(operator(root, `injected-${name}`));
      const sandboxPath = join(sourceRepository, ".factory-sandboxes", name);
      prepare(sourceRepository, branch);
      const calls = [];
      const effects = [];
      const result = (status, stdout = "") => ({ ok: status === 0, status, stdout, stderr: "", argv: [] });
      const operations = {
        cwd: () => sourceRepository, resolvePath: resolve, joinPath: join, realpath: realpathSync,
        lstat: (...args) => { effects.push("lstat"); return lstatSync(...args); },
        mkdir: (...args) => { effects.push("mkdir"); return mkdirSync(...args); },
        readdir: (...args) => { effects.push("readdir"); return readdirSync(...args); },
        runGit: (repository, args) => {
          calls.push({ repository, args: args.join(" ") });
          return inject({ repository, args: args.join(" "), sourceRepository, sandboxPath, result, calls }) ?? observeGit(repository, args);
        },
        prove: (...args) => { effects.push("prove"); return proveInitContainment(...args); },
        publish: (...args) => { effects.push("publish"); return publish(...args); },
      };
      const promise = dispatchInit([name], { repo: sourceRepository, branch, prBase: base, now: NOW }, operations);
      return { sourceRepository, sandboxPath, calls, effects, promise };
    };

    const ignoreSeamRows = [
      { name: "seam-missing", response: (result) => result(1) },
      { name: "seam-malformed", response: (result) => result(0, ".gitignore:1:.factory/ .factory/seam-malformed/run.json\n") },
      { name: "seam-multiline", response: (result) => result(0, ".gitignore:1:.factory/\t.factory/seam-multiline/run.json\nextra\n") },
      { name: "seam-wrong-probe", response: (result) => result(0, ".gitignore:1:.factory/\t.factory/other/run.json\n") },
    ];
    for (const row of ignoreSeamRows) {
      const observed = await injectedInit(row.name, { inject: ({ repository, args, sourceRepository, result }) =>
        repository === sourceRepository && args === `check-ignore -v --no-index -- .factory/${row.name}/run.json`
          ? row.response(result) : null });
      await assert.rejects(observed.promise, /requires '.factory\//u);
      assert.deepEqual(observed.effects, [], row.name);
      assert.deepEqual(observed.calls.map(({ args }) => args), [
        "rev-parse --show-toplevel",
        "ls-files --error-unmatch -- .gitignore",
        `check-ignore -v --no-index -- .factory/${row.name}/run.json`,
      ], row.name);
      assert.equal(existsSync(observed.sandboxPath), false, row.name);
    }
    for (const row of [
      { name: "seam-container-missing", probe: ".factory-sandboxes/" },
      { name: "seam-descendant-missing", probe: ".factory-sandboxes/seam-descendant-missing/.factory/seam-descendant-missing/run.json" },
    ]) {
      const sandboxSeam = await injectedInit(row.name, { inject: ({ repository, args, sourceRepository, result }) =>
        repository === sourceRepository && args === `check-ignore -v --no-index -- ${row.probe}` ? result(1) : null });
      await assert.rejects(sandboxSeam.promise, /add exactly '\/\.factory-sandboxes\/'/u);
      assert.deepEqual(sandboxSeam.effects, [], row.name);
      const expected = [
        "rev-parse --show-toplevel",
        "ls-files --error-unmatch -- .gitignore",
        `check-ignore -v --no-index -- .factory/${row.name}/run.json`,
        "check-ignore -v --no-index -- .factory-sandboxes/",
      ];
      if (row.name === "seam-descendant-missing") expected.push(`check-ignore -v --no-index -- ${row.probe}`);
      assert.deepEqual(sandboxSeam.calls.map(({ args }) => args), expected, row.name);
    }

    for (const row of [
      { name: "malformed-branch", branch: "bad..branch", match: /feature branch 'bad\.\.branch' is not a valid branch name/u },
      { name: "malformed-base", base: "bad..base", match: /PR base 'bad\.\.base' is not a valid branch name/u },
    ]) {
      const observed = await injectedInit(row.name, row);
      await assert.rejects(observed.promise, row.match);
      assert.equal(existsSync(observed.sandboxPath), false, row.name);
    }

    const collisionName = "pre-reserved-feature";
    const collisionBranch = `feature/${collisionName}`;
    const featureCollision = await injectedInit(collisionName, {
      prepare: (repository) => git(repository, "branch", collisionBranch),
    });
    await assert.rejects(featureCollision.promise, (error) => {
      assert.equal(error.message, `feature branch '${collisionBranch}' already exists at 'refs/heads/${collisionBranch}' in operator repository '${featureCollision.sourceRepository}'; restore the operator checkout to 'main', remove the colliding '${collisionBranch}' ref, and retry; sandbox path '${featureCollision.sandboxPath}' was not created`);
      return true;
    });
    assert.equal(existsSync(featureCollision.sandboxPath), false);
    assert.equal(existsSync(join(featureCollision.sandboxPath, ".factory", collisionName, "run.json")), false);

    const missingName = "missing-local-base";
    const absentBaseName = "not-local";
    const missingLocal = await injectedInit(missingName, { base: absentBaseName });
    await assert.rejects(missingLocal.promise, (error) => {
      assert.equal(error.message, `PR base '${absentBaseName}' does not name local ref 'refs/heads/${absentBaseName}' in operator repository '${missingLocal.sourceRepository}'; sandbox path '${missingLocal.sandboxPath}' was not created`);
      return true;
    });
    assert.equal(existsSync(missingLocal.sandboxPath), false);
    assert.equal(existsSync(join(missingLocal.sandboxPath, ".factory", missingName, "run.json")), false);

    const operatorRows = [
      { name: "feature-lookup-failure", target: "feature", status: 2, description: "feature branch ref", ref: (name) => `refs/heads/feature/${name}` },
      { name: "base-lookup-unavailable", target: "base", status: "nonnumeric", description: "PR base ref", ref: () => "refs/heads/main" },
    ];
    for (const row of operatorRows) {
      const observed = await injectedInit(row.name, { inject: ({ repository, args, sourceRepository, result }) =>
        repository === sourceRepository && args.startsWith("show-ref ")
          && ((row.target === "feature" && args.includes(`feature/${row.name}`)) || (row.target === "base" && args.endsWith("refs/heads/main")))
          ? result(row.status) : null });
      await assert.rejects(observed.promise, (error) => {
        assert.equal(error.message, `could not observe ${row.description} '${row.ref(row.name)}' in repository '${observed.sourceRepository}'`);
        return true;
      });
      assert.equal(existsSync(observed.sandboxPath), false, row.name);
      assert.equal(existsSync(join(observed.sandboxPath, ".factory", row.name, "run.json")), false, row.name);
    }

    const exactRows = [
      { name: "exact-absence", inject: ({ repository, args, sandboxPath, result }) => repository === sandboxPath && args.startsWith("show-ref ") ? result(1) : null,
        message: ({ sandboxPath }) => `PR base 'main' could not be resolved from ${["refs/heads/main", "refs/remotes/origin/main"].map((ref) => `'${ref}'`).join(" or ")} in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent` },
      { name: "numeric-lookup-failure", inject: ({ repository, args, sandboxPath, result }) => repository === sandboxPath && args.endsWith("refs/remotes/origin/main") ? result(7) : null,
        message: ({ sandboxPath }) => `could not observe PR base ref 'refs/remotes/origin/main' in repository '${sandboxPath}'; sandbox was retained; run.json is absent` },
      { name: "unpeelable", inject: ({ repository, args, sandboxPath, result }) => repository === sandboxPath && args.includes("refs/remotes/origin/main^{commit}") ? result(7) : null,
        message: ({ sandboxPath }) => `PR base ref 'refs/remotes/origin/main' could not be peeled to one commit in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent` },
      { name: "malformed-peel", inject: ({ repository, args, sandboxPath, result }) => repository === sandboxPath && args.includes("refs/remotes/origin/main^{commit}") ? result(0, "not-an-oid\n") : null,
        message: ({ sandboxPath }) => `PR base ref 'refs/remotes/origin/main' could not be peeled to one commit in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent` },
      { name: "unavailable-peel", inject: ({ repository, args, sandboxPath, result }) => repository === sandboxPath && args.includes("refs/remotes/origin/main^{commit}") ? result(null) : null,
        message: ({ sandboxPath }) => `could not observe commit for PR base ref 'refs/remotes/origin/main' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent` },
      { name: "divergent", inject: ({ repository, args, sandboxPath, result }) => repository === sandboxPath && args.startsWith("show-ref ") ? result(0) : repository === sandboxPath && args.includes("refs/heads/main^{commit}") ? result(0, `${"1".repeat(40)}\n`) : repository === sandboxPath && args.includes("refs/remotes/origin/main^{commit}") ? result(0, `${"2".repeat(40)}\n`) : null,
        message: ({ sandboxPath }) => `PR base 'main' resolves to different commits at 'refs/heads/main' and 'refs/remotes/origin/main' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent` },
    ];
    for (const row of exactRows) {
      const observed = await injectedInit(row.name, row);
      await assert.rejects(observed.promise, (error) => {
        assert.equal(error.message, row.message(observed));
        return true;
      });
      assert.equal(existsSync(observed.sandboxPath), true, row.name);
      assert.equal(existsSync(join(observed.sandboxPath, ".factory", row.name, "run.json")), false, row.name);
    }

    const classification = await injectedInit("classify-before-peel", { inject: ({ repository, args, sandboxPath, result }) => {
      if (repository !== sandboxPath || !args.startsWith("show-ref ")) return null;
      return args.endsWith("refs/heads/main") ? result(0) : result("nonnumeric");
    } });
    await assert.rejects(classification.promise, (error) => {
      assert.equal(error.message, `could not observe PR base ref 'refs/remotes/origin/main' in repository '${classification.sandboxPath}'; sandbox was retained; run.json is absent`);
      return true;
    });
    assert.equal(existsSync(classification.sandboxPath), true);
    assert.equal(existsSync(join(classification.sandboxPath, ".factory", "classify-before-peel", "run.json")), false);
    assert.equal(classification.calls.some(({ repository, args }) => repository === classification.sandboxPath && args.startsWith("rev-parse --verify")), false);

    const equalSource = realpathSync(operator(root, "injected-equal-dual"));
    const equalOid = git(equalSource, "rev-parse", "main^{commit}");
    git(equalSource, "remote", "add", "origin", equalSource);
    const equalName = "equal-dual";
    const equalSandbox = join(equalSource, ".factory-sandboxes", equalName);
    const equal = await dispatchInit([equalName], { repo: equalSource, branch: `feature/${equalName}`, prBase: "main", now: NOW }, {
      cwd: () => equalSource, resolvePath: resolve, joinPath: join, realpath: realpathSync, lstat: lstatSync,
      mkdir: mkdirSync, readdir: readdirSync, prove: proveInitContainment, publish: dispatchInitPublication,
      runGit: (repository, args) => repository === equalSandbox && args[0] === "show-ref"
        ? { ok: true, status: 0, stdout: "", stderr: "" }
        : repository === equalSandbox && args[0] === "rev-parse" && args.at(-1).endsWith("main^{commit}")
          ? { ok: true, status: 0, stdout: `${equalOid}\n`, stderr: "" } : observeGit(repository, args),
    });
    assert.equal(equal.branch, `feature/${equalName}`);
    assert.equal(git(equalSandbox, "rev-parse", "HEAD^{commit}"), equalOid);

    for (const row of [
      { name: "head", command: "git switch --detach --quiet" },
      { name: "oid", command: "git -c user.name=Factory -c user.email=factory@example.test commit --allow-empty --quiet -m moved" },
      { name: "reflog", command: "git reflog expire --expire=now --all" },
    ]) {
      const bootstrapSource = operator(root, `invariant-${row.name}`, (repository) => writeFileSync(join(repository, ".factory.json"), `${JSON.stringify({ resolve: "true", verify: "true", publish: "true", publishing_identity: "test", bootstrap: row.command })}\n`));
      const observed = invoke(bootstrapSource, ["init", `invariant-${row.name}`, "--pr-base", "main", "--now", NOW], recorder(join(root, `invariant-${row.name}-recorder`)));
      assert.equal(observed.ok, false, row.name);
      assert.match(observed.stderr, /sandbox .* was retained; run\.json is absent/u, row.name);
    }

    const raced = await injectedInit("final-race", { publish: async (input) => {
      observeGit(dirname(dirname(input.sandboxPath)), ["branch", "feature/final-race", "main"]);
      return dispatchInitPublication(input);
    } });
    await assert.rejects(raced.promise, /appeared at 'refs\/heads\/feature\/final-race'.*run\.json is absent/u);
    assert.equal(existsSync(join(raced.sandboxPath, ".factory", "final-race", "run.json")), false);

    const configuredCommand = "node -e \"const f=require('fs');if(f.existsSync('.factory/configured-bootstrap/run.json'))process.exit(9);f.appendFileSync('bootstrap-count','x');f.writeFileSync('bootstrap-cwd',process.cwd());f.writeFileSync('bootstrap-env',process.env.FACTORY_BOOTSTRAP_ENV_MARKER??'');f.writeFileSync('bootstrap-stdin',f.readFileSync(0,'utf8'));f.mkdirSync('node_modules',{recursive:true});console.log('bootstrap-out');console.error('bootstrap-err')\"";
    const configuredSource = operator(root, "configured-bootstrap", (repository) => {
      writeFileSync(join(repository, ".factory.json"), `${JSON.stringify({
        resolve: "true", verify: "true", publish: "true", publishing_identity: "test",
        pr_draft: false, bootstrap: configuredCommand, bootstrap_timeout_ms: 120000,
      }, null, 2)}\n`);
    });
    const configuredRecord = recorder(join(root, "configured-recorder"));
    // Unlike the default invoke helper this gives the CLI a concrete stdin marker. Bootstrap
    // can only copy it when its child uses inherited fd 0, and the environment marker likewise
    // distinguishes inherited process.env from a reconstructed environment.
    const configuredProcess = spawnSync(process.execPath, [CLI, "init", "configured-bootstrap", "--now", NOW, "--json", "--repo", configuredSource], {
      encoding: "utf8", input: "bootstrap-stdin-marker\n", stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv({
        PATH: `${configuredRecord.bin}:${process.env.PATH}`, GIT_LOG: configuredRecord.log, REAL_GIT,
        FACTORY_BOOTSTRAP_ENV_MARKER: "bootstrap-environment-marker",
      }),
    });
    const configured = {
      ok: configuredProcess.status === 0,
      stdout: String(configuredProcess.stdout ?? ""), stderr: String(configuredProcess.stderr ?? configuredProcess.error?.message ?? ""),
      response: JSON.parse(String(configuredProcess.stdout ?? "")),
    };
    assert.equal(configured.ok, true, configured.stderr);
    assert.deepEqual(JSON.parse(configured.stdout), configured.response, "init --json stdout remains exactly one JSON object");
    assert.match(configured.stderr, /bootstrap-out/u);
    assert.match(configured.stderr, /bootstrap-err/u);
    assert.equal(readFileSync(join(configured.response.sandbox_path, "bootstrap-count"), "utf8"), "x");
    assert.equal(readFileSync(join(configured.response.sandbox_path, "bootstrap-cwd"), "utf8"), configured.response.sandbox_path);
    assert.equal(readFileSync(join(configured.response.sandbox_path, "bootstrap-env"), "utf8"), "bootstrap-environment-marker");
    assert.equal(readFileSync(join(configured.response.sandbox_path, "bootstrap-stdin"), "utf8"), "bootstrap-stdin-marker\n");
    assert.equal(existsSync(join(configured.response.sandbox_path, "node_modules")), true, "untracked dependency output is compatible");
    const configuredRun = JSON.parse(readFileSync(join(configured.response.run_dir, "run.json"), "utf8"));
    assert.deepEqual(Object.fromEntries(Object.entries(configuredRun)
      .filter(([key]) => key.startsWith("bootstrap_"))), { bootstrap_command: configuredCommand, bootstrap_exit: 0 });
    assert.equal(configuredRun.pr_draft, false);
    const configuredJsonStatus = invoke(configured.response.sandbox_path, ["status", "configured-bootstrap", "--json"], configuredRecord);
    assert.equal(configuredJsonStatus.response.pr_draft, false);
    const configuredPlainStatus = invoke(configured.response.sandbox_path, ["status", "configured-bootstrap"], configuredRecord);
    assert.match(configuredPlainStatus.stdout, /^pr_draft: false$/mu);

    const failureCases = [
      { name: "dirty", command: "node -e \"const f=require('fs');f.appendFileSync('bootstrap-attempt-count','x');f.writeFileSync('tracked dirty.txt','changed');process.exit(7)\"", timeout: 120000, match: /left tracked paths dirty after init: "tracked dirty\.txt"/u, attempts: 1 },
      { name: "staged", command: "node -e \"const f=require('fs');f.appendFileSync('bootstrap-attempt-count','x');f.writeFileSync('tracked dirty.txt','staged');require('child_process').execFileSync('git',['add','tracked dirty.txt'])\"", timeout: 120000, match: /left tracked paths dirty after init: "tracked dirty\.txt"/u, attempts: 1 },
      { name: "unobservable", command: "node -e \"const f=require('fs');f.appendFileSync('bootstrap-attempt-count','x');f.renameSync('.git','.git-gone');process.exit(7)\"", timeout: 120000, match: /could not observe tracked paths after init/u, attempts: 1 },
      // Review finding on #263: the post-bootstrap guard re-proved branch/ref/reflog state but not
      // physical containment. This bootstrap moves `.git` out of the sandbox and leaves a gitdir
      // pointer behind, so git keeps answering every logical question correctly -- HEAD, the branch,
      // its reflog, and tracked cleanliness are all intact and observable -- while Git administration
      // now lives outside S. Distinct from `unobservable`, which breaks git entirely and is caught by
      // the cleanliness check; this one is green everywhere except the physical proof.
      { name: "gitdir", command: "node -e \"const f=require('fs'),p=require('path');f.appendFileSync('bootstrap-attempt-count','x');const out=p.join(p.dirname(process.cwd()),'escaped-'+p.basename(process.cwd()));f.renameSync('.git',out);f.writeFileSync('.git','gitdir: '+out+'\\n')\"", timeout: 120000, match: /physical containment could not be re-proved for sandbox/u, attempts: 1 },
      { name: "throw", command: "bootstrap-throw-secret\0", timeout: 120000, match: /failed during init; exit status unavailable/u, hidden: "bootstrap-throw-secret", attempts: 0 },
      { name: "exit", command: "node -e \"require('fs').appendFileSync('bootstrap-attempt-count','x');process.exit(7)\"", timeout: 120000, match: /failed during init with exit status 7/u, attempts: 1 },
      { name: "timeout", command: "node -e \"require('fs').appendFileSync('bootstrap-attempt-count','x');setTimeout(()=>{},10000)\"", timeout: 1000, match: /failed during init; exit status unavailable/u, attempts: 1 },
    ];
    for (const row of failureCases) {
      const failedBootstrapSource = operator(root, `bootstrap-${row.name}`, (repository) => {
        writeFileSync(join(repository, "tracked dirty.txt"), "clean\n");
        writeFileSync(join(repository, ".factory.json"), `${JSON.stringify({
          resolve: "true", verify: "true", publish: "true", publishing_identity: "test",
          bootstrap: row.command, bootstrap_timeout_ms: row.timeout,
        })}\n`);
      });
      const failedBootstrapRecord = recorder(join(root, `bootstrap-${row.name}-recorder`));
      const observed = invoke(failedBootstrapSource, ["init", `bootstrap-${row.name}`, "--now", NOW, "--json"], failedBootstrapRecord);
      assert.equal(observed.ok, false, row.name);
      assert.equal(observed.stdout, "", row.name);
      assert.match(observed.stderr, row.match, row.name);
      if (row.hidden) assert.doesNotMatch(observed.stderr, new RegExp(row.hidden, "u"), "spawn refusals must not expose command text");
      assert.match(observed.stderr, /sandbox .* was retained; run\.json is absent/u, row.name);
      assert.equal(existsSync(join(failedBootstrapSource, ".factory-sandboxes", `bootstrap-${row.name}`, ".factory", `bootstrap-${row.name}`, "run.json")), false);
      const attempts = join(failedBootstrapSource, ".factory-sandboxes", `bootstrap-${row.name}`, "bootstrap-attempt-count");
      assert.equal(existsSync(attempts), row.attempts === 1, `${row.name}: executable bootstrap must leave one attempt marker`);
      if (row.attempts === 1) assert.equal(readFileSync(attempts, "utf8"), "x", `${row.name}: bootstrap failure and timeout have no retry`);
    }

    const truePolicySource = operator(root, "config-pr-draft-true", (repository) => writeFileSync(join(repository, ".factory.json"), `${JSON.stringify({
      resolve: "true", verify: "true", publish: "true", publishing_identity: "test", pr_draft: true,
    })}\n`));
    const truePolicy = invoke(truePolicySource, ["init", "config-pr-draft-true", "--now", NOW, "--json"], recorder(join(root, "config-pr-draft-true-recorder")));
    assert.equal(truePolicy.ok, true, truePolicy.stderr);
    assert.equal(JSON.parse(readFileSync(join(truePolicy.response.run_dir, "run.json"), "utf8")).pr_draft, true);

    const configCases = [
      { name: "unknown", patch: { unexpected: true, pr_draft: "draft", bootstrap: 7, bootstrap_timeout_ms: 0 }, named: [] },
      ...[null, 0, "false", [], {}].map((pr_draft, index) => ({ name: `pr-draft-${index}`, patch: { pr_draft, resolve: null, bootstrap_timeout_ms: 0 }, named: ["pr_draft"] })),
      { name: "invalid-both", patch: { resolve: null, bootstrap: 7, bootstrap_timeout_ms: 0 }, named: ["bootstrap"] },
      { name: "invalid-with-timeout", patch: { bootstrap: " ", bootstrap_timeout_ms: 10 }, named: ["bootstrap"] },
      { name: "orphan", patch: { bootstrap_timeout_ms: 10 }, named: ["bootstrap_timeout_ms"] },
      { name: "invalid-orphan", patch: { bootstrap_timeout_ms: 0 }, named: ["bootstrap_timeout_ms"] },
      { name: "invalid-timeout", patch: { bootstrap: "true", bootstrap_timeout_ms: 0 }, named: ["bootstrap_timeout_ms"] },
    ];
    for (const row of configCases) {
      const configSource = operator(root, `config-${row.name}`, (repository) => writeFileSync(join(repository, ".factory.json"), `${JSON.stringify({
        resolve: "true", verify: "true", publish: "true", publishing_identity: "test", ...row.patch,
      })}\n`));
      const configRecord = recorder(join(root, `config-${row.name}-recorder`));
      const observed = invoke(configSource, ["init", `config-${row.name}`, "--now", NOW], configRecord);
      assert.equal(observed.ok, false, row.name);
      assert.deepEqual([...observed.stderr.matchAll(/entry '([^']+)'/gu)].map((match) => match[1]), row.named, row.name);
      assert.equal(existsSync(join(configSource, ".factory-sandboxes", `config-${row.name}`, ".factory", `config-${row.name}`, "run.json")), false);
    }

    const resolutionCommand = "node bootstrap.js";
    const resolutionSource = operator(root, "resolution", (repository) => {
      writeFileSync(join(repository, "bootstrap.js"), "const f=require('fs'),c=require('child_process');f.writeFileSync('pre-resolution',require.resolve('workspace-only'));f.mkdirSync('node_modules/workspace-only',{recursive:true});f.writeFileSync('node_modules/workspace-only/index.js','module.exports=\\\"sandbox\\\"');f.writeFileSync('post-resolution',c.execFileSync(process.execPath,['-p',\"require.resolve('workspace-only')\"],{encoding:'utf8'}).trim());\n");
      writeFileSync(join(repository, "verify.js"), "const p=require('path');if(!require.resolve('workspace-only').startsWith(process.cwd()+p.sep)||require('workspace-only')!=='sandbox')process.exit(1);\n");
      writeFileSync(join(repository, ".factory.json"), `${JSON.stringify({ resolve: "true", verify: "node verify.js", publish: "true", publishing_identity: "test", bootstrap: resolutionCommand })}\n`);
    });
    mkdirSync(join(resolutionSource, "node_modules", "workspace-only"), { recursive: true });
    writeFileSync(join(resolutionSource, "node_modules", "workspace-only", "index.js"), "module.exports='parent';\n");
    const resolutionRecord = recorder(join(root, "resolution-recorder"));
    const resolution = invoke(resolutionSource, ["init", "resolution", "--now", NOW, "--json"], resolutionRecord);
    assert.equal(resolution.ok, true, resolution.stderr);
    assert.equal(readFileSync(join(resolution.response.sandbox_path, "pre-resolution"), "utf8").startsWith(`${realpathSync(resolutionSource)}/node_modules/`), true);
    assert.equal(readFileSync(join(resolution.response.sandbox_path, "post-resolution"), "utf8").startsWith(`${resolution.response.sandbox_path}/node_modules/`), true);
    execFileSync(process.execPath, [join(resolution.response.sandbox_path, "verify.js")], { cwd: resolution.response.sandbox_path });
    const bootstrapSpawns = [];
    for (const timeoutMs of [undefined, 123456]) {
      assert.equal(runBootstrap(resolution.response.sandbox_path, "declared command", timeoutMs, {
        runner: (command, args, options) => { bootstrapSpawns.push({ command, args, options }); return { status: 0 }; },
      }), 0);
    }
    assert.deepEqual(bootstrapSpawns.map(({ command, args, options }) => ({ command, args, timeout: options.timeout, shell: options.shell,
      cwd: options.cwd, stdout: options.stdio[1], stderr: options.stdio[2] })), [
      { command: "declared command", args: [], timeout: 900000, shell: true, cwd: resolution.response.sandbox_path, stdout: process.stderr, stderr: process.stderr },
      { command: "declared command", args: [], timeout: 123456, shell: true, cwd: resolution.response.sandbox_path, stdout: process.stderr, stderr: process.stderr },
    ]);

    const initSource = readFileSync(join(pkg, "bin", "factory.js"), "utf8");
    const dispatchBody = initSource.slice(initSource.indexOf("export async function dispatchInit"), initSource.indexOf("\nfunction preflightInit"));
    const observeSource = readFileSync(join(pkg, "observe", "index.js"), "utf8");
    const proofBody = observeSource.slice(observeSource.indexOf("export function proveInitContainment"), observeSource.indexOf("\nfunction summarize"));
    const publicationBody = readFileSync(join(pkg, "bin", "init-publication.js"), "utf8");
    const ownedProduction = [initSource, proofBody, publicationBody].join("\n");
    assert.equal((dispatchBody.match(/\["clone", "--local", "--", operatorRoot, S\]/gu) ?? []).length, 1);
    // The publication guard must be the containment-inclusive one. Pinning the wiring by name is
    // what caught the #263 review finding's fix going in: `proveBranch` alone re-proves branch, ref
    // and reflog state, all of which survive a `.git` relocated outside the sandbox.
    assert.match(dispatchBody, /await dispatchInitPublication\(\{ runDir, sandboxPath: S, candidate: run, finalGuard: proveContainedBranch \}\)/u);
    assert.doesNotMatch(dispatchBody, /finalGuard: proveBranch\b/u);
    // The post-bootstrap guard is the same containment-inclusive one, and the only bare `proveBranch()`
    // call is the pre-bootstrap one, where physical containment was proved moments earlier with only
    // `git switch` in between.
    assert.equal((dispatchBody.match(/^ {2}proveContainedBranch\(\);$/gmu) ?? []).length, 1);
    assert.equal((dispatchBody.match(/^ {2}proveBranch\(\);$/gmu) ?? []).length, 1);
    assert.match(initSource, /^\/\/ Enforcement, following the #277 seed-guard precedent: an unignored control plane cannot complete a factory run\.$/mu);
    assert.match(initSource, /runGit\(operatorRoot, \["ls-files", "--error-unmatch", "--", "\.gitignore"\]\)/u);
    assert.match(initSource, /runGit\(operatorRoot, \["check-ignore", "-v", "--no-index", "--", probe\]\)/u);
    assert.doesNotMatch(initSource, /check-ignore[^\n]*"-z"/u);
    assert.doesNotMatch(ownedProduction, /--no-hardlinks|\b(?:copyFile|cp|rm|rmSync|rmdir|unlink|unlinkSync)\s*\(|staging path|quarantine|ownership (?:record|evidence)|attempt-numbered/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
