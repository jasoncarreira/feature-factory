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
