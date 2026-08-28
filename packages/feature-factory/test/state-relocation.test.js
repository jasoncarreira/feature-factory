import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initFresh, seedLegacyRun } from "./init-fixture.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkg, "bin", "factory.js");

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function factory(repository, ...args) {
  return JSON.parse(execFileSync("node", [cli, ...args, "--repo", repository, "--json"], { encoding: "utf8" }));
}

function refAbsent(repository, ref) {
  try {
    git(repository, "show-ref", "--verify", "--quiet", ref);
    return false;
  } catch (error) {
    if (error.status === 1) return true;
    throw error;
  }
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
  const skill = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
  for (const fragment of [
    "RUN_REPO=\"<exact response sandbox_path>\"",
    "RUN_DIR=\"<exact init response run_dir, or $RUN_REPO/.factory/$R after status resume>\"",
    "RUN_MANIFEST=\"$RUN_DIR/run.json\"",
    "SLICE_ROOT=\"$RUN_REPO/.factory/worktrees/$R\"",
    "A legacy candidate selects the\nreturned `O`; a sandbox candidate selects the returned sandbox",
    "Read exactly\n`RUN_MANIFEST` through the host's direct file-read capability, parse it as JSON, bind it as `parsedRun`",
    "response and manifest run IDs to equal `R`",
    "FEATURE_BRANCH = parsedRun.branch",
    "immediately discard every intake or stale feature-branch and\nworktree value",
    "recorded state always wins",
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
    "outside the current persisted ownership paths",
    "original paths\nas an unchanged prefix followed by the requested additions",
    "the resume command never amends paths,\nchanges `test_plan`, or reseeds the plan",
    "immutable seeded test plan's evidence\n   and the bound review",
    "merge --no-ff \"$SLICE_BRANCH\"",
    "refuses a merge commit that does not have exactly two parents",
    "**A moved base is fine.**",
    "--repo \"$RUN_REPO\"",
    "A top-level needs-human sandbox stays retained while parked and continues only after explicit factory resume.",
    "A `blocked` or `partial` sandbox run retains `RUN_REPO`",
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
    "validates it and returns its exact\n`sandbox_path`",
    "status reports `dead_lock: true` only for\na stale lock on a current `running` run",
    "Before consulting `status.next`, computing or activating a wave",
    "walk first\nparents from the current integration HEAD, nearest to oldest",
    "not\na base-movement-only guard",
    "terminalize means terminate the current `factory slice … merged` CLI invocation",
    "it does not mean the irreversible\nfactory terminal transition",
    "Await every in-flight specialist task",
    "Stop\nscheduling heartbeats and await every heartbeat already in flight",
    "Outcome: repository-verify-exhausted",
    "Outcome: retained-lock-error",
    "status: \"running\"`, `terminal_result: null`",
    "binds `SESSION_ID` to the actual stable host-adapter identity",
    "never require session-ID inequality",
    ".factory/$R/artifacts/post-merge-repairs.md",
    "never fall back to fetching one when a command is not found",
    "Status is exactly `planned`, `committed`, `verified`, `failed`, `exhausted`, or `needs-human`",
    "--repository-verify --repo \"$RUN_REPO\"",
  ]) assert.ok(skill.includes(fragment), `state-relocation contract is missing: ${fragment}`);

  const commands = documentedFactoryCommands(skill);
  assert.ok(commands.length >= 35, `expected every documented factory command shape, found ${commands.length}`);
  const nonSelectedRepositoryShapes = new Set([
    'factory init "$R" --branch "$FEATURE_BRANCH" [--worktree "$WORKTREE"] [--pr-base "$PR_BASE"] [--issue "$KEY"] [--mode "$MODE"] --repo "$O" --json)"',
    'factory status "$R" --json --repo "<candidate-repository>"',
  ]);
  for (const command of commands.filter((entry) => entry.includes('"$R"'))) {
    if (nonSelectedRepositoryShapes.has(command)) continue;
    assert.match(command, /^factory [a-z-]+\s/u, `factory invocation is not command-first: ${command}`);
    assert.match(command, /--repo "\$RUN_REPO"$/u, `factory invocation lacks trailing selected RUN_REPO: ${command}`);
  }
  assert.deepEqual(commands.filter((entry) => /--repo "\$O"/u.test(entry)), [[...nonSelectedRepositoryShapes][0]]);
  assert.ok(commands.includes([...nonSelectedRepositoryShapes][1]));
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
        || /^factory sandbox:/u.test(command)
        || /^factory slice … (?:running|merged)$/u.test(command)
        || ["factory init --mode autonomous", "factory init --mode headless"].includes(command),
      `factory command shape is neither qualified nor a declared compatibility stem: ${command}`,
    );
  }

  const stepFour = skill.slice(skill.indexOf("## Step 4 — Build slices"), skill.indexOf("## Step 5 — Integrate"));
  assert.doesNotMatch(stepFour, /(?:--repo|git -C) "\$(?:S|O)"/u);
  assert.doesNotMatch(stepFour, /\$W\//u);
  const classificationPolicy = stepFour.slice(stepFour.indexOf("Classify it into exactly four outcomes:"), stepFour.indexOf("Determine `INTRODUCING_MERGE`"));
  assert.match(classificationPolicy, /- `green`: exact run, subject, current head, and unchanged `verify` command binding, observed integer\s+exit zero, and `review_ready: true`\.[\s\S]*- `failed`: the same exact binding with an observed nonzero integer exit, or observed zero that is not\s+review-ready[\s\S]*- `unavailable`: the same exact binding with canonical `observed: false`, `exit: null`, and\s+`skipped_reason: null`\.[\s\S]*- `unknown`: missing, unreadable, malformed, foreign, stale-head, wrong-command, missing-field, or\s+internally inconsistent evidence[\s\S]*`unavailable` is the only replay-eligible class/u,
    "the closed classifier must bind all four outcomes, including exact provenance and the canonical unavailable tuple");
  assert.match(classificationPolicy, /Only matching `unavailable` evidence, no active\s+repair record, a freshly verified exact integration worktree on the recorded feature branch, current\s+integration `HEAD` equal to that row's immutable merge SHA, and a freshly observable clean tree authorize\s+replay/u,
    "same-SHA replay must require every fresh safety proof");
  assert.match(classificationPolicy, /Unsafe verification evidence parks top-level needs-human; explicit resume must replay the existing reconciliation path\.[\s\S]*Clean, unchanged second-unavailable\s+exhaustion is the sole nonterminal exception/u,
    "unsafe and untrusted outcomes must remain durably terminal while clean exhaustion stays nonterminal");
  const repairPolicy = stepFour.slice(stepFour.indexOf("### Post-merge finding routing and repair journal"), stepFour.indexOf("**Ownership disclosure.**"));
  const exhaustionPolicy = stepFour.slice(stepFour.indexOf("### Orderly repository-verification exhaustion"), stepFour.indexOf("### Post-merge finding routing and repair journal"));
  const exhausted = exhaustionPolicy.indexOf("Outcome: repository-verify-exhausted");
  const quiesceTasks = exhaustionPolicy.indexOf("Await every in-flight specialist task");
  const quiesceHeartbeats = exhaustionPolicy.indexOf("Stop\nscheduling heartbeats and await every heartbeat already in flight");
  const release = exhaustionPolicy.indexOf('factory lock "$R" release --session "$SESSION_ID" --repo "$RUN_REPO"');
  const verifyRelease = exhaustionPolicy.indexOf('factory status "$R" --json --repo "$RUN_REPO"');
  assert.ok(quiesceTasks >= 0 && quiesceTasks < quiesceHeartbeats && quiesceHeartbeats < release && release < verifyRelease && verifyRelease < exhausted,
    "repository verification exhaustion must quiesce work, release its owner, and verify durable status before reporting");
  const restartGuards = exhaustionPolicy.indexOf("repeats normal run selection, manifest validation, provenance, branch,");
  const restartClaim = exhaustionPolicy.indexOf('factory lock "$R" claim --session "$SESSION_ID" --repo "$RUN_REPO"');
  const restartOwnership = exhaustionPolicy.indexOf("reports that exact session as owner");
  const restartReplay = exhaustionPolicy.indexOf("Only then may it perform same-SHA reconciliation");
  assert.ok(restartGuards >= 0 && restartGuards < restartClaim && restartClaim < restartOwnership && restartOwnership < restartReplay,
    "a later invocation must repeat normal guards and verify a new claim before same-SHA reconciliation");
  assert.match(exhaustionPolicy, /value may equal or differ from the prior invocation's value/u);
  assert.ok(stepFour.includes("A validated active repair record supplies it only after it\nequals exactly one merged row and is an ancestor of that record's Starting head"),
    "an active repair must prove unique introducing-merge identity and ancestry");
  const fieldSentence = /Each record contains ([^.]+)\./u.exec(repairPolicy)?.[1] ?? "";
  assert.deepEqual([...fieldSentence.matchAll(/`([^`]+)`/gu)].map((match) => match[1]), [
    "Introducing merge", "Attempt", "Starting head", "Trigger result", "Test paths", "Cause",
    "Property outcome", "Repair commit", "Post-repair result", "Status",
  ], "the repair journal must retain every exact field");
  const statusSentence = /Status is exactly ([^.]+)\./u.exec(repairPolicy)?.[1] ?? "";
  assert.deepEqual([...statusSentence.matchAll(/`([^`]+)`/gu)].map((match) => match[1]), [
    "planned", "committed", "verified", "failed", "exhausted", "needs-human",
  ]);
  assert.ok(repairPolicy.includes("This repair record is not the run envelope, and envelope resume does not clear that status."));
  for (const fragment of [
    "attempts are ordered, contiguous, duplicate- and gap-free\n`1..N`",
    "`N <= max_retries`; globally at most one record is active (`planned` or `committed`)",
    "Immutable fields from the first `planned` write are record ID, introducing merge, attempt, Starting\nhead, trigger snapshot, trigger result, paths, and cause",
    "Starting head is exact HEAD at planning and\nmust descend from the introducing merge",
    "separate single-parent commit whose parent is Starting head",
    "nonempty diff is exactly the sorted test paths, which changes tests only, and which is current\nHEAD when recorded",
  ]) assert.ok(repairPolicy.includes(fragment), `repair invariant is missing: ${fragment}`);
  for (const fragment of [
    "This contract applies only to new version-1 records.",
    "version-1 journal is canonical UTF-8 JSON with no BOM",
    "The complete status-conditioned shape is:",
    "is identity and ancestry proof only, never the re-verification execution target.",
    "operator-only recovery action by instruction, not identity, role, session, or authority enforcement.",
    "requires exactly the run ID and exact canonical record ID; its only optional flags are `--repo`, `--now`, and `--json`.",
    "Every direct entry of `.factory/$R/evidence/` whose basename starts `repair-reverification.` belongs to",
    "Marker attempts are contiguous `1..N`.",
    "Marker publication linearizes begin; final evidence publication linearizes finish; a marker-only tail always requires manual resolution.",
    "Gate 3 and publication perform only\nsynchronous lock-free validation",
  ]) assert.ok(repairPolicy.includes(fragment), `version-1 repair contract is missing: ${fragment}`);
  const transitionSentence = /Allowed transitions are ([\s\S]*?)\nFinal records/u.exec(repairPolicy)?.[1] ?? "";
  assert.deepEqual([...transitionSentence.matchAll(/`([^`]+ → [^`]+)`/gu)].map((match) => match[1]), [
    "planned → committed|needs-human",
    "committed → verified|failed|exhausted|needs-human",
    "failed → exhausted",
  ], "the repair journal must admit only the approved transitions");
  assert.ok(repairPolicy.includes("Envelope resume does not clear or alter these repair transitions."));
  assert.ok(repairPolicy.includes('Only the explicit `factory reverify-repair "$R" "$REPAIR_RECORD_ID" --repo "$RUN_REPO"` may derive effective `verified` from this repair-record needs-human; the physical row stays frozen, and resume and reconciliation never execute or clear it.'));
  for (const [state, outcomes] of [
    ["planned", ["tree is clean", "`HEAD === Starting head`", "same known trigger", "resume edits without rerunning verify", "Otherwise terminalize"]],
    ["committed", ["valid repair head and diff plus green evidence becomes `verified`", "known failed evidence becomes\n`failed` or `exhausted`", "unknown evidence or any mismatch terminalizes"]],
    ["failed", ["matching\nrepair head and known failed evidence creates the next contiguous attempt when allowed", "otherwise it\nbecomes `exhausted`", "mismatch, green, or unknown terminalizes"]],
    ["verified", ["permits progression only when\nit is latest for that introducing merge and canonical evidence is green at current HEAD", "reconcile any\nnearer recorded merge independently"]],
    ["exhausted", ["`exhausted` and every unresolved repair record always block", "envelope resume does not clear either"]],
  ]) {
    for (const outcome of outcomes) assert.ok(repairPolicy.includes(outcome), `${state} resume outcome is missing: ${outcome}`);
  }
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
  assert.equal(branchProbes.length, 4, "feature branch must be reverified before waves, activation, observation, and merge");
  assert.ok(recordedFeatureDefinition >= 0 && recordedFeatureDefinition < integrationDefinition && integrationDefinition < branchProbes[0]);
  assert.ok(branchProbes[0] < branchProbes[1] && branchProbes[1] < sliceActivation && sliceActivation < branchProbes[2] && branchProbes[2] < sliceObservation);
  assert.ok(sliceObservation < branchProbes[3] && branchProbes[3] < integrationMerge,
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
  const gateThree = stepFive.slice(stepFive.indexOf("### Gate 3 — Pre-PR"));
  for (const fragment of [
    "first validate `.factory/$R/artifacts/post-merge-repairs.md`",
    "complete journal, ancestry, separate repair commit, transition, resume, attempt-bound,\none-active-record, evidence inventory, and latest-effective-verified/current-head rules",
    "A Gate 3 repair-record needs-human remains blocked until the complete inventory proves its canonical first passing re-verification; Gate 3 never executes or clears re-verification.",
    "`## Post-merge test-only repairs` section",
    "summarizes every journal record in order",
    "property outcome and every\nproperty loss",
    "No attempt, outcome, or\nproperty loss may be omitted",
    "Publication accepts a repair-record needs-human only through its first canonical pass-derived effective `verified`, with the separate repair commit supplying current-head repository-test proof; resume and reconciliation never execute or clear it.",
  ]) assert.ok(gateThree.includes(fragment), `Gate 3 repair summary is missing: ${fragment}`);
  assert.ok(gateThree.indexOf("first validate `.factory/$R/artifacts/post-merge-repairs.md`") < gateThree.indexOf('factory gate "$R" pre_pr pending --artifact gates/pre_pr.md'),
    "repair history must be validated and summarized before Gate 3 presentation");

  const resumeSection = skill.slice(skill.indexOf("### Resume or collision"), skill.indexOf("### Fresh sandbox request"));
  const parsedRunBinding = resumeSection.indexOf("bind it as `parsedRun`");
  const featureBranchBinding = resumeSection.indexOf("FEATURE_BRANCH = parsedRun.branch");
  const resumePushProof = resumeSection.indexOf("Only after that guard passes may resume enter the");
  assert.ok(parsedRunBinding >= 0 && parsedRunBinding < featureBranchBinding && featureBranchBinding < resumePushProof,
    "resume must replace intake branch intent with parsedRun.branch before continuing");
  assert.match(resumeSection, /recorded state always wins/u);

  const fresh = skill.slice(skill.indexOf("### Fresh sandbox request"), skill.indexOf("### Gate 1 — Story"));
  const selectedInit = fresh.indexOf('factory init "$R"');
  const successfulSelection = fresh.indexOf("Only a\nsuccessful JSON response selects paths");
  const selectedRepositoryDefinition = fresh.indexOf("Bind `RUN_REPO` from its exact canonical `sandbox_path`");
  assert.ok(selectedInit >= 0 && selectedInit < successfulSelection && successfulSelection < selectedRepositoryDefinition,
    "fresh selected repository paths must come only from successful init output");

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
    writeFileSync(join(repository, ".gitignore"), ".factory/\n/.factory-sandboxes/\n");
    git(repository, "add", "tracked.txt", ".gitignore");
    git(repository, "commit", "--quiet", "-m", "fixture");

    const initialized = seedLegacyRun(repository, "state-relocation", { branch: "feature/state-relocation", pr_base: "main" });
    assert.equal(initialized.repository, resolve(repository));
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

    const resumed = seedLegacyRun(repository, "resumed-stale", { branch: "feature/resumed-stale", pr_base: "main" });
    factory(repository, "terminal", "resumed-stale", "needs-human", "--reason", "external cause", "--now", "2026-08-05T00:00:00Z");
    factory(repository, "lock", "resumed-stale", "claim", "--session", "resumed-session", "--branch", "feature/resumed-stale");
    factory(repository, "resume", "resumed-stale", "--session", "resumed-session", "--now", "2026-08-05T00:01:00Z");
    writeFileSync(join(resumed.runDir, "factory.lock"), `${JSON.stringify({
      session: "dead-resumed-session", pid: 1234, run_id: "resumed-stale", branch: "feature/resumed-stale",
      claimed_at: "2020-01-01T00:00:00.000Z", heartbeat_at: "2020-01-01T00:00:00.000Z",
    })}\n`);
    const resumedStale = factory(repository, "status", "resumed-stale");
    assert.equal(resumedStale.status, "running");
    assert.deepEqual(resumedStale.terminal_result, { status: "needs-human", reason: "external cause" });
    assert.equal(resumedStale.dead_lock, true, "historical parked result must not hide a crashed running run");
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
    writeFileSync(join(operator, ".gitignore"), ".factory/\n/.factory-sandboxes/\n");
    git(operator, "add", "operator.txt", ".gitignore");
    git(operator, "commit", "--quiet", "-m", "operator seed");
    git(operator, "switch", "--quiet", "-c", "operator-work");
    writeFileSync(join(operator, "operator-work.txt"), "operator work\n");
    git(operator, "add", "operator-work.txt");
    git(operator, "commit", "--quiet", "-m", "operator work");
    git(operator, "remote", "add", "origin", operator);
    const operatorBefore = {
      branch: git(operator, "symbolic-ref", "--quiet", "--short", "HEAD"),
      head: git(operator, "rev-parse", "HEAD"),
      status: git(operator, "status", "--porcelain"),
    };
    const featureBranch = `feature/${runId}`;
    const featureRef = `refs/heads/${featureBranch}`;
    assert.equal(refAbsent(operator, featureRef), true);
    const seedHead = git(operator, "rev-parse", "main^{commit}");
    assert.notEqual(seedHead, operatorBefore.head, "explicit base seed must not fall back to operator HEAD");
    const initialized = initFresh(operator, [runId, "--branch", featureBranch, "--pr-base", "main"]);
    const sandbox = initialized.repository;
    assert.equal(sandbox, realpathSync(join(container, runId)));
    assert.equal(refAbsent(operator, featureRef), true);
    git(sandbox, "config", "user.name", "Factory Test");
    git(sandbox, "config", "user.email", "factory@example.test");
    const operatorPush = git(operator, "remote", "get-url", "--push", "origin");
    git(sandbox, "config", "--replace-all", "remote.origin.pushurl", operatorPush);
    assert.equal(git(operator, "remote", "get-url", "--push", "origin"), git(sandbox, "remote", "get-url", "--push", "origin"));
    assert.equal(refAbsent(operator, featureRef), true);
    assert.equal(git(sandbox, "symbolic-ref", "--quiet", "--short", "HEAD"), featureBranch);
    assert.equal(git(sandbox, "rev-parse", "HEAD^{commit}"), seedHead);
    assert.equal(git(sandbox, "rev-parse", `${featureRef}^{commit}`), seedHead);
    assert.equal(refAbsent(operator, featureRef), true);
    const plane = initialized.runDir;
    const worktreeRoot = join(sandbox, ".factory", "worktrees", runId);
    const sliceWorktree = join(worktreeRoot, "slice-a");
    mkdirSync(worktreeRoot, { recursive: true });
    git(sandbox, "worktree", "add", "--quiet", "-b", `factory/${runId}/slice-a`, sliceWorktree, featureBranch);
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
