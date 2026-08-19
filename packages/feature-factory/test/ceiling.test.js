// The ceiling. This test exists to fail when scope grows.
//
// The build plan listed non-goals as refusals, not deferrals. Prose cannot
// enforce that: the inherited 43,013 lines were each individually defensible
// at the time. So the command set, the run.json key set, the family list, and the
// absence of the dropped subsystems are asserted here as exact values.
//
// Widening any of them requires editing this file, which is the point: the
// decision becomes visible in a diff instead of arriving as a reasonable-sounding
// addition. Only Jason widens it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../bin/factory.js";
import { FAMILY_IDS } from "../core/contracts.js";
import { MODES, RUN_KEYS } from "../state/schema.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Widened deliberately when slices/observe landed. The build plan declared
// twelve commands; `validator` and `pr` are not built yet, so they are absent here
// and adding them will be another visible diff.
// All twelve commands the build plan declared are built. Issue #243 authorizes the thirteenth:
// explicit resume is the sole transition that clears a parked needs-human stop. Run 257 authorizes
// one parked amendment command that changes only an unmerged slice's ownership and history.
const CLI_COMMANDS = [
  "init", "status", "amend-paths", "resume", "lock", "heartbeat", "gate", "step", "terminal",
  "slices-seed", "slice", "observe", "validator", "pr", "reverify-repair", "effective-push",
];

const RUN_JSON_KEYS = [
  // the inherited fifteen
  "version", "run_id", "issue_key", "branch", "worktree", "pr_base", "pr_draft", "created_at", "updated_at",
  "status", "max_parallel_slices", "max_retries", "gates", "steps", "slices", "validator", "pr_url",
  // the four justified additions. base_commit was dropped: it was written and never
  // read, which is the standard a durable field has to meet. plan_digest meets it: the seed reads
  // it and refuses on mismatch, which is the only thing binding the plan a human approved to the
  // one that gets ratified.
  "mode", "terminal_result", "plan_digest", "bootstrap_command", "bootstrap_exit",
];

const FAMILIES = ["envelope", "gates", "steps", "slices", "verdict"];

// The chain the build plan settled: story -> spec -> decomposition ->
// (impl -> review -> merge) x n -> test-verifier -> implementation-validator -> PR.
// security-reviewer is absent deliberately; it is a declared non-goal.
const AGENT_NAMES = [
  "story-reader", "story-writer", "codebase-researcher", "design-interpreter", "spec-writer",
  "work-decomposer", "work-reviewer", "test-verifier", "implementation-validator",
  "backend-builder", "frontend-builder",
];

// Dropped subsystems. Each was a top-level run.json field or a module in the
// predecessor; none is required by the inherited design plus atomic transitions and autonomy.
const FORBIDDEN_SUBSTRINGS = [
  "post_pr", "continuation", "checkpoint_source", "checkpoint_progress",
  "integration_amendment", "integration_gate", "steering", "cost_attribution",
  "delivery_envelope", "special_builder_dispatch", "debug_snapshot", "review_tier",
  "dispatch_claim", "completion_token", "hash_chain", "claim_nonce",
];

// Finding 7: this scanner skipped hidden directories and every extension but .js, so
// scope could grow in a `.hidden/` module or an imported `.mjs` file and the ceiling
// stayed green. Only node_modules and .git are skipped now, and every JS extension
// counts.
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".json"];
// Prose is scanned for dropped subsystems too, but not counted toward the line
// tripwire. The agents and the skill are instructions to a model, so a subsystem
// deleted from the code can walk straight back in as a paragraph telling an agent to
// write a receipt or honour a checkpoint — and every one of these files arrived from
// the predecessor carrying exactly that. The tripwire stays code-only because prose
// length is not the scope risk; a dropped subsystem reappearing is.
const PROSE_EXTENSIONS = [".md"];

