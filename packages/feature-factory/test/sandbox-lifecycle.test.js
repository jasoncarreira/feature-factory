import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchInit } from "../bin/factory.js";
import { initFresh, seedLegacyRun } from "./init-fixture.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(pkg, "bin", "factory.js");
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
  try {
    const command = [CLI, ...args, ...(args.includes("--repo") ? [] : ["--repo", repository])];
    const stdout = execFileSync(process.execPath, command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${record.bin}:${process.env.PATH}`, GIT_LOG: record.log, REAL_GIT, ...extra },
    });
    return { ok: true, stdout, response: args.includes("--json") ? JSON.parse(stdout) : null };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? error.message) };
  }
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
    assert.deepEqual(Object.keys(result.response), ["run_id", "run_dir", "sandbox_path", "branch", "worktree", "pr_base", "status", "mode"]);
    assert.equal(result.response.sandbox_path, sandbox);
    assert.equal(result.response.run_dir, join(sandbox, ".factory", runId));
    assert.equal(realpathSync(sandbox), sandbox);
    assert.equal(clones(record).length, 1);
    assert.deepEqual(clones(record)[0].args, ["clone", "--local", "--", realpathSync(source), sandbox]);
    assert.deepEqual({ exists: clones(record)[0].exists, empty: clones(record)[0].empty }, { exists: true, empty: true });
    const objectId = git(source, "rev-parse", "HEAD:tracked.txt");
    const sourceObject = join(source, ".git", "objects", objectId.slice(0, 2), objectId.slice(2));
    const sandboxObject = join(sandbox, ".git", "objects", objectId.slice(0, 2), objectId.slice(2));
    assert.deepEqual({ dev: statSync(sandboxObject).dev, ino: statSync(sandboxObject).ino }, { dev: statSync(sourceObject).dev, ino: statSync(sourceObject).ino });
    for (const path of ["plan", "artifacts", "evidence", "reviews"]) assert.equal(realpathSync(join(result.response.run_dir, path)), join(result.response.run_dir, path));
    assert.equal(realpathSync(join(sandbox, ".factory", "worktrees", runId)), join(sandbox, ".factory", "worktrees", runId));

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
      assert.match(unsafe.stderr, kind === "file" ? /regular file/u : /symbolic link/u);
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
    const complete = invoke(completeSource, [
      "init", "complete-scalars", "--branch", "custom/branch", "--worktree", ".", "--pr-base", "main",
      "--issue", "ISSUE-1", "--mode", "autonomous", "--max-parallel-slices", "1", "--max-retries", "1", "--now", NOW, "--json",
    ], completeRecord);
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
      assert.match(physical.stderr, /physical containment could not be proved/u);
      assert.match(physical.stderr, new RegExp(physicalSandbox.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.equal(clones(physicalRecord).length, 1);
      assert.equal(existsSync(join(physicalSandbox, ".factory", row.name, "run.json")), false);
      assert.deepEqual(snapshot(external), externalBefore);
      assertClonePreserved(physicalRecord);
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
    assert.equal(clones(symlinkContainerRecord).length, 0);
    assert.deepEqual(snapshot(external), externalBefore);

    const fixtureSource = operator(root, "fixture");
    const fresh = initFresh(fixtureSource, ["fixture", "--now", NOW]);
    assert.equal(fresh.repository, fresh.sandboxPath);
    assert.equal(fresh.runDir, join(fresh.sandboxPath, ".factory", "fixture"));
    const legacySource = operator(root, "legacy");
    const legacy = seedLegacyRun(legacySource, "legacy", { branch: "main", pr_base: "main" });
    assert.equal(JSON.parse(readFileSync(join(legacy.runDir, "run.json"), "utf8")).run_id, "legacy");
    const missingBase = seedLegacyRun(legacySource, "legacy-missing-base", { branch: "main", pr_base: undefined });
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(missingBase.runDir, "run.json"), "utf8")), "pr_base"), false);
    const malformedRoot = join(root, "malformed-legacy");
    mkdirSync(malformedRoot);
    assert.throws(() => seedLegacyRun(malformedRoot, "malformed", { mode: "invalid", pr_base: undefined }), /run\.mode/u);
    assert.equal(existsSync(join(malformedRoot, ".factory")), false);

    const initSource = readFileSync(join(pkg, "bin", "factory.js"), "utf8");
    const dispatchBody = initSource.slice(initSource.indexOf("export async function dispatchInit"), initSource.indexOf("\nfunction preflightInit"));
    const observeSource = readFileSync(join(pkg, "observe", "index.js"), "utf8");
    const proofBody = observeSource.slice(observeSource.indexOf("export function proveInitContainment"), observeSource.indexOf("\nfunction summarize"));
    const publicationBody = readFileSync(join(pkg, "bin", "init-publication.js"), "utf8");
    const ownedProduction = [initSource, proofBody, publicationBody].join("\n");
    assert.equal((dispatchBody.match(/\["clone", "--local", "--", operatorRoot, S\]/gu) ?? []).length, 1);
    assert.match(dispatchBody, /await dispatchInitPublication\(\{ runDir, sandboxPath: S, candidate: run \}\)/u);
    assert.doesNotMatch(ownedProduction, /--no-hardlinks|\b(?:copyFile|cp|rm|rmSync|rmdir|unlink|unlinkSync)\s*\(|staging path|quarantine|ownership (?:record|evidence)|attempt-numbered/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
