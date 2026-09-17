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
    // rendered work item. The rule is therefore restated in this skill.
    //
    // Bound as a WHOLE REGION, not as selected sentences. Review of the first attempt caught why that
    // matters: the hand-picked subset started at "With a valid present file" and omitted the config
    // schema, validation order and malformed-config refusals that decide validity -- so the restatement
    // read as executable while leaving a pre-init driver unable to determine whether a resolver was even
    // declared. A subset binding also cannot fail for an omission, which is the defect it should catch.
    // Compared on whitespace-normalized text so the two files may wrap differently.
    const flat = (text) => String(text).replace(/\s+/gu, " ").trim();
    const canonicalText = String(canonicalWorkflow);
    // The region starts at the `O` derivation, not at the config heading: the copied text reads
    // `$O/.factory.json` and runs `resolve` with cwd `O`, so a copy that omits how `O` is bound is still
    // not executable before `init`. Second review finding, same class as the first.
    const regionStart = canonicalText.indexOf("Preserve the admitted request bytes for story content and adapter forwarding.");
    const regionEnd = canonicalText.indexOf("#### Resolver and repository verification boundaries");
    assert.ok(regionStart >= 0 && regionEnd > regionStart,
      "the canonical pre-init region markers must both exist, in order");
    const canonicalRegion = flat(canonicalText.slice(regionStart, regionEnd));
    assert.ok(canonicalRegion.length > 9000,
      `the canonical pre-init region looks truncated at ${canonicalRegion.length} chars`);
    assert.ok(flat(skill).includes(canonicalRegion),
      "SKILL.md must restate the complete canonical pre-init region verbatim, `O` derivation and config validation included");
    assert.ok(canonicalRegion.includes("rev-parse --show-toplevel") && canonicalRegion.includes("Require an absolute, nonempty `O`"),
      "the bound region must span the `O` derivation, or the copy cannot locate the repository config");

    // Ordering is the defect, so pin ordering rather than presence: the restated region must precede the
    // operating modes, and the skill must say `init` is not exempt from coming after it.
    // The opening ordering contract, pinned as a sequence rather than as document position. The previous
    // version told the driver to read the staged workflow "before any state read" while the intake it also
    // mandates must read `$O/.factory.json` before `init` -- a contradiction a driver resolves by
    // initializing first, which is the original defect. Third review finding.
    const order = ["1. **Admission**", "2. **Repository resolver intake**", "3. **Reach the staged canonical workflow.**", "4. **Read that staged file completely**"];
    let cursor = -1;
    for (const step of order) {
      const at = skill.indexOf(step);
      assert.ok(at > cursor, `the opening order must list ${step} after the previous step`);
      cursor = at;
    }
    assert.ok(skill.includes("those reads and executions are the step itself and are not covered by the restriction in 4"),
      "the intake's own reads must be exempted from the staged-workflow restriction, or the order contradicts itself");
    assert.doesNotMatch(skill, /\*\*Read that file completely before any state read/u,
      "the blanket pre-read mandate must not return: it forbids the pre-init intake it also requires");
    assert.ok(skill.indexOf("## Repository resolver intake") < skill.indexOf("## Operating modes"));
    // The temporal split inside the copied region. The region is bound whole for drift protection, so it
    // also carries constraints that only apply at or after `init` -- the publishing-identity rules are
    // resolved BY `init` and bound from `status --json`. Declaring the whole region "step 2, before every
    // factory command including init" made those impossible. Fourth review finding: name the executable
    // pre-init subset, and exclude the rest from step 2, or the driver gets impossible sequencing again.
    assert.match(skill, /\*\*Step 2 executes exactly this subset, and nothing else in the region:\*\* derive and validate `O`; read and\s+validate `\$O\/\.factory\.json`; execute a declared `resolve`; validate its payload; bind `R`/u,
      "step 2 must name exactly the pre-init executable subset");
    assert.match(skill, /also carries constraints that apply at or after\s+`init` — do not attempt them in step 2/u,
      "the copied region's post-init constraints must be excluded from step 2");
    assert.match(skill, /publishing-identity rules below describe what\s+`factory init` itself resolves and records/u,
      "the post-init exclusion must name the publishing-identity rules, which are the ones in the region");
    assert.match(skill, /Nothing in this region licenses running a `factory`\s+command during step 2\./u,
      "step 2 must not be readable as permission to run a factory command");
    // The excluded text must actually be present in the region, or the exclusion is describing nothing.
    assert.ok(skill.includes("Bind `DECLARED_PUBLISHING_IDENTITY` from that reported value"),
      "the region must still contain the post-init binding the exclusion refers to");
    assert.match(skill, /Steps 1 and 2 are specified here, in full, because the document that specifies everything else does not\s+exist until step 3/u,
      "the skill must say why admission and the intake are restated here, or a later edit removes them as duplication");
    assert.ok(skill.startsWith("---\nname: feature\n"));
    // The workflow is read from where `init` stages it, not from beside this file: that path is outside
    // the workspace and `external_directory` is denied for every agent, so a run depending on it fails on a
    // permission refusal. These pin the reordering, one fragment per line so the assertion can match.
    assert.match(skill, /`factory init` stages the canonical workflow at the `workflow` path/u);
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

    // ENFORCEMENT, not instruction: this prevents a false green. A driver runs `factory init` at step 3,
    // before the canonical workflow is readable, so this skill is the only place the invocation can come
    // from -- and it used to describe init only as three isolated flag fragments (`--pr-base`,
    // `--max-retries`, `--mode`) with no `--repo` and no `--json` anywhere. A model assembled exactly those
    // fragments, omitted `--json`, and got a successful init whose response the workflow refuses to bind
    // from; repeating init is forbidden, so the run published `run.json`, stopped, and exited 0 leaving a
    // live sandbox at `status: running`. The fix is one source of truth, so the property pinned is byte
    // equality with the canonical block rather than the presence of any particular flag.
    const canonicalInit = String(canonicalWorkflow).split("\n").find((line) => line.startsWith("INIT_RESPONSE="));
    assert.ok(canonicalInit && canonicalInit.includes("factory init") && canonicalInit.endsWith("--json)\""),
      `the canonical workflow no longer carries a single --json-terminated init block: ${canonicalInit}`);
    assert.ok(skill.includes(canonicalInit),
      "SKILL.md must carry the canonical init invocation verbatim; step 3 runs it before the workflow exists");
    // The run-id derivation, on the same terms and for a sharper reason: a SUMMARY of it was written here
    // first and selected different runs than the canonical algorithm -- `implement ABC-123 login` became
    // `implement-abc-123-login` rather than `abc-123`, `café` became `caf` rather than `cafe`, and the
    // branch fallback and both multiple-key refusals were missing. That happens before init, so the wrong
    // run is created before any driver can notice the documents disagree. Byte equality, not paraphrase.
    const canonicalDerivation = String(canonicalWorkflow).slice(
      String(canonicalWorkflow).indexOf("If resolution did not already bind `R`"),
      String(canonicalWorkflow).indexOf("`cannot derive a canonical run id; no session or run created.`")
        + "`cannot derive a canonical run id; no session or run created.`".length,
    );
    assert.ok(canonicalDerivation.length > 600 && canonicalDerivation.includes("ambiguous branch ticket keys"),
      "the canonical derivation markers must still bound the whole algorithm");
    assert.ok(skill.includes(canonicalDerivation),
      "SKILL.md must carry the canonical run-id derivation verbatim; a summary of it picked different runs");
    assert.match(skill, /`--json` is mandatory\./u,
      "the skill must say --json is mandatory, which is the flag whose absence stranded a run");
    assert.match(skill, /before any dispatch, gate, further state read, or `?factory`?\s+command other than the `init` or `status` named above/u);
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
