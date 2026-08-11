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
    assert.ok(skill.startsWith("---\nname: feature\n"));
    assert.match(skill, /read `WORKFLOW\.md` located\nnext to this file completely/u);
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
