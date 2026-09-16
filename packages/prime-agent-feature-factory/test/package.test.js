import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const factoryManifest = JSON.parse(readFileSync(new URL("../../feature-factory/package.json", import.meta.url), "utf8"));
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
    // Pinned to the factory's own version rather than to a literal. The three packages release in
    // lockstep from 0.7.0, so a literal here would have to be edited on every sync and would fail for
    // being stale rather than for the dependency being wrong — which is what it did at 0.3.6.
    // `boundary.test.js` pins the opencode adapter the same way; the workspace-level check that all
    // three versions actually match lives in `test/pack.test.js`.
    assert.deepEqual(manifest.dependencies, { "feature-factory": factoryManifest.version });
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
    // The same rule 0.8.6 applied to WORKFLOW.md, applied to this skill. Scoping it to the canonical
    // contract is why an unconditional `--draft` survived in README.md until an outside audit found it;
    // a rule that holds for the contract holds wherever the contract is restated. Selectors come from the
    // WORKFLOW.md this package bundles, so nothing here reaches into another package.
    const bundled = readFileSync(new URL("../skills/feature/WORKFLOW.md", import.meta.url), "utf8");
    const selectors = new Set();
    for (const [, body] of bundled.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)) {
      for (const [, name] of body.matchAll(/(?:if\s+\[{1,2}\s+|case\s+|elif\s+\[{1,2}\s+)"?\$\{?(\w+)\}?"?/gu)) selectors.add(name);
    }
    assert.ok(selectors.has("PR_DRAFT"), "the bundled workflow must still expose PR_DRAFT, or this check is vacuous");
    const skillProse = skill.replace(/```[a-z]*\n[\s\S]*?```/gu, "");
    const offending = skillProse.split(/\n\s*\n/u)
      .filter((para) => /draft PR\b|\bdraft publication\b|PR is a draft\b/iu.test(para) && !/PR_DRAFT|pr_draft/iu.test(para));
    assert.deepEqual(offending, [],
      `the skill states a PR_DRAFT outcome as if it were fixed:\n  ${offending.join("\n  ")}`);
    // Fences too. The first version of this guard stripped them, so appending an unconditional
    // ```sh\ngh pr create --draft\n``` to the skill passed -- which is exactly the shape the README
    // defect took. Checked over the whole file, examples included.
    const inFences = skill.split(/\n\s*\n/u)
      .filter((block) => /gh pr create --draft|\bDRAFT PR\b/u.test(block) && !/PR_DRAFT|pr_draft/iu.test(block));
    assert.deepEqual(inFences, [],
      `the skill shows an unconditional draft outcome in an example:\n  ${inFences.join("\n  ")}`);

    // ENFORCEMENT, not instruction: this prevents a false green. Prime does load the canonical workflow
    // before init, so unlike OpenCode it is not bootstrapping blind -- but a skill that describes init
    // only as isolated flag fragments still invites a driver to assemble one, and on OpenCode exactly
    // that produced an init without `--json`: a successful init whose response the workflow refuses to
    // bind from, with repeating init forbidden, so the run published `run.json`, stopped, and exited 0
    // leaving a live sandbox at `status: running`. One invocation across hosts is the fix, so the
    // property pinned is byte equality with the canonical block rather than any particular flag.
    const canonicalInit = String(canonicalWorkflow).split("\n").find((line) => line.startsWith("INIT_RESPONSE="));
    assert.ok(canonicalInit && canonicalInit.includes("factory init") && canonicalInit.endsWith("--json)\""),
      `the canonical workflow no longer carries a single --json-terminated init block: ${canonicalInit}`);
    assert.ok(skill.includes(canonicalInit),
      "SKILL.md must carry the canonical init invocation verbatim; step 3 runs it before the workflow exists");
    assert.match(skill, /`--json` is mandatory\./u,
      "the skill must say --json is mandatory, which is the flag whose absence stranded a run");
    // The shared command must not drag OpenCode's bootstrap rationale with it. Prime loads the canonical
    // workflow BEFORE intake, admission and `feature_factory_context`, so "the workflow is unreadable
    // until init" and "step 3 runs init" are both false here -- Prime's step 3 applies host bindings --
    // and they contradict this file's own preflight. That is the contradictory-instruction defect this
    // change exists to remove, reintroduced by the fix for it, and the byte-equality assertion above
    // cannot see it because the command was identical. Caught in review. Lexical, like any prose guard:
    // it pins the claims that were actually made, not every way the order could be misstated.
    for (const openCodeOnly of [/not readable until init/u, /only document available/u, /Step 3 runs `factory init`/u]) {
      assert.doesNotMatch(skill, openCodeOnly, `Prime skill carries an OpenCode-only bootstrap claim: ${openCodeOnly}`);
    }
    assert.ok(skill.indexOf("## Load the canonical contract first") >= 0
      && skill.indexOf("## Load the canonical contract first") < skill.indexOf("## The init invocation"),
      "Prime's canonical-workflow load must precede the init invocation section, which is its real order");
    assert.match(skill, /This section adds no ordering\./u,
      "the Prime copy must say it adds no ordering, or it reads as a competing sequence");
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
