import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkg, "bin", "factory.js");

function filesUnder(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) filesUnder(path, found);
    else if ([".js", ".mjs", ".cjs", ".json"].some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function factory(repository, ...args) {
  return JSON.parse(execFileSync("node", [cli, ...args, "--repo", repository, "--json"], { encoding: "utf8" }));
}

test("AC2/AC3/AC8/AC11/AC13/AC14 relocate state and slices while preserving proof contracts", () => {
  const skill = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
  for (const fragment of [
    "P = S/.factory/R",
    "W = S/.factory/worktrees/R",
    "every slice worktree is `W/<slice-id>`",
    "every slice branch is `factory/R/<slice-id>`",
    "git -C \"$S\" worktree add -b \"$SLICE_BRANCH\" \"$SLICE_WORKTREE\" \"$FEATURE_BRANCH\"",
    "require both `refs/heads/$SLICE_BRANCH` and the\n`SLICE_WORKTREE` path to be absent",
    "must record exactly `W/<slice-id>` and `factory/R/<slice-id>`",
    "`git -C \"$S\" worktree list --porcelain` to associate that physical path with that exact branch",
    "an unrecorded existing path or ref is a collision",
    "--worktree \"$SLICE_WORKTREE\" --base \"$SLICE_BASE_REF\"",
    "`base_ref` is fixed when the slice is activated and cannot be changed afterwards",
    "existing `resolveWorktree` containment check",
    "outside the seeded ownership paths",
    "seeded test plan's evidence and the bound review",
    "merge --no-ff \"$SLICE_BRANCH\"",
    "refuses a merge commit that does not have exactly two parents",
    "**A moved base is fine.**",
    "A `blocked`, `partial`, or `needs-human` run retains `S`",
    "stale nonterminal locks retain it",
    "Nothing removes any of those sandboxes automatically.",
    "report `sandbox_path` as the resolved selected repository",
    "reports `dead_lock: true` only when the run is nonterminal and its lock is stale",
  ]) assert.ok(skill.includes(fragment), `state-relocation contract is missing: ${fragment}`);

  const shell = [...skill.matchAll(/```sh\n([\s\S]*?)```/gu)].map(([, body]) => body).join("\n").replace(/\\\n\s*/gu, " ");
  const invocations = shell.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("factory "));
  assert.ok(invocations.length >= 20, `expected fully qualified factory examples, found ${invocations.length}`);
  for (const invocation of invocations) {
    assert.match(invocation, /^factory [a-z-]+\s/u, `factory invocation is not command-first: ${invocation}`);
    assert.match(invocation, /--repo "\$(?:S|RUN_REPO|O)"$/u, `factory invocation lacks a trailing selected repository: ${invocation}`);
  }

  const sourceFiles = filesUnder(pkg);
  const productionLines = sourceFiles.filter((path) => !path.includes(`${pkg}/test/`))
    .reduce((total, path) => total + readFileSync(path, "utf8").split("\n").length, 0);
  assert.equal(productionLines, 2665, "AC8 production must remain exactly 2665 lines under the approved ceiling");
  assert.equal(readFileSync(cli, "utf8").split("\n").length - 1, 702, "AC14 factory.js must gain zero physical lines");

  const repository = mkdtempSync(join(tmpdir(), "factory-state-relocation-"));
  try {
    git(repository, "init", "--quiet", "--initial-branch=main");
    git(repository, "config", "user.name", "Factory Test");
    git(repository, "config", "user.email", "factory@example.test");
    writeFileSync(join(repository, "tracked.txt"), "state relocation\n");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "--quiet", "-m", "fixture");

    const initialized = factory(repository, "init", "state-relocation", "--branch", "feature/state-relocation", "--pr-base", "main");
    assert.equal(initialized.sandbox_path, resolve(repository));
    const active = factory(repository, "status", "state-relocation");
    assert.equal(active.sandbox_path, resolve(repository));
    assert.equal(active.dead_lock, false);
    assert.equal(factory(repository, "status", "missing").sandbox_path, resolve(repository));

    const runDirectory = join(repository, ".factory", "state-relocation");
    const run = JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8"));
    assert.equal(Object.hasOwn(run, "sandbox_path"), false, "AC14 sandbox_path must be output-only");
    assert.equal(Object.hasOwn(run, "dead_lock"), false, "AC13 dead_lock must be output-only");
    writeFileSync(join(runDirectory, "factory.lock"), `${JSON.stringify({
      session: "dead-session",
      pid: 1234,
      run_id: "state-relocation",
      branch: "feature/state-relocation",
      claimed_at: "2020-01-01T00:00:00.000Z",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
    })}\n`);
    assert.equal(factory(repository, "status", "state-relocation").dead_lock, true, "AC13 stale nonterminal lock must be reported dead");
    factory(repository, "terminal", "state-relocation", "blocked", "--reason", "fixture blocked");
    const terminal = factory(repository, "status", "state-relocation");
    assert.equal(terminal.dead_lock, false, "AC11 terminal retained sandbox must not report a dead nonterminal lock");
    assert.equal(terminal.sandbox_path, resolve(repository));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
