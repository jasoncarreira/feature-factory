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
  "init", "status", "amend-paths", "resume", "restore", "snapshot", "decide", "lock", "heartbeat", "gate", "step", "terminal",
  "slices-seed", "slice", "observe", "validator", "pr", "reverify-repair", "effective-push",
];

const RUN_JSON_KEYS = [
  // the inherited fifteen
  "version", "run_id", "issue_key", "branch", "worktree", "pr_base", "pr_draft", "created_at", "updated_at",
  "status", "max_parallel_slices", "max_retries", "gates", "steps", "slices", "validator", "pr_url",
  // The operator's answer to a parked run: the one channel into a park, since resume carries no message
  // and every other write is refused there.
  "operator_decision",
  // 0.8.0: the account a run publishes as, resolved at init from the flag or the environment and
  // never from a checked-in file. Read by every publication guard as the compared expectation.
  "publishing_identity",
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
      "--repo", "--branch", "--worktree", "--pr-base", "--issue", "--issue-key", "--publishing-identity", "--mode",
      "--max-parallel-slices", "--max-retries", "--now", "--json",
    ]);
    assert.deepEqual(COMMANDS.resume, ["--repo", "--session", "--now", "--json"]);
    assert.deepEqual(COMMANDS.restore, ["--repo", "--from", "--now", "--json"]);
    assert.deepEqual(COMMANDS.snapshot, ["--repo", "--json"]);
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
      // Instruction only: one park sequence for three branches, and one bounded reason each. Review found
      // two branches entering the shared stop without quiescing or releasing, and a third conditioning
      // release on the snapshot publishing -- which the shared procedure explicitly permits failing, so a
      // run that could not publish one stayed locked too. Each reason row is pinned because an unbounded
      // reason is how host error text reaches run.json, the snapshot and the operator report at once.
      "**Every infrastructure-triggered needs-human park follows one sequence.** This sequence explicitly splices unlock",
      "5. Whether or not step 2 published a snapshot, release this driver's verified owning session and require",
      "parked-success report. Report only `Outcome: retained-lock-error` with actual status, terminal result,",
      "| `NON_RETRYABLE_REASON` | `specialist invocation failed with a non-retryable error for <role> on <subject>; inspect the host invocation log, then prove execution never started or recover the same invocation before continuing` |",
      "| `UNKNOWN_OUTCOME_REASON` | `specialist infrastructure outcome unknown for <role> on <subject>; prove execution never started or recover the same invocation before continuing` |",
      "| `SECOND_FAILURE_REASON` | `specialist infrastructure failed twice consecutively for <role> on <subject>; after provider or network recovery, prove execution never started or recover the same invocation before continuing` |",
      "resume, `status.next`, provider recovery, the reset count, and an operator assertion alone establish",

      // Instruction only: which command publishes is an environment property, like the identity beside it.
      // Each selection branch is pinned separately, because review caught the first attempt stating
      // precedence in one paragraph while the execution paragraph still keyed on the file -- a literal
      // adapter would have ignored an environment-only override. The branches are the contract; a single
      // fragment naming the variable would have passed against the contradictory text.
      "**Resolve one publishing selection before running anything, and execute that selection rather than",
      "character selects that string; the same variable set empty or to whitespace selects the default, even",
      "file declares one; and with neither, the default. The resolution runs whether or not `$O/.factory.json`",
      "exists, so an environment-only override selects a command in a repository that declares none, and a",
      "declared `publish` is never executed while that variable holds a different value. Nothing downstream",
      "**When the resolution selects a command rather than the default, run that exact selected string instead",

      // Enforcement is in repository-config.js; these pin the contract it implements, because a `publish`
      // that is optional in code and still documented as required is the same defect one layer over.
      "`publish` was required and invoked nowhere until this release, so every",
      "The fully qualified `git push` above is factory-owned and unchanged for every resolved publishing",
      "as one shell command in `RUN_REPO` cwd with no stdin or positional arguments. Add exactly five values to",
      "`selected publishing command outcome indeterminate; re-observe whether the pull request exists before retry`;",
      "persist no other reason text. Never append or interpolate stdout, stderr, exit status or status text, URLs,",
      "When the recorded identity is non-null, both Step 6 identity guards run for every resolved selection and",

      // Instruction only: the single-slice validator skip removes a duplicate verdict, not the second
      // reading. mimir's chainlink-1304 merged one slice clean and the test-verifier review then found
      // two real production defects in it, so a wording that calls the re-read valueless invites cutting
      // the only pass that catches them.
      "**Skipping it does not mean the integrated diff goes unread**, and nothing here should be read as",
      "defects in it, both real and both confirmed. What the skip removes is a duplicate *verdict* on a",
      "production defect parks the run for an operator instead of returning to a builder. Review it as the",

      // Instruction only: reassess substantive progress, not category counts, before another retry.
      "a bounded, achievable remediation target for the next attempt, even when the design is fully decided.",
      "If no such target can be identified, park through the existing parked-stop procedure for replanning",
      "Unchanged finding counts alone are not a stall: progress can occur within a category that remains open.",

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
      "**The platform skill owns invocation-option admission, and this workflow never parses the\ninvocation.**",
      "the **admitted mode tokens**,\nwhich are the exact case-sensitive `--autonomous` and `--headless` tokens it consumed",
      "This workflow never decides where that prefix ends.",
      "If both distinct mode tokens were admitted, in either order, return exactly:",
      "`conflicting mode flags: --autonomous and --headless; choose one`.",
      "Return immediately, before any\n   intake, run-id derivation, state read, or CLI action. Never fall back to interactive or another\n   mode.",
      "Otherwise use only the unchanged admitted remainder for ticket detection, story content, design\n   detection, branch intent, and run-id derivation.",
      "`--autonomous` maps only to `factory init --mode autonomous`.",
      "`--headless` maps only to `factory init --mode headless`.",
      "With no admitted mode token, omit `--mode`; existing `factory init` records\n     `interactive`.",
      "Repeated copies of one mode token are idempotent: the skill consumes them all and this workflow\nselects that mode once.",
      "A mode token the skill did not admit, standing after the first request token,\nis request content and neither selects nor conflicts.",
      "Natural-language intent, `--interactive`, capitalization variants, abbreviations, assignment or\npunctuation forms, quoted lookalikes, and near misses are request content, not selectors.",
      "an existing manifest always resumes its immutable persisted\nmode. Invocation flags never reinitialize, compare, or mutate an existing run's mode.",
      "Using only the request remainder produced by mode admission:",
    ]) assert.ok(markdown.includes(fragment), `skill mode-admission contract is missing: ${fragment}`);
    // ENFORCEMENT, not instruction: two documents parsing the same bytes is a false-green generator, and
    // this one already fired. `--base` and `--max-retries` were added to the host skills and never here,
    // while this section went on ending the prefix at the first non-mode token -- so the documents
    // disagreed over whether `--max-retries 5 <run-id>` was an option pair or part of the run id. Read
    // alone this section derived the run id `max-retries-5-1606`; read alongside the skill it halted a run
    // outright, which is the better failure but still a halt. The drift was invisible because the 0.8.1
    // verbatim-restatement guard binds a later region of this file and never reached this section. Any
    // future host option recreates the defect the moment this section starts parsing again, so the
    // property pinned is that it does not parse.
    const admission = markdown.slice(admissionIndex, operatingModesIndex);
    assert.match(admission, /This workflow never decides where that prefix ends\./u,
      "the admission section must concede the whole option prefix to the platform skill");
    for (const terminator of [/ends the prefix/u, /maximal consecutive sequence/u, /remove every token in the recognized prefix/u]) {
      assert.doesNotMatch(admission, terminator,
        `the admission section must not define its own prefix terminator: ${terminator}`);
    }
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
    assert.ok(markdown.includes('factory init "$R" --branch "$FEATURE_BRANCH" [--worktree "$WORKTREE"] [--pr-base "$PR_BASE"] [--issue "$KEY"] [--mode "$MODE"] [--max-retries "$MAX_RETRIES"] --repo "$O" --json'));
    // The workflow must not construct `--publishing-identity`. It has no value to supply, so the flag would
    // be built from an unbound shell variable, expand to an empty argument, and -- before the resolution
    // fix below it -- mask a valid inherited value and refuse the run. Caught in review of 0.8.0.
    assert.ok(!markdown.includes("--publishing-identity \"$PUBLISHING_IDENTITY\""),
      "the workflow must not pass an identity flag it has no source for");
    assert.ok(markdown.includes("Never pass `--publishing-identity` from this workflow."),
      "and it must say so, or the next edit re-adds it");
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
      // A retry must reuse rather than resupply these identities; the CLI refuses the flags on N+1.
      { command: "slice", when: /\brunning\b/u, unless: /NEXT_SLICE_ATTEMPT/u, flag: "--branch", why: "the merge refuses a fresh slice with no recorded branch" },
      { command: "slice", when: /\brunning\b/u, unless: /NEXT_SLICE_ATTEMPT/u, flag: "--worktree", why: "a fresh slice must record its isolated worktree" },
    ];
    for (const { command, when, unless, flag, why } of required) {
      const relevant = invocations.filter((entry) => entry.command === command && !entry.elided
        && when.test(entry.snippet) && !unless?.test(entry.snippet));
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
      { name: "story-writer", label: "known defects stay bounded", fragment: "name the failure scenarios to prevent rather than silently generalizing them into a subsystem-wide guarantee." },
      { name: "story-writer", label: "broader guarantees need explicit proof scope", fragment: "If a broader guarantee is necessary, explain its scope and proof obligations before approval." },
      // Instruction only: keep scope tied to the request without reopening approved requirements.
      { name: "story-writer", label: "scope tied to requested outcome", fragment: "Each acceptance criterion must support the requested outcome or a necessary correctness/safety condition." },
      { name: "story-writer", label: "scope additions need approval", fragment: "explain why they are needed, and obtain explicit approval at the existing story gate before" },
      { name: "work-reviewer", label: "unapproved expansion is rejected", fragment: "reject unapproved scope expansion rather than silently accepting it as an implementation requirement." },
      { name: "work-reviewer", label: "approved scope is not reopened", fragment: "Check the supplied request and approval record; do not reopen explicitly approved scope merely because" },

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
      // Instruction pins: distinguish behavioral proof from inventories without adding a CLI gate.
      ...["backend-builder", "frontend-builder", "work-reviewer"].map((name) => (
        { name, label: "control-failure exclusions remain explicit", fragment: "syntax, import, discovery, or unrelated" })),
      // Instruction only: no later round exists to carry a withheld finding into.
      { name: "work-reviewer", label: "final integrated reading is exhaustive", fragment: "make its findings exhaustive in one pass: a production defect recorded here parks the run" },
      { name: "work-reviewer", label: "behavioral boundary mapping", fragment: "invokes the relevant production boundary and asserts its required effect or exclusion." },
      { name: "work-reviewer", label: "enumeration is not behavioral proof", fragment: "AST references and test names prove enumeration, not behavior." },
      { name: "work-reviewer", label: "attestation is self-report", fragment: "Treat the builder's negative-control report as self-reported diagnostic information," },
      { name: "work-reviewer", label: "attestation is not a new blocker", fragment: "syntax, import, discovery, or unrelated failure. Missing attestation alone is not a blocker;" },
      ...["backend-builder", "frontend-builder"].flatMap((name) => [
        { name, label: "early representative control", fragment: "Before expanding a class-wide behavioral test matrix, run one representative negative control" },
        { name, label: "mutation changes behavior without changing tests", fragment: "Change production behavior without changing the tests or preventing" },
        { name, label: "mutation must permit execution", fragment: "execution. Confirm the mapped test passes before the mutation" },
        { name, label: "control is diagnostic without schema expansion", fragment: "This is diagnostic instruction, not a new claim-schema field or a" },
        { name, label: "control does not replace ratified tests", fragment: "replacement for the ratified test run." },
        { name, label: "behavioral failure and restored pass", fragment: "assertion with the mutation, and passes after restoration." },
        { name, label: "restore before delivery", fragment: "failure does not count. Restore the mutation before committing or reporting." },
        { name, label: "specific control report", fragment: "In your narrative report, name the inventory row, production symbol and mutation, exact test command," },
        { name, label: "unperformed control is explicit", fragment: "observed assertion failure, and restoration result. Mark an unperformed control as **not run** with" },
      ]),
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
    // Instruction placement: keep the scope verdict in doc-step review, not survey discipline.
    const scopeVerdict = "reject unapproved scope expansion rather than silently accepting it as an implementation requirement.";
    // Both bullet markers must be found before they can bound a slice. An absent end marker makes
    // indexOf return -1, and slice(start, -1) reads to end-of-file -- which would quietly relax the
    // check below to "appears anywhere after Doc steps" and keep passing on a botched move.
    const docStart = reviewer.indexOf("- **Doc steps");
    const docEnd = reviewer.indexOf("- **Build slices");
    assert.ok(docStart >= 0 && docEnd > docStart, "doc-step review must be bounded by both subject bullets");
    const docReview = reviewer.slice(docStart, docEnd);
    assert.ok(docReview.includes(scopeVerdict), "scope verdict belongs in doc-step review");
    assert.equal(reviewer.split(scopeVerdict).length - 1, 1, "scope verdict must not be duplicated");
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
    assert.equal(RUN_KEYS.length, 24, "twenty-four: the prior twenty-three plus the operator decision recorded against a parked run");
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
    // 4533 -> 4541: init stages the canonical workflow into the run directory. `external_directory` is
    // denied for every agent, so the read SKILL.md mandates -- of a file in the adapter package, outside the
    // workspace -- is refused, and whether a run survives depends on whether the skill loader happened to
    // inline it. Two runs died that way. The permission model cannot express the narrow fix: a `*` rule
    // outranks a path rule, and omitting `*` leaves everything else at `ask`, which a headless run cannot
    // answer. Staging is the only option that keeps the deny absolute. It lives in the CLI because
    // `boundary.test.js` gives the adapter no way to write, and after init because that is when a run
    // directory exists, and BEFORE publication so a failure aborts init while a retry is still possible.
    // Written through `writeProtectedFileAtomic`, not a copy: `bootstrap` runs repository-controlled
    // commands first, so a planted destination symlink would redirect a plain write out of the sandbox.
    // Twelve lines, six of them the reason. Inside the 4550 tripwire, so no authorization is involved.
    // 4541 -> 4545 -> 4550: `init` accepts `--issue-key` as an alias for `--issue`. `issue_key` is the field
    // name every reader of `run.json` and `status --json` sees, and it is the spelling a caller reaches for
    // first: mimir 1606's driver ran `init "1606" --issue-key "1606"`, got `unknown option`, and recovered by
    // dropping the flag rather than retrying the other spelling. That run then read issue 1606 for real, built
    // a correct story, merged four slices and opened a correct PR while recording `issue_key: null` -- so the
    // field is a coin flip on how a driver happened to spell it, and an absent key is exempt from the `Closes`
    // linkage the key exists to produce. Neither a guard nor instruction: an accepted input spelling.
    // One line of it is enforcement and says so in place -- disagreeing values refuse instead of preferring
    // one, because the key is appended as `Closes #<key>` and a silent preference closes a stranger's issue.
    // **This lands exactly on the 4550 tripwire.** No authorization was needed, and none is left: the next
    // production line anywhere in this package requires an operator-authorized raise, recorded in the issue
    // body before the run. Read that as the ledger doing its job, not as room to round up.
    // 4545 -> 4550 was the `--issue-key` alias, not the workflow staging above: 0.7.3's edit renumbered this
    // assertion but left the older description attached, so the message named the wrong change. Corrected here.
    // 4550 -> 4557: `factory terminal <R> completed` now requires a recorded `pr_url`. `completed` is the only
    // terminal status asserting the run earned a result, and the ordering that gave it meaning -- publish, then
    // terminalize with reason `draft-pr-recorded` (WORKFLOW.md) -- was instruction alone. mimir 1483 showed the
    // cost: a ~70-second run with no commits, no pushed branch and no PR recorded `completed`, and a consumer
    // binding on `status == "completed"` read a do-nothing run as a shipped epic. That is a false green in the
    // exact sense this file exists to price, and the CLI already held the state needed to refuse it.
    // Enforcement, and it says so in place. `blocked` and `partial` stay unguarded because they claim less.
    // Checked against what it must not block: WORKFLOW.md's two other `completed` terminalizations re-terminalize
    // an already-published run to update a cleanup reason, so `pr_url` is set and both still pass -- verified by
    // running the suite, not by reading it. Negative control run: with the guard deleted terminal-handoff fails,
    // restored it passes.
    // Tripwire raised 4550 -> 4560 by operator authorization given before this work began, for this one finding.
    // 0.7.3 landed exactly on 4550 and recorded that the next line would need a raise; this is that line.
    // 4557 -> 4574: the publishing identity moves out of the checked-in config and into the run.
    // It was a required key in `.factory.json`, which cannot hold two values for one repository published
    // from two environments -- a maintainer's own checkout and an automated host. 0.7.5 tried an
    // environment override expressed as contract text, and the driver never looked: `FACTORY_PUBLISHING_IDENTITY`
    // reached the child's shell (proven by the resolver short-circuiting on `$MIMIR_WORK_ITEM_JSON` on the
    // same injection path) and attempt 8's stderr contained no reference to it. A new instruction in a
    // 143 KB contract is a compliance ask; this is the same fix expressed as code.
    // Resolution is now `--publishing-identity` then the environment, in `init`, recorded immutably in
    // `run.json` and reported by `status` -- which also makes it observable, so a controller can verify what
    // a run will publish as instead of discovering a mismatch at Gate 1. The comparison against
    // `gh api /user` stays instruction, because putting network calls and credentials in the CLI is a
    // different and larger change; it is resolution that was unreliable, not the comparison.
    // Absence refuses. The operator chose fail-closed over a checked-in fallback: a forgotten value must
    // stop the run rather than silently publish as whatever credential the host happens to carry.
    // Tripwire raised 4550 -> 4600 by operator authorization given before this work began, sized for this
    // change plus review fixes so a second raise is not needed mid-flight.
    // 4574 -> 4579: `observe/repository-config.js` drops the key from its required set. Worth recording that
    // I first reported this mechanism as "zero references in production code" from a grep over `bin/`, `core/`
    // and `state/` -- the parser lives in `observe/`, so the claim was scoped too narrowly to be true, and the
    // 0.7.5 changelog says it. The allowed set is closed, so a config still carrying the key is malformed
    // rather than ignored, which is what makes the removal visible to whoever edits the file.
    // 4579 -> 4584 in review: resolution was `flags.publishingIdentity ?? process.env.FACTORY_PUBLISHING_IDENTITY`,
    // and `??` falls through only on nullish. The workflow line this change added constructed
    // `--publishing-identity "$PUBLISHING_IDENTITY"` from a variable nothing binds, so under the documented
    // environment-only migration it expanded to an empty argument, satisfied `??`, masked a valid inherited
    // value, and refused init. Both sources now count only when they carry at least one character, and the
    // workflow no longer constructs a flag it has no value for. mimir caught it; the runtime test proves an
    // empty flag yields to the environment, and a contract test proves the workflow never builds the flag.
    // 4584 -> 4599: `status` reports `park_snapshot` for a parked run.
    // 0.8.2 made the snapshot a contract requirement and it did not fire on mimir chainlink 1521's first real
    // park -- the run was verifiably on 0.8.2, since the pin fails closed. The cause was mine: eleven
    // one-line rules say a run parks and defer to the shared semantics, and I appended the snapshot to those
    // semantics as a sentence rather than making the parked stop an ordered sequence the rules enter. Prose
    // has now failed twice in exactly this place -- 0.7.5's environment override was the first.
    // So the copy stays a driver step, because this CLI is forbidden copy and delete primitives, but whether
    // it happened is now observable: an existence check, computed at read time so there is no stored key to
    // keep truthful and no answer that can go stale against the filesystem. Observability, not enforcement --
    // it cannot make the snapshot happen, it makes a missing one a fact a controller can act on, which is
    // the property that made the 0.8.0 identity work land.
    // Tripwire 4600 -> 4650, using the authorization given during the 0.8.2 discussion for this same feature
    // area. It went unused then because that implementation turned out to be prose; the observability half is
    // code, and landing on 4599 would leave one line before a review fix needed a raise mid-flight.
    // 4599 -> 4633 across two review rounds, because the observation was twice a false green of its own.
    // "Does the pathname exist" reported a snapshot from an earlier park as this park's evidence. Matching
    // only `run.json` then proved one file was copied after the current terminalization, not that the
    // publication finished -- a driver that created the directory and copied that file first, or an
    // interrupted copy, still read as published. The test written for that version constructed exactly the
    // accepting shape, so it demonstrated the hole rather than catching it.
    // The property is now the one the publication contract already defines: inventory equality over the whole
    // plane -- relative path, type, mode, SHA-256 for files, target for links, sorted -- plus the manifest
    // compared by bytes, because an earlier park's `updated_at` is the same length as this one's and size
    // alone would call a stale snapshot current. My own stale regression caught that, which is the argument
    // for writing the failing case before the passing one.
    // 4633 -> 4635, round three. That version recorded file sizes rather than digests, arguing `status` is
    // polled continuously and the plane carries a 143 KB workflow copy. The cost estimate was right and the
    // conclusion was wrong: a same-length byte change and a mode-only change both compared equal, so an
    // altered tree reported as published while the contract said altered trees yield `null`. A signal that
    // disagrees with its own description is the defect this change exists to remove, and it had reappeared
    // inside the fix for it. Both halves are pinned by regressions with independent negative controls --
    // dropping the digest fails the same-size case alone, dropping the mode fails the mode case alone.
    // 4635 -> 4636, round four. The inventory walked into the root without recording it, so a snapshot whose
    // own directory mode differed from the plane's compared equal -- while the contract inventories `.` and
    // every descendant, meaning that copy fails the verification the snapshot is supposed to have passed.
    // The same round made the sort lexical by relative path, which is what the contract says and what the
    // completed archive does; ordering was never a false green, since both sides ran the same walk, but
    // "the same inventory the publication step verifies" is the whole claim being made here.
    // Every path component is `lstat`ed and never followed, since `lstat` on the final entry still follows
    // intermediate symlinks, and an entry that is neither file, directory, nor link is rejected rather than
    // silently skipped.
    // 4636 -> 4641. `status` now reports `max_retries`. Init has recorded it since the flag existed and
    // nothing ever read it back, so an operator forwarding `--max-retries` could not tell a budget that
    // took effect from one that silently fell back to the default 3 -- which is how a run bounded at the
    // wrong number looks exactly like a correct one. Observability, not enforcement: it cannot make a
    // budget correct, it makes a wrong one visible, which is the same argument that carried the 0.8.0
    // identity field and the 0.8.3 park snapshot. The field is emitted unguarded because `max_retries` is
    // a required schema-validated positive integer; a manifest without one is invalid and never reaches
    // the emitter, so a `?? null` here would be describing a state that cannot exist.
    // 4641 -> 4650, found in production rather than in review. A live park published a complete,
    // byte-correct control plane and `status` reported `park_snapshot: null` eleven seconds later: the
    // copy held `heartbeat_at` 23:28:25 and the plane had moved to 23:28:36. The inventory compared the
    // whole plane including `factory.lock`, the one entry whose purpose is to change on a timer, so any
    // snapshot was invalid by the next heartbeat and the field answered "no park" about a park that was
    // sitting on disk. Every test published and read back with nothing touching the plane in between,
    // which is exactly why three review rounds and one real park all missed it; the regression now ticks
    // a heartbeat between the two, and a second one plants a nested `factory.lock` so the exclusion
    // cannot widen from an exact root path to a name match.
    //
    // 0.8.7 landed exactly on the 4650 tripwire with zero headroom, reported as a fact rather than used
    // to ask for room. 4650 -> 4656 here, and the tripwire 4650 -> 4700 on the operator's explicit
    // instruction in the session that requested this change ("do the structured steps/slices change,
    // raise the tripwire"), given before the work rather than after the number was known.
    //
    // What the six lines bought: `status --json` projected step and slice rows as
    // `${agent}:${status}(${attempts})`, so `attempts` -- the single field a controller reads to decide
    // whether an attempt was consumed -- had to be regexed back out of a rendering. mimir's escalation
    // epic stalled on exactly that, having to classify outcomes by parsing prose. Nothing in the suite
    // asserted the string form, so it was a public shape with no coverage, which is how a display
    // artifact survived inside a machine contract. The content did not change; only the shape did.
    // 4656 -> 4682, same PR, same defect class, three more fields. The projection is the ONLY lossy layer
    // in this system: `run.json` holds records and `status --json` narrowed them on the way out. Gates
    // came out as a bare status string with `at` and `artifact` dropped -- and `at` is most of what "is
    // this run stuck" means. The validator came out as a bare verdict, losing `loops`, which says whether
    // validation is converging. `next` packed a kind and a subject into one string, so the field a
    // controller most needs to branch on had to be split on a colon.
    //
    // `nextActionRecord` is now the single computation and `nextAction` is a one-line formatter over it,
    // so the string cannot drift from the record; a test asserts `next` is exactly that formatting.
    // The narrowing guard reads GATE_KEYS and VALIDATOR_KEYS from the schema rather than a hand-written
    // list, so a field added to either must be exposed or consciously excluded here. Its first draft was
    // itself a no-op TWICE over: the validator half sat behind a `!== null` where no validator exists, and
    // the step half looped over an array that is empty in all 23 invocations of that fixture -- so the
    // step projection could have reverted to display strings and passed. Both read as coverage and proved
    // nothing; both were caught by running the control rather than by the suite going green. Each now sits
    // at the first fixture where the record it checks actually exists.
    // 4682 -> 4724, and the tripwire 4700 -> 4750 on the operator's explicit instruction ("raise it to
    // 4750"), alongside the instruction to fix the audit's pre-existing findings as well as the ones this
    // PR introduced -- given knowing three of them are state-machine defects rather than prose. Reproduced through
    // the CLI by the auditor, each of them:
    //
    // - A reviewed step consumed nothing. `accepted` was recorded against a missing review file, a REJECT
    //   with blocking fixes, and an approval naming a nonexistent commit. The reference was stored and
    //   never read, which made the README's enforcement claim and the workflow's "must APPROVE before you
    //   accept that step" instruction rather than fact.
    // - A `pre_pr` approval named no commit, so on a single-slice run -- which skips the validator that
    //   carries that binding for multi-slice runs -- approving at A, committing B and re-observing tests
    //   at B published under the older approval. Fresh evidence is not fresh approval. The gate already
    //   observed the head to prove readiness; it now records it, and publication compares it.
    // - An accepted step could not record a rejection, so a Gate 2 revision could record its success and
    //   never its REJECT. Reopening is legal only with a raised attempt, which is what a revision is.
    // 4724 -> 4760, and the tripwire 4750 -> 4775 on the operator's explicit instruction ("raise it to
    // 4775"), given after being shown the measured overage and what bought it. The 4750 authorization was
    // given when the count was 4724; a re-review then found three false greens in the production code
    // added earlier in this same change, and closing them cost 36 lines:
    //
    // - A review was matched by subject and verdict but not by ATTEMPT, so accepting attempt 1, recording
    //   `running --attempts 2` and then accepting again with no `--review-ref` re-consumed attempt 1's
    //   approval through the reference fallback. Omitting a flag was enough; nothing had to be contrived.
    // - `test-verifier` inherited the planning-subject exemption from the head binding. A planning subject
    //   has no commit to name; the verifier judges the integrated branch and does, so a review naming a
    //   commit that does not exist was accepted.
    // - Reopening an accepted step was allowed on any raised attempt, which reopened planning work after
    //   the slices derived from it were seeded, and reopened steps on completed, blocked and partial runs.
    //   A revision is narrower than a raised attempt.
    //
    // Nothing was trimmed to fit. The alternative offered was dropping one of the three, which would have
    // left a false green in code this PR introduced.
    // 4760 -> 4774, inside the 4775 tripwire already authorized, and nothing was trimmed to reach it.
    // A fourth review pass found two more in the code added above, both reproduced through the CLI:
    //
    // - Publication read gates, slices, evidence and the validator, and never the step rows. So a verifier
    //   REJECT recorded AFTER Gate 3 was approved did not reach it, and the run published under the older
    //   approval. Permitting verifier revisions is what made that reachable, so allowing the revision had
    //   to come with the approval rule that follows from it.
    // - The revision scoping ran only when the status changed, so accepted@1 -> accepted@2 skipped every
    //   restriction, on a terminal run included -- which is exactly what a driver recording only the
    //   successful final result produces. Any departure from the settled row is a revision; only exact
    //   same-attempt re-acceptance, which is what a resumed driver re-records, stays free.
    // 4774 -> 4858, and the tripwire 4775 -> 4900 on the operator's explicit instruction ("make the ledger
    // 4900"), given after being shown the measured cost. The largest single jump in this series, and the
    // only one that is a feature rather than a fix.
    //
    // `factory decide` is the operator's answer to a parked run. There was no channel: `resume` carries no
    // message and every command that could carry one is refused while parked, so the contract's own advice
    // -- record the decision in the issue -- named the one place a retained run never re-reads. A six-hour
    // build parked asking whether a ceiling was authoritative, and the only supported reply was to destroy
    // the sandbox and relaunch, discarding the planning the run had already done.
    //
    // The 84 lines are a schema field with its validation, a transition mode that may change nothing but
    // the decision, a CLI handler that appends and digests, and one status field. The split is the usual
    // one: recording is enforced because a false green here is a decision silently lost, while READING it
    // is instruction, since no CLI can make an agent read a file. The digest identifies recorded bytes;
    // it does not prove that a driver applied them.
    // 4858 -> 4860: explicit resume refreshes the staged contract before unparking and checks bindings
    // after that asynchronous copy. The operator-authorized tripwire remains 4900; no code was trimmed.
    // 4860 -> 5182 for issue #343: restore qualifies an immutable parked snapshot and exact pushed ref,
    // proves every preserved merge binding, reports downgraded work, omits stale ownership, records durable
    // provenance, and publishes the transformed manifest last. The issue authorizes the 5200 tripwire.
    // 5182 -> 5192: `.factory.json` `publish` stops being a required key nobody runs. Optional does not
    // mean unchecked, so an empty or non-string command remains a loud refusal.
    // 5192 -> 5240 for issue #352: a merit REJECT is the only slice event that spends N+1, retries retain
    // their original base across sibling merges, and wrong-attempt evidence refuses before publication.
    // 5240 -> 5366 for issue #353, on top of #352's reviewed slice blocking: publishing a parked
    // snapshot was specified only as driver prose, so a supervisor that parks a run it is not driving --
    // which `factory terminal` deliberately permits -- could complete step 1 of the three-step park and
    // nothing else. The cost is the five-phase swap: preflight, stage, verify by inventory equality, the
    // two-rename commit with rollback, and cleanup that reports a residual rather than failing a
    // completed publication. The last 9 are review's second and third findings: publication applies the
    // same `validateRun` the consumer does, requires the manifest to name the run being published, and
    // qualifies the staged tree again before the rename -- a manifest replaced between qualification and
    // copy reaches both trees, so inventory equality passes and only re-qualifying catches it.
    assert.equal(total, 5366, "publishing a parked snapshot lands at 5366 production lines");
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
    // Issue #343 authorizes 4900 -> 5200 for snapshot restore, including source/destination binding,
    // Git provenance, explicit loss reporting, and atomic publication. Issue #352 authorized 5200 -> 5240
    // for bounded slice merit retries; issue #353 authorizes 5350 for the snapshot publisher, and the
    // merged tree carries both. #353's figure was re-authorized to 5400 once #352 merged first: 5350 was
    // estimated from a 5192 base, and the combined tree measures 5354, which neither issue anticipated.
    // Raised on explicit operator instruction recorded in the issue; nothing was trimmed to fit.
    assert.ok(total <= 5400, `production source is ${total} lines; the tripwire is 5400`);
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
