// The ceiling. This test exists to fail when scope grows.
//
// BUILD-PLAN-SMALL.md lists non-goals as refusals, not deferrals. Prose cannot
// enforce that: the predecessor's 43,013 lines were each individually defensible
// at the time. So the command set, the run.json key set, the family list, and the
// absence of the dropped subsystems are asserted here as exact values.
//
// Widening any of them requires editing this file, which is the point: the
// decision becomes visible in a diff instead of arriving as a reasonable-sounding
// addition. Only Jason widens it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../bin/factory.js";
import { FAMILY_IDS } from "../core/contracts.js";
import { RUN_KEYS } from "../state/schema.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Widened deliberately when slices/observe landed. BUILD-PLAN-SMALL.md declares
// twelve commands; `validator` and `pr` are not built yet, so they are absent here
// and adding them will be another visible diff.
// All twelve commands BUILD-PLAN-SMALL.md declares are now built. A thirteenth
// needs a reason in the plan first, not just an edit here.
const CLI_COMMANDS = [
  "init", "status", "lock", "heartbeat", "gate", "step", "terminal",
  "slices-seed", "slice", "observe", "validator", "pr",
];

const RUN_JSON_KEYS = [
  // viso's fifteen
  "version", "run_id", "jira_key", "branch", "worktree", "created_at", "updated_at",
  "status", "max_parallel_slices", "max_retries", "gates", "steps", "slices", "validator", "pr_url",
  // the two justified additions. base_commit was dropped: it was written and never
  // read, which is the standard a durable field has to meet.
  "mode", "terminal_result",
];

const FAMILIES = ["envelope", "gates", "steps", "slices", "verdict"];

// Dropped subsystems. Each was a top-level run.json field or a module in the
// predecessor; none is required by "viso + atomic transitions + autonomy".
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

function sourceFiles(dir = pkg, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(path);
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

describe("ceiling — scope cannot grow without editing this file", () => {
  it("exposes exactly the declared CLI commands, and the skill invokes only those", () => {
    assert.deepEqual(Object.keys(COMMANDS).sort(), [...CLI_COMMANDS].sort());

    // The skill is the authoritative instruction set, and nothing checked it against the CLI
    // it drives. Four of its examples had drifted far enough to block a normal merge and the
    // late-head recovery — including one this session introduced while correcting the same
    // command elsewhere in the same round. Every prose fix so far was found by reading, which
    // is why they kept coming back.
    const markdown = readFileSync(join(pkg, "skill", "SKILL.md"), "utf8");
    // Join shell continuations so one command is one string, then read only code — fenced
    // blocks and inline spans — so prose cannot be mistaken for an invocation.
    const text = markdown.replace(/\\\n\s*/gu, " ");
    const snippets = [];
    for (const [, body] of text.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)) snippets.push(...body.split("\n"));
    for (const [, body] of text.matchAll(/`([^`\n]+)`/gu)) snippets.push(body);

    // Not anchored at the start of the snippet: an invocation quoted mid-sentence inside a
    // code span was skipped entirely by `/^\s*factory/`. Flags are read from the command
    // onward and stop at the next invocation, so two on one line do not pool their flags.
    const invocations = [];
    for (const snippet of snippets) {
      const found = [...snippet.matchAll(/\bfactory\s+([a-z-]+)/gu)];
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
  });

  it("declares exactly the declared run.json top-level keys", () => {
    assert.deepEqual([...RUN_KEYS].sort(), [...RUN_JSON_KEYS].sort());
    assert.equal(RUN_KEYS.length, 17, "seventeen: viso's fifteen plus mode and terminal_result");
  });

  it("registers exactly the declared families", () => {
    assert.deepEqual([...FAMILY_IDS].sort(), [...FAMILIES].sort());
  });

  it("contains no trace of a dropped subsystem, under any spelling", () => {
    const offenders = [];
    for (const path of productionFiles) {
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
    // 2000 -> 2500 when the twelfth command landed. 2500 was BUILD-PLAN-SMALL.md's stated
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
    assert.ok(total < 2650, `production source is ${total} lines; the tripwire is 2650`);
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
    assert.ok(count <= 80, `${count} tests; the budget is 80`);
  });
});
