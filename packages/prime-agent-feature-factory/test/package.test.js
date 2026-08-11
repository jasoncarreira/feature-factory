import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const skill = readFileSync(new URL("../skills/feature/SKILL.md", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../skills/feature/WORKFLOW.md", import.meta.url), "utf8");
const canonicalWorkflow = readFileSync(new URL("../../feature-factory/WORKFLOW.md", import.meta.url), "utf8");

describe("Prime package contract", () => {
  it("declares a conventional Prime package with only runtime factory state dependency", () => {
    assert.equal(manifest.name, "prime-agent-feature-factory");
    assert.ok(manifest.keywords.includes("pi-package"));
    assert.deepEqual(manifest.pi, {
      extensions: ["./extensions"],
      skills: ["./skills"],
    });
    assert.deepEqual(manifest.dependencies, { "feature-factory": "0.3.6" });
    assert.ok(manifest.files.includes("extensions"));
    assert.ok(manifest.files.includes("skills"));
  });

  it("ships a valid feature skill and binds the canonical workflow to Prime delegation", () => {
    assert.ok(skill.startsWith("---\nname: feature\ndescription: "));
    assert.match(skill, /\nlicense: MIT\ncompatibility: [^\n]+\n---\n/u);
    assert.match(skill, /\[WORKFLOW\.md\]\(WORKFLOW\.md\)/u);
    assert.match(skill, /Do not assume the skill loader inlined it/u);
    assert.match(skill, /feature_factory_context/u);
    assert.match(skill, /handle = await rlm\(prompt\)/u);
    assert.match(skill, /receiver_role="parent"/u);
    assert.match(skill, /never hand-write `run\.json`/u);
    assert.match(skill, /reject an exact case-sensitive first\s+`--background`/u);
    const grammar = [
      /exact case-sensitive first\s+`--background`/u,
      /assignment, case, punctuation, and later variants remain request content/u,
      /maximal leading option prefix/u,
      /mode and base in either order/u,
      /Preserve the suffix\s+beginning with the first request token byte-for-byte/u,
      /`--base=x`, case and punctuation variants/u,
      /`--base` after the first request token\s+are request content/u,
      /missing value for --base; no run created\./u,
      /repeated --base; no run created\./u,
      /Duplicate copies of one mode are\s+idempotent/u,
      /conflicting mode flags: --autonomous and --headless;\s+choose one/u,
      /missing \/feature\s+request; no run created\./u,
      /git\s+check-ref-format --branch <value>/u,
      /git show-ref --verify\s+--quiet/u,
      /before those same effects/u,
      /factory init --pr-base <value>/u,
      /for no-base\s+input, omit `--pr-base` without changing the preserved request suffix or other effects/u,
    ];
    for (const contract of grammar) assert.match(skill, contract);
    const retryGrammar = [
      ["retry-syntax", /\[--max-retries <n>\] <request>/u],
      ["retry-two-token", /at most one exact two-token `--max-retries <n>` pair/u],
      ["retry-prefix-order", /with mode and base in either order and\s+retry in any position/u],
      ["retry-request-variants", /`--max-retries=3`, `--Max-Retries 3`, and `--max-retries! 3`/u],
      ["retry-later-request", /exact\s+`--max-retries` after the first request token, are request content/u],
      ["retry-missing", /missing\s+value for --max-retries; no run created\./u],
      ["retry-repeated", /repeated --max-retries; no run created\./u],
      ["retry-repeat-precedence", /repetition wins even\s+when the first retry value is invalid/u],
      ["retry-options-only", /prefix containing only admitted mode, base, and retry options reaches exactly\s+`missing \/feature request; no run created\.` before retry numeric validation/u],
      ["retry-ascii-range", /full token matches ASCII `\[0-9\]\+` and its\s+mathematical value is from 1 through `9007199254740991`/u],
      ["retry-valid-examples", /`1`, `003`, and `9007199254740991` are\s+accepted/u],
      ["retry-invalid-examples", /`0`, `000`, `-1`, `\+1`, `1\.0`, `1e2`, embedded whitespace, non-ASCII digits, and\s+`9007199254740992`/u],
      ["retry-invalid-refusal", /--max-retries must be a positive integer; no run created\./u],
      ["retry-forward", /supplied retry token unchanged only as `factory init --max-retries <n>`/u],
      ["retry-persistence", /persists it\s+numerically as `max_retries` in `run\.json`, so `003` persists as `3`/u],
      ["retry-absent", /retry is absent, omit the entire\s+`--max-retries <n>` argv pair/u],
      ["preflight-order", /closed pre-context order:\s+canonical workflow load; placement rejection; full-prefix mode, base, and retry structural checks;\s+missing request; retry numeric validation; then base syntax and local-ref validation/u],
      ["refusal-skips-context", /Every admission refusal\s+skips `feature_factory_context` and precedes run-id allocation, configuration, state reads, dispatch, and every\s+factory invocation/u],
      ["one-context-call", /Only after successful admission, call `feature_factory_context` exactly once/u],
      ["context-validation-before-effects", /Require its returned\s+`sessionId`, `agents`, and `cli` to be non-empty strings and require the agent directory and CLI path to\s+be readable before resolver or configuration work, state reads, dispatch, or any factory effect/u],
    ];
    const checkRetryGrammar = (text) => {
      for (const [label, contract] of retryGrammar) {
        if (!contract.test(text)) throw new Error(label);
      }
    };
    checkRetryGrammar(skill);
    for (const [label, contract] of retryGrammar) {
      const match = skill.match(contract);
      assert.throws(() => checkRetryGrammar(skill.replace(match[0], "")), new RegExp(label, "u"));
    }
    assert.ok(skill.indexOf("This is the closed pre-context order:") < skill.indexOf("Only after successful admission"));
    assert.equal(workflow, canonicalWorkflow);
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
