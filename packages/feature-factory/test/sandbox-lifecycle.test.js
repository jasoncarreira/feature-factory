import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
    "SEED_HEAD=\"$(git -C \"$O\" rev-parse --verify 'HEAD^{commit}')\"",
    "PR_BASE=\"$(git -C \"$O\" symbolic-ref --quiet --short HEAD)\"",
    "PUSH_TARGET=\"$(LC_ALL=C git -C \"$O\" remote get-url --push origin)\"",
    "LC_ALL=C git clone --local \"$O\" \"$S\"",
    "factory sandbox: hardlink clone failed; retrying with --no-hardlinks",
    "LC_ALL=C git clone --local --no-hardlinks \"$O\" \"$S\"",
    "git -C \"$S\" config --replace-all remote.origin.pushurl \"$PUSH_TARGET\"",
    "RESOLVED_PUSH=\"$(LC_ALL=C git -C \"$S\" remote get-url --push origin)\"",
    "shell-string equality with\n`PUSH_TARGET` must be exact",
    "TOP_LEVEL=\"$(cd \"$(git -C \"$S\" rev-parse --show-toplevel)\" && pwd -P)\"",
    "GIT_DIR=\"$(cd \"$(git -C \"$S\" rev-parse --absolute-git-dir)\" && pwd -P)\"",
    "Require `CANONICAL_S` and `TOP_LEVEL` to equal `S`, and `GIT_DIR` to\nequal `S/.git`.",
    "require their\nphysical canonical locations to be strict\ndescendants of `S`",
    "git -C \"$S\" switch --no-track -c \"$FEATURE_BRANCH\" \"$SEED_HEAD\"",
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
    "switch --no-track -c",
    "factory init \"$R\"",
    "dispatch the planned ticket",
  ].map(position);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "AC3 bootstrap checks must precede branch, init, and dispatch");

  assert.equal((step0.match(/git clone --local --no-hardlinks/gu) ?? []).length, 1, "AC4 permits exactly one fallback command");
  assert.match(step0, /Only a nonzero result[^]*`failed to create link` admits one\nfallback/u);
  assert.match(step0, /Do not retry any other clone failure\.[^]*make no\nthird attempt\./u);
  assert.doesNotMatch(step0, /git -C "\$O" (?:switch|reset|clean|stash|worktree|config)\b/u);

  const factoryCommands = [...step0.matchAll(/^factory .+$/gmu)].map(([command]) => command);
  assert.ok(factoryCommands.length >= 4);
  for (const command of factoryCommands) {
    assert.match(command, /^factory [a-z-]+ /u, `factory syntax must be command-first: ${command}`);
    assert.match(command, /--repo "\$(?:RUN_REPO|S)"$/u, `factory repository must be trailing: ${command}`);
  }
});
