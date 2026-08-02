import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(resolve(pkg, "skills", "feature", "SKILL.md"), "utf8");
const step0 = skill.slice(
  skill.indexOf("## Step 0 — Intake, run id, lock, manifest"),
  skill.indexOf("### Gate 1 — Story"),
);

function position(fragment) {
  const index = step0.indexOf(fragment);
  assert.notEqual(index, -1, `AC1/AC3/AC4 sandbox contract is missing: ${fragment}`);
  return index;
}

function factoryInvocations(markdown) {
  return [...markdown.matchAll(/(?:^|`)(factory\s+[a-z-]+\s+[^`\n]+)(?=`|$)/gmu)]
    .map(([, invocation]) => invocation.trim());
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`);
}

// This is deliberately a small executable model of the shell sequence the skill directs.  The
// factory is an agent skill rather than a bootstrap binary, so real Git operations plus the skill's
// exact command/order assertions below are the boundary that can prove the destructive sequence.
function bootstrapWithInjectedHardlinkFailure({ operator, sandbox, runId, dispatch }) {
  const container = dirname(sandbox);
  const plane = join(sandbox, ".factory", runId);
  const worktrees = join(sandbox, ".factory", "worktrees", runId);
  const events = [];
  const seed = git(operator, "rev-parse", "--verify", "HEAD^{commit}");
  const pushTarget = git(operator, "remote", "get-url", "--push", "origin");
  let attempts = 0;
  let containmentProven = false;
  mkdirSync(container);

  const clone = (noHardlinks) => {
    attempts += 1;
    events.push(noHardlinks ? "clone:no-hardlinks" : "clone:hardlinks");
    if (!noHardlinks) {
      mkdirSync(sandbox);
      writeFileSync(join(sandbox, "partial"), "only this attempt may remove me\n");
      const error = new Error("fatal: failed to create link");
      error.stderr = "fatal: failed to create link";
      throw error;
    }
    assert.equal(existsSync(sandbox), false, "AC4 partial sandbox must be removed before the sole fallback clone");
    execFileSync("git", ["clone", "--local", "--no-hardlinks", operator, sandbox], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    });
  };

  try {
    clone(false);
  } catch (error) {
    assert.match(error.stderr, /failed to create link/u, "AC4 only the hardlink failure admits fallback");
    assert.equal(existsSync(join(sandbox, "partial")), true, "AC4 fixture must create the invocation partial sandbox");
    rmSync(sandbox, { recursive: true });
    events.push("remove:partial");
    clone(true);
  }
  assert.equal(attempts, 2, "AC4 allows one initial hardlink attempt and exactly one fallback");

  git(sandbox, "config", "--replace-all", "remote.origin.pushurl", pushTarget);
  assert.equal(git(sandbox, "remote", "get-url", "--push", "origin"), pushTarget,
    "AC3 effective push proof completes before containment and dispatch");
  const canonicalSandbox = realpathSync(sandbox);
  assert.equal(realpathSync(git(sandbox, "rev-parse", "--show-toplevel")), canonicalSandbox,
    "AC3 clone top level must be exactly S");
  assert.equal(realpathSync(git(sandbox, "rev-parse", "--absolute-git-dir")), join(canonicalSandbox, ".git"),
    "AC3 clone Git dir must be S/.git");
  mkdirSync(plane, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  assert.equal(inside(realpathSync(plane), canonicalSandbox), true, "AC2 P must physically be inside S");
  assert.equal(inside(realpathSync(worktrees), canonicalSandbox), true, "AC2 W must physically be inside S");
  git(sandbox, "switch", "--quiet", "--no-track", "-c", `feature/${runId}`, seed);
  assert.equal(git(sandbox, "rev-parse", "HEAD"), seed);
  containmentProven = true;
  events.push("containment:proved");
  dispatch();
  assert.equal(containmentProven, true, "AC3 dispatch callback cannot run before containment succeeds");
  events.push("dispatch");
  return { events, plane, worktrees };
}

test("AC1/AC3/AC4 fresh and resumed runs use a contained sandbox with guarded hardlink fallback", () => {
  const required = [
    "C = dirname(O)/.<basename(O)>.factory-sandboxes",
    "S = C/R",
    "P = S/.factory/R",
    "W = S/.factory/worktrees/R",
    "A = O/.factory/R",
    "O=\"$(cd \"$(git -C \"$INVOCATION_CHECKOUT\" rev-parse --show-toplevel)\" && pwd -P)\"",
    "Never switch, reset, clean, stash, create a\nbranch or worktree, write Git configuration, or initialize factory state in `O` for a fresh run.",
    "A valid legacy manifest at `A/run.json` resumes with\n`RUN_REPO=\"$O\"`; a valid sandbox manifest at `P/run.json` resumes with `RUN_REPO=\"$S\"`.",
    "If both manifests exist, print both\nabsolute paths and refuse as ambiguous.",
    "Never follow a symlink at `C` or `S`.",
    "Do not reuse, repair, or delete it.",
    "a failed resume check retains\nthe sandbox and refuses dispatch",
    "Refuse if `refs/heads/$FEATURE_BRANCH` already exists in `O`.",
    "SEED_HEAD=\"$(git -C \"$O\" rev-parse --verify 'HEAD^{commit}')\"",
    "PR_BASE=\"$(git -C \"$O\" symbolic-ref --quiet --short HEAD)\"",
    "PUSH_TARGET=\"$(LC_ALL=C git -C \"$O\" remote get-url --push origin)\"",
    "LC_ALL=C git clone --local \"$O\" \"$S\"",
    "Remove only the partial `S` created by this invocation",
    "factory sandbox: hardlink clone failed; retrying with --no-hardlinks",
    "LC_ALL=C git clone --local --no-hardlinks \"$O\" \"$S\"",
    "git -C \"$S\" config --replace-all remote.origin.pushurl \"$PUSH_TARGET\"",
    "RESOLVED_PUSH=\"$(LC_ALL=C git -C \"$S\" remote get-url --push origin)\"",
    "shell-string equality with\n`PUSH_TARGET` must be exact",
    "On configuration, lookup, or equality failure, expose neither value",
    "remove only this invocation's new `S`, and refuse dispatch",
    "CANONICAL_S=\"$(cd \"$S\" && pwd -P)\"",
    "TOP_LEVEL=\"$(cd \"$(git -C \"$S\" rev-parse --show-toplevel)\" && pwd -P)\"",
    "GIT_DIR=\"$(cd \"$(git -C \"$S\" rev-parse --absolute-git-dir)\" && pwd -P)\"",
    "Require `CANONICAL_S` and `TOP_LEVEL` to equal `S`, and `GIT_DIR` to\nequal `S/.git`.",
    "require their\nphysical canonical locations to be strict\ndescendants of `S`",
    "Any fresh failure removes only the new `S`;\nany resume failure retains it.",
    "Refuse an existing sandbox `refs/heads/$FEATURE_BRANCH`",
    "git -C \"$S\" switch --no-track -c \"$FEATURE_BRANCH\" \"$SEED_HEAD\"",
    "SWITCHED_HEAD=\"$(git -C \"$S\" rev-parse --verify 'HEAD^{commit}')\"",
    "SWITCHED_BRANCH=\"$(git -C \"$S\" symbolic-ref --quiet --short HEAD)\"",
    "Require `SWITCHED_HEAD` to equal `SEED_HEAD` and\n`SWITCHED_BRANCH` to equal `FEATURE_BRANCH`.",
    "factory init \"$R\" --branch \"$FEATURE_BRANCH\" --pr-base \"$PR_BASE\" [--jira \"$KEY\"] [--mode \"$MODE\"] --repo \"$S\"",
  ];
  required.forEach(position);

  const order = [
    "### Resume or collision",
    "### Fresh sandbox bootstrap",
    "SEED_HEAD=",
    "PUSH_TARGET=",
    "git clone --local \"$O\" \"$S\"",
    "config --replace-all remote.origin.pushurl",
    "### Physical containment gate",
    "CANONICAL_S=",
    "Any fresh failure removes only the new `S`",
    "Refuse an existing sandbox `refs/heads/$FEATURE_BRANCH`",
    "switch --no-track -c",
    "SWITCHED_HEAD=",
    "SWITCHED_BRANCH=",
    "Require `SWITCHED_HEAD`",
    "factory init \"$R\"",
    "dispatch the planned ticket",
  ].map(position);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "AC3 bootstrap checks must precede branch, init, and dispatch");

  assert.equal((step0.match(/git clone --local --no-hardlinks/gu) ?? []).length, 1, "AC4 permits exactly one fallback command");
  assert.match(step0, /Only a nonzero result[^]*`failed to create link` admits one\nfallback/u);
  assert.match(step0, /Do not retry any other clone failure\.[^]*make no\nthird attempt\./u);
  assert.doesNotMatch(step0, /git -C "\$O" (?:switch|reset|clean|stash|worktree|config)\b/u);

  const fallbackOrder = [
    "Only a nonzero result",
    "Remove only the partial `S` created by this invocation",
    "factory sandbox: hardlink clone failed; retrying with --no-hardlinks",
    "LC_ALL=C git clone --local --no-hardlinks",
  ].map(position);
  assert.deepEqual(fallbackOrder, [...fallbackOrder].sort((a, b) => a - b), "AC4 partial cleanup must precede the sole fallback retry");

  const pushFailureOrder = [
    "RESOLVED_PUSH=",
    "On configuration, lookup, or equality failure",
    "remove only this invocation's new `S`",
    "### Physical containment gate",
  ].map(position);
  assert.deepEqual(pushFailureOrder, [...pushFailureOrder].sort((a, b) => a - b), "AC3 failed fresh push proof must clean only its new sandbox before dispatch");

  const containmentOrder = [
    "### Physical containment gate",
    "CANONICAL_S=",
    "TOP_LEVEL=",
    "GIT_DIR=",
    "Require `CANONICAL_S` and `TOP_LEVEL`",
    "physical canonical locations to be strict",
    "Any fresh failure removes only the new `S`",
    "any resume failure retains it",
    "Either failure stops before dispatch.",
  ].map(position);
  assert.deepEqual(containmentOrder, [...containmentOrder].sort((a, b) => a - b), "AC3 containment proof must finish with fresh cleanup and resumed retention before dispatch");

  const containmentComplete = position("Either failure stops before dispatch.");
  for (const match of step0.matchAll(/\bdispatch\b/gu)) {
    const prefix = step0.slice(Math.max(0, match.index - 24), match.index + match[0].length);
    if (/(?:refuses?|before) dispatch$/u.test(prefix)) continue;
    assert.ok(match.index > containmentComplete, `AC3 agent dispatch precedes completed containment checks: ${prefix}`);
  }

  const factoryCommands = factoryInvocations(step0);
  assert.deepEqual(factoryCommands, [
    'factory status "$R" --json --repo "$RUN_REPO"',
    'factory lock "$R" claim --session "$SESSION_ID" --repo "$RUN_REPO"',
    'factory lock "$R" steal --session "$SESSION_ID" --repo "$RUN_REPO"',
    'factory init "$R" --branch "$FEATURE_BRANCH" --pr-base "$PR_BASE" [--jira "$KEY"] [--mode "$MODE"] --repo "$S"',
    'factory lock "$R" claim --session "$SESSION_ID" --repo "$S"',
    'factory status "$R" --json --repo "$S"',
    'factory heartbeat "$R" --session "$SESSION_ID" --repo "$RUN_REPO"',
  ], "AC1 parser must cover every fenced and inline Step-0 factory invocation");
  for (const command of factoryCommands) {
    assert.match(command, /^factory [a-z-]+ /u, `factory syntax must be command-first: ${command}`);
    assert.match(command, /--repo "\$(?:RUN_REPO|S)"$/u, `factory repository must be trailing: ${command}`);
  }

  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-lifecycle-"));
  try {
    const operator = join(root, "operator");
    const pushTarget = join(root, "push-target.git");
    const sandbox = join(root, ".operator.factory-sandboxes", "sandbox-lifecycle");
    mkdirSync(operator);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", operator]);
    git(operator, "config", "user.name", "Factory Test");
    git(operator, "config", "user.email", "factory@example.test");
    writeFileSync(join(operator, "tracked.txt"), "operator stays untouched\n");
    git(operator, "add", "tracked.txt");
    git(operator, "commit", "--quiet", "-m", "seed");
    git(operator, "switch", "--quiet", "-c", "operator-work");
    execFileSync("git", ["init", "--bare", "--quiet", pushTarget]);
    git(operator, "remote", "add", "origin", pushTarget);
    const operatorBefore = {
      branch: git(operator, "symbolic-ref", "--quiet", "--short", "HEAD"),
      head: git(operator, "rev-parse", "HEAD"),
      status: git(operator, "status", "--porcelain"),
    };
    let dispatches = 0;
    const bootstrapped = bootstrapWithInjectedHardlinkFailure({
      operator, sandbox, runId: "sandbox-lifecycle",
      dispatch: () => { dispatches += 1; },
    });
    assert.deepEqual(bootstrapped.events, [
      "clone:hardlinks", "remove:partial", "clone:no-hardlinks", "containment:proved", "dispatch",
    ], "AC3/AC4 partial cleanup and containment must precede the one dispatch");
    assert.equal(dispatches, 1, "AC3 dispatch occurs once after containment proof");
    assert.deepEqual({
      branch: git(operator, "symbolic-ref", "--quiet", "--short", "HEAD"),
      head: git(operator, "rev-parse", "HEAD"),
      status: git(operator, "status", "--porcelain"),
    }, operatorBefore, "AC1 bootstrap must not switch, commit, or dirty the operator checkout");
    assert.equal(existsSync(join(sandbox, "partial")), false, "AC4 fallback never retains the partial clone");
    assert.equal(realpathSync(bootstrapped.plane).startsWith(`${realpathSync(sandbox)}/`), true);
    assert.equal(realpathSync(bootstrapped.worktrees).startsWith(`${realpathSync(sandbox)}/`), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
