import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkg, "bin", "factory.js");

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function factory(repository, ...args) {
  return JSON.parse(execFileSync("node", [cli, ...args, "--repo", repository, "--json"], { encoding: "utf8" }));
}

function documentedFactoryCommands(markdown) {
  const joined = markdown.replace(/\\\n\s*/gu, " ");
  const snippets = [];
  for (const [, body] of joined.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)) snippets.push(...body.split("\n"));
  for (const [, body] of joined.matchAll(/`([^`\n]+)`/gu)) snippets.push(body);
  return snippets.flatMap((snippet) => {
    const matches = [...snippet.matchAll(/\bfactory\s+([a-z-]+)/gu)];
    return matches.map((match, index) => snippet.slice(match.index, matches[index + 1]?.index ?? snippet.length).trim());
  });
}

test("AC2/AC3/AC8/AC11/AC13/AC14 relocate state and slices while preserving proof contracts", () => {
  const skill = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
  for (const fragment of [
    "P = S/.factory/R",
    "W = S/.factory/worktrees/R",
    "RUN_MANIFEST=\"$RUN_REPO/.factory/$R/run.json\"",
    "SLICE_ROOT=\"$RUN_REPO/.factory/worktrees/$R\"",
    "a sandbox selects `S/.factory/worktrees/R`; a legacy run selects its existing\n`O/.factory/worktrees/R` layout",
    "Read exactly `RUN_MANIFEST` through the host's direct file-read capability",
    "do not spawn\na process, scan another directory, or write the file",
    "bind the parsed object as `parsedRun`, require `parsedRun.run_id` to equal `R`",
    "FEATURE_BRANCH = parsedRun.branch",
    "Discard any feature-branch value left from\nintake or the invocation checkout; recorded state always wins on resume",
    "Every slice branch is `factory/R/<slice-id>`",
    "SLICE_WORKTREE=\"$SLICE_ROOT/$SLICE_ID\"",
    "git -C \"$RUN_REPO\" worktree add -b \"$SLICE_BRANCH\" \"$SLICE_WORKTREE\" \"$FEATURE_BRANCH\"",
    "require both `refs/heads/$SLICE_BRANCH` and the\n`SLICE_WORKTREE` path to be absent",
    "`factory status` exposes compact slice labels only; it does not expose recorded\nworktree, branch, or `base_ref` values",
    "Immediately before every\nre-observation, directly reload and parse exactly `RUN_MANIFEST`",
    "RECORDED_SLICE = parsedRun.slices row whose id equals SLICE_ID",
    "SLICE_WORKTREE = RECORDED_SLICE.worktree",
    "SLICE_BRANCH = RECORDED_SLICE.branch",
    "SLICE_BASE_REF = RECORDED_SLICE.base_ref",
    "`SLICE_WORKTREE` to equal `SLICE_ROOT/<slice-id>`",
    "`git -C \"$RUN_REPO\" worktree list\n--porcelain`",
    "an unrecorded existing path or ref is a collision",
    "--worktree \"$SLICE_WORKTREE\" --base \"$SLICE_BASE_REF\"",
    "`base_ref` is fixed when the slice is activated and cannot be changed afterwards",
    "existing `resolveWorktree` containment check",
    "outside the seeded ownership paths",
    "seeded test plan's evidence and the bound review",
    "merge --no-ff \"$SLICE_BRANCH\"",
    "refuses a merge commit that does not have exactly two parents",
    "**A moved base is fine.**",
    "--repo \"$RUN_REPO\"",
    "A `blocked`, `partial`, or `needs-human` sandbox run retains `RUN_REPO`",
    "stale nonterminal locks retain it",
    "Nothing removes any of those sandboxes automatically.",
    "RECORDED_RUN_WORKTREE = parsedRun.worktree",
    "INTEGRATION_WORKTREE = physical normalized resolution of RECORDED_RUN_WORKTREE under RUN_REPO",
    "Immediately before every pending-slice activation, observation, or merge",
    "CHECKED_OUT_FEATURE_BRANCH=\"$(git -C \"$INTEGRATION_WORKTREE\" symbolic-ref --quiet --short HEAD)\"",
    "A failed probe\nmeans detached HEAD and is refused; a different branch is refused as a mismatch",
    "never substitute stale intake branch intent",
    "activate the first seeded slice whose `depends_on` is empty before any other slice\ncan merge",
    "ROOT_SLICE = first parsedRun.slices row whose depends_on is empty",
    "BRANCH_POINT = ROOT_SLICE.base_ref",
    "Neither value comes from status, current\nHEAD, a branch name, or an unpersisted variable",
    "report `sandbox_path` as the resolved selected repository",
    "reports `dead_lock: true` only when the run is nonterminal and its lock is stale",
  ]) assert.ok(skill.includes(fragment), `state-relocation contract is missing: ${fragment}`);

  const commands = documentedFactoryCommands(skill);
  assert.ok(commands.length >= 35, `expected every documented factory command shape, found ${commands.length}`);
  const nonRunnableSandboxShapes = new Set([
    'factory init "$R" --branch "$FEATURE_BRANCH" --pr-base "$PR_BASE" [--issue "$KEY"] [--mode "$MODE"] --repo "$S"',
    'factory lock "$R" claim --session "$SESSION_ID" --repo "$S"',
    'factory status "$R" --json --repo "$S"',
  ]);
  for (const command of commands.filter((entry) => entry.includes('"$R"'))) {
    if (nonRunnableSandboxShapes.has(command)) continue;
    assert.match(command, /^factory [a-z-]+\s/u, `factory invocation is not command-first: ${command}`);
    assert.match(command, /--repo "\$RUN_REPO"$/u, `factory invocation lacks trailing selected RUN_REPO: ${command}`);
  }
  assert.deepEqual(commands.filter((entry) => /--repo "\$S"$/u.test(entry)), [...nonRunnableSandboxShapes]);
  assert.ok(skill.includes("older bootstrap assertion retains the non-runnable command shape"));
  assert.ok(skill.includes("non-runnable bootstrap claim shapes are"));
  for (const stem of ["factory status <run-id> --json", "factory gate <run-id> pre_pr pending"]) {
    assert.ok(commands.includes(stem), `missing compatibility command stem: ${stem}`);
  }
  const placeholderCommands = commands.filter((entry) => entry.includes("<run-id>"));
  assert.ok(placeholderCommands.length >= 3);
  assert.ok(placeholderCommands.every((entry) => [
    "factory status <run-id> --json", "factory gate <run-id> pre_pr pending",
  ].includes(entry)), `unqualified placeholder invocation is not marked compatibility: ${placeholderCommands.join(", ")}`);
  assert.ok(skill.includes("quoted phrase names a\ncommand stem, not a runnable invocation"));
  assert.ok(skill.includes("It names a non-runnable\ncommand stem. Execute only `factory status \"$R\" --json --repo \"$RUN_REPO\"`"));
  assert.ok(skill.includes("compatibility transition name is `factory gate <run-id> pre_pr pending`; the runnable form is the\nrepository-qualified command above"));
  const introduction = skill.slice(0, skill.indexOf("## Threat boundary"));
  assert.match(introduction, /preserved compatibility\nclaim reads: A subagent may read —\n`factory status <run-id> --json`[^]*command stem, not a runnable invocation[^]*--repo "\$RUN_REPO"/u);
  const resuming = skill.slice(skill.indexOf("## Resuming"), skill.indexOf("## Guardrails"));
  assert.match(resuming, /preserved compatibility\nclaim reads “run `factory status <run-id> --json` and resume; never restart\.” It names a non-runnable\ncommand stem\. Execute only `factory status "\$R" --json --repo "\$RUN_REPO"`/u);
  const modeAdmission = skill.slice(skill.indexOf("## Mode admission"), skill.indexOf("## Operating modes"));
  assert.match(modeAdmission, /compatibility phrases name init command stems, not runnable invocations[^]*--repo "\$RUN_REPO"/u);
  for (const command of commands.filter((entry) => !entry.includes('"$R"') && !entry.includes("<run-id>"))) {
    assert.ok(
      /^factory (?:observe|init|status|slice|pr)$/u.test(command)
        || /^factory slice … (?:running|merged)$/u.test(command)
        || ["factory init --mode autonomous", "factory init --mode headless"].includes(command),
      `factory command shape is neither qualified nor a declared compatibility stem: ${command}`,
    );
  }

  const stepFour = skill.slice(skill.indexOf("## Step 4 — Build slices"), skill.indexOf("## Step 5 — Integrate"));
  assert.doesNotMatch(stepFour, /(?:--repo|git -C) "\$(?:S|O)"/u);
  assert.doesNotMatch(stepFour, /\$W\//u);
  const sliceObservation = stepFour.indexOf('$ factory observe "$R" "$SLICE_ID"');
  for (const binding of [
    "SLICE_WORKTREE = RECORDED_SLICE.worktree",
    "SLICE_BRANCH = RECORDED_SLICE.branch",
    "SLICE_BASE_REF = RECORDED_SLICE.base_ref",
  ]) {
    const resumeBinding = stepFour.indexOf(binding);
    assert.ok(resumeBinding >= 0 && resumeBinding < sliceObservation, `recorded resume row must bind before observation: ${binding}`);
  }
  const integrationDefinition = stepFour.indexOf("INTEGRATION_WORKTREE = physical normalized resolution");
  const integrationMerge = stepFour.indexOf('git -C "$INTEGRATION_WORKTREE" merge');
  assert.ok(integrationDefinition >= 0 && integrationDefinition < integrationMerge, "integration worktree must be defined before merge");
  const recordedFeatureDefinition = stepFour.indexOf("FEATURE_BRANCH = parsedRun.branch");
  const branchProbes = [...stepFour.matchAll(/CHECKED_OUT_FEATURE_BRANCH="\$\(git -C "\$INTEGRATION_WORKTREE" symbolic-ref --quiet --short HEAD\)"/gu)]
    .map((match) => match.index);
  const sliceActivation = stepFour.indexOf('$ factory slice "$R" "$SLICE_ID" running');
  assert.equal(branchProbes.length, 3, "feature branch must be reverified for activation, observation, and merge");
  assert.ok(recordedFeatureDefinition >= 0 && recordedFeatureDefinition < integrationDefinition && integrationDefinition < branchProbes[0]);
  assert.ok(branchProbes[0] < sliceActivation && sliceActivation < branchProbes[1] && branchProbes[1] < sliceObservation);
  assert.ok(sliceObservation < branchProbes[2] && branchProbes[2] < integrationMerge,
    "recorded feature branch verification must immediately precede each slice operation");

  const stepFive = skill.slice(skill.indexOf("## Step 5 — Integrate"), skill.indexOf("## Step 6 — Draft PR"));
  const rootBaseDefinition = stepFive.indexOf("BRANCH_POINT = ROOT_SLICE.base_ref");
  const integratedObservation = stepFive.indexOf('factory observe "$R" test-verifier');
  assert.ok(rootBaseDefinition >= 0 && rootBaseDefinition < integratedObservation, "root base_ref must define branch point before integration observation");
  const integrationProbes = [...stepFive.matchAll(/CHECKED_OUT_FEATURE_BRANCH="\$\(git -C "\$INTEGRATION_WORKTREE" symbolic-ref --quiet --short HEAD\)"/gu)]
    .map((match) => match.index);
  const integrationObservations = [...stepFive.matchAll(/factory observe "\$R" test-verifier/gu)].map((match) => match.index);
  assert.equal(integrationProbes.length, integrationObservations.length);
  integrationObservations.forEach((observation, index) => {
    assert.ok(integrationProbes[index] < observation, "recorded feature branch verification must precede integration observation");
  });

  const resumeSection = skill.slice(skill.indexOf("### Resume or collision"), skill.indexOf("### Fresh sandbox bootstrap"));
  const parsedRunBinding = resumeSection.indexOf("bind the parsed object as `parsedRun`");
  const featureBranchBinding = resumeSection.indexOf("FEATURE_BRANCH = parsedRun.branch");
  const resumeLock = resumeSection.indexOf('factory lock "$R" claim');
  assert.ok(parsedRunBinding >= 0 && parsedRunBinding < featureBranchBinding && featureBranchBinding < resumeLock,
    "resume must replace intake branch intent with parsedRun.branch before continuing");
  assert.match(resumeSection, /recorded state always wins on resume/u);

  const fresh = skill.slice(skill.indexOf("### Fresh sandbox bootstrap"), skill.indexOf("### Gate 1 — Story"));
  const selectedRepositoryDefinition = fresh.indexOf('RUN_REPO="$S"');
  const selectedManifestDefinition = fresh.indexOf('RUN_MANIFEST="$RUN_REPO/.factory/$R/run.json"');
  const selectedRootDefinition = fresh.indexOf('SLICE_ROOT="$RUN_REPO/.factory/worktrees/$R"');
  const selectedInit = fresh.indexOf('$ factory init "$R"');
  assert.ok(selectedRepositoryDefinition >= 0 && selectedRepositoryDefinition < selectedManifestDefinition);
  assert.ok(selectedManifestDefinition < selectedRootDefinition && selectedRootDefinition < selectedInit,
    "fresh selected repository paths must be defined before init");

  const selectedPaths = (operator, sandbox, sandboxed, recordedWorktree) => {
    const runRepository = sandboxed ? sandbox : operator;
    return {
      runRepository,
      sliceRoot: join(runRepository, ".factory", "worktrees", "state-relocation"),
      integrationWorktree: resolve(runRepository, recordedWorktree),
    };
  };
  assert.deepEqual(selectedPaths("/operator", "/sandbox", true, "."), {
    runRepository: "/sandbox", sliceRoot: "/sandbox/.factory/worktrees/state-relocation", integrationWorktree: "/sandbox",
  });
  assert.deepEqual(selectedPaths("/operator", "/sandbox", false, "configured"), {
    runRepository: "/operator", sliceRoot: "/operator/.factory/worktrees/state-relocation", integrationWorktree: "/operator/configured",
  });

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

  // Execute the path convention with real linked-worktree metadata, rather than only deriving
  // strings from it.  `repository` above is the selected repo unit fixture; this one distinguishes
  // the untouched operator O from the sandbox S that owns both P and W.
  const root = mkdtempSync(join(tmpdir(), "factory-state-sandbox-"));
  try {
    const operator = join(root, "operator");
    const container = join(operator, ".factory-sandboxes");
    const sandbox = join(container, "state-relocation");
    const runId = "state-relocation";
    mkdirSync(operator);
    git(operator, "init", "--quiet", "--initial-branch=main");
    git(operator, "config", "user.name", "Factory Test");
    git(operator, "config", "user.email", "factory@example.test");
    writeFileSync(join(operator, "operator.txt"), "operator\n");
    // The ignore rule is load-bearing, not hygiene: the container now lives *inside* `O`, so without
    // it every run leaves the operator checkout dirty and the ownership refusal fires against the
    // run's own workspace. Committed here so the `operatorBefore`/`operatorAfter` comparison below
    // proves it — that assertion fails with `?? .factory-sandboxes/` if the rule is ever dropped.
    writeFileSync(join(operator, ".gitignore"), "/.factory-sandboxes/\n");
    git(operator, "add", "operator.txt", ".gitignore");
    git(operator, "commit", "--quiet", "-m", "operator seed");
    git(operator, "switch", "--quiet", "-c", "operator-work");
    const operatorBefore = {
      branch: git(operator, "symbolic-ref", "--quiet", "--short", "HEAD"),
      head: git(operator, "rev-parse", "HEAD"),
      status: git(operator, "status", "--porcelain"),
    };
    mkdirSync(container);
    execFileSync("git", ["clone", "--quiet", "--local", operator, sandbox]);
    git(sandbox, "config", "user.name", "Factory Test");
    git(sandbox, "config", "user.email", "factory@example.test");
    git(sandbox, "switch", "--quiet", "-c", `feature/${runId}`);
    factory(sandbox, "init", runId, "--branch", `feature/${runId}`, "--pr-base", "main");
    const plane = join(sandbox, ".factory", runId);
    const worktreeRoot = join(sandbox, ".factory", "worktrees", runId);
    const sliceWorktree = join(worktreeRoot, "slice-a");
    mkdirSync(worktreeRoot, { recursive: true });
    git(sandbox, "worktree", "add", "--quiet", "-b", `factory/${runId}/slice-a`, sliceWorktree, `feature/${runId}`);
    const canonicalSandbox = realpathSync(sandbox);
    for (const path of [plane, worktreeRoot, sliceWorktree]) {
      const physical = realpathSync(path);
      const pathInsideSandbox = relative(canonicalSandbox, physical);
      assert.ok(pathInsideSandbox && pathInsideSandbox !== ".." && !pathInsideSandbox.startsWith(`..${sep}`),
        `AC2 ${path} must physically remain under S`);
    }
    assert.equal(realpathSync(git(sandbox, "rev-parse", "--show-toplevel")), canonicalSandbox,
      "AC2 feature repository is the sandbox, not O");
    assert.equal(realpathSync(git(sliceWorktree, "rev-parse", "--show-toplevel")), realpathSync(sliceWorktree),
      "AC2 slice worktree is a real linked worktree inside W");
    assert.equal(existsSync(join(operator, ".factory", runId, "run.json")), false,
      "AC2 sandbox initialization must not create a control plane in O");
    assert.deepEqual({
      branch: git(operator, "symbolic-ref", "--quiet", "--short", "HEAD"),
      head: git(operator, "rev-parse", "HEAD"),
      status: git(operator, "status", "--porcelain"),
    }, operatorBefore, "AC1/AC2 real slice creation must leave O unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