function sourceFiles(dir = pkg, found = [], extensions = SOURCE_EXTENSIONS) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found, extensions);
    else if (extensions.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

// Finding 7: forbidden names were matched as exact case-sensitive substrings, so a
// `postPR` alias passed. Comparison is now on a normalized form — lowercased with
// separators stripped — so post_pr, postPr, post-pr and postPR all collide.
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const files = sourceFiles();
const productionFiles = files.filter((path) => !path.includes(`${pkg}/test/`));
const proseFiles = sourceFiles(pkg, [], PROSE_EXTENSIONS);

describe("ceiling — scope cannot grow without editing this file", () => {
  it("exposes exactly the declared CLI commands, and the skill invokes only those", () => {
    assert.deepEqual(Object.keys(COMMANDS).sort(), [...CLI_COMMANDS].sort());
    assert.deepEqual(Object.keys(COMMANDS).slice(0, 4), ["init", "status", "amend-paths", "resume"]);
    assert.deepEqual(COMMANDS.init, [
      "--repo", "--branch", "--worktree", "--pr-base", "--issue", "--mode",
      "--max-parallel-slices", "--max-retries", "--now", "--json",
    ]);
    assert.deepEqual(COMMANDS.resume, ["--repo", "--session", "--now", "--json"]);
    assert.deepEqual(COMMANDS["amend-paths"], ["--repo", "--add", "--reason", "--session", "--now", "--json"]);
    assert.deepEqual(COMMANDS["reverify-repair"], ["--repo", "--now", "--json"]);
    assert.deepEqual(COMMANDS["effective-push"], []);
    assert.deepEqual(MODES, ["interactive", "headless", "autonomous"]);

    // The workflow is the authoritative host-neutral instruction set, and nothing checked it against the CLI
    // it drives. Four of its examples had drifted far enough to block a normal merge and the
    // late-head recovery — including one this session introduced while correcting the same
    // command elsewhere in the same round. Every prose fix so far was found by reading, which
    // is why they kept coming back.
    const markdown = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
    assert.equal(markdown.startsWith("---\n"), false, "WORKFLOW.md is not a platform skill");
    for (const platformToken of ["OpenCode", "feature_background", "run-orchestrator", "FACTORY_SESSION_ID", "--background"]) {
      assert.equal(markdown.includes(platformToken), false, `WORKFLOW.md must stay host-neutral: ${platformToken}`);
    }
    // These are instruction, and this pins them against silent deletion — nothing more. It cannot
    // prove a run performs the satisfiability check or records a decision where the next run reads
    // it; only a future run parking correctly on a contradictory brief shows that. Said plainly
    // because a presence assertion reads like coverage and is not.
    //
    // Each fragment sits on one line in the raw markdown. One spanning a line wrap could never
    // match, and would fail for a reason unrelated to the rule it guards.
    for (const instruction of [
      // Three of the four runs that stopped on their own brief stopped on a contradiction between
      // two criteria, a criterion and a scope lock, or a criterion and a pinned dependency.
      // Nothing in this workflow compared them before this.
      "is a defect in the issue, not work to attempt",
      // The risk the instruction names, and the reason it is worth writing down even unenforced:
      // silently satisfying the easier criterion yields a green suite and a merged change that does
      // not do what the issue asked. Enforcing it would need the pairs recorded in the brief
      // artifact and the gate refusing without them, which is a schema change and is not here.
      "Do not choose one side silently",
      // A module split from the test asserting an exact inventory over it leaves no legal move once
      // paths are seeded, because a slice may not edit a path it does not own.
      "asserts an exact closed inventory over it in one",
      // A brief-level contradiction cannot be fixed by resuming: resume continues from the existing
      // manifest and never re-reads the issue, so the edited body cannot reach a retained run's
      // artifacts. The route is record, abandon, replace — and this pins that it says so.
      "The supported",
      "route is: record the decision in the issue body, then have the operator remove the retained sandbox",
      // The reason the removal is load-bearing rather than incidental: without it a relaunch
      // reselects the parked run, because the run id is deterministic and init refuses to collide.
      "reselects the parked run instead of replacing it",
      // mimir 1551 ratified `uv run python -c "..."` as its only entry because this bullet called an entry a
      // "command string" and never said it is argv-split with no shell. Seeding still admits that entry, and
      // the end-to-end payload rows pin it as admitted, so these fragments are the whole of the prevention:
      // they stop a decomposer authoring the shape rather than refusing it after the fact.
      "executed as argv split on single spaces with no shell",
      "are alternatives, not a sequence",
      // mimir 1569's decomposer first wrote `./scripts/x.sh`, which seeding refuses because argv[0] is resolved
      // at Gate 2 and the work had not created it yet. It recovered on its own by moving to `sh scripts/x.sh`,
      // which costs an attempt; these pin the shape that works so the next decomposer does not pay for it.
      "resolved against the repository when the plan is seeded",
      "interpreter that already resolves and pass the script as an argument",
    ]) {
      assert.ok(markdown.includes(instruction), `WORKFLOW.md no longer instructs: ${instruction}`);
    }
    const admissionIndex = markdown.indexOf("## Mode admission");
    const operatingModesIndex = markdown.indexOf("## Operating modes");
    const intakeIndex = markdown.indexOf("## Step 0 — Intake, run id, lock, manifest");
    assert.ok(admissionIndex >= 0 && admissionIndex < operatingModesIndex && operatingModesIndex < intakeIndex,
      "mode admission must run before operating-mode behavior and all intake");
    for (const fragment of [
      "Before any intake action, including ticket, story, or design detection, branch intent, run-id\nderivation, manifest or state reads, and every `factory` command, process the raw invocation arguments",
      "Ignore leading whitespace.",
      "The **mode prefix** is the maximal consecutive sequence of\nwhitespace-delimited tokens that are exactly and case-sensitively `--autonomous` or `--headless`.",
      "The first other token ends the prefix.",
      "If both distinct flags occur in that prefix, in either order, return exactly:",
      "`conflicting mode flags: --autonomous and --headless; choose one`.",
      "Return immediately, before any\n   intake, run-id derivation, state read, or CLI action. Never fall back to interactive or another\n   mode.",
      "remove every token in the recognized prefix and its separating whitespace. Use only the\n   unchanged remainder for ticket detection, story content, design detection, branch intent, and\n   run-id derivation.",
      "`--autonomous` maps only to `factory init --mode autonomous`.",
      "`--headless` maps only to `factory init --mode headless`.",
      "With no recognized leading mode token, omit `--mode`; existing `factory init` records\n     `interactive`.",
      "Repeated copies of one recognized flag are idempotent: remove them all and select that mode once.",
      "An\nexact mode token after the first other token is request content and neither selects nor conflicts.",
      "Natural-language intent, `--interactive`, capitalization variants, abbreviations, assignment or\npunctuation forms, quoted lookalikes, and near misses are request content, not selectors.",
      "an existing manifest always resumes its immutable persisted\nmode. Invocation flags never reinitialize, compare, or mutate an existing run's mode.",
      "Using only the request remainder produced by mode admission:",
    ]) assert.ok(markdown.includes(fragment), `skill mode-admission contract is missing: ${fragment}`);
    assert.equal(markdown.includes("Only when the invocation explicitly requests it."), false);
    assert.equal(markdown.includes("Never infer it from vague wording."), false);
    // Join shell continuations so one command is one string, then read only code — fenced
    // blocks, effective-push's indented command sites, and inline spans — so prose cannot be mistaken for an invocation.
    const text = markdown.replace(/\\\n\s*/gu, " ");
    const snippets = [];
    for (const [, body] of text.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)) snippets.push(...body.split("\n"));
    for (const [, body] of text.matchAll(/^ {4}(factory effective-push .+)$/gmu)) snippets.push(body);
    for (const [, body] of text.matchAll(/`([^`\n]+)`/gu)) snippets.push(body);

    // Not anchored at the start of the snippet: an invocation quoted mid-sentence inside a
    // code span was skipped entirely by `/^\s*factory/`. Flags are read from the command
    // onward and stop at the next invocation, so two on one line do not pool their flags.
    const invocations = [];
    for (const snippet of snippets) {
      const found = [...snippet.matchAll(/\bfactory\s+([a-z-]+)\b(?!:)/gu)];
      found.forEach((match, index) => {
        const tail = snippet.slice(match.index, found[index + 1]?.index ?? snippet.length);
        invocations.push({
          snippet: tail.trim(),
          command: match[1],
          flags: [...tail.matchAll(/--[a-z][a-z-]*/gu)].map((flag) => flag[0]),
          // A back-reference elided with U+2026 — `factory slice \u2026 running` — is a pointer to an
          // invocation given in full elsewhere, not a runnable example. Its flags are still checked
          // against the CLI, because naming a flag that does not exist is wrong either way; it is
          // only exempt from *required*-flag checks, since omission is the whole point of an ellipsis.
          elided: tail.includes("\u2026"),
        });
      });
    }
    assert.ok(invocations.length >= 10, `only ${invocations.length} documented invocations found; the parser is broken, not the skill`);

    // Both directions. Without this, deleting every mention of a command passes as long as
    // the invocation floor above is still met by the others — an orchestrator following the
    // skill would simply never learn the command exists.
    assert.deepEqual(
      [...new Set(invocations.map(({ command }) => command))].sort(),
      [...CLI_COMMANDS].sort(),
      "every CLI command must appear in the skill, and the skill must invoke no others",
    );

    // Removing or renaming a flag is the drift that actually happens — --reviewed-head,
    // --skip-tests-reason, --force and --worktree all went this session — so it is checked
    // generally rather than case by case.
    const unknown = [];
    for (const { command, flags, snippet } of invocations) {
      if (!Object.hasOwn(COMMANDS, command)) {
        unknown.push(`unknown command '${command}': ${snippet}`);
        continue;
      }
      for (const flag of flags) {
        if (!COMMANDS[command].includes(flag)) unknown.push(`'${command}' has no ${flag}: ${snippet}`);
      }
    }
    assert.deepEqual(unknown, [], "the skill documents a command or flag the CLI does not accept");
    const cliSource = readFileSync(join(pkg, "bin", "factory.js"), "utf8");
    assert.ok(cliSource.indexOf("  factory amend-paths <run-id>") < cliSource.indexOf("  factory resume <run-id>"));
    assert.ok(cliSource.includes("  factory reverify-repair <run-id> <repair-record-id> [--repo PATH] [--now ISO] [--json]"));
    const initPublicationSource = readFileSync(join(pkg, "bin", "init-publication.js"), "utf8");
    const readme = readFileSync(resolve(pkg, "..", "..", "README.md"), "utf8");
    assert.ok(COMMANDS.init.includes("--pr-base"));
    const initHandler = /  async init\(positional, flags\) \{\n([\s\S]*?)\n  \},\n\n  status/u.exec(cliSource)?.[1];
    const initOperations = /const INIT_OPERATIONS = Object\.freeze\(\{([\s\S]*?)\n\}\);/u.exec(cliSource)?.[1];
    const dispatchInitSource = /export async function dispatchInit\(positional, flags, operations = INIT_OPERATIONS\) \{\n([\s\S]*?)\n\}\n\nfunction preflightInit/u.exec(cliSource)?.[1];
    assert.equal(initHandler?.trim(), "return dispatchInit(positional, flags);",
      "HANDLERS.init must delegate to dispatchInit without an operations override or direct publication");
    assert.match(initOperations ?? "",
      /(?:^|\n)  runGit: git, prove: proveInitContainment, publish: dispatchInitPublication,(?:\n|$)/u,
      "dispatchInit's default operations must use the private publication dispatcher");
    assert.match(dispatchInitSource ?? "", /(?:^|\n)  const dispatchInitPublication = publish;(?:\n|$)/u,
      "dispatchInit must select publication from its operations");
    assert.match(dispatchInitSource ?? "",
      /(?:^|\n)  const \{ observedRun \} = await dispatchInitPublication\(\{ runDir, sandboxPath: S, candidate: run, finalGuard: proveContainedBranch \}\);(?:\n|$)/u,
      "dispatchInit must await private publication with its derived paths, validated candidate, and the containment-inclusive final guard");
    assert.match(initPublicationSource,
      /\{ writer = writeProtectedJsonAtomic, observeTarget = observeInitTarget \} = \{\},[\s\S]*?if \(finalGuard\) await finalGuard\(\);[\s\S]*?await writer\(runDir, "run\.json", candidate, \{ createOnly: true \}\)/u,
      "the private dispatcher must invoke the create-only protected writer");
    assert.ok(cliSource.includes("[--branch B=feature/<run-id>] [--worktree W=.] [--pr-base TARGET]"));
    assert.ok(markdown.includes('factory init "$R" --branch "$FEATURE_BRANCH" [--worktree "$WORKTREE"] [--pr-base "$PR_BASE"] [--issue "$KEY"] [--mode "$MODE"] --repo "$O" --json'));
    assert.ok(readme.includes("factory init <run-id> [--branch B] [--worktree W] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]"));
    assert.ok(markdown.includes('gh pr create --draft --base "<pr_base>" --head "<branch>" --title "<title>" --body-file "<body-file>"'));
    assert.ok(markdown.includes('gh pr create --base "<pr_base>" --head "<branch>" --title "<title>" --body-file "<body-file>"'));

    // Omissions and wrong argument *values* cannot be derived from the flag lists, so the few
    // that blocked the path are named. Each entry is one refusal a reader would otherwise hit.
    //
    // Deliberately only flags the handler accepts as optional but a *later* command needs.
    // Flags a handler rejects immediately — init --branch/--worktree, observe --base, validator
    // --report, pr --url, terminal --reason — are left out: the CLI already refuses those on
    // the spot, so documenting them wrong fails loudly at the first attempt and needs no test.
    const required = [
      { command: "lock", when: /\bsteal\b/u, flag: "--session", why: "claiming a stolen lock needs a session id" },
      { command: "slice", when: /\breview\b/u, flag: "--review-ref", why: "the merge refuses a slice with no review_ref" },
      { command: "slice", when: /\breview\b/u, flag: "--evidence-ref", why: "the merge refuses a slice with no evidence_ref" },
      { command: "slice", when: /\brunning\b/u, flag: "--branch", why: "the merge refuses a slice with no recorded branch" },
      { command: "slice", when: /\brunning\b/u, flag: "--worktree", why: "an unset worktree falls back to the repository root instead of the isolated slice tree" },
    ];
    for (const { command, when, flag, why } of required) {
      const relevant = invocations.filter((entry) => entry.command === command && !entry.elided && when.test(entry.snippet));
      assert.ok(relevant.length > 0, `no documented '${command}' invocation matching ${when}`);
      for (const entry of relevant) {
        assert.ok(entry.flags.includes(flag), `${entry.snippet}\n  must pass ${flag}: ${why}`);
      }
    }
    // A branch name can never equal the slice's recorded base_ref sha, so evidence observed
    // against one is refused at merge — and the branch moves as siblings land.
    assert.equal(/--base\s+<feature-branch>/u.test(markdown), false,
      "observe --base must be the slice's recorded base_ref sha, not a mutable branch name");

    // Every agent the skill dispatches must ship with the package. The predecessor's agent
    // definitions lived in a separate assets/ tree, so the skill named seven agents the
    // package did not contain and could not run a feature at all.
    const targetList = /The only specialized task targets a run driver may dispatch are exactly:\n\n((?:- `[^`\n]+`\n)+)\nA specialist must not dispatch/u.exec(markdown)?.[1] ?? "";
    const dispatched = [...new Set([...targetList.matchAll(/^- `([^`\n]+)`$/gmu)]
      .map(([, name]) => name))];
    const shipped = readdirSync(join(pkg, "agents")).filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.replace(/\.md$/u, ""));
    assert.deepEqual(dispatched.sort(), [...AGENT_NAMES].sort(),
      "the skill must recognize exactly the declared dispatched agents");
    assert.ok(markdown.includes("binding policy even if its host cannot enforce target names structurally."),
      "the workflow must require adapters to enforce the closed target list");
    // And nothing ships that the chain never runs — security-reviewer is a declared non-goal,
    // so its presence would mean a dropped stage walked back in as a file.
    assert.deepEqual(shipped.sort(), [...AGENT_NAMES].sort(),
      "the shipped agents must equal the declared chain");

    // Two properties of the agent prompts, both defects found by reading them:
    //
    // 1. The claim block an agent emits is parsed by `factory observe --claim` and reconciled
    //    field by field against what the orchestrator observes. The prompts said
    //    `"status": "pass"`, which mismatches the evidence vocabulary, so every builder
    //    following its own prompt would record a disagreement and block its own slice.
    //    Verified against reconcileClaim before fixing.
    // 2. They came from one repository and named its stack throughout. A repository-neutral
    //    package that hands an agent another project's file layout sends it looking for paths
    //    that do not exist.
    const agentText = shipped.map((name) => ({ name, text: readFileSync(join(pkg, "agents", `${name}.md`), "utf8") }));

    // 3. A plan can be contradictory in its own order and pass every check that existed. mimir run
    //    1387 gave an earlier slice a test asserting a module's absence and a later slice the module;
    //    pytest collection imports both test files before either runs, so the earlier suite failed the
    //    moment the later slice landed, and `paths` freeze at seeding so nothing could repair it. The
    //    two slices shared no path, so file-disjointness saw nothing. Four slices of work reached a stop
    //    that was decided at seeding. The decomposer must not emit such a plan and the reviewer must
    //    block it; both are decidable from the plan alone, which is why neither is a CLI guard.
    //    The narrowing matters as much as the rule. A first pass blocked any earlier slice asserting a
    //    later-owned path is unreachable, which also condemns a valid dependency-direction invariant
    //    proven statically — the very form the decomposer recommends. So both sides are pinned on the
    //    distinction, not merely on the prohibition: what blocks is a claim the later path invalidates.
    const byName = new Map(agentText.map(({ name, text }) => [name, text]));
    // Instruction, not enforcement, pinned only against silent deletion: a plan deadlock blocks rather
    // than producing a false green, and "does this slice change an interface" is not computable here.
    // mimir 1410 lost a run at seven of ten merged slices because an interface change and its callers
      // sat apart, and 1423 lost one because a merged slice read an env var whose documented inventory
    // lived in a later slice -- so the rule earns a presence assertion even though
    // nothing can enforce it. Each fragment sits on one line in the raw markdown.
    for (const [agent, fragment] of [
      ["work-decomposer", "A slice must be able to make its ratified `test_plan` green using only the paths it owns."],
      ["work-decomposer", "`observe` executes each ratified command as argv with no shell"],
        ["work-decomposer", "The trigger is invalidation, not change."],
        ["work-decomposer", "Moving a repo-wide rule whose inventory another slice owns."],
      ["work-decomposer", "If you cannot satisfy it, merge the slices rather than ordering them."],
      ["work-reviewer", "green using only that slice's own `paths`"],
    ]) {
      assert.ok(byName.get(agent)?.includes(fragment),
        `${agent}.md must keep the interface-ownership rule: ${fragment}`);
    }
    // Enforcement: these checks prevent false-green drift in shipped agent contracts.
    const forbiddenAgentTerms = /jira|atlassian|figma|logrocket|confluence|cloudid|tracker[ _-]?key|context7|get_best_practices|search_documentation|find_examples/giu;
    // Enforcement: the declaration above IS the guard, so the declaration itself must be pinned.
    // The scan below runs against a corpus that is clean today, so deleting a token from the regex
    // leaves every agent file passing and the suite green — the check would quietly stop covering
    // the term it was added for, which is the false green this whole block exists to prevent. Each
    // row proves the detector still fires for one prohibited form, independently of the corpus.
    // `String.match` is used rather than `.test` because the regex is global and `.test` would
    // advance `lastIndex` between rows.
    const forbiddenTermProbes = [
      ["jira", "file the Jira ticket first"],
      ["atlassian", "see the Atlassian docs"],
      ["figma", "open the Figma frame"],
      ["logrocket", "check LogRocket for the session"],
      ["confluence", "linked from the Confluence page"],
      ["cloudid", "pass the cloudId parameter"],
      ["tracker key", "record the tracker key"],
      ["tracker_key", "read the tracker_key field"],
      ["tracker-key", "read the tracker-key field"],
      ["trackerkey", "read the trackerkey field"],
      ["context7", "resolve the library through context7"],
      ["get_best_practices", "call get_best_practices first"],
      ["search_documentation", "call search_documentation for the API"],
      ["find_examples", "call find_examples for usage"],
    ];
    for (const [term, probe] of forbiddenTermProbes) {
      assert.ok(probe.match(forbiddenAgentTerms)?.length,
        `forbiddenAgentTerms no longer detects '${term}' — the declaration was weakened`);
    }
    // The other direction: a detector that matched ordinary prose would make the scan unfalsifiable,
    // because every agent file would have to be written around it rather than around the rule.
    for (const benign of [
      "the issue key is recorded on the branch",
      "use whatever documentation tool this repository provides",
      "track the work in the run manifest",
    ]) {
      assert.equal(benign.match(forbiddenAgentTerms), null,
        `forbiddenAgentTerms over-matches ordinary prose: ${benign}`);
    }
    const agentPolicyFiles = sourceFiles(join(pkg, "agents"), [], PROSE_EXTENSIONS);
    const agentPolicyOffenders = agentPolicyFiles.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(forbiddenAgentTerms)]
        .map(([token]) => `${relative(pkg, path)} :: ${token}`));
    assert.deepEqual(agentPolicyOffenders, [], "shipped agent prose contains a prohibited vendor or operational tool identifier");
    const requiredAgentFragments = [
      // Class-wide classification is what makes the finite-inventory requirement and the reviewer's
      // acceptance bar apply, so the trigger has to be the property of the claim rather than four
      // keywords. mimir #1423 spent four runs and zero slices on a criterion that quantified over an
      // open set ("absence of a standalone-runtime path") using none of the words: nothing demanded a
      // finite inventory, so review rejected at finer granularity every round. All three steps that
      // act on the classification are pinned, because widening one alone would have the reviewer
      // demand an inventory the researcher was never told to build.
      // Paired on purpose. The first version of this widening said "its truth depends on a set the
      // criterion does not enumerate", which is also true of an *existential* claim -- "a module
      // constructs the runtime" quantifies over an open set and is settled by one witness. That would
      // have imposed closed-world inventory work on ordinary requirements, so each agent pins the
      // universal test *and* the existential exemption. Dropping either half lets the rule collapse
      // back into "any unenumerated set", which over-triggers instead of under-triggering.
      // Rule 4b could not reject an oversized *single-slice* plan: its concentration sentence was guarded by
      // "where the plan has more than one slice" and its exemption said a small feature may still be one
      // slice. Three monoliths exploited that -- 1423 at 30 paths/22 ACs, then 25/17 and 48/12 -- and the
      // last two seeded after briefs began carrying closed inventories. Deleting both clauses was rejected
      // in review: it would leave "none may claim the entire acceptance set" applying to a lone slice, which
      // no one-slice plan can satisfy, imposing a structural minimum of two slices. So the reviewability test
      // is unconditional and the one-slice escape survives but must be *argued*. All four fragments are
      // pinned: the universal test, the justification requirement, the reviewer's blocker, and the
      // over-rejection guard that keeps a genuinely small change to one slice.
      { name: "work-decomposer", label: "reviewability applies to a one-slice plan", fragment: "including the only slice of a" },
      { name: "work-decomposer", label: "one-slice plans must be argued", fragment: "That the brief presents one closed inventory is not a reason." },
      { name: "work-reviewer", label: "unsupported one-slice justification blocks", fragment: "closed inventory, is a BLOCKER" },
      { name: "work-reviewer", label: "small changes are not forced to split", fragment: "is a stated reason, not a minimum slice count" },
      { name: "codebase-researcher", label: "class-wide test is bounded-witness", fragment: "cannot be established by a bounded witness" },
      { name: "codebase-researcher", label: "existential claims are exempt", fragment: "An **existential** criterion is not class-wide" },
      { name: "spec-writer", label: "class-wide test is bounded-witness", fragment: "cannot be established by a bounded witness" },
      { name: "spec-writer", label: "existential claims are exempt", fragment: "An existential criterion is not class-wide and needs no inventory" },
      { name: "work-reviewer", label: "class-wide test is bounded-witness", fragment: "cannot be established by a bounded witness" },
      { name: "work-reviewer", label: "existential claims are exempt", fragment: "An existential claim is the opposite and must **not** be treated as class-wide" },
      { name: "backend-builder", label: "current backend commit-template field", fragment: "<issue_key>: <imperative backend summary>" },
      { name: "backend-builder", label: "backend no-key fallback", fragment: "If no issue key yet, use a short imperative subject" },
      { name: "backend-builder", label: "backend delivery ownership", fragment: "Do **not** push or open a PR" },
      { name: "frontend-builder", label: "generic framework documentation guidance", fragment: "For framework API questions, use whatever framework skill or documentation tool this repository provides rather than guessing from older patterns." },
      { name: "frontend-builder", label: "current frontend commit-template field", fragment: "<issue_key>: <imperative frontend summary>" },
      { name: "frontend-builder", label: "frontend delivery ownership", fragment: "Do **not** push or open a PR" },
      { name: "story-writer", label: "neutral repository classification", fragment: "suggested repository classification" },
      { name: "story-writer", label: "neutral ticket authority", fragment: "never creates or edits an external ticket itself" },
      { name: "story-writer", label: "external-ticket creation boundary", fragment: "You do not create or edit the external ticket" },
      { name: "story-writer", label: "neutral ticket output structure", fragment: "**Suggested ticket fields (orchestrator will use these if you approve creating the ticket):**" },
      { name: "story-writer", label: "draft-only ownership", fragment: "you only draft. The orchestrator handles creation." },
      { name: "story-writer", label: "human ticket-creation gate", fragment: "creating the ticket is a human-gated step the orchestrator performs after approval." },
      { name: "codebase-researcher", label: "neutral research context", fragment: "If an issue reference or design brief is included" },
      { name: "codebase-researcher", label: "code-over-requirements boundary", fragment: "your job is the **code**, not the requirements." },
    ];
    for (const { name, label, fragment } of requiredAgentFragments) {
      assert.ok(byName.get(name)?.includes(fragment), `${name} is missing ${label}: ${fragment}`);
    }
    const decomposer = byName.get("work-decomposer") ?? "";
    const reviewer = byName.get("work-reviewer") ?? "";
    // Rules 6 and 7 were merged into one invariant: a slice must be able to make its ratified
    // `test_plan` green from its own `paths`. This assertion previously pinned rule 6's headline
    // ("No slice may depend on the absence of what another slice owns"), which is now one of three
    // named faces of that invariant rather than a rule of its own. Pinning the invariant instead
    // keeps the guard at the altitude of the thing being guarded; the absence face is still pinned
    // by its own fragment below.
    assert.match(decomposer, /A slice must be able to make its ratified `test_plan` green using only the paths it owns/u,
      "work-decomposer must require each slice's test_plan to be satisfiable from its own paths");
    assert.match(decomposer, /Proving an absence a later slice fills/u,
      "work-decomposer must keep the absence face of the satisfiability invariant");
    assert.match(decomposer, /how\*\* a negative claim survives later slices/u,
      "work-decomposer must require a negative claim to state how it survives later slices");
    assert.match(decomposer, /Stable once it lands/u,
      "work-decomposer must keep the stable-invariant case, or a valid plan reads as contradictory");
    // Both reviewer fragments live in the `work-decomposer` satisfiability bullet. They used to sit in
    // the "Doc steps" bullet, which stated the same invariant a second time from the pre-merge angle --
    // two copies of one rule, where an edit can fix one and leave the other. These assertions search the
    // whole file rather than a bullet, so they followed the rule to its single home unchanged.
    assert.match(reviewer, /the landing of a later slice's owned path would invalidate\*\* is a BLOCKER/u,
      "work-reviewer must block on invalidation by the later path, not on negative phrasing");
    assert.match(reviewer, /must \*\*not\*\* be blocked/u,
      "work-reviewer must exempt a claim whose proof survives the later slice");

    const claimants = agentText.filter(({ text }) => text.includes('"status":'));
    assert.ok(claimants.length >= 3, "the builders and the test-verifier all emit claim blocks");
    for (const { name, text } of claimants) {
      assert.ok(/"status": "completed\|blocked"/u.test(text),
        `${name} must document the claim status vocabulary evidence uses; "pass" reads as a disagreement`);
    }

    // Widened after a review found survivors: my first pass listed frameworks and file trees and
    // missed *named products and fixtures* — database grant roles, a feature-flag vendor, a commit
    // hook, a formatter, a package manager, a selector attribute, a hardcoded port. Those are the
    // ones that read as generic advice while only being true of one repository.
    const REFERENCE_STACK = new RegExp([
      // frameworks, build tools, test runners
      "graphql", "liquibase", "blaze", "angular", "playwright", "jhipster", "gradle", "junit",
      "\\bjest\\b", "\\bbun\\b", "husky", "prettier", "vitest", "\\bnpx\\b",
      // framework idioms that only exist in one framework
      "ngclass", "onpush", "signal store", "standalone: true",
      // named products, roles and fixtures
      "launchdarkly", "featureflagguard", "metabaseusr", "iam_readonly", "referenceproduct",
      "client api", "data-pw", "e2e-cli", "build:local", "format:write",
      // paths, branches and ports that are one repository's
      "src\\/main\\/", "origin\\/development", "localhost:\\d+", ":9000",
    ].join("|"), "iu");
    const prose = [...agentText, { name: "WORKFLOW.md", text: markdown }];
    const leaked = prose.filter(({ text }) => REFERENCE_STACK.test(text)).map(({ name }) => name);
    assert.deepEqual(leaked, [], "an agent names the reference repository's stack instead of asking this one");

    // Host neutrality, which is a different axis from stack neutrality and was missed by the regex
    // above. Genericising the agents replaced the inherited stack with `CLAUDE.md` throughout — one host's
    // filename, in a package whose own description says host-agnostic, shipped to run under opencode,
    // which reads AGENTS.md. Naming either file alone is the defect; naming both is the fix.
    const oneSided = prose
      .filter(({ text }) => text.includes("CLAUDE.md") !== text.includes("AGENTS.md"))
      .map(({ name }) => name);
    assert.deepEqual(oneSided, [],
      "prose names one host's instructions file alone; name both AGENTS.md and CLAUDE.md");

    const tools = (text) => (/^tools:\s*(.*)$/mu.exec(text)?.[1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    for (const name of ["story-reader", "design-interpreter"]) {
      assert.deepEqual(tools(agentText.find((entry) => entry.name === name)?.text ?? ""), ["Read", "Grep", "Glob"],
        `${name} must declare exactly the generic read capabilities`);
    }
    const namedToolMarker = ["mcp", "__"].join("");
    assert.deepEqual(agentText.filter(({ text }) => text.toLowerCase().includes(namedToolMarker)).map(({ name }) => name), [],
      "shipped agents must not contain a hardcoded external tool identifier");
    const design = agentText.find(({ name }) => name === "design-interpreter")?.text ?? "";
    for (const pattern of [/context[^\n]*tree|tree[^\n]*context/iu, /screenshot/iu, /token/iu, /component mapping/iu]) {
      assert.match(design, pattern, `design-interpreter is missing capability prose: ${pattern}`);
    }
    assert.match(design, /absent[^.]*gap|gap[^.]*absent/iu);
    assert.match(design, /do not infer/iu);

    const repo = resolve(pkg, "..", "..");
    const scannedExtensions = [...SOURCE_EXTENSIONS, ".jsx", ...PROSE_EXTENSIONS];
    const packageFiles = execFileSync(
      "git",
      ["ls-files", "--", "packages/feature-factory", "packages/opencode-feature-factory"],
      { cwd: repo, encoding: "utf8" },
    ).split("\n").filter((path) => scannedExtensions.some((extension) => path.endsWith(extension)))
      .map((path) => join(repo, path)).filter(existsSync);
    // There is deliberately no guard here on the predecessor's name, and this comment exists so the next reader
    // does not add one back. It tested for a four-character substring, which ordinary English contains: `advisory`
    // and `supervisor` both matched, and it blocked an autonomous run over a local variable that had nothing to do
    // with the predecessor. It also had no comment saying what it protected. By the rule this repository governs
    // itself with -- enforce what can produce a false green, instruct the rest -- a brand name surviving in prose
    // is not a false green, and the documents that carried the real references are gone from the tree.
    //
    // The markers below are the opposite case and stay. They are distinctive API names, matched case-sensitively,
    // and their reappearance means removed compatibility code came back with them.
    const removedMarkers = [
      ["validate", "Run", "For", "Read"].join(""),
      ["read", "Envelope"].join(""),
      ["validate", "Envelope"].join(""),
      ["jira", "key"].join("_"),
    ];
    const removedOffenders = packageFiles.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return removedMarkers.filter((marker) => text.includes(marker))
        .map((marker) => `${path.slice(repo.length + 1)} :: ${marker}`);
    });
    assert.deepEqual(removedOffenders, [], "removed state compatibility names must not remain in either package");
  });

  it("declares exactly the declared run.json top-level keys", () => {
    assert.deepEqual([...RUN_KEYS].sort(), [...RUN_JSON_KEYS].sort());
    assert.equal(RUN_KEYS.length, 22, "twenty-two: the prior twenty-one plus immutable PR draft policy");
  });

  it("registers exactly the declared families", () => {
    assert.deepEqual([...FAMILY_IDS].sort(), [...FAMILIES].sort());
  });

  it("contains no trace of a dropped subsystem, under any spelling", () => {
    const offenders = [];
    for (const path of [...productionFiles, ...proseFiles]) {
      const normalized = normalize(readFileSync(path, "utf8"));
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        // The ceiling test names them to forbid them, so it exempts itself.
        if (normalized.includes(normalize(needle))) offenders.push(`${path.slice(pkg.length + 1)} :: ${needle}`);
      }
    }
    assert.deepEqual(offenders, [], "a dropped subsystem reappeared");
  });

  it("finds scope hidden in a dot-directory, a .mjs file, or a camelCase alias", () => {
    // Asserting the scanner's constants proved nothing: disabling hidden traversal,
    // .mjs traversal, or normalization left the suite green. This builds a tree
    // containing each evasion and asserts the scanner and the matcher actually catch
    // it, so those protections cannot silently regress.
    const root = mkdtempSync(join(tmpdir(), "ff-ceiling-probe-"));
    try {
      mkdirSync(join(root, ".hidden"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, ".hidden", "sneaked.js"), "export const x = 'post_pr';\n");
      writeFileSync(join(root, "alias.mjs"), "export const y = 'steering';\n");
      writeFileSync(join(root, "camel.js"), "export const postPR = 1;\n");
      writeFileSync(join(root, "ignored.txt"), "post_pr\n");
      writeFileSync(join(root, "node_modules", "vendor.js"), "post_pr\n");

      const found = sourceFiles(root).map((path) => path.slice(root.length + 1));
      assert.ok(found.includes(join(".hidden", "sneaked.js")), "a hidden directory must be scanned");
      assert.ok(found.includes("alias.mjs"), "a .mjs file must be scanned");
      assert.ok(found.includes("camel.js"));
      assert.equal(found.includes(join("node_modules", "vendor.js")), false, "node_modules stays skipped");

      // The matcher, on the same fixtures.
      const offenders = found.filter((relative) => {
        const text = normalize(readFileSync(join(root, relative), "utf8"));
        return FORBIDDEN_SUBSTRINGS.some((needle) => text.includes(normalize(needle)));
      }).sort();
      assert.deepEqual(offenders, [join(".hidden", "sneaked.js"), "alias.mjs", "camel.js"].sort(),
        "each evasion must be caught: hidden directory, .mjs, and a camelCase alias");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("imports nothing from the predecessor tree", () => {
    const offenders = files
      .filter((path) => /from\s+["'][^"']*\/src\//u.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(pkg.length + 1));
    assert.deepEqual(offenders, [], "the old tree is a reference, never a dependency");
  });

  it("depends on nothing outside the node standard library", () => {
    const offenders = [];
    for (const path of files) {
      for (const [, specifier] of readFileSync(path, "utf8").matchAll(/from\s+["']([^"']+)["']/gu)) {
        const bare = !specifier.startsWith(".") && !specifier.startsWith("node:");
        if (bare) offenders.push(`${path.slice(pkg.length + 1)} :: ${specifier}`);
      }
    }
    // The standalone package must build and test with no opencode installed, and
    // a zero-dependency package is the cheapest way to keep that true.
    assert.deepEqual(offenders, [], "the standalone package takes no third-party dependency");
  });

  it("keeps the production surface small enough to read in one sitting", () => {
    const total = productionFiles.reduce((sum, path) => sum + readFileSync(path, "utf8").split("\n").length, 0);
    // 2000 -> 2500 when the twelfth command landed. 2500 was the build plan's stated
    // upper bound for the whole system and was described here as a number that could not
    // be quietly raised again. This raise is therefore not quiet: Jason authorized it
    // explicitly, for three named findings, after the removals below were made first.
    //
    // Closed by the lines this buys:
    //   * publication readiness centralized in one function and invoked at Gate 3's
    //     approval, not only in `factory pr`. The skill pushes the branch and creates the
    //     PR before calling `factory pr`, so every check that lived there was post-effect:
    //     it could describe a bad publication but not prevent one.
    //   * `test_plan` ratified on the slice row, replacing `observe --skip-tests-reason`,
    //     under which the party being observed wrote its own exemption from testing.
    //   * the gates contract's reobserve hook, without which a registered readiness
    //     observer is accepted and never called - the third instance of that defect.
    //
    // Paid for first, so the raise covers only what is new: `lock inspect` and `--force`
    // (duplicates of `status` and `steal`), `treeEntries` and `observeTree` (dead once
    // the merge proof became a diff), and three copies of the integration-head
    // observation collapsed into one helper.
    //
    // Reduction candidate if this has to come down again: core/run-lock.js (331 lines) is
    // the largest ported file. Its quarantine machinery is NOT the candidate - that is
    // active correctness machinery - but its hook plumbing exceeds what twelve commands
    // use.
    // Raised to 2700 for the publication-authorization findings and then **put back**,
    // because the deletion arrived: run-lock.js gave up 70 lines of plumbing no caller used
    // — a contended-error class and reclaimMode nothing selects, two reclaim wrappers whose
    // only content was a null check, a six-hook object collapsed to the one `onBeforeSteal`
    // seam a test actually needs, owner-detail timeout formatting, run-lock's own
    // stolen_from bookkeeping, a configurable retry delay nobody set, and five dead imports
    // — plus write-core's unused lockOptions and beforeRename pass-throughs.
    //
    // Its quarantine machinery, the steal seam, both CAS comparisons, and the atomic
    // writer's beforeCommit hook all stay: those are live correctness machinery.
    //
    // So the number is 2650 again, and the precedent is the one worth keeping: a raise is a
    // debt, and the next one should be paid the same way.
    //
    // 2650 -> 2655, unpaid, for the single-slice validator rule in assertPublicationReady: the
    // slice-count branch, and the split that keeps a *recorded* verdict binding even when one was
    // not required. Four lines of it are the comment explaining why skipping is safe and why zero
    // slices is not the same case, which is the part a future reader cannot reconstruct. Debt.
    //
    // 2655 -> 2666, one correctness fix in the lock steal, in two parts because the first part
    // exposed the second. The steal established "still the lock I judged stale" from the lock
    // directory's dev/ino alone, and Linux reuses inode numbers, so a lock deleted and recreated at
    // the same path presented the recorded identity and a *live* lock was renamed away — green on
    // APFS, red on Linux. Comparing the owner nonce fixed that and widened the window between
    // observing the identity and renaming, which surfaced the second part: losing the race threw
    // instead of retrying, because only ENOENT counted as losing. Both are now retries.
    //
    // Neither part is a feature, and the lines are the two checks plus the notes recording that the
    // original falsification of this pre-check's removal ran only where inodes are not reused.
    //
    // Equality was tried, reverted, and then deliberately restored. Recording that here, because the
    // note used to argue against the assertion sitting immediately below it, and #225 was filed on
    // exactly that contradiction.
    //
    // Why equality earns its place: `assert.equal(total, N)` records reductions as well as growth.
    // Under `<`, trimming five lines leaves five lines of headroom nobody voted for, and the next
    // addition spends it silently.
    //
    // Why it was reverted once, and the cost is real: a run that deletes a line incidentally fails a
    // lock its plan never predicted, in a file it does not own, and the cheapest way back to green is
    // to ADD a meaningless line. Manufacturing scope to satisfy an assertion is worse than the offset
    // equality was meant to catch, and it is the move an agent optimizing for a green suite finds
    // first. Deletions are also more often incidental than additions, so the friction lands on the
    // behaviour this repository wants to encourage.
    //
    // What resolves it is the rule beside the assertion, not the comparison operator. **This equality
    // is a ledger**: it records where the last run landed, not a target. Updating it to your own
    // landed total is expected and is not a ceiling change. The `<=` tripwire below is the only cap,
    // and only Jason widens that. CLAUDE.md carries the other half -- "Never pad or trim production
    // code to satisfy it -- manufacturing scope to make an assertion pass is worse than the drift the
    // assertion catches" -- so padding is forbidden by rule and caught in review, rather than made
    // impossible by `<` at the price of silent headroom. On 2026-08-08/09 this number moved
    // 3687 -> 3800 -> 3896 -> 3909 across four runs, each recording a landing. That traffic is the
    // mechanism working, not drift.
    //
    // Neither comparison catches an offset. A diff that adds one line and deletes an unrelated one
    // nets zero either way; no assertion on a single total can see it. Run 175 did exactly that - it
    // needed one line to split a diagnostic conflating two causes, could not raise the number because
    // this file was outside its slice's approved paths, and paid with a comment line in the same
    // handler. Catching that is work-reviewer's job and its prose now names it; making it unnecessary
    // is work-decomposer's, which now bounds the expected change before paths are seeded. What is left
    // for the assertion is unauthorized growth, and `<` does that.
    //
    // Issue #187 centralized duplicate scope assertions in this ledger. State-relocation AC8 and
    // terminal-handoff AC20 each pinned production at exactly 2665 lines; those exact guards were
    // removed because `< 2666` is now the sole executable production budget and intentionally
    // permits reductions.
    //
    // State-relocation AC14 separately pinned `bin/factory.js` at 702 physical lines to enforce
    // zero physical growth. That narrower 702-line zero-growth rule is intentionally retired
    // without a replacement per-file budget. Its value and intent remain historical rationale
    // only; the aggregate ceiling does not provide or enforce that guarantee.
    //
    // 2666 -> 2671 for issue #195's 2670-line result: one centralized slice-action helper is
    // reused before and after the gate loop so unopened gates cannot mask in-flight work. The old
    // inline scans were removed; no further safe deletion exists in this narrow state projection
    // without obscuring its public precedence contract.
    // 2670 -> 2726 (#178). Gate 2 now presents the plan before it is seeded, which needs a
    // `seed-slices` state in nextAction, a checked first seed, and — the largest part — a
    // `plan_digest` that binds the seeded bytes to the ones a human was shown.
    //
    // Two review rounds shaped that binding and both were right. The first: gate ordering alone left
    // the approval bound to a *filename*, so approve plan A, edit plan/slices.json, seed plan B, and
    // the ratified `paths` and `test_plan` are ones nobody reviewed — an empty test_plan among them,
    // which waives the observed test run. The second: hashing at *approval* left a window, because
    // the plan is presented when the gate moves to `pending`. So the digest is taken at presentation
    // and approval refuses if the file moved since, rather than re-hashing whatever is on disk.
    //
    // The lines are that binding at three points, the refusals at each, and the notes recording why
    // a filename was never the thing being approved. Well inside the 2900 Jason authorized for this
    // batch; the number is what it landed on, not what was allowed.
    // 2704 -> 2998 for run 182, which moved one-attempt local sandbox creation and complete physical
    // containment into init. The ceiling is 3000; this is the landed count, not a target.
    // 2998 -> 2998 (#213). Repository command configuration changes only skill/docs/tests and costs
    // zero production lines.
    // 2998 -> 3002 for issue 213's remediation: `.factory.json` joins the privileged-exact list. Issue
    // #234 lands at 3009 by authorizing slice test commands against the persisted ratified test_plan.
    // 3009 -> 3186 (#237). The narrowly scoped repository-verify shell path, central post-record merge
    // hook, and shared canonical evidence writer/classifier detect cross-slice failures before Gate 3.
    // 3188 -> 3288 (#240). Repository-configured verify timeouts, complete canonical classification,
    // fresh retry safety, and a two-attempt same-SHA replay recover interrupted verification safely.
    //
    // The tripwire moves 3000 -> 3600, which is the maximum Jason authorized for this batch (#213) and
    // not a number this run chose. The landed count is the assertion above; this is the bound the work
    // may not cross without a new authorization. Raise it only with one, and record the reason here.
    // 3288 -> 3293 on review: the replay-eligibility predicate recomputes review_ready rather
    // than checking its type. `readEvidence` already refuses a self-contradicting record, so
    // this closes no reachable false green -- it keeps the predicate that authorizes another
    // execution from being correct only by virtue of its caller. Four of the five lines are
    // that reasoning.
    // 3293 -> 3356 for issue #243: an explicit resume transition, parked pre-effect command guards,
    // historical-result validation, real continuation projection, and current-status health checks.
    // 3356 -> 3372 on review: resume proves ownership before un-parking. It is the handoff -- the one
    // command where a new driver takes over a run nobody is driving -- so two drivers could otherwise
    // both resume the same parked run and both believe they own it. Twelve of the sixteen lines are the
    // three refusals and the reasoning.
    // 3372 -> 3376 removing the session lock's `pid`: two lines of code deleted, six of comment
    // added. The field was never the run's owner -- it was the CLI, or the transient shell that
    // invoked it -- so it could not answer the liveness question its presence implied, and #250
    // was closed for trying. The comment is the change: the key stays *listed* so locks written
    // before this still validate, and deleting it from that list would read every one of them as
    // absent and let a second session claim a run being worked. Net growth for a deletion is the
    // honest count, so it is recorded rather than trimmed away.
    // 3376 -> 3376 for issue #216. The publishing-identity guard lives in the skill, the docs and
    // the tests rather than in production JavaScript, so it adds no counted production source
    // while its acceptance checks still bind the early and the pre-publication boundaries.
    // 3376 -> 3433 retaining each attempt's review verdict. A review record lives at one path per
    // subject, so attempt 3 destroys what attempts 1 and 2 said. That is fatal exactly where it
    // matters: attempts are budgeted, exhausting the budget blocks a run, and `blocked` is final --
    // so the artifact an operator most needs to understand a blocked run is the one the final
    // attempt overwrites. Run 216's test-verifier was rejected twice and approved on the third,
    // and both reasons had to be inferred from commit subjects. Roughly half of these lines are the
    // reasoning for why an archive is create-only and why a failed archive must not fail the step.
    // 3433 -> 3509 for issue #224: one private shell-free effective-push mechanism validates its
    // positional contract, freshly observes and aligns targets, and emits only cause-free refusals.
    // 3509 -> 3526 on review: the target comparison read a utf8-decoded string, and Node maps
    // every distinct invalid byte sequence to the same U+FFFD. Two unequal targets could
    // therefore compare equal while `git push` used the original raw bytes -- a sandbox
    // publishing somewhere the operator never approved, from a guard that reported a match.
    // A local-path remote on Unix may legitimately carry non-UTF-8 bytes, so it is reachable.
    // Capture now keeps bytes and compares them, and bootstrap refuses a target that would
    // not survive the utf8 round trip argv requires rather than configuring something else.
    // 3526 -> 3530 on the second review round: the byte comparison stripped every trailing LF, so a
    // target that itself ends in LF reduced to the same bytes as one that does not -- `path\n\n` and
    // `path\n` both became `path`, and two unequal targets compared equal. Git contributes exactly
    // one record terminator, so exactly one is removed and its absence fails closed. That is the
    // same defect class as the utf8 decoding it replaced, reintroduced one layer down while fixing it.
    // 3530 -> 3687 merging run 257 into #224's landed total: a parked, exact-owner path amendment
    // appends audited ownership while seed admission stays empty and the slices family freshly observes
    // the authorized session. It exists because a wrong slice plan otherwise kills the run outright --
    // mimir 1390 blocked with a module and its exact-inventory test in different slices and no legal
    // move, and `blocked` is final.
    //
    // 3700 -> 3800 (#248): declared sandbox bootstrap, byte-exact resume binding, and serialized
    // session-owner writes close dependency-resolution false greens and resume publication races.
    // 3800 -> 3896 (#259): init validates qualified operator refs, resolves an exact sandbox seed,
    // creates the feature branch, and proves its binding and one-line provenance through publication.
    // 3896 -> 3909 on review of #263: the post-bootstrap guard re-proved branch, ref and reflog
    // state but not physical containment, and every one of those reads answers correctly through a
    // `.git` relocated outside the sandbox. Thirteen lines re-prove containment after bootstrap and
    // again as the publication final guard, closing a path that published `run.json` for a
    // repository whose Git administration had left S.
    // 3918 -> 3966 for run 276: seed admission rejects commands observe cannot execute as argv.
    // 3976, not the 3966 the run first landed. Two review rounds moved it: the token predicate that replaced
    // a false-refusing substring scan costs a few lines more, and the POSIX-only boundary is now enforced in
    // code rather than inferred from Linux-only CI -- deleting the Windows branch had relocated the very
    // admission-versus-spawn mismatch the check exists to prevent. That is 8 over the 50 the issue
    // authorized. Recorded rather than trimmed: what remains is the comment saying which kind of check this
    // is and the platform refusal itself, and cutting either to satisfy an assertion is the trade this file
    // exists to prevent. The 4000 tripwire below is the only cap and is untouched.
    // 3981: five of these lines are the `repository` field added to this package's manifest after the
    // GitHub repo was renamed to `feature-factory`. The ledger counts `.json`, so package metadata lands
    // here alongside code. npm freezes metadata per published version, which is why the field goes in
    // before a first publish rather than after.
    // 3988 for issue 286: seven lines refuse an inline `--claim` and say why. `--claim` is a path the CLI
    // resolves against RUN_REPO, its one documented use named a variable defined nowhere, and no test passed
    // the flag at all -- so a run inlined the builder's report, the CLI resolved that JSON as a filename, and
    // an ENOENT discarded a slice that had already committed and observed green. Six of the seven lines are
    // the comment recording that this is instruction at the moment of failure and not enforcement: an
    // unreadable claim already refused, and only the message changes.
    // 4000 for issue 285: init refuses to seed a repository whose control plane is not ignored by a tracked
    // root `.gitignore`. The provenance is the reason it costs this much — a bare `check-ignore` exit code
    // would have been two lines and a false pass, because `.git/info/exclude` and a local `core.excludesFile`
    // satisfy it and neither survives the clone into the sandbox. So the guard parses `check-ignore -v`,
    // requires the deciding file to be tracked and to be the root `.gitignore`, requires the reported path to
    // be the probe, and fail-closes on anything malformed.
    //
    // **This landing consumes the remaining headroom: the exact total now equals the tripwire below.** The
    // next production line in this package fails it. That is a decision to take deliberately, with a reason
    // recorded here — not by nudging the number while landing something else. Written when separation was the
    // instrument for deliberateness; see the governing paragraph beside the tripwire, which now takes an
    // operator authorization recorded in the issue body instead.
    // 4003 for issue 293, the first change to spend the headroom #295 authorized. Three lines, all of them
    // comment: `readReview` now collects every shape problem and throws once instead of failing on the first.
    // The code is net zero — the five checks already sat one per line, so each `throw` became a
    // `problems.push` and the three-line `reviewed_commit` block collapsed to one. What it prevents: run
    // 1437's validator record had two unknown keys, no `reviewed_commit` and no `attempt`, and fail-fast named
    // only the keys, so each correction cost another validator pass over a 27-file change.
    // 4017 for issue 301: `readReview` now requires all eight keys of `REVIEW_KEYS`, not just the four it
    // happened to check. `reviewer`, `findings`, `required_fixes` and `checked_against` were rejected when
    // unknown but never required, so a record naming only a subject, verdict, attempt and binding passed every
    // check and was consumed as a complete approval -- while the agent prose has required all eight since #300.
    // Eight of the fourteen lines are the comment recording that this is enforcement, and that presence is
    // checked while key order deliberately is not: JSON order carries no meaning, and refusing a complete
    // record over its formatting is the over-reach that cost run 291 its work.
    // 4521 for issue 303: a repair record parked at `needs-human` had no exit, even once the external cause was
    // resolved and the work verified green. `factory reverify-repair` is that exit, and it is the only thing that
    // may derive effective `verified` from such a record -- the physical row stays frozen, and resume and
    // reconciliation never execute or clear it. Three modules carry it: `repair-record` reads and validates the
    // record, `repair-reverification` runs the attempt against a detached worktree, and `repository-config` is the
    // configured-command parser extracted out of `bin/factory.js`, which that extraction shortened by 22 lines.
    // The autonomous run that wrote this blocked at 4521 against a 4500 tripwire rather than compress anything to
    // fit; the operator then raised the tripwire, which is the order this ledger is meant to force.
    // 4533 for issue 315: twelve lines in `state/review-archive.js` refusing to archive an archive.
    // A live run reported an archive path back as `--review-ref`, the attempt suffix was appended twice,
    // and `spec-writer.attempt-1.attempt-1.json` landed beside the real archive with identical bytes.
    // Eight of the twelve are the comment recording that this is instruction rather than enforcement:
    // the live record is untouched and `createOnly` protects the genuine archive, so nothing here can
    // manufacture a false green -- what it prevents is a reviews directory that invites an operator to
    // look for a second verdict. Well inside the 4550 tripwire, so no authorization is involved.
    // 4533 unchanged for mimir 1551, because this repository's own rule sent a guard back. The run ratified
    // `uv run python -c "..."` as its only test command, `--test-cmd` is tokenized on spaces and spawned with
    // `shell: false`, so `python -c` received `"import` and exited 1 and no attempt could observe the slice
    // green. Enforcement was written for exactly that and reached 4543 across five predicates, each admitting
    // the real grouping forms while falsely refusing a command that runs -- `printf %s '"' '"'`, then
    // `tests/don't.py`, then `printf %s " "`, then `printf %s " x "`. The entry string cannot separate
    // grouping from payload, and the offending entry *executes*: it fails, which is a different thing.
    // Since it cannot manufacture a false green either -- `readEvidence` refuses fabricated evidence and a
    // failing command yields no `review_ready` -- the governing rule is instruct, not enforce. WORKFLOW.md
    // carries the argv contract instead, and the seed row records the entry as deliberately admitted.
    assert.equal(total, 4533, "declining to enforce test_plan quoting keeps production at 4533 lines");
    // **How this number may move.** An operator authorization recorded in the issue body, written before the
    // run starts, permits the raise to land in the same change as the work it serves. The requirement was never
    // that a raise occupy its own pull request -- separation was a proxy for deliberateness, and the issue body
    // is the better instrument: it is operator-written, it precedes the work, and a reviewer can read the
    // decision and its sizing next to the change that spends it.
    //
    // What stays forbidden is a run moving this number on its own initiative, or a change nudging it to fit
    // what happened to land. Absent a recorded authorization the cap is the cap, and the honest outcome is to
    // block and say the work does not fit -- which is what issue 303's first attempt did, correctly, after its
    // approved brief measured the smallest safe unit against the 33 lines then remaining.
    //
    // Provenance: raised from 4000 to 4050 for issue 292, which landed as its own change and nothing else.
    // That was the instrument available at the time -- #290 had left the exact total on the cap and asked that
    // the next raise be deliberate, and separation was how deliberateness was demonstrated then. It is no
    // longer the requirement; the paragraph above is. A raise carried by the change that spends it is fine when
    // an operator authorized it in the issue body beforehand, and was not fine in #292 only because no such
    // authorization existed to point at.
    //
    // Sized from this file's own record rather than asserted. The last five landings moved the total by 48, 15,
    // 7, 12 and 3 lines — median 12. 50 lines of headroom is therefore three to four more changes at the
    // observed rate, which brings this decision back within a handful of merges. An earlier draft proposed 200
    // and justified it as "the next few guards" at costs of 7 and 12; that arithmetic gives 17 to 29 guards,
    // which is not a few, and deferring the question that long is how a cap stops being one.
    //
    // The cap is not a budget to spend down. It is the point at which growing production requires saying why.
    //
    // Raised to 4550 by operator authorization for issue 303, after a run measured 4521 and blocked rather than
    // trimming to fit 4500. The margin is 29 lines, which at the observed median landing of 12 is two more changes
    // before this decision returns -- deliberately smaller than the 483 lines the 4500 authorization opened, because
    // the work that needed that room has now landed and the cap should tighten back toward the record.
    assert.ok(total <= 4550, `production source is ${total} lines; the tripwire is 4550`);
  });

  it("keeps the test budget within the attack catalogue's scale", () => {
    const testFiles = files.filter((path) => path.endsWith(".test.js"));
    // Counts `test(` as well as `it(` — the budget previously counted only `it(`, so
    // node:test's other entry point bypassed it.
    const count = testFiles.reduce((sum, path) => sum + (readFileSync(path, "utf8").match(/^\s*(?:it|test)\(/gmu)?.length ?? 0), 0);
    // Raised 60 -> 80 after opencode's review. The added tests are all attack or
    // ratchet coverage tied to a specific finding — the late CAS window, merge
    // without evidence, evidence not review_ready, PR with no slice plan, PR with an
    // open slice, and the ceiling's own self-assertions — not proof mass. The counter
    // also now includes `test(` as well as `it(`, so the number it reports is larger
    // than before for the same suite.
    //
    // Raise this only alongside findings it closes. "We needed more tests" is the
    // sentence that produced 68,911 lines of them last time.
    // 80 -> 82. The addition is `test/prompt-claims.test.js`, which closes a class that had
    // recurred three times: prose asserting what the CLI permits, wrongly. Each of those shipped
    // inside a fix for the previous one. That is the standard this number demands — a raise tied to
    // findings it closes, not "we needed more tests".
    //
    // Note what this counts: `it(`/`test(` call sites, not executed tests. The claim table is one
    // site driving five cases, so adding a claim row is invisible here. That is deliberate rather
    // than an oversight — a new row is a line of data binding existing prose to existing behaviour,
    // which is the growth this codebase wants. What the number constrains is new files and new call
    // sites, which is where proof mass actually accumulates.
    //
    // 82 -> 83, tied to two findings from a live run. `nextAction` had no test of its output at
    // all, and it reported `gate:brief` through the whole of research and spec. And the
    // single-slice validator rule needed both sides proven — every publication fixture here is
    // single-slice, so the moment one slice stopped requiring a verdict the requirement would
    // have had no test left at all.
    // 83 -> 87 funds the four AC-mapped lifecycle sites approved for issue 173: sandbox,
    // effective push, state relocation, and terminal handoff.
    // Issue #187 removed terminal-handoff AC20's duplicate guard; issue #234 raises 87 -> 88 for the
    // real-CLI command-authorization regression. This remains the sole executable call-site budget.
    // Issue #303 raises 88 -> 93 for the repair re-verification recovery path. Five sites, and the reason
    // there are five rather than one per behaviour is this budget: cases that share a shape are data rows
    // inside a site — seven corrupted inventories, three non-canonical timestamps, six disqualifying
    // records — and only genuinely different shapes earned a site. That path carried 469 production lines
    // and no executable coverage when review caught it, which is the growth this budget exists to permit.
    assert.equal(count, 93, `the approved catalogue has exactly 93 call sites; found ${count}`);
  });
});
