import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const factoryRoot = resolve(packageRoot, "..", "feature-factory");
const skill = readFileSync(resolve(packageRoot, "skills/feature/SKILL.md"), "utf8");
const bundledWorkflow = readFileSync(resolve(packageRoot, "skills/feature/WORKFLOW.md"));
const canonicalWorkflow = readFileSync(resolve(factoryRoot, "WORKFLOW.md"));

describe("OpenCode skill adapter", () => {
  it("owns OpenCode mechanics and loads the exact canonical workflow before effects", () => {
    // The resolver runs before `init`, but `init` is what stages the canonical workflow, so a driver that
    // reads the workflow first can never learn the rule in time. mimir chainlink 1521 initialized from the
    // literal reference, read the staged workflow afterwards, and story-reader got a bare key instead of the
    // rendered work item. The rule is therefore restated in this skill -- and bound to the canonical text
    // here, because a duplicated contract with nothing holding it is the drift this repository keeps paying
    // for. Compared on whitespace-normalized text so the two files may wrap differently.
    const flat = (text) => String(text).replace(/\s+/gu, " ");
    const skillFlat = flat(skill);
    const canonicalFlat = flat(canonicalWorkflow);
    for (const clause of [
      "execute `resolve` before issue, ticket, design, or free-text classification",
      "the inherited environment plus `FACTORY_INPUT`, and no positional argument or structured stdin",
      "`FACTORY_INPUT` is the exact admitted request remainder after mode-prefix removal, preserving its whitespace and bytes",
      "Exit zero with exactly zero stdout bytes means the resolver did not recognize an issue reference",
      "Continue existing ticket, design, and free-text derivation from the original admitted request",
      "not use the compatibility issue resolver and do not dispatch `story-reader`",
      "Exit zero with non-empty stdout means stdout itself is `ISSUE_PAYLOAD`",
      "Validate `run_id`, `title`, and `body` — presence and type — before binding `R` or dispatching anything",
      "The configured `run_id` must match `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`",
      "factory config entry 'resolve' failed for reference <reference> with exit status <status>; no session or run created.",
      "factory config entry 'resolve' failed for reference <reference>; exit status unavailable; no session or run created.",
      "factory config entry 'resolve' returned malformed payload for reference <reference>; no session or run created.",
    ]) {
      const wanted = flat(clause);
      assert.ok(canonicalFlat.includes(wanted), `canonical workflow no longer states: ${clause}`);
      assert.ok(skillFlat.includes(wanted), `SKILL.md must restate the pre-init resolver rule: ${clause}`);
    }
    // Ordering is the defect, so pin ordering rather than presence: the resolver section must precede the
    // staged-workflow read in the document, and the skill must say `init` is not exempt from coming after it.
    assert.ok(skill.indexOf("## Repository resolver intake") < skill.indexOf("## Operating modes"));
    assert.match(skill, /before run-id allocation, config effects, state\s+reads, tool calls, or any `factory` command, `init` included/u);
    assert.ok(skill.includes("admission, the repository resolver intake below, and the `init` invocation are"),
      "the skill must not claim admission is fully specified without the resolver intake");
    assert.ok(skill.startsWith("---\nname: feature\n"));
    // The workflow is read from where `init` stages it, not from beside this file: that path is outside
    // the workspace and `external_directory` is denied for every agent, so a run depending on it fails on a
    // permission refusal. These pin the reordering, one fragment per line so the assertion can match.
    assert.match(skill, /`factory init` stages the canonical workflow at the `workflow` path/u);
    assert.match(skill, /before any state read, dispatch, gate, or factory command other than/u);
    assert.match(skill, /Do not read `WORKFLOW\.md` next to this file/u);
    assert.match(skill, /feature_background/u);
    assert.match(skill, /FACTORY_SESSION_ID/u);
    const grammar = [
      /at most one exact, case-sensitive first token `--background`/u,
      /maximal leading option prefix/u,
      /in any\s+order/u,
      /preserve\s+the suffix beginning there byte-for-byte/iu,
      /`--base=x`, case or punctuation variants/u,
      /`--base` after the first request\s+token are request content/u,
      /missing value for --base; no run created\./u,
      /repeated --base; no run created\./u,
      /Duplicate copies of one mode remain idempotent/u,
      /conflicting mode flags: --autonomous and --headless; choose one/u,
      /only admitted\s+mode\/base options reaches the existing placement-specific missing-request refusal/u,
      /git check-ref-format --branch <value>/u,
      /git show-ref --verify --quiet refs\/heads\/<value>/u,
      /before run-id allocation, config effects, context lookup, state reads,\s+tool calls, or factory invocation/u,
      /factory init --pr-base <value>/u,
      /for\s+no-base input, omit `--pr-base` without changing the preserved request suffix or other effects/u,
    ];
    for (const contract of grammar) assert.match(skill, contract);
    const retryGrammar = [
      /\[--max-retries <n>\] <ticket key \| feature idea>/u,
      /\[--max-retries <n>\] <ticket key \| issue reference \| feature idea>/u,
      /\[--max-retries <n>\] <request>/u,
      /at most\s+one exact two-token `--max-retries <n>` pair in any order/u,
      /exact standalone case-sensitive token `--max-retries`/u,
      /Preserve `--max-retries=3`, `--MAX-RETRIES 3`, `--max-retries! 3`, and `request --max-retries 3` as request bytes\./u,
      /missing value for --max-retries; no run created\./u,
      /repeated --max-retries; no run created\./u,
      /repetition wins even when the first retry value is invalid/u,
      /admitted retry option but no request reaches that same missing-request refusal before numeric validation/u,
      /All retry refusals\s+precede run-id allocation, config effects, context lookup, state reads, tool calls, and factory invocation/u,
      /complete token matches\s+ASCII `\[0-9\]\+` and its numeric value is from 1 through 9007199254740991 inclusive/u,
      /Accept `1`, `003`, and\s+`9007199254740991`/u,
      /reject `0`, `000`, `-1`, `\+1`, `1\.0`, `1e2`, embedded whitespace, non-ASCII digits,\s+and `9007199254740992`/u,
      /--max-retries must be a positive integer; no run created\./u,
      /supplied retry token unchanged only as `factory init --max-retries <n>`/u,
      /when retry is absent,\s+omit the complete `--max-retries` argv pair/u,
      /`run\.json\.max_retries`, so forwarded `003` persists as `3`/u,
      /immutable persisted mode, base, and retry budget/u,
      /inner maximal mode\/base\/retry-prefix\s+admission/u,
    ];
    const checkRetryContract = (text, contract) => assert.match(text, contract);
    for (const contract of retryGrammar) checkRetryContract(skill, contract);
    for (const contract of retryGrammar) {
      const matchedPhrase = skill.match(contract)[0];
      assert.throws(() => checkRetryContract(skill.replace(matchedPhrase, ""), contract));
    }
    assert.deepEqual(bundledWorkflow, canonicalWorkflow);
    const workflow = bundledWorkflow.toString("utf8");
    const firstMatch = "Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries.";
    const noOp = "When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change.";
    const checkBootstrapPolicy = (text) => {
      if (!text.includes(firstMatch)) throw new Error("bootstrap-first-match");
      if (!text.includes(noOp)) throw new Error("bootstrap-absence-no-op");
    };
    checkBootstrapPolicy(workflow);
    assert.throws(() => checkBootstrapPolicy(workflow.replace(firstMatch, "")), /bootstrap-first-match/u);
    assert.throws(() => checkBootstrapPolicy(workflow.replace(noOp, "")), /bootstrap-absence-no-op/u);
  });
});
