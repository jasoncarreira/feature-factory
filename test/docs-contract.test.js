import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DIAGNOSTIC_CLASSIFICATIONS,
  DIAGNOSTIC_CONDITIONS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_STATUSES,
} from "../src/factory-diagnostics.js";
import { HEARTBEAT_PHASES, TERMINAL_RUN_STATUSES } from "../src/validate.js";

const SKILL = readDoc("../assets/skills/feature/SKILL.md");
const SCHEMA = readDoc("../assets/skills/feature/SCHEMA.md");
const COMMAND = readDoc("../assets/command/feature.md");
const README = readDoc("../README.md");
const SPEC = readDoc("../SPEC.md");
const TODO = readDoc("../TODO.md");
const CONTRIBUTING = readDoc("../CONTRIBUTING.md");
const RELEASING = readDoc("../RELEASING.md");
const CHANGELOG = readDoc("../CHANGELOG.md");
const DOGFOOD_LEARNINGS = readDoc("../DOGFOOD-LEARNINGS.md");
const RUN_LATENCY_FINDINGS = readDoc("../RUN-LATENCY-FINDINGS.md");
const SIMPLIFICATION = readDoc("../SIMPLIFICATION.md");
const PACKAGE = JSON.parse(readDoc("../package.json"));
const TOOL_VERSIONS = readDoc("../.tool-versions");
const CI_WORKFLOW = readDoc("../.github/workflows/ci.yml");
const PUBLISH_WORKFLOW = readDoc("../.github/workflows/publish.yml");
const CLI = readDoc("../src/cli.js");
const PLUGIN = readDoc("../src/plugin.js");
const TUI = readDoc("../src/tui.jsx");
const CODEBASE_RESEARCHER_PROMPT = readDoc("../assets/agent/codebase-researcher.md");
const SPEC_WRITER_PROMPT = readDoc("../assets/agent/spec-writer.md");
const WORK_DECOMPOSER_PROMPT = readDoc("../assets/agent/work-decomposer.md");
const WORK_REVIEWER_PROMPT = readDoc("../assets/agent/work-reviewer.md");
const IMPLEMENTATION_VALIDATOR_PROMPT = readDoc("../assets/agent/implementation-validator.md");
const SECURITY_REVIEWER_PROMPT = readDoc("../assets/agent/security-reviewer.md");
const BLOCKED_CONTINUE_COMMAND = "feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>";
const STATE_WRITE_COMMANDS = Object.freeze([
  "factory env record-created <run-id> --json",
  "factory env record-resume <run-id> --json",
  "factory steer <run-id> --message TEXT --json",
  "factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json",
  "factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --reason TEXT --json",
  "factory cost-record <run-id> --agent AGENT --step STEP --slice-id ID --provider PROVIDER --model MODEL --input-tokens N --output-tokens N --total-tokens N --cost-total N --currency CODE --json",
  "factory answer --json <run-id> <gate> approve",
  "factory recover <run-id> --reason TEXT --json",
  "factory gate-decision <run-id> <gate> pending",
  "factory gate-decision <run-id> <gate> approved",
  "factory slices-seed <run-id> --from plan/slices.json",
  "factory slice-status <run-id> <slice-id> running",
  "factory slice-status <run-id> <slice-id> review",
  "factory slice-status <run-id> <slice-id> blocked",
  "factory step <run-id> <known-agent> running",
  "factory step <run-id> <known-agent> accepted",
  "factory verdicts <run-id> --validator GO",
  "factory terminal <run-id> blocked --reason TEXT",
  "factory slice-merged <run-id> <slice-id> --merge-commit SHA",
  "factory pr-created <run-id> --pr-url URL --pr-number N --repository OWNER/REPO",
]);
const PROCESS_SIDECAR_COMMANDS = Object.freeze([
  "factory cancel <run-id> --json",
]);
const COST_REPORT_DOCS = Object.freeze({ SKILL, SCHEMA, COMMAND, README, SPEC });
const LIVE_DRAIN_SKILL = markdownSection(SKILL, "Live-Run Steering Drain Protocol");
const LIVE_DRAIN_SCHEMA = markdownSection(SCHEMA, "Live-Run Steering Drain Protocol");
const LIVE_DRAIN_DOCS = Object.freeze({ LIVE_DRAIN_SKILL, LIVE_DRAIN_SCHEMA });
const LIVE_DRAIN_BOUNDARIES = Object.freeze([
  "After a heartbeat-bracketed wait",
  "Before an autonomous gate approval decision",
  "Before dispatching the next agent or next build wave",
  "Before remediation",
  "Before terminalization or PR creation",
]);

describe("class-wide planning prompt contract", () => {
  it("requires research to enumerate a finite source-to-sink surface", () => {
    assert.match(CODEBASE_RESEARCHER_PROMPT, /class-wide requirements as closed-world inventory work/i);
    for (const trigger of ["all", "every", "centralize", "across"]) {
      assert.match(CODEBASE_RESEARCHER_PROMPT, literalPattern(`\`${trigger}\``), `research prompt missing class-wide trigger ${trigger}`);
    }
    for (const column of ["Source", "Sink / call site", "Existing guard", "Required policy", "Compatibility / exclusion", "Test"]) {
      assert.match(CODEBASE_RESEARCHER_PROMPT, literalPattern(column), `research inventory missing ${column}`);
    }
    assert.match(CODEBASE_RESEARCHER_PROMPT, /deliberate exclusions with reasons/i);
    assert.match(CODEBASE_RESEARCHER_PROMPT, /cannot establish a finite inventory[\s\S]*additional research required/i);
  });

  it("requires specs to close class-wide scope before builders run", () => {
    assert.match(SPEC_WRITER_PROMPT, /research map must contain a finite surface inventory/i);
    assert.match(SPEC_WRITER_PROMPT, /Class-wide implementation matrix \(required when applicable\)/i);
    for (const column of ["Source", "Sink / call site", "Required primitive / policy", "Compatibility / exclusion", "Test"]) {
      assert.match(SPEC_WRITER_PROMPT, literalPattern(column), `spec matrix missing ${column}`);
    }
    assert.match(SPEC_WRITER_PROMPT, /stop and request targeted research/i);
    assert.match(SPEC_WRITER_PROMPT, /Do not use open-ended phrases such as "apply everywhere"/i);
  });

  it("requires first review to consolidate same-class findings across every dimension", () => {
    assert.match(WORK_REVIEWER_PROMPT, /First-attempt completeness rule:[\s\S]*`attempt: 1`[\s\S]*every dimension of under-specification/i);
    assert.match(WORK_REVIEWER_PROMPT, /do not surface one example, or one category, while withholding equivalent findings for later rounds/i);
    assert.match(WORK_REVIEWER_PROMPT, /new category that was discoverable at `attempt: 1`[\s\S]*first-pass miss/i);
    assert.match(WORK_REVIEWER_PROMPT, /class-wide requirements[\s\S]*finite source-to-sink implementation matrix/i);
    assert.match(WORK_REVIEWER_PROMPT, /Delta rule:[\s\S]*`attempt > 1`/i);
  });

  it("gives the spec review an acceptance bar so it converges", () => {
    assert.match(WORK_REVIEWER_PROMPT, /Spec acceptance bar/i);
    assert.match(WORK_REVIEWER_PROMPT, /every in-scope sink carries a decided policy[\s\S]*maps to a test/i);
    assert.match(WORK_REVIEWER_PROMPT, /Reject only for a genuinely missing sink, policy, compatibility decision, or test — not for achievable-but-absent depth/i);
    assert.match(SKILL, /Accept the brief once the inventory is finite[\s\S]*decided per-sink policy[\s\S]*mechanical residual detail/i);
  });

  it("bounds deferral so an in-scope sink cannot be waived without story/scope authorization", () => {
    // A deferral/exclusion is legitimate only when the approved story or scope authorizes it,
    // and never for a sink under an all/every criterion — otherwise the bar passes the unsafe
    // interpretation where a reviewer defers a required sink and calls the spec accepted.
    assert.match(
      WORK_REVIEWER_PROMPT,
      /deferral or exclusion is legitimate \*\*only when the approved story or scope authorizes it\*\*[\s\S]*never (?:waive, defer, or leave undecided )?an in-scope sink (?:that falls )?under an `all`\/`every`\/`across`/i,
      "work-reviewer must forbid deferring an in-scope all/every sink without story/scope authorization",
    );
    assert.match(
      SKILL,
      /deferring or excluding a sink only when the approved story or scope authorizes it \(never an in-scope sink under an `all`\/`every` criterion\)/i,
      "SKILL must mirror the story/scope-authorized deferral boundary",
    );
  });

  it("forbids leaving an unresolved behavioral/design decision as a bounded residual", () => {
    // A residual must be mechanical detail whose behavior/compat/security/state policy is already
    // decided; an undecided behavioral/design decision is not a residual and cannot be shipped to
    // builders as an open choice — otherwise the bar passes the unsafe "approve an undecided row".
    assert.match(
      WORK_REVIEWER_PROMPT,
      /bounded residual\*\* may be left to build-time remediation only when it is mechanical implementation detail whose behavior, backward-compatibility, security, and state-transition policy are already decided[\s\S]*unresolved behavioral or design decision is not a residual and must be decided here/i,
      "work-reviewer must exclude unresolved behavioral/design decisions from bounded residuals",
    );
    assert.match(
      SKILL,
      /only mechanical residual detail whose behavior, compatibility, security, and state-transition policy are already decided, never an unresolved behavioral or design decision/i,
      "SKILL must mirror the mechanical-only residual boundary",
    );
  });

  it("keeps a required late-discovered omission blocking until fixed despite the delta rule", () => {
    // Precedence: a genuinely required sink/policy/compat/test omission is blocking regardless of
    // attempt number; the delta rule's NONBLOCKING carve-out is only for unrelated new scope or
    // optional depth — otherwise an attempt-2 discovery could be approved as nonblocking.
    assert.match(
      WORK_REVIEWER_PROMPT,
      /Precedence for late discoveries:[\s\S]*blocking regardless of attempt number[\s\S]*NONBLOCKING carve-out applies only to \*unrelated\* new scope or \*optional\* additional depth[\s\S]*never downgrades a required in-scope omission to optional/i,
      "work-reviewer must state that required omissions stay blocking regardless of attempt",
    );
    assert.match(
      WORK_REVIEWER_PROMPT,
      /Record it once in `required_fixes`, carry it into every later review, and REJECT until observed evidence proves it landed/i,
      "work-reviewer must carry a required omission forward and reject until it lands",
    );
    assert.match(
      SKILL,
      /recorded once and carried in prior `required_fixes` until observed fixed[\s\S]*each review must REJECT until it lands/i,
      "SKILL must carry a required omission forward and reject until it lands",
    );
    assert.doesNotMatch(WORK_REVIEWER_PROMPT, /blocking-once|do not reopen it/i);
  });

  it("puts the closed-scope guard in workflow steps 1 and 2", () => {
    assert.match(SKILL, /Step 1 - Research And Design[\s\S]*finite in-scope surface inventory[\s\S]*Step 2 - Spec And Decomposition/i);
    assert.match(SKILL, /Step 2 - Spec And Decomposition[\s\S]*closed implementation matrix[\s\S]*Do not dispatch builders with unresolved instructions/i);
    assert.match(SKILL, /first spec review[\s\S]*every currently discoverable same-class issue[\s\S]*one `required_fixes` list/i);
  });

  it("rejects specifications whose required behavior conflicts with every allowed implementation mechanism", () => {
    assert.match(
      WORK_REVIEWER_PROMPT,
      /Feasibility rule:[\s\S]*cannot be implemented within its allowed mechanisms, dependencies, compatibility constraints, or explicit non-goals/i,
    );
    assert.match(
      WORK_REVIEWER_PROMPT,
      /grammar-complete[\s\S]*prohibiting every parser, tokenizer, scanner, dependency/i,
    );
    assert.match(
      SKILL,
      /reject mutually incompatible constraints[\s\S]*feasible within the brief's allowed mechanisms, dependencies, compatibility rules, and non-goals/i,
    );
  });
});

describe("review trust and remediation escalation contract", () => {
  it("requires concrete authority gain inside the declared trust model", () => {
    for (const [name, text] of documentEntries({ IMPLEMENTATION_VALIDATOR_PROMPT, SECURITY_REVIEWER_PROMPT })) {
      assert.match(text, /untrusted ingress[\s\S]*privileged sink[\s\S]*capability gained[\s\S]*already possess/i, `${name} must require concrete authority gain`);
      assert.match(text, /arbitrary code already executing in the same (?:Node\.js )?process[\s\S]*unless the (?:approved )?story[\s\S]*untrusted/i, `${name} must keep same-process mutation outside the default trust model`);
      assert.match(text, /secret-exposure[\s\S]*sensitive source[\s\S]*unauthorized disclosure sink or observer[\s\S]*does not require attacker-controlled ingress/i, `${name} must preserve secret disclosure as independently blocking`);
      assert.match(text, /Supply-chain compromise and security regressions[\s\S]*(?:independently|remain)[\s\S]*blocking/i, `${name} must preserve supply-chain and regression blockers`);
    }
  });

  it("classifies rerun findings and consolidates discoverable authority surfaces", () => {
    for (const [name, text] of documentEntries({ IMPLEMENTATION_VALIDATOR_PROMPT, SECURITY_REVIEWER_PROMPT })) {
      for (const classification of ["unresolved-prior", "remediation-regression", "remediation-exposed", "unrelated-new-scope"]) {
        assert.match(text, literalPattern(classification), `${name} must classify ${classification} findings`);
      }
    }
    assert.match(SECURITY_REVIEWER_PROMPT, /first review[\s\S]*complete discoverable authority and mutation surface[\s\S]*Do not reveal one[\s\S]*per remediation round/i);
  });

  it("stops retry churn when remediation requires a design decision", () => {
    assert.match(SKILL, /Before spending a remediation attempt[\s\S]*design-level root cause/i);
    assert.match(SKILL, /violate an accepted story or brief constraint[\s\S]*repeated findings arise from the same unresolved design choice/i);
    assert.match(SKILL, /do not burn another implementation retry[\s\S]*terminalize the run as blocked[\s\S]*reviewed continuation to amend the specification/i);
  });
});

describe("consolidated reviewer decision procedure contract", () => {
  const reviewerPrompts = {
    WORK_REVIEWER_PROMPT,
    IMPLEMENTATION_VALIDATOR_PROMPT,
    SECURITY_REVIEWER_PROMPT,
  };

  it("defines exactly one ordered, role-specific procedure per reviewer", () => {
    for (const [name, text] of documentEntries(reviewerPrompts)) {
      assert.equal(text.match(/^## Ordered decision procedure$/gmu)?.length, 1, `${name} must have exactly one decision procedure`);
    }
    assert.match(WORK_REVIEWER_PROMPT, orderedPattern(["evidence truth", "evidence boundary", "attempt mode", "subject checks", "touched-path security", "declared trust model", "required-omission precedence", "structured review"]));
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, orderedPattern(["bounded integrated surface", "attempt mode", "priority order", "mandatory security review", "declared trust model", "validator threshold", "structured validation report"]));
    assert.match(SECURITY_REVIEWER_PROMPT, orderedPattern(["trust model and bounded diff surface", "attempt mode", "every touched ingress", "Qualify each candidate", "trust and authority qualification", "security-specific threshold", "structured security review"]));
  });

  it("keeps procedural policy inside the one ordered procedure", () => {
    const procedureMarkers = {
      WORK_REVIEWER_PROMPT: [
        /Producer reports are claims; orchestrator-observed evidence is truth/i,
        /First-attempt completeness rule/i,
        /Feasibility rule/i,
        /mandatory touched-path security review/i,
        /Apply the declared trust model/i,
        /Precedence for late discoveries/i,
        /Emit the structured review/i,
      ],
      IMPLEMENTATION_VALIDATOR_PROMPT: [
        /Establish the bounded integrated surface/i,
        /Delta Review Rule/i,
        /Review holistically in priority order/i,
        /Perform the mandatory security review/i,
        /Qualify security candidates against the declared trust model before elevation/i,
        /Apply the validator threshold and determine severity\/verdict/i,
        /Emit and route the structured validation report/i,
      ],
      SECURITY_REVIEWER_PROMPT: [
        /Establish the trust model and bounded diff surface/i,
        /Delta rule/i,
        /Construct bypasses across every touched ingress/i,
        /Qualify each candidate before blocking/i,
        /Apply trust and authority qualification/i,
        /Apply the security-specific threshold and determine verdict/i,
        /Emit and route the structured security review/i,
      ],
    };

    for (const [name, text] of documentEntries(reviewerPrompts)) {
      const procedure = markdownSection(text, "Ordered decision procedure");
      const outsideProcedure = text.replace(procedure, "");
      for (const marker of procedureMarkers[name]) {
        assert.match(procedure, marker, `${name} must retain its ${marker} policy in the procedure`);
        assert.doesNotMatch(outsideProcedure, marker, `${name} must not duplicate ${marker} in a legacy rule block`);
      }
    }
  });

  it("preserves exact role-specific structured verdict schemas, actionable fields, and durable routes", () => {
    const workOutput = firstFencedBlockAfter(WORK_REVIEWER_PROMPT, /## Output/i);
    for (const field of [
      "## Review: <subject>",
      "**Verdict:** APPROVE | REJECT",
      "**Checked against:** output-contract, technical-brief, observed-evidence, repo-guidelines",
      "**Claim vs observed:** consistent | MISMATCH - <details>",
      "**Findings:**",
      "- [BLOCKER] <what> - `path:line` - <why it fails> - fix_owner: <agent>",
      "- [MAJOR] <...>",
      "- [MINOR] <...>",
      "**Required fixes (if REJECT):**",
      "1. <specific fix>",
    ]) {
      assert.match(workOutput, literalPattern(field), `work reviewer output missing ${field}`);
    }

    const validatorOutput = firstFencedBlockAfter(IMPLEMENTATION_VALIDATOR_PROMPT, /## Output/i);
    for (const field of [
      "## Validation report",
      "**Verdict:** GO | GO-WITH-NITS | NO-GO",
      "**Acceptance criteria:**",
      "| AC | Implemented | Tested | Notes |",
      "| AC1 | yes/no/partial | yes/no | `path:line` |",
      "**Findings:**",
      "- [BLOCKER] <what> - `path:line` - <why it fails> - fix_owner: <agent>",
      "- [MAJOR] <...>",
      "- [MINOR] <...>",
      "**Brief deviations:** <list, each defensible/not | none>",
      "**Scope check:** <clean | issue at path>",
      "**If NO-GO:** <single most important fix and owner>",
    ]) {
      assert.match(validatorOutput, literalPattern(field), `validator output missing ${field}`);
    }
    for (const route of ["reviews/implementation-validator.json", "artifacts/validation-report.md", "run.json.validator.report", "run.json.validator.review_ref"]) {
      assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, literalPattern(`\`${route}\``), `validator missing route ${route}`);
    }

    const securityOutput = firstFencedBlockAfter(SECURITY_REVIEWER_PROMPT, /## Output/i);
    for (const field of [
      "## Security review",
      "**Verdict:** PASS | BLOCK",
      "**Ingresses reviewed:** <every untrusted-input entry path you traced>",
      "**Findings:**",
      "- [BLOCK] <what> - `path:line` - <the concrete bypass / why it fails> - fix: <specific change>",
      "- [NONBLOCKING] <...>",
      "**Bypass attempts:** <what you tried; for each: blocked (why) or exploitable (how)>",
    ]) {
      assert.match(securityOutput, literalPattern(field), `security reviewer output missing ${field}`);
    }
    for (const route of ["reviews/security-reviewer.json", "run.json.security_review.review_ref"]) {
      assert.match(SECURITY_REVIEWER_PROMPT, literalPattern(`\`${route}\``), `security reviewer missing route ${route}`);
    }
  });

  it("preserves work-review evidence authority and every subject-specific rejection disposition", () => {
    assert.match(WORK_REVIEWER_PROMPT, /Producer reports are claims; orchestrator-observed evidence is truth[\s\S]*Reject if a claim and the observed evidence disagree/i);
    assert.match(WORK_REVIEWER_PROMPT, /supplied evidence is insufficient[\s\S]*REJECT with the exact missing ref, path, or command[\s\S]*Do not compensate with open-ended scanning/i);

    for (const failClosedCase of [
      "`review_ready=false`",
      "empty or unobserved required diff",
      "missing, failed, fake, or unobserved tests without an explicit acceptable skip reason",
    ]) {
      assert.match(WORK_REVIEWER_PROMPT, new RegExp(`REJECT[^\\n]*${escapeRegExp(failClosedCase)}`, "i"), `work reviewer must reject ${failClosedCase}`);
    }

    assert.match(WORK_REVIEWER_PROMPT, /REJECT[\s\S]*out-of-lane edits outside slice `paths`[\s\S]*acceptance criterion that is unimplemented or untested/i);
    assert.match(WORK_REVIEWER_PROMPT, /REJECT serious correctness, repository-convention, migration, generated-code, or compatibility risk/i);
    for (const decompositionFailure of ["orphan acceptance criteria", "cyclic dependencies", "same-wave path overlap", "un-serialized hotspots", "dependency path deeper than three waves"]) {
      assert.match(WORK_REVIEWER_PROMPT, new RegExp(`For decomposition, REJECT[^\\n]*${escapeRegExp(decompositionFailure)}`, "i"), `work reviewer must reject ${decompositionFailure}`);
    }

    assert.match(WORK_REVIEWER_PROMPT, /mandatory touched-path security review[\s\S]*Enumerate \*\*every\*\* path the observed diff touches[\s\S]*including sibling entry points/i);
    assert.match(
      WORK_REVIEWER_PROMPT,
      /outside the factory trust model[\s\S]*NONBLOCKING notes, never REJECT reasons[\s\S]*malicious local operator[\s\S]*manipulating `PATH`[\s\S]*rewriting Git history[\s\S]*hand-editing run state[\s\S]*tampering across runs[\s\S]*arbitrary code already executing in the same process[\s\S]*story does not classify it as untrusted[\s\S]*Same-process object mutation alone adds no signaling authority[\s\S]*Cite the README trust statement/i,
      "work reviewer must preserve the complete outside-model and same-process authority carve-out",
    );
    assert.match(WORK_REVIEWER_PROMPT, /confirmed applicable trust-boundary, injection, auth-bypass, or secret-exposure issue is a BLOCKER -> REJECT, even if default-off/i);
    assert.match(WORK_REVIEWER_PROMPT, /Give actionable justification for every rejection and specific fixes owned by the appropriate agent/i);
    assert.match(WORK_REVIEWER_PROMPT, /\*\*Required fixes \(if REJECT\):\*\*[\s\S]*<specific fix>/i);
  });

  it("preserves validator holistic checks, ingress completeness, authority qualification, and routing", () => {
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /priority order[^\n]*security → correctness → architecture → performance → tests → style/i);
    for (const check of [
      /every acceptance criterion is implemented and meaningfully tested/i,
      /follows the brief or has explicitly defensible deviations/i,
      /cross-slice integration and shared hotspots are coherent/i,
      /scope is clean/i,
      /no serious correctness, migration, generated-code, performance, or compatibility issue remains/i,
      /Tests must contain real assertions that would fail on regression/i,
    ]) {
      assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, check, `validator missing holistic check ${check}`);
    }
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /mandatory security review[\s\S]*Enumerate \*\*every\*\* relevant ingress and path[\s\S]*including sibling handlers/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /Carry every unresolved prior fix forward[\s\S]*unresolved prior blockers[\s\S]*produce `NO-GO`/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /same process is outside the threat model unless the approved story explicitly classifies it as untrusted[\s\S]*same-process object mutation alone adds no signaling authority/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /`reviews\/implementation-validator\.json` with `subject` equal to the integrated feature branch name/i);
  });

  it("preserves security-review attack completeness, strict dispositions, routing, and distinct schema", () => {
    assert.match(SECURITY_REVIEWER_PROMPT, /Deny the untrusted path \*\*before\*\* any trusted-allowance carve-out/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /Construct bypasses across every touched ingress[\s\S]*Enumerate \*\*every\*\* ingress the diff touches[\s\S]*including sibling endpoints/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /Carry unresolved prior fixes forward[\s\S]*Applicable unresolved-prior[\s\S]*remain `BLOCK`/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /same Node\.js process unless the approved story explicitly classifies it as untrusted[\s\S]*does not gain a new signaling capability by mutating another in-process object/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /`reviews\/security-reviewer\.json` with `subject` equal to the integrated feature branch name/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /Record every bypass attempt as blocked with why, or exploitable with how/i);

    const securityOutput = firstFencedBlockAfter(SECURITY_REVIEWER_PROMPT, /## Output/i);
    for (const validatorOnlyField of ["Acceptance criteria", "Brief deviations", "Scope check", "If NO-GO", "fix_owner", "[MAJOR]", "[MINOR]"]) {
      assert.doesNotMatch(securityOutput, literalPattern(validatorOnlyField), `security output must not gain validator field ${validatorOnlyField}`);
    }
    assert.doesNotMatch(SECURITY_REVIEWER_PROMPT, /artifacts\/validation-report\.md|run\.json\.validator\./i, "security routing must remain distinct from validator routing");
  });

  it("preserves security classes and each role's repository-rubric boundary", () => {
    for (const [name, text] of documentEntries(reviewerPrompts)) {
      for (const findingClass of ["Trust boundaries", "Injection", "Forgeable identity / authz", "Secrets", "Security regression"]) {
        assert.match(text, literalPattern(findingClass), `${name} missing security class ${findingClass}`);
      }
    }
    for (const text of [IMPLEMENTATION_VALIDATOR_PROMPT, SECURITY_REVIEWER_PROMPT]) assert.match(text, /Supply chain[\s\S]*(?:when|if).*touch/i);
    for (const text of [WORK_REVIEWER_PROMPT, IMPLEMENTATION_VALIDATOR_PROMPT]) assert.match(text, /`REVIEW\.md`[\s\S]*binding rubric when present/i);
    assert.doesNotMatch(SECURITY_REVIEWER_PROMPT, /REVIEW\.md/i, "security reviewer must not gain a repository-rubric policy");
  });

  it("keeps severity mappings and role-specific fail-closed thresholds distinct", () => {
    assert.match(WORK_REVIEWER_PROMPT, /confirmed applicable[\s\S]*BLOCKER -> REJECT[\s\S]*default-off/i);
    assert.match(WORK_REVIEWER_PROMPT, orderedPattern(["`BLOCKER` -> REJECT", "`MAJOR` -> APPROVE", "`MINOR` -> note only"]));
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /confirmed applicable[\s\S]*`BLOCKER` -> `NO-GO`[\s\S]*default-off/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /Do not apply the security reviewer's broader “not ruled out” threshold/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /MAJOR-only -> `GO-WITH-NITS`[\s\S]*clean or minor-only -> `GO` or `GO-WITH-NITS`/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /applicable under the declared trust model[\s\S]*confirmed \*\*or not-ruled-out\*[\s\S]*produces `BLOCK`[\s\S]*default-off/i);
    assert.doesNotMatch(WORK_REVIEWER_PROMPT, /not-ruled-out/i);
  });

  it("preserves rerun classifications, carry-forward, and remediation dispositions without homogenizing work review", () => {
    for (const [name, text] of documentEntries({ IMPLEMENTATION_VALIDATOR_PROMPT, SECURITY_REVIEWER_PROMPT })) {
      assert.match(text, /fresh read-only|prior `required_fixes`/i, `${name} must receive fresh/prior-fix context`);
      for (const classification of ["unresolved-prior", "remediation-regression", "remediation-exposed", "unrelated-new-scope"]) {
        assert.match(text, literalPattern(`\`${classification}\``), `${name} missing ${classification}`);
      }
      assert.match(text, /Carry (?:every )?unresolved prior fix(?:es)? forward/i, `${name} must carry unresolved fixes`);
      assert.match(text, /remediation-regression[\s\S]*remediation-exposed[\s\S]*(?:blocking|NO-GO|BLOCK)/i, `${name} must disposition created/exposed issues`);
      assert.match(text, /unrelated-new-scope[\s\S]*NONBLOCKING/i, `${name} must keep unrelated unchanged scope nonblocking`);
    }
    assert.match(WORK_REVIEWER_PROMPT, /required-omission rule overrides the delta rule/i);
    assert.doesNotMatch(WORK_REVIEWER_PROMPT, /`unresolved-prior`|`remediation-regression`|`remediation-exposed`/i);
  });

  it("keeps all three searches bounded by supplied evidence and concrete expansion triggers", () => {
    assert.match(WORK_REVIEWER_PROMPT, /concrete artifact claim contradicts a cited file/i);
    assert.match(WORK_REVIEWER_PROMPT, /supplied evidence[\s\S]*Do not start a new broad codebase survey/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /supplied full-diff file inventory[\s\S]*Do not run broad repository rediscovery[\s\S]*concrete changed import, call site, or generated-output edge/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /supplied full-diff path inventory[\s\S]*Do not broadly rescan[\s\S]*concrete changed ingress, sink, import, or shared guard/i);
  });
});

describe("bounded agent depth contract", () => {
  it("denies recursive delegation to every subagent in the schema", () => {
    assert.match(SCHEMA, /Only the primary `feature-factory` agent may use the Task tool/i);
    assert.match(SCHEMA, /Every registered subagent has `permission\.task: "deny"`/i);
  });

  it("gives research one scoped pass with a bounded budget and no repeated scans", () => {
    assert.match(CODEBASE_RESEARCHER_PROMPT, /Do not delegate to another agent/i);
    assert.match(CODEBASE_RESEARCHER_PROMPT, /Perform one discovery pass/i);
    assert.match(CODEBASE_RESEARCHER_PROMPT, /do not repeat an equivalent Glob\/Grep query or reread an unchanged file/i);
    assert.match(CODEBASE_RESEARCHER_PROMPT, /Budget roughly 8 searches and 16 file reads[\s\S]*class-wide[\s\S]*12 searches and 24 reads/i);
    assert.match(CODEBASE_RESEARCHER_PROMPT, /stop and report the exact missing evidence instead of continuing open-ended discovery/i);
  });

  it("keeps planning and review inside supplied evidence boundaries", () => {
    assert.match(SPEC_WRITER_PROMPT, /Do not delegate and do not run broad Glob\/Grep searches/i);
    assert.match(SPEC_WRITER_PROMPT, /Never repeat research already present in the map/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /Do not delegate or rediscover the codebase/i);
    assert.match(WORK_REVIEWER_PROMPT, /Never edit, commit, fix, or delegate/i);
    assert.match(WORK_REVIEWER_PROMPT, /Bind the evidence boundary[\s\S]*verification subject-specific/i);
    assert.match(WORK_REVIEWER_PROMPT, /Do not independently rediscover the repository or repeat the researcher's inventory searches/i);
    assert.match(WORK_REVIEWER_PROMPT, /Do not reread unchanged files or rerun first-attempt discovery/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /Do not run broad repository rediscovery[\s\S]*concrete changed import, call site, or generated-output edge/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /Expand only when a concrete changed ingress, sink, import, or shared guard leads to an unlisted path/i);
  });

  it("documents bounded workflow depth in the README", () => {
    assert.match(README, /### Workflow Depth/i);
    assert.match(README, /only agent allowed to dispatch tasks/i);
    assert.match(README, /duplicate plugin-owned agent names/i);
  });
});

describe("decomposition depth contract", () => {
  it("requires the decomposer and reviewer to enforce a three-wave maximum", () => {
    assert.match(WORK_DECOMPOSER_PROMPT, /longest dependency path may span at most three waves; a root slice is wave 1/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /combine tightly serialized work into one coherent slice instead of creating a fourth wave/i);
    assert.match(WORK_REVIEWER_PROMPT, /dependency path deeper than three waves \(root is wave 1\)/i);
  });

  it("documents derived depth separately from concurrency", () => {
    for (const [name, text] of Object.entries({ SKILL, SCHEMA, README })) {
      assert.match(text, /root(?: slice)? is wave 1/i, `${name} must define root depth`);
      assert.match(text, /(?:at most|capped at) three waves/i, `${name} must document the depth cap`);
      assert.match(text, /max_parallel_slices[\s\S]{0,120}(?:concurrency|concurrently)[\s\S]{0,120}(?:does not|not)[\s\S]{0,80}(?:depth cap|cap)/i, `${name} must distinguish concurrency from depth`);
    }
  });

  it("seeds (validates) before recording work-decomposer acceptance, atomically", () => {
    // slices-seed is the enforcing validation; it must run BEFORE the accepted step so an
    // over-depth/invalid plan cannot leave a durable accepted decomposition + unseeded plan.
    assert.match(
      SKILL,
      /seed durable slices first[\s\S]*slices-seed[\s\S]*enforcing validation[\s\S]*Only after it succeeds[\s\S]*work-decomposer accepted/i,
      "SKILL Step 4 must seed (validate) before recording work-decomposer acceptance",
    );
  });

  it("states that a grandfathered already-seeded deeper graph remains runnable", () => {
    assert.match(
      SKILL,
      /resumed run whose durable `run\.slices` already matches a deeper seeded plan[\s\S]*stays runnable/i,
      "SKILL must state a grandfathered seeded graph stays runnable",
    );
    assert.match(
      SCHEMA,
      /Existing durable runs with older, deeper seeded plans remain readable and resumable/i,
      "SCHEMA must state grandfathered seeded plans remain runnable",
    );
  });
});

describe("heartbeat docs contract", () => {
  it("lists every required heartbeat phase in the skill and schema", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      for (const phase of HEARTBEAT_PHASES) assert.match(text, literalPattern(`\`${phase}\``), `${name} missing phase ${phase}`);
    }
  });

  it("documents start-before-dispatch ordering for long subagent waits", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /Mark in-flight state first/i, `${name} must require in-flight state before heartbeat`);
      assert.match(text, /Start heartbeat immediately before[\s\S]*(?:dispatch\/wait|dispatch)/i, `${name} must start heartbeat before dispatch/wait`);
      assert.match(text, /Stop heartbeat[\s\S]*(?:after-return|finally)/i, `${name} must stop heartbeat after return/finally`);
    }
    assert.match(SKILL, /Step 2[\s\S]*`spec-review`[\s\S]*start heartbeat immediately before[\s\S]*`decomposition-review`[\s\S]*Step 4/i, "SKILL must bracket spec/decomposition review waits");
    assert.match(SKILL, /Step 4[\s\S]*mark every dispatched slice `running` first[\s\S]*`builder-wave`[\s\S]*`slice-review`[\s\S]*Step 5/i, "SKILL must bracket builder waves and slice reviews");
    assert.match(SKILL, /Step 5[\s\S]*`test-verifier`[\s\S]*`test-rerun`[\s\S]*`test-review`[\s\S]*`implementation-validator`[\s\S]*`security-reviewer`[\s\S]*`remediation`/i, "SKILL must bracket integration, panel, and remediation waits");
  });

  it("brackets spec and decomposition producer Task waits as well as reviewer waits", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assertNear(text, "`spec-review`", "`spec-writer` Task dispatch/wait", `${name} must tie spec-review heartbeat to the spec-writer Task wait`);
      assertNear(text, "`spec-review`", "`work-reviewer`", `${name} must tie spec-review heartbeat to the reviewer wait`);
      assertNear(text, "`decomposition-review`", "`work-decomposer` Task dispatch/wait", `${name} must tie decomposition-review heartbeat to the work-decomposer Task wait`);
      assertNear(text, "`decomposition-review`", "`work-reviewer`", `${name} must tie decomposition-review heartbeat to the reviewer wait`);
    }
    assert.match(SKILL, /Step 2[\s\S]*`spec-writer` Task dispatch\/wait[\s\S]*`spec-review`[\s\S]*`work-reviewer` dispatch\/wait[\s\S]*`spec-review`[\s\S]*`work-decomposer` Task dispatch\/wait[\s\S]*`decomposition-review`[\s\S]*`work-reviewer` decomposition review dispatch\/wait[\s\S]*`decomposition-review`[\s\S]*Step 4/i, "SKILL Step 2 must bracket producer and reviewer waits for spec and decomposition");
  });

  it("requires stopping heartbeat before the next semantic state write", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /Do not perform the next semantic `run\.json` \/ factory CLI state write while the long-wait heartbeat remains active/i, `${name} must forbid semantic writes while heartbeat is active`);
      assert.match(text, /stop heartbeat|verify inactive/i, `${name} must stop or verify inactive before the next state write`);
    }
    assert.match(SKILL, /stop heartbeat[\s\S]*before writing evidence/i, "SKILL must stop before evidence writes");
    assert.match(SKILL, /stop heartbeat[\s\S]*before[\s\S]*(?:verdicts|terminal writes|Gate 3 state)/i, "SKILL must stop before verdict/terminal/gate writes");
  });

  it("maps every documented phase and keeps phase validation opaque", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      for (const phase of HEARTBEAT_PHASES) assert.match(text, literalPattern(`\`${phase}\``), `${name} missing phase ${phase}`);
      assert.match(text, /phase[\s\S]*(?:opaque|display convention)[\s\S]*(?:non-enforced|accepts any non-empty string|non-empty)/i, `${name} must keep heartbeat phase opaque/non-enforced`);
    }
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      for (const phase of HEARTBEAT_PHASES) {
        assert.match(text, new RegExp(`${escapeRegExp(`\`${phase}\``)}[\\s\\S]{0,180}(?:wait|review|builder|remediation|rerun|validator)`, "i"), `${name} must map phase ${phase} to a wait`);
      }
    }
  });

  it("keeps protected gates heartbeat-free and resolves the heartbeat TODO", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /Protected gates?[\s\S]*`story`[\s\S]*`brief`[\s\S]*`pre_pr`[\s\S]*(?:heartbeat-free|stay off|intentionally absent)/i, `${name} must keep protected gates heartbeat-free`);
      assert.match(text, /liveness-only[\s\S]*(?:not authority|not.*authority)|not authority[\s\S]*liveness-only/i, `${name} must keep heartbeat liveness-only and non-authoritative`);
    }
    assert.doesNotMatch(TODO, /Enforce heartbeat around long factory subagent waits/i, "TODO must not leave the resolved heartbeat enforcement item open");
  });

  it("documents heartbeat as liveness-only around long waits", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /liveness-only|liveness only/i, `${name} must describe heartbeat as liveness-only`);
      assert.match(text, /Start heartbeat immediately before/i, `${name} must start heartbeat immediately before waits`);
      assert.match(text, /long\s+`Task`|long orchestrator waits/i, `${name} must tie heartbeat to long waits`);
      assert.match(text, /stop heartbeat/i, `${name} must stop heartbeat after waits`);
      assert.match(text, /last_tick_at/i, `${name} must document timestamp liveness`);
      assert.match(text, /interval_ms/i, `${name} must document heartbeat interval`);
      assert.match(text, /max\(2 \* interval_ms, 120000ms\)/i, `${name} must document freshness threshold`);
      assert.match(text, /not.*heartbeat\.json.*authority|heartbeat\.json.*not.*authority/i, `${name} must not treat heartbeat.json as authority`);
    }
  });

  it("forbids heartbeat during protected gates and names terminal statuses", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /Do not start heartbeat while[\s\S]*`story`[\s\S]*`brief`[\s\S]*`pre_pr`/i, `${name} must forbid heartbeat during protected gates`);
      assert.match(text, /Before writing terminal[\s\S]*terminal_result[\s\S]*stop heartbeat if it is active/i, `${name} must stop active heartbeat before terminal writes`);
      for (const status of TERMINAL_RUN_STATUSES) assert.match(text, literalPattern(`\`${status}\``), `${name} must name terminal status ${status}`);
    }
  });
});

describe("simplified state contract docs", () => {
  it("documents durable local state, transition helpers, and no proof layer", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /run\.json/i, `${name} must document run.json`);
      assert.match(text, /transitionGateDecision/i, `${name} must document transitionGateDecision`);
      assert.match(text, /transitionPrCreated/i, `${name} must document transitionPrCreated`);
      assert.match(text, /pending_snapshot/i, `${name} must document pending_snapshot`);
      assert.match(text, /debug_snapshot/i, `${name} must document debug_snapshot`);
      assert.match(text, /proof layer removed/i, `${name} must document removed proof layer`);
    }
  });

  it("documents environment snapshot commands and redaction", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /factory env record-created <run-id> --json/i, `${name} must document record-created`);
      assert.match(text, /factory env record-resume <run-id> --json/i, `${name} must document record-resume`);
      assert.match(text, /diagnostic-only|diagnostic only/i, `${name} must mark snapshots diagnostic-only`);
      assert.match(text, /redact|omit/i, `${name} must document redaction`);
      for (const tokenShape of ["ghp_*", "github_pat_*", "gho_*", "sk-proj_*", "sk-*", "xoxb_*"]) {
        assert.match(text, literalPattern(tokenShape), `${name} must mention token shape ${tokenShape}`);
      }
    }
  });

  it("documents PR-created transition preconditions", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /feature-factory factory pr-created <run-id>/i, `${name} must document factory pr-created CLI`);
      assert.match(text, /pre_pr/i, `${name} must mention pre_pr gate`);
      assert.match(text, /validator[\s\S]*(GO|GO-WITH-NITS)/i, `${name} must require passing validator`);
      assert.match(text, /security[\s\S]*PASS/i, `${name} must require passing security review`);
      assert.match(text, /canonical GitHub PR URL|canonical PR URL/i, `${name} must require canonical PR URL`);
    }
  });

  it("documents reachable CLI verbs for orchestrator state writes", () => {
    for (const command of STATE_WRITE_COMMANDS) {
      assert.match(SKILL, commandPattern(command), `SKILL missing ${command}`);
      assert.match(SCHEMA, commandPattern(command), `SCHEMA missing ${command}`);
      assertCliSurfaceIncludes(command);
    }
    for (const verb of implementedStateWriteVerbs()) {
      assert.ok(documentedStateWriteVerbs().has(verb), `factory ${verb} mutates state but is missing from STATE_WRITE_COMMANDS`);
    }
    for (const forbidden of ["transitionRunStep", "transitionRunSlice", "transitionTerminalResult", "transitionLifecycleRun", "mutateRunJsonLocked", "run-state.js"]) {
      assert.doesNotMatch(SKILL, literalPattern(forbidden), `SKILL must not instruct unreachable helper ${forbidden}`);
    }
  });

  it("keeps process-sidecar writes separate from semantic run.json writes", () => {
    for (const command of PROCESS_SIDECAR_COMMANDS) assertCliSurfaceIncludes(command);
    for (const command of PROCESS_SIDECAR_COMMANDS) {
      assert.ok(!documentedStateWriteVerbs().has(command.split(/\s+/u)[1]), `${command} must not be in semantic run.json state-write commands`);
    }
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /Process-sidecar write command[\s\S]*factory cancel <run-id> --json/i, `${name} must document cancel as process-sidecar write`);
      assert.match(text, /factory cancel[\s\S]*(?:not a semantic `run\.json`|outside the checked semantic `run\.json`)/i, `${name} must keep cancel out of semantic run.json transitions`);
      assert.doesNotMatch(firstFencedBlockAfter(text, /Required semantic `run\.json` .*write commands:/i), /factory cancel <run-id> --json/i, `${name} must not list cancel in semantic run.json write commands`);
    }
  });

  it("does not reintroduce removed proof-layer terminology in active docs", () => {
    const retiredTerms = [
      "heartbeat" + "_owner",
      "stop" + "_requested_at",
      "deadline" + "_at",
      "owner" + "Capability",
      "HEARTBEAT" + "_OWNER",
      "assertSemantic" + "TransitionHeartbeatState",
      "prove" + "nance" + "-authority",
      "review" + "-guard",
      "safe" + "-git",
      "safe" + "_git" + "_policy",
      "merge" + "-chain",
      "invalid" + "-authority",
      "unverifiable" + "-authority",
    ];
    const retiredPattern = new RegExp(retiredTerms.map(escapeRegExp).join("|"), "i");
    const retiredDirectoryPattern = new RegExp(`${escapeRegExp("attest" + "ations")}/`, "i");
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README })) {
      assert.doesNotMatch(text, retiredPattern, `${name} must not reference removed proof-layer terms`);
      assert.doesNotMatch(text, retiredDirectoryPattern, `${name} must not require retired proof directories`);
    }
  });
});

describe("diagnostics docs contract", () => {
  it("documents the diagnostic envelope shape and enums", () => {
    for (const [name, text] of documentEntries({ README, SPEC, SKILL, SCHEMA })) {
      for (const field of ["schema_version", "checked_at", "authoritative", "status", "severity", "classification", "summary", "items", "condition", "message", "action", "evidence"]) {
        assert.match(text, literalPattern(field), `${name} must document diagnostics.${field}`);
      }
      for (const condition of DIAGNOSTIC_CONDITIONS) assert.match(text, literalPattern(`\`${condition}\``), `${name} must document condition ${condition}`);
      for (const classification of DIAGNOSTIC_CLASSIFICATIONS) assert.match(text, literalPattern(`\`${classification}\``), `${name} must document classification ${classification}`);
      for (const status of DIAGNOSTIC_STATUSES) assert.match(text, literalPattern(`\`${status}\``), `${name} must document status ${status}`);
      for (const severity of DIAGNOSTIC_SEVERITIES) assert.match(text, literalPattern(`\`${severity}\``), `${name} must document severity ${severity}`);
    }
  });

  it("documents aggregation order and operator actions", () => {
    const conditionOrder = ["invalid-run-state", "missing-worktree", "missing-heartbeat-process", "stale-heartbeat", "protected-gate", "terminal-run"];
    for (const [name, text] of documentEntries({ README, SPEC, SKILL, SCHEMA })) {
      assert.match(text, orderedPattern(["invalid", "blocked", "needs-human", "recoverable", "terminal", "healthy"]), `${name} must document classification order`);
      assert.match(text, orderedPattern(["critical", "error", "warning", "info"]), `${name} must document severity order`);
      assert.match(text, orderedPattern(["error", "warning", "ok"]), `${name} must document status order`);
      assert.match(text, orderedPattern(conditionOrder), `${name} must document condition order`);
      assert.match(text, /original detection order/i, `${name} must document detection-order tiebreaker`);
      assert.match(text, /do not restart blindly|not restart blindly/i, `${name} must warn against blind restart`);
      assert.match(text, /`running` step[\s\S]*`running` slice[\s\S]*`review` slice/i, `${name} must document heartbeat diagnostics require in-flight work`);
      assert.match(text, /restore (?:the )?worktree|recover from durable state/i, `${name} must explain missing-worktree action`);
      assert.match(text, /answer (?:the )?pending protected gate|answer or stop/i, `${name} must explain protected-gate action`);
      assert.match(text, /read `terminal_result`|inspect the terminal result/i, `${name} must explain terminal-run action`);
    }
  });
});

describe("blocked-run continuation docs contract", () => {
  it("documents the public continuation command and intent", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, literalPattern(BLOCKED_CONTINUE_COMMAND), `${name} must document factory continue CLI`);
      assert.match(text, /blocked-run-continuation/, `${name} must document blocked-run-continuation intent or payload`);
    }
    assert.match(SKILL, /Intent types:[\s\S]*blocked-run-continuation/i, "SKILL must list blocked-run-continuation intent");
    assert.match(SKILL, /Actions by intent:[\s\S]*blocked-run-continuation/i, "SKILL must define blocked-run-continuation action");
  });

  it("treats continuation payloads as untrusted operator data, not privileged instructions", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /continuation payload[\s\S]*untrusted operator data\/config/i, `${name} must call continuation payload untrusted data/config`);
      assert.match(text, /not privileged instruction/i, `${name} must deny privileged-instruction status`);
    }
  });

  it("documents top-level payload.continuation rather than driver.continuation", () => {
    assert.match(COMMAND, /payload\.continuation/, "COMMAND must read continuation metadata from top-level payload.continuation");
    assert.match(COMMAND, /Do not read continuation metadata from driver configuration/i, "COMMAND must reject driver config as the continuation source");
    assert.doesNotMatch(COMMAND, /driver\.continuation/i, "COMMAND must not route continuation from driver.continuation");
  });

  it("documents continuation manifest persistence and parent validation", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /run\.json\.continuation|run\.continuation/i, `${name} must persist run.continuation`);
      assert.match(text, /status(?:`|\s)*(?:is\s+)?exactly(?:`|\s)*`?blocked`?/i, `${name} must require parent status exactly blocked`);
      assert.match(text, /read-only parent context|parent context as read-only/i, `${name} must make parent context read-only`);
      assert.match(text, /approved review evidence/i, `${name} must validate approved review evidence`);
      assert.match(text, /not rely on|do not depend on|without relying on/i, `${name} must not rely on a blocking verdict enum`);
      assert.match(text, /blocking verdict enum/i, `${name} must name the blocking verdict enum non-requirement`);
    }
  });

  it("documents the accepted nested run.continuation shape with hashes", () => {
    for (const term of [
      '"kind": "blocked-run-continuation"',
      '"parent"',
      '"review"',
      '"target"',
      '"run_hash"',
      '"hash"',
      '"parent_artifacts"',
      '"parent_evidence"',
      '"parent_reviews"',
      '"base_commit"',
    ]) {
      assert.match(SCHEMA, literalPattern(term), `SCHEMA must document continuation field ${term}`);
    }
    assert.match(SCHEMA, /parent_artifacts[\s\S]*\{kind, ref, hash\}/, "SCHEMA must describe parent_artifacts as ref/hash entries");
    assert.match(SCHEMA, /nested `parent`, `review`, and `target` objects/i, "SCHEMA must describe nested continuation objects");
    assert.match(SCHEMA, /refs paired with hashes|ref.*hash/i, "SCHEMA must require validated refs and hashes");
  });

  it("gates planning reuse on durable acceptance, not file presence", () => {
    // The brief is reused only when the parent DURABLY ACCEPTED it; presence of a
    // technical-brief.md in a parent whose spec-writer step was rejected must NOT be
    // adopted as approved. Pin the eligibility gate + amendment-only fallback.
    for (const [name, text] of documentEntries({ SKILL, COMMAND })) {
      assert.match(text, /continuation\.planning_reuse\.eligible/i, `${name} must gate reuse on continuation.planning_reuse.eligible`);
      assert.match(text, /amendment input only/i, `${name} must treat an unaccepted parent brief as amendment input only`);
    }
    // The adopted spec acceptance is recorded through the CHECKED adopt-continuation
    // transition (which verifies the parent acceptance binding), not a hand-rolled
    // generic `factory step accepted`.
    assert.match(SKILL, /factory adopt-continuation <run-id>[\s\S]*Do not hand-roll a generic `factory step spec-writer accepted`/i, "SKILL must record adoption through the checked adopt-continuation transition");
    assert.match(COMMAND, /factory adopt-continuation <run-id>[\s\S]*not a hand-rolled generic `factory step accepted`/i, "COMMAND must record adoption through the checked adopt-continuation transition");
    // Continuation decomposition is scoped to the blocking review's required_fixes, not a
    // full-brief re-decomposition that recreates completed parent work.
    assert.match(SKILL, /decompose \*\*only `continuation\.review\.required_fixes`\*\*[\s\S]*do not re-decompose the full brief/i, "SKILL must scope continuation remediation to continuation.review.required_fixes");
    assert.match(COMMAND, /decompose only `continuation\.review\.required_fixes`/i, "COMMAND must scope continuation remediation to continuation.review.required_fixes");
    // SCHEMA documents the acceptance-gated planning_reuse shape + acceptance binding.
    assert.match(SCHEMA, /planning_reuse[\s\S]*reusable by durable acceptance rather than file presence/i, "SCHEMA must describe planning_reuse acceptance gating");
    assert.match(SCHEMA, /child_spec_review_ref/i, "SCHEMA must document the child-local carried spec review ref");
    assert.match(SCHEMA, /acceptance` binding[\s\S]*bytes changed after acceptance are not silently treated as accepted/i, "SCHEMA must document the immutable acceptance binding gating reuse");
    assert.match(SCHEMA, /inherited_acceptance/i, "SCHEMA must document the inherited-acceptance provenance record");
  });

  it("documents configurable PR mode for factory continue", () => {
    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /factory continue[\s\S]*prMode|Continuation[\s\S]*effective PR mode/i, `${name} must document continuation PR mode`);
      assert.match(text, /`--draft`[\s\S]*`--ready`|`--ready`[\s\S]*`--draft`/i, `${name} must document per-run PR mode overrides`);
    }
  });

  it("documents persisted PR mode across resume", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /run\.json\.pr_mode/i, `${name} must document persisted run.pr_mode`);
      assert.match(text, /run\.json\.pr_mode[\s\S]*resume|resume[\s\S]*run\.json\.pr_mode/i, `${name} must document preserving PR mode on resume`);
    }
  });

  it("documents normal gates, configurable PRs, and exhausted-remediation terminal blocked outcome", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      for (const term of ["story", "brief", "build", "test", "validator", "security", "pre-PR"]) {
        assert.match(text, new RegExp(escapeRegExp(term), "i"), `${name} must include normal ${term} gate/step`);
      }
      assert.match(text, /configured PR mode|effective PR mode|prMode/i, `${name} must document configurable PR mode`);
      assert.match(text, /ready-for-review|ready/i, `${name} must document ready PR mode`);
      assert.match(text, /draft/i, `${name} must document draft PR mode`);
      assert.match(text, /terminal[\s\S]*blocked|status:\s*"blocked"/i, `${name} must document terminal blocked outcome`);
      assert.match(text, /no PR URL|pr_url:\s*null/i, `${name} must document no PR URL on exhausted remediation`);
    }
  });

  it("does not leave the resolved blocked-run continuation item open in TODO", () => {
    assert.doesNotMatch(TODO, /Automated blocked-run continuation/i, "TODO must not leave the resolved blocked-run continuation item open");
  });
});

describe("non-destructive disrupted-worktree recovery docs contract", () => {
  it("requires explicit resume-check recovery and forbids silent re-scaffolding", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /feature-factory factory resume-check <run-id> --json/i, `${name} must document resume-check`);
      assert.match(text, /factory start --headless\|--autonomous "resume <run-id>"/i, `${name} must document start resume preflight`);
      assert.match(text, /missing[\s\S]*inaccessible[\s\S]*invalid[\s\S]*(?:run\.json|\.opencode\/factory\/\<run-id\>\/run\.json)/i, `${name} must name missing/inaccessible/invalid durable state`);
      assert.match(text, /must not[\s\S]*(?:re-scaffold|re-scaffolded)|never[\s\S]*(?:re-scaffold|re-scaffolded)/i, `${name} must forbid re-scaffolding`);
      assert.match(text, /synthetic non-durable[\s\S]*blocked[\s\S]*ok:false[\s\S]*durable:false[\s\S]*updated:false[\s\S]*recovered:false/i, `${name} must describe non-durable blocked envelope`);
      assert.match(text, /terminal_result\.reason[\s\S]*no durable `?terminal_result`?[\s\S]*(?:forbidden re-scaffolding|without forbidden re-scaffolding)/i, `${name} must explain why no durable terminal_result can be written`);
    }
  });

  it("forbids destructive cleanup, prune, and remove during recovery", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /resume-check[\s\S]*(?:must not|never)[\s\S]*destructive cleanup/i, `${name} must forbid recovery cleanup`);
      assert.match(text, /resume-check[\s\S]*(?:must not|never)[\s\S]*git worktree prune/i, `${name} must forbid recovery prune`);
      assert.match(text, /resume-check[\s\S]*(?:must not|never)[\s\S]*git worktree remove/i, `${name} must forbid recovery worktree remove`);
      assert.match(text, /cleanup remains an explicit operator action/i, `${name} must reserve cleanup for explicit operator action`);
      assert.match(text, /status[\s\S]*list[\s\S]*validate[\s\S]*watch[\s\S]*(?:read-only|read only)[\s\S]*(?:cleanup|prune|remove)/i, `${name} must keep diagnostics non-destructive`);
    }
  });

  it("documents safe missing-worktree restoration criteria", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /missing active worktree|missing \.opencode\/worktrees/i, `${name} must scope recovery to missing active worktrees`);
      assert.match(text, /branch exists/i, `${name} must require branch existence`);
      assert.match(text, /base_commit[\s\S]*merge_commit[\s\S]*ancestors? of branch HEAD/i, `${name} must require base and merged commits to be ancestors`);
      assert.match(text, /target[\s\S]*(?:under|stays under|remains under)[\s\S]*\.opencode\/worktrees/i, `${name} must constrain the target path`);
      assert.match(text, /no (?:unsafe )?existing path would be overwritten/i, `${name} must forbid overwriting existing paths`);
      assert.match(text, /git worktree add[\s\S]*succeeds/i, `${name} must require successful git worktree add`);
      assert.match(text, /(?:final )?(?:checkWorktreeIdentity|worktree identity)[\s\S]*HEAD[\s\S]*(?:match|matches)/i, `${name} must require final identity and HEAD checks`);
    }
  });

  it("distinguishes blocked and needs-human terminal outcomes with clear reasons", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /contradictory git evidence[\s\S]*terminal `?blocked`?|terminal `?blocked`?[\s\S]*contradictory git evidence/i, `${name} must map contradictory git evidence to blocked`);
      assert.match(text, /unsafe or inaccessible local paths?[\s\S]*terminal `?needs-human`?|terminal `?needs-human`?[\s\S]*unsafe or inaccessible local paths?/i, `${name} must map unsafe paths to needs-human`);
      assert.match(text, /terminal_result\.reason[\s\S]*(?:conflicting branch\/commit evidence|path that requires operator reconciliation)/i, `${name} must require clear terminal_result.reason details`);
    }
  });

  it("does not leave disrupted recovery as open future TODO work", () => {
    assert.doesNotMatch(TODO, /Non-destructive disrupted-worktree recovery/i, "TODO must not leave disrupted recovery open");
  });
});

describe("remediation context reuse docs contract", () => {
  it("documents implementer-only runtime task_id reuse boundaries", () => {
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA })) {
      assert.match(text, /task_id/i, `${name} must mention Task task_id reuse`);
      assert.match(text, /runtime-only|runtime context|orchestrator memory/i, `${name} must make task_id runtime-only`);
      assert.match(text, /implementer-only|eligible implementer|implementer remediation|implementer that owns the fix/i, `${name} must make reuse implementer-only`);
      for (const implementer of ["backend-builder", "frontend-builder", "test-verifier"]) {
        assert.match(text, literalPattern(implementer), `${name} must name eligible implementer ${implementer}`);
      }
      assert.match(text, /same (?:eligible )?implementer role|role is the same eligible implementer|same role|same role, subject\/slice\/test owner/i, `${name} must require the same role`);
      assert.match(text, /subject\/slice\/test owner|same owned remediation subject|same subject|same slice id|same acceptance-test\/integration test owner|same test owner|subject ownership is unchanged/i, `${name} must require the same subject/slice/test owner`);
      assert.match(text, /same[^.\n]*worktree|worktree[^.\n]*unchanged/i, `${name} must require the same worktree`);
      assert.match(text, /same[^.\n]*branch|branch[^.\n]*unchanged/i, `${name} must require the same branch`);
      assert.match(text, /same live orchestrator session|live orchestrator session is unchanged|same[^.\n]*orchestrator session/i, `${name} must require the same live orchestrator session`);
      assert.match(text, /same[^.\n]*bounded remediation loop|bounded remediation loop[^.\n]*(?:unchanged|only)|current bounded remediation loop/i, `${name} must require the same bounded remediation loop`);
    }

    assert.match(COMMAND, /bounded remediation loop/i, "COMMAND must route NO-GO through bounded remediation");
    assert.match(COMMAND, /backend-builder, frontend-builder, or test-verifier implementer context/i, "COMMAND must limit reuse to implementer context");
    assert.match(COMMAND, /skill's strict runtime `task_id` reuse rules/i, "COMMAND must bind reuse to the skill's strict runtime task_id rules");
  });

  it("keeps reviewers and final panel agents fresh, task_id-free, and read-only", () => {
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA, COMMAND })) {
      for (const reviewer of ["work-reviewer", "implementation-validator", "security-reviewer"]) {
        assert.match(text, literalPattern(reviewer), `${name} must name ${reviewer}`);
      }
      assert.match(text, /fresh/i, `${name} must require fresh reviewer/panel tasks`);
      assert.match(text, /(?:without|no|never|must not)[^\n.]*task_id|task_id[^\n.]*must never/i, `${name} must prohibit reviewer task_id reuse`);
    }

    for (const [name, text] of documentEntries({ SKILL, README, SPEC, WORK_REVIEWER_PROMPT, IMPLEMENTATION_VALIDATOR_PROMPT, SECURITY_REVIEWER_PROMPT })) {
      assert.match(text, /read-only|read and judge|do not edit|never edit/i, `${name} must keep reviewer/validator/security roles read-only`);
    }
  });

  it("does not serialize task_id into durable schema examples or state records", () => {
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA, COMMAND })) {
      assert.doesNotMatch(text, /["']task_id["']\s*:/i, `${name} must not add a durable task_id JSON field`);
    }
    assert.match(SCHEMA, /No `run\.json`, evidence, or reviews schema has a `task_id` field/i, "SCHEMA must explicitly exclude durable task_id fields");
    assert.match(SCHEMA, /intentionally excluded from `run\.json`[\s\S]*evidence files[\s\S]*review files/i, "SCHEMA must exclude task_id from durable run/evidence/review state");
  });

  it("preserves attempt and required_fixes for all re-review reruns", () => {
    assert.match(SKILL, /For every re-review, pass `attempt: <n>` and the prior review's `required_fixes` list[\s\S]*rejected slice remediation/i, "SKILL must preserve slice attempt and required_fixes on re-review");
    assert.match(SKILL, /test-verifier re-review[\s\S]*fresh `work-reviewer` task[\s\S]*`attempt: <n>`[\s\S]*prior review's `required_fixes` list/i, "SKILL must preserve test-verifier attempt and required_fixes on re-review");
    assert.match(SKILL, /panel re-run[\s\S]*fresh `implementation-validator` and `security-reviewer` tasks[\s\S]*never pass `task_id`[\s\S]*`attempt: <n>` plus the prior validator\/security `required_fixes` list/i, "SKILL must preserve implementation-validator/security reviewer attempt and required_fixes on panel reruns");
    assert.match(SPEC, /current `attempt` and the prior applicable `required_fixes` list[\s\S]*review checks whether required fixes landed/i, "SPEC must preserve attempt and required_fixes delta-review behavior");
    assert.match(WORK_REVIEWER_PROMPT, /Delta rule:[\s\S]*`attempt > 1`[\s\S]*prior `required_fixes` item landed[\s\S]*regressions/i, "work-reviewer prompt must preserve delta rule");
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /Delta Review Rule:[\s\S]*fresh read-only validator task[\s\S]*prior findings[\s\S]*`required_fixes`[\s\S]*introduced regressions/i, "implementation-validator prompt must preserve fresh delta rule");
    assert.match(SECURITY_REVIEWER_PROMPT, /Delta rule:[\s\S]*`attempt > 1`[\s\S]*prior `required_fixes` item landed[\s\S]*introduced regressions/i, "security-reviewer prompt must preserve delta rule");
  });

  it("does not leave remediation context reuse as an open TODO", () => {
    assert.doesNotMatch(TODO, /Remediation context reuse/i, "TODO must not leave the resolved remediation context reuse item open");
  });
});

describe("interrupt steer resume docs contract", () => {
  it("documents run-scoped process evidence and SIGTERM-only fail-closed cancellation", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /process\.json/i, `${name} must document process.json`);
      assert.match(text, /processes\/<timestamp>\.log|processes\/\S+\.log/i, `${name} must document run-scoped process logs`);
      assert.match(text, /validated run-owned/i, `${name} must require validated run-owned launches for run-scoped process evidence`);
      assert.match(text, /generic[\s\S]*detached[\s\S]*(?:not|must not|without)[\s\S]*(?:process\.json|run-scoped)/i, `${name} must not guarantee process.json for generic detached starts`);
      assert.match(text, /--run-id <run-id>[\s\S]*(?:does not|do not|not)[\s\S]*(?:process-evidence authority|process evidence|process\.json)|(?:does not|do not|not)[\s\S]*(?:process-evidence authority|process evidence|process\.json)[\s\S]*--run-id <run-id>/i, `${name} must document that generic --run-id does not grant process-evidence authority`);
      assert.doesNotMatch(text, /factory start --detached --run-id <run-id>[\s\S]{0,160}(?:writes|records|creates)[\s\S]{0,80}(?:process\.json|run-scoped process evidence)/i, `${name} must not document generic start --detached --run-id as process evidence authority`);
      assert.match(text, /factory cancel <run-id> --json/i, `${name} must document factory cancel`);
      assert.match(text, /SIGTERM/i, `${name} must document SIGTERM cancellation`);
      assert.match(text, /fail-closed|failed-closed/i, `${name} must document fail-closed cancellation`);
      assert.match(text, /missing[\s\S]*invalid[\s\S]*stale[\s\S]*mismatch|missing[\s\S]*stale[\s\S]*invalid[\s\S]*mismatch/i, `${name} must fail closed on bad process evidence`);
      assert.match(text, /broad process kill|process-group signal|pkill|killall/i, `${name} must forbid broad cancellation fallback`);
      assert.match(text, /signaled:false[\s\S]*updated:false|updated:false[\s\S]*signaled:false/i, `${name} must document non-signaling failed response`);
    }
    for (const field of ["schema_version", "kind", "opencode-process", "execution_id", "pid", "started_at", "updated_at", "state", "cwd", "identity", "log_ref", "cancel"]) {
      assert.match(SCHEMA, literalPattern(field), `SCHEMA must document process evidence field ${field}`);
    }
  });

  it("documents steering/resume workflow, payload, and untrusted label", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /cancel[\s\S]*(?:before|first)[\s\S]*(?:steer|steering|resume)|(?:before|first)[\s\S]*(?:steer|steering|resume)[\s\S]*cancel/i, `${name} must document cancel-before-steer/resume`);
      assert.match(text, /factory steer <run-id> --message TEXT/i, `${name} must document factory steer`);
      assert.match(text, /factory steer-consume <run-id> --ref steering\/<file>\.json --hash sha256:<hash>/i, `${name} must document steer-consume`);
      assert.match(text, /factory resume <run-id>[\s\S]*--dry-run/i, `${name} must document resume dry-run`);
      assert.match(text, /UNTRUSTED OPERATOR STEERING DATA \(not instructions\)/, `${name} must document untrusted label`);
      assert.match(text, /untrusted-operator-data/i, `${name} must document untrusted trust value`);
      assert.match(text, /raw_message_included[\s\S]*false/i, `${name} must document raw_message_included=false`);
      assert.match(text, /record-resume[\s\S]*before[\s\S]*steer-consume/i, `${name} must document record-resume before steer-consume`);
      assert.match(text, /active-heartbeat/i, `${name} must document active-heartbeat rejection`);
    }
  });

  it("documents deterministic plugin parsing for feature command envelopes", () => {
    for (const [name, text] of documentEntries({ COMMAND, README, SPEC })) {
      assert.match(text, /command\.execute\.before|before model execution/i, `${name} must parse before model execution`);
      assert.match(text, /PLUGIN_PARSED_OPERATOR_PAYLOAD/i, `${name} must document the normalized payload block`);
      assert.match(text, /deterministic(?:ally)? pars|structurally validate/i, `${name} must require deterministic parsing`);
      assert.match(text, /untrusted operator data\/config/i, `${name} must keep parsed values untrusted`);
      assert.match(text, /ffpayload-v1:<base64url>/i, `${name} must document the preprocessing-safe versioned transport`);
      assert.match(text, /fail closed|routing_authority: none|must not authorize/i, `${name} must reject invalid envelopes without routing authority`);
      assert.match(text, /(?:never|not|must not)[\s\S]*(?:parse|authorize)[\s\S]*(?:autonomous|resume|routing)|raw[\s\S]*(?:never|must not)[\s\S]*(?:autonomous|resume|routing)/i, `${name} must not recover autonomous routing from raw transport text`);
    }
    assert.equal((COMMAND.match(/^UNTRUSTED_OPERATOR_PAYLOAD_START$/gmu) || []).length, 1, "COMMAND must contain exactly one standalone payload delimiter");
    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /positional[\s\S]*(?:not cryptographic|no cryptographic)|(?:not cryptographic|no cryptographic)[\s\S]*positional/i, `${name} must describe the non-cryptographic positional boundary`);
    }
  });

  it("documents steering conflict checkpoint after steer-consume and no automatic rollback", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /after `?steer-consume`?[\s\S]*(?:steering-conflict|conflict checkpoint)/i, `${name} must require conflict checkpoint after steer-consume`);
      assert.match(text, /factory steer-conflict <run-id> --ref steering\/<file>\.json --hash sha256:<hash>/i, `${name} must document steer-conflict CLI`);
      assert.match(text, /accepted durable state|protected accepted state|protected state/i, `${name} must document protected accepted state`);
      assert.match(text, /approved gates[\s\S]*accepted steps[\s\S]*(?:merged|blocked) slices/i, `${name} must list protected gates/steps/slices`);
      assert.match(text, /validator[\s\S]*security/i, `${name} must include validator/security in protected state`);
      assert.match(text, /automatic rollback is forbidden|do not automatically roll back|must not.*rollback/i, `${name} must forbid automatic rollback`);
      assert.match(text, /needs-human/i, `${name} must document needs-human steering conflict outcome`);
    }
    assert.match(SCHEMA, /ok:false[\s\S]*conflict:true[\s\S]*updated:true[\s\S]*status:\"needs-human\"/i, "SCHEMA must document steer-conflict response semantics");
    assert.match(SCHEMA, /inactive heartbeat/i, "SCHEMA must require inactive heartbeat for steer-conflict");
    assert.match(SCHEMA, /consumed steering file[\s\S]*hash matches/i, "SCHEMA must verify consumed steering file hash");
  });

  it("preserves PR review boundary and no-merge rule in docs", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, README, SPEC })) {
      assert.match(text, /Never auto-merge|Never merge the PR|never auto-merges/i, `${name} must forbid automatic merge`);
      assert.match(text, /Humans review and merge|human PR review boundary|review and merge/i, `${name} must keep PR human review boundary`);
      assert.match(text, /implementation-validator[\s\S]*security-reviewer|security-reviewer[\s\S]*implementation-validator/i, `${name} must require final review panel before PR`);
    }
  });

  it("does not leave cancellation rollback as an open TODO", () => {
    assert.doesNotMatch(TODO, /Future work: live cancellation\/kill/i, "TODO must not leave live cancellation as future work");
    assert.doesNotMatch(TODO, /semantic rollback when steering conflicts/i, "TODO must not leave steering rollback as future work");
  });
});

describe("live-run steering drain docs contract", () => {
  it("enumerates exactly the five safe consume boundaries in each authoritative contract", () => {
    for (const [name, text] of documentEntries(LIVE_DRAIN_DOCS)) {
      const numberedBoundaries = [...text.matchAll(/^\d+\. \*\*([^*]+):\*\*/gmu)].map((match) => match[1]);
      assert.deepEqual(numberedBoundaries, LIVE_DRAIN_BOUNDARIES, `${name} must contain exactly the approved five safe boundaries`);
      assert.match(text, /Every numbered boundary uses the (?:complete|same) pointer-(?:probe|only discovery),? conditional(?:-| )drain,? (?:conflict-checkpoint|immediate conflict checkpoint),? and prospective(?:-| )application (?:protocol|contract)/i, `${name} must govern every boundary with the complete protocol`);
    }
  });

  it("defines each boundary precisely and applies it from live orchestrator stages", () => {
    for (const [name, text] of documentEntries(LIVE_DRAIN_DOCS)) {
      assert.match(text, /heartbeat-bracketed wait[\s\S]*heartbeat[\s\S]*(?:stopped|inactive)[\s\S]*before[\s\S]*(?:cost-record|cost recording)/i, `${name} must drain after inactive-heartbeat waits before cost/state writes`);
      assert.match(text, /autonomous gate approval[\s\S]*material[\s\S]*eligibility evidence[\s\S]*immediately before[\s\S]*gate-decision \.\.\. approved[\s\S]*no intervening durable write/i, `${name} must drain immediately before autonomous approval`);
      assert.match(text, /next agent(?: is)?[\s\S]{0,80}each standalone Task|each standalone Task[\s\S]{0,80}next agent/i, `${name} must define each standalone Task as a next agent`);
      assert.match(text, /next build wave(?: is)?[\s\S]{0,100}dependency-ready slice batch|dependency-ready slice batch[\s\S]{0,100}next build wave/i, `${name} must define a dependency-ready batch as a next build wave`);
      assert.match(text, /never between[\s\S]*(?:its )?already-started/i, `${name} must not drain between started wave members`);
      assert.match(text, /Before remediation[\s\S]*before choosing, routing, or locally applying each new remediation attempt/i, `${name} must drain before every remediation attempt`);
      assert.match(text, /terminalization or PR creation[\s\S]*immediately before `factory terminal`[\s\S]*Gate 3 approval[\s\S]*immediately before `gh pr create`/i, `${name} must drain before terminalization and PR creation`);
    }

    for (const stage of ["Autonomous Mode", "Step 2 - Spec And Decomposition", "Step 4 - Build Slices", "Step 5 - Integrate And Validate", "Gate 3 - Pre-PR", "Step 6 - PR Creation", "Resuming"]) {
      assert.match(markdownSection(SKILL, stage), /Live-Run Steering Drain Protocol/i, `SKILL ${stage} must apply the live drain protocol`);
    }
  });

  it("uses pointer-only discovery and skips drain delivery when both durable pointers are null", () => {
    for (const [name, text] of documentEntries(LIVE_DRAIN_DOCS)) {
      assert.match(text, /factory status <run-id> --json/i, `${name} must probe status`);
      assert.match(text, /steering\.pending["]? and [`"]?steering\.uncheckpointed|steering\.pending`? and `steering\.uncheckpointed/i, `${name} must discover pending and uncheckpointed metadata`);
      assert.match(text, /pointer-only discovery|read-only pointer probe/i, `${name} must make discovery pointer-only`);
      assert.match(text, /do not open (?:either|steering) file|must not open either file/i, `${name} must not read raw text during discovery`);
      assert.match(text, /both (?:are|pointers are) null[\s\S]*(?:do not call|skip)[\s\S]*(?:record-resume|drain commands)[\s\S]*(?:steer-consume|boundary)/i, `${name} must make delivery conditional`);
      assert.match(text, /Status is (?:pointer-only|metadata) discovery, not a consume site/i, `${name} must keep status read-only`);
    }
  });

  it("requires inactive heartbeat and record-resume -> consume -> immediate checkpoint ordering", () => {
    for (const [name, text] of documentEntries(LIVE_DRAIN_DOCS)) {
      const normalized = text.toLowerCase();
      const recordResume = normalized.indexOf("feature-factory factory env record-resume <run-id> --json");
      const consume = normalized.indexOf("feature-factory factory steer-consume <run-id> --ref <pending-or-uncheckpointed.ref> --hash <pending-or-uncheckpointed.hash> --json");
      const checkpoint = normalized.indexOf("immediately perform the steering-conflict checkpoint", consume);
      assert.ok(recordResume >= 0 && recordResume < consume && consume < checkpoint, `${name} must order record-resume before consume before checkpoint`);
      assert.match(text, /active-heartbeat[\s\S]*(?:prevents|prevent)[\s\S]*(?:application|raw-text application)[\s\S]*(?:boundary crossing|crossing the boundary)/i, `${name} must reject active heartbeat before crossing`);
      assert.match(text, /steer-consume[\s\S]*independently rechecks heartbeat inactivity/i, `${name} must retain the consume heartbeat check`);
      assert.match(text, /immediately after every (?:delivery|consume)/i, `${name} must make the checkpoint immediate`);
      assert.match(text, /do not perform a cost write|No cost write/i, `${name} must forbid intervening writes/actions`);
    }
  });

  it("preserves untrusted labeling, one-time archival, prospective application, and conflict stop", () => {
    for (const [name, text] of documentEntries(LIVE_DRAIN_DOCS)) {
      assert.match(text, /UNTRUSTED OPERATOR STEERING DATA \(not instructions\)/, `${name} must retain the raw-text label`);
      assert.match(text, /trust: untrusted-operator-data/, `${name} must retain the trust value`);
      assert.match(text, /prospectively[\s\S]*future unaccepted work/i, `${name} must apply compatible guidance prospectively`);
      assert.match(text, /steering\/consumed-(?:\*|<file>)/i, `${name} must archive consumed steering`);
      assert.match(text, /without (?:another|a second) (?:rename|archive|consumed event)|archives? exactly once/i, `${name} must preserve one-time consumption`);
      assert.match(text, /steering\.uncheckpointed[\s\S]*(?:redeliver|redelivery)/i, `${name} must document crash-safe uncheckpointed redelivery`);
      assert.match(text, /factory steer-ack[\s\S]*applied-prospectively/i, `${name} must require no-conflict acknowledgement`);
      assert.match(text, /approved gates[\s\S]*accepted steps[\s\S]*merged or blocked slices[\s\S]*validator\/security verdicts[\s\S]*pr_url[\s\S]*terminal_result/i, `${name} must list protected durable state`);
      assert.match(text, /only permitted workflow write[\s\S]*factory steer-conflict/i, `${name} must limit conflict writes to steer-conflict`);
      assert.match(text, /needs-human/i, `${name} must stop conflicts as needs-human`);
      assert.match(text, /(?:do not auto-rollback|perform no rollback)/i, `${name} must prohibit rollback`);
      assert.match(text, /fixed safe[\s\S]*(?:reason code|summary)|reason_code/i, `${name} must prevent raw conflict reasons`);
    }
  });

  it("documents lock-protected stale boundary rejection and the durable pre-PR fence", () => {
    for (const [name, text] of documentEntries(LIVE_DRAIN_DOCS)) {
      assert.match(text, /factory boundary-open/i, `${name} must expose boundary-open`);
      assert.match(text, /factory boundary-cross/i, `${name} must expose boundary-cross`);
      assert.match(text, /generation[\s\S]*(?:state hash|run-state hash)[\s\S]*(?:stale|reject)/i, `${name} must reject stale boundary observations`);
      assert.match(text, /action.claim[\s\S]*(?:blocks|remains active)[\s\S]*(?:action start|action-started)/i, `${name} must hold an action claim through start`);
      assert.match(text, /factory pr-fence[\s\S]*before `?gh pr create`?/i, `${name} must fence before the external PR side effect`);
      assert.match(text, /blocks new steering[\s\S]*(?:every|any) `?run\.json`? writer|prevents new steering[\s\S]*(?:every|any) `?run\.json`? write/i, `${name} must block steering and sibling writers while fenced`);
      assert.match(text, /pr-created[\s\S]*(?:missing|mismatched|stale) fence|missing, mismatched, or stale fence/i, `${name} must validate the fence at pr-created`);
    }
  });

  it("keeps every privileged public command inventory token-complete", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /factory boundary-cross <run-id> <dispatch\|remediation> --boundary-token TOKEN --json/i, `${name} boundary-cross inventory must require its token`);
      assert.match(text, /factory action-started <run-id> <dispatch\|remediation> --action-token TOKEN --json/i, `${name} must inventory action-start acknowledgement`);
      assert.match(text, /factory action-abort <run-id> <dispatch\|remediation> --action-token TOKEN --json/i, `${name} must inventory action recovery`);
      assert.match(text, /factory gate-decision <run-id> <gate> approved[^\n]*--boundary-token TOKEN --json/i, `${name} approved gate inventory must require its token`);
      assert.match(text, /factory terminal <run-id> blocked --reason TEXT --boundary-token TOKEN --json/i, `${name} terminal inventory must require its token`);
      assert.match(text, /factory pr-fence <run-id> --clear --fence-token TOKEN --json/i, `${name} must inventory exact-token PR fence recovery`);
      assert.match(text, /factory pr-created <run-id>[^\n]*--fence-token TOKEN --json/i, `${name} pr-created inventory must require its fence token`);
    }
  });

  it("prohibits consume on unsafe paths and at every non-enumerated site by default", () => {
    for (const [name, text] of documentEntries(LIVE_DRAIN_DOCS)) {
      assert.match(text, /low-level (?:run-state )?transition helpers/i, `${name} must prohibit low-level transitions`);
      assert.match(text, /heartbeat tick\/start\/status\/stop helpers/i, `${name} must prohibit heartbeat helper consumption`);
      assert.match(text, /cost-record|cost writes/i, `${name} must prohibit cost-write consumption`);
      assert.match(text, /read-only[\s\S]*status[\s\S]*list[\s\S]*validate[\s\S]*watch[\s\S]*TUI/i, `${name} must prohibit read-only path consumption`);
      assert.match(text, /Every site outside the five numbered safe boundaries is prohibited by default/i, `${name} must prohibit every other site by default`);
    }
  });

  it("preserves explicit resume semantics and marks live drain implemented", () => {
    assert.match(markdownSection(SCHEMA, "`/feature resume` Contract"), /Preserve existing resume semantics[\s\S]*calls `record-resume` before any other mutating resume work whether or not steering is pending/i, "SCHEMA must preserve explicit resume semantics");
    assert.match(TODO, /Live-run draining is implemented/i, "TODO must mark live-run draining implemented");
    assert.doesNotMatch(TODO, /Future work: drain and consume pending steering/i, "TODO must not leave live-run drain as future work");
    for (const summary of ["after heartbeat-bracketed waits", "before autonomous gate approval", "before dispatching the next agent or build wave", "before remediation", "before terminalization or PR creation"]) {
      assert.match(TODO, new RegExp(escapeRegExp(summary), "i"), `TODO must summarize ${summary}`);
    }
  });
});

describe("cost attribution docs contract", () => {
  it("documents the cost-record command and run.json cost_attribution schema", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /factory cost-record <run-id>/i, `${name} must document factory cost-record`);
      assert.match(text, /run\.json\.cost_attribution|"cost_attribution"/i, `${name} must document run.json.cost_attribution`);
      assert.match(text, /by_agent/i, `${name} must document by_agent cost rollup`);
      assert.match(text, /by_slice/i, `${name} must document by_slice cost rollup`);
      for (const status of ["available", "partial", "unavailable"]) assert.match(text, literalPattern(status), `${name} must document ${status} cost status`);
    }
    for (const field of ["input_tokens", "output_tokens", "total_tokens", "cost_total", "cost_currency", "mixed_currency", "missing"]) {
      assert.match(SCHEMA, literalPattern(field), `SCHEMA must document cost field ${field}`);
    }
  });

  it("keeps cost attribution diagnostic and provider-supplied only", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /local current-run diagnostic|current-run diagnostics|diagnostic(?:-only)? local current-run/i, `${name} must scope cost attribution to local current-run diagnostics`);
      assert.match(text, /not billing authority/i, `${name} must deny billing authority`);
      assert.match(text, /provider-supplied|supplied by (?:the )?(?:active )?provider/i, `${name} must require provider-supplied costs`);
      assert.match(text, /pricing tables/i, `${name} must forbid pricing tables`);
      assert.match(text, /pricing APIs/i, `${name} must forbid pricing APIs`);
      assert.match(text, /missing-to-zero|coerce missing/i, `${name} must forbid missing-to-zero coercion`);
      assert.match(text, /unavailable[\s\S]*(?:not zero|not.*zero cost)/i, `${name} must say unavailable is not zero`);
    }
  });

  it("documents status/list/TUI exposure for cost summaries", () => {
    for (const [name, text] of documentEntries({ README, SPEC, COMMAND })) {
      assert.match(text, /status[\s\S]*list[\s\S]*TUI|status\/list\/TUI|status[\s\S]*TUI/i, `${name} must document status/list/TUI cost summary exposure`);
    }
  });

  it("documents orchestration attribution points and heartbeat ordering", () => {
    for (const [name, text] of documentEntries({ SKILL, COMMAND, README, SPEC, SCHEMA })) {
      for (const agent of ["spec-writer", "work-reviewer", "work-decomposer", "test-verifier", "implementation-validator", "security-reviewer"]) {
        assert.match(text, literalPattern(agent), `${name} must document ${agent} cost attribution`);
      }
      assert.match(text, /builder/i, `${name} must document builder cost attribution`);
      assert.match(text, /remediation/i, `${name} must document remediation cost attribution`);
      assert.match(text, /stop heartbeat|heartbeat[^.]+stopped|verify inactive/i, `${name} must require heartbeat stopped/verified inactive before cost-record`);
      assert.match(text, /cost-record[\s\S]*(?:before terminal|before[\s\S]*terminal writes|before[\s\S]*pr-created)|terminal[\s\S]*before[\s\S]*pr-created/i, `${name} must order cost-record before terminal writes/PR-created`);
    }
  });

  it("does not leave baseline cost attribution as an open TODO", () => {
    assert.doesNotMatch(TODO, /Record per-agent and per-slice token\/cost usage/i, "TODO must not leave baseline cost recording open");
    assert.doesNotMatch(TODO, /Persist cost data in durable run artifacts/i, "TODO must not leave baseline cost persistence open");
    assert.doesNotMatch(TODO, /Surface cost summaries in CLI\/status and eventually TUI/i, "TODO must not leave baseline cost surfacing open");
  });
});

describe("cost report docs contract", () => {
  it("documents human, JSON, and opt-in telemetry invocations", () => {
    for (const [name, text] of documentEntries(COST_REPORT_DOCS)) {
      assert.match(text, /feature-factory factory cost-report <run-id>/i, `${name} must document human cost-report invocation`);
      assert.match(text, /cost-report <run-id> --json/i, `${name} must document JSON cost-report invocation`);
      assert.match(text, /cost-report <run-id> --telemetry \[--json\]/i, `${name} must document telemetry cost-report invocation`);
      assert.match(text, /report-v1|schema_version(?:`|\s)*:?(?:`|\s)*1/i, `${name} must name report-v1/schema version 1`);
    }
  });

  it("documents dimensions, counts, on-read recomputation, and missing steps", () => {
    for (const [name, text] of documentEntries(COST_REPORT_DOCS)) {
      for (const dimension of ["totals", "by_agent", "by_step", "by_slice"]) {
        assert.match(text, literalPattern(dimension), `${name} must document ${dimension}`);
      }
      for (const count of ["entry_count", "request_count", "agent_count", "step_count", "slice_count", "unattributed_step_entry_count"]) {
        assert.match(text, literalPattern(count), `${name} must document ${count}`);
      }
      assert.match(text, /recomput(?:e|es|ed)[\s\S]*(?:exclusively )?from[\s\S]*(?:cost_attribution\.)?entries[\s\S]*(?:read time|at read time)|(?:read time|at read time)[\s\S]*recomput/i, `${name} must recompute report views from entries at read time`);
      assert.match(text, /persisted[\s\S]*(?:status[\s\S]*)?totals[\s\S]*by_agent[\s\S]*by_slice[\s\S]*(?:ignore|ignored)|ignore[\s\S]*persisted[\s\S]*totals/i, `${name} must ignore persisted rollup caches`);
      assert.match(text, /missing[\s\S]*null[\s\S]*(?:empty|blank)[\s\S]*whitespace-only[\s\S]*(?:excluded|omitted)[\s\S]*by_step/i, `${name} must exclude missing/null/blank steps`);
      assert.match(text, /no synthetic|never (?:placed in|assigned|represented by) a synthetic/i, `${name} must forbid a synthetic step group`);
    }
  });

  it("preserves raw JSON identities and injective terminal-safe human labels", () => {
    for (const [name, text] of documentEntries(COST_REPORT_DOCS)) {
      assert.match(text, /exact[\s\S]*untrimmed[\s\S]*unsanitized|raw untrimmed\/unsanitized/i, `${name} must preserve exact raw grouping identities`);
      assert.match(text, /raw JSON (?:map )?(?:key|keys|identit)|JSON identities/i, `${name} must preserve raw JSON keys`);
      assert.match(text, /injective terminal-safe/i, `${name} must require injective terminal-safe human labels`);
      assert.match(text, /uppercase `?\\uXXXX`?/i, `${name} must document reversible UTF-16 display escaping`);
      assert.match(text, /(?:never|do not)[\s\S]*(?:merge|merges)[\s\S]*(?:identities|groups)|display[\s\S]*(?:never|does not)[\s\S]*merge/i, `${name} must forbid display collision merging`);
    }
  });

  it("documents status, null-as-absence, data-less partial, and mixed currencies", () => {
    for (const [name, text] of documentEntries(COST_REPORT_DOCS)) {
      for (const status of ["available", "partial", "unavailable"]) assert.match(text, literalPattern(status), `${name} must document ${status}`);
      assert.match(text, /data-less `?partial`?|partial[\s\S]*no usage or cost numeric fields/i, `${name} must preserve data-less partial status`);
      assert.match(text, /(?:every|all|any)[\s\S]*(?:usage\/cost|usage or cost)[\s\S]*numeric[\s\S]*`?null`?[\s\S]*(?:absence|omitted)/i, `${name} must treat every numeric null as absence`);
      assert.match(text, /explicit numeric `?0`?[\s\S]*(?:remain|preserv)/i, `${name} must preserve explicit zero`);
      assert.match(text, /mixed.currenc[\s\S]*mixed_currency(?:`|\s)*:?(?:`|\s)*true[\s\S]*(?:omit|suppress)[\s\S]*cost_total[\s\S]*cost_currency/i, `${name} must suppress mixed-currency totals and currency`);
      assert.match(text, /component[\s\S]*(?:remain|still|may)[\s\S]*(?:sum|summed)|separately summed component/i, `${name} must warn about compatibility component sums`);
      assert.match(text, /(?:not normalized|must not[\s\S]*(?:reconstruct|combined total))/i, `${name} must forbid treating components as normalized totals`);
    }
  });

  it("documents strict read-only, local, non-billing boundaries", () => {
    for (const [name, text] of documentEntries(COST_REPORT_DOCS)) {
      assert.match(text, /read-only|read only/i, `${name} must mark cost-report read-only`);
      assert.match(text, /(?:does not|must not|never)[\s\S]*mutate/i, `${name} must forbid mutation`);
      assert.match(text, /(?:does not|must not|never)[\s\S]*(?:acquire|wait for)[\s\S]*run-json(?: write)? lock|run-json\.lock[\s\S]*(?:does not|never)/i, `${name} must forbid lock acquisition/waiting`);
      assert.match(text, /(?:does not|must not|never)[\s\S]*(?:require|accepted)[\s\S]*attestations?/i, `${name} must forbid attestation requirements`);
      assert.match(text, /pricing tables|pricing-table/i, `${name} must forbid pricing tables`);
      assert.match(text, /pricing APIs|pricing-table\/API|pricing tables\/APIs/i, `${name} must forbid pricing APIs`);
      assert.match(text, /(?:price or estimate|pricing[\s\S]*estimation|estimate costs)/i, `${name} must forbid pricing/estimation`);
      assert.match(text, /convert currencies|currency conversion/i, `${name} must forbid conversion`);
      assert.match(text, /missing-to-zero|coerc(?:e|ion)[\s\S]*missing/i, `${name} must forbid missing-to-zero coercion`);
      assert.match(text, /no network|make(?:s)? no network|does not[\s\S]*make network calls|never[\s\S]*make network calls/i, `${name} must forbid network calls`);
      assert.match(text, /strictly local|local[\s\S]*diagnostic/i, `${name} must keep cost-report local diagnostics`);
      assert.match(text, /non-billing|not billing authority/i, `${name} must deny billing authority`);
    }
  });

  it("limits telemetry to opt-in report-invocation correlation, not entry/span proof", () => {
    for (const [name, text] of documentEntries(COST_REPORT_DOCS)) {
      assert.match(text, /--telemetry[\s\S]*(?:opt(?:s)? in|opt-in|opt in)[\s\S]*(?:report invocation|invocation)/i, `${name} must make report telemetry opt-in`);
      assert.match(text, /telemetry\.trace_id|trace_id/i, `${name} must document telemetry trace_id`);
      assert.match(text, /telemetry\.parent_span_id|parent_span_id/i, `${name} must document telemetry parent_span_id`);
      assert.match(text, /correlat(?:e|es)[\s\S]*(?:report )?invocation only|(?:report-)?invocation(?:-| )correlation only/i, `${name} must scope telemetry to report invocation correlation`);
      assert.match(text, /(?:does|do) not prove|not proof/i, `${name} must deny telemetry proof`);
      assert.match(text, /entry[\s\S]*agent[\s\S]*step[\s\S]*slice[\s\S]*provider request[\s\S]*aggregate/i, `${name} must deny attribution-to-span proof for every report subject`);
      assert.match(text, /(?:does not|creates no|must not)[\s\S]*(?:create )?spans?|no span/i, `${name} must not claim span creation`);
      assert.match(text, /(?:does not|initializes no|must not)[\s\S]*exporter/i, `${name} must not enable an exporter`);
    }
  });

  it("closes richer report/export TODO while retaining genuine follow-ups", () => {
    assert.doesNotMatch(TODO, /richer reporting\/export views/i, "TODO must not leave cost reporting/export as future work");
    assert.match(TODO, /provider-specific metadata normalization/i, "TODO must retain provider normalization follow-up");
    assert.match(TODO, /span taxonomy\/correlation/i, "TODO must retain genuine telemetry span follow-up");
    assert.match(TODO, /SDK\/export/i, "TODO must retain exporter validation follow-up");
    assert.match(TODO, /not entry-to-span proof/i, "TODO must distinguish invocation correlation from entry/span proof");
  });
});

describe("telemetry readiness docs contract", () => {
  it("documents doctor --telemetry readiness categories", () => {
    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /feature-factory doctor --telemetry/i, `${name} must document doctor --telemetry`);
      assert.match(text, /experimental\.openTelemetry/i, `${name} must document native opencode OTel readiness`);
      assert.match(text, /native AI SDK spans?/i, `${name} must document native AI SDK span expectation`);
      assert.match(text, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT[\s\S]*OTEL_EXPORTER_OTLP_ENDPOINT|OTEL_EXPORTER_OTLP_ENDPOINT[\s\S]*OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/i, `${name} must document OTLP endpoint readiness`);
      assert.match(text, /OTEL_EXPORTER_OTLP_TRACES_HEADERS[\s\S]*OTEL_EXPORTER_OTLP_HEADERS|OTEL_EXPORTER_OTLP_HEADERS[\s\S]*OTEL_EXPORTER_OTLP_TRACES_HEADERS/i, `${name} must document OTLP header readiness`);
      assert.match(text, /OTEL_SERVICE_NAME[\s\S]*OTEL_RESOURCE_ATTRIBUTES|OTEL_RESOURCE_ATTRIBUTES[\s\S]*OTEL_SERVICE_NAME/i, `${name} must document service/resource readiness`);
      assert.match(text, /companion telemetry plugin[\s\S]*@devtheops\/opencode-plugin-otel|@devtheops\/opencode-plugin-otel[\s\S]*companion telemetry plugin/i, `${name} must document companion plugin check`);
      assert.match(text, /@opentelemetry\/api[\s\S]*(?:loadable|loadability|exports)/i, `${name} must document instrumentation loadability`);
      assert.match(text, /FEATURE_FACTORY_OTEL_ENABLED[\s\S]*default-off|default-off[\s\S]*FEATURE_FACTORY_OTEL_ENABLED/i, `${name} must document enablement/default-off status`);
      assert.match(text, /content-capture risk|content capture risk/i, `${name} must document content capture risk`);
    }
  });

  it("documents Honeycomb/native OTel setup, sanitized OTLP env, and prompt capture warnings", () => {
    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /Honeycomb/i, `${name} must document Honeycomb setup`);
      assert.match(text, /x-honeycomb-team/i, `${name} must document Honeycomb OTLP header name`);
      assert.match(text, /native opencode|native OTel/i, `${name} must document native opencode OTel setup`);
      assert.match(text, /OpenTelemetry Collector redaction|collector redaction/i, `${name} must document collector redaction option`);
      assert.match(text, /headers?[\s\S]*(?:without printing values|never .* values|value:\"\[redacted\]\"|value.*\[redacted\])/i, `${name} must document sanitized OTLP header behavior`);
      assert.match(text, /credential-bearing (?:endpoint )?URLs?[\s\S]*(?:redacted|scrubbed)|redacted[\s\S]*credential-bearing (?:endpoint )?URLs?/i, `${name} must document credential-bearing URL redaction`);
      assert.match(text, /native opencode\/AI SDK[\s\S]*(?:capture prompts|may capture prompts|prompt\/output)/i, `${name} must warn about prompt/content capture`);
      for (const flag of ["captureMessages", "captureToolArguments", "captureToolResults", "captureReviews", "captureEvidence"]) {
        assert.match(text, literalPattern(flag), `${name} must document content capture flag ${flag}`);
      }
    }
  });

  it("documents no-default-telemetry and no durable trace state", () => {
    for (const [name, text] of documentEntries({ README, SPEC, SKILL, SCHEMA })) {
      assert.match(text, /(?:off by default|No telemetry enabled by default|no default telemetry)/i, `${name} must document telemetry off by default`);
      assert.match(text, /no default exporter|no exporter\/network side effects|no default.*network side effects/i, `${name} must document no default exporter/network side effects`);
      assert.match(text, /no durable trace state|not persisted in `run\.json`|must not be written into `run\.json`/i, `${name} must document no durable trace state`);
      assert.match(text, /not (?:workflow )?authority|non-authoritative/i, `${name} must document telemetry/trace non-authority`);
    }
    assert.doesNotMatch(SCHEMA, /["'](?:traceparent|tracestate|parentSpanId)["']\s*:/i, "SCHEMA must not add durable trace-context fields");
    assert.match(SCHEMA, /report telemetry[\s\S]*(?:not persisted|not persisted[\s\S]*report telemetry)|telemetry[\s\S]*response[\s\S]*not persisted/i, "SCHEMA must keep cost-report parent_span_id response metadata non-durable");
  });

  it("documents trace-context launch flags and runtime env mapping", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      for (const flag of ["--parent-span-id", "--traceparent", "--tracestate"]) {
        assert.match(text, literalPattern(flag), `${name} must document trace flag ${flag}`);
      }
      for (const envName of ["TRACEPARENT", "TRACESTATE", "FEATURE_FACTORY_TRACEPARENT", "FEATURE_FACTORY_TRACESTATE", "FEATURE_FACTORY_PARENT_SPAN_ID"]) {
        assert.match(text, literalPattern(envName), `${name} must document runtime env ${envName}`);
      }
      assert.match(text, /non-authoritative runtime (?:config|configuration)|runtime metadata only/i, `${name} must make trace context non-authoritative runtime config`);
      assert.match(text, /not (?:operator )?instructions|not user instructions/i, `${name} must state trace context is not instructions`);
      assert.match(text, /not persisted in `run\.json`|must not be written into `run\.json`|No `run\.json`[\s\S]*trace-context/i, `${name} must forbid persisting trace context in run.json`);
    }
  });

  it("narrows Honeycomb TODO to future span instrumentation and validation", () => {
    assert.match(TODO, /Completed readiness\/propagation baseline/i, "TODO must acknowledge completed telemetry readiness/propagation baseline");
    assert.match(TODO, /Future work:[\s\S]*span taxonomy\/correlation spans/i, "TODO must leave future feature-factory span instrumentation");
    assert.match(TODO, /Honeycomb Agent Timeline/i, "TODO must leave Honeycomb validation follow-up");
    assert.doesNotMatch(TODO, /Include `doctor --telemetry` readiness checks/i, "TODO must not leave doctor --telemetry readiness as future work");
  });
});

describe("TUI sidebar refresh diagnostics docs contract", () => {
  it("renders the refresh signal directly under the Feature Factory header with muted styling", () => {
    assert.match(TUI, /<b>Feature Factory<\/b>[\s\S]*<text fg=\{theme\(\)\.textMuted\} wrapMode="none">\{refreshMetadata\(\)\.label\}<\/text>/, "TUI must render the muted refresh label directly under the Feature Factory header");
  });

  it("documents the sidebar data-version label and restart limitation", () => {
    assert.match(README, /Feature Factory` panel[\s\S]*`sidebar vN · plugin changes need TUI restart`/i, "README must document the sidebar refresh metadata label");
    assert.match(README, /30s root-cache TTL|30-second root-cache TTL|30 second root-cache TTL|caches root discovery for 30 seconds/i, "README must document the root-cache TTL behind sidebar refreshes");
    assert.match(README, /already-open opencode TUI process[\s\S]*stale Feature Factory sidebar data[\s\S]*restart or reload the TUI/i, "README must document the active-session plugin-change limitation");
  });

  it("resolves the open TUI refresh hardening TODO while retaining the operational note", () => {
    assert.doesNotMatch(TODO, /TUI active-session refresh hardening/i, "TODO must not leave the resolved TUI refresh hardening item open");
    assert.match(TODO, /plugin bundle changes[\s\S]*restart(?:ing)? the opencode TUI|restart(?:ing)? the opencode TUI[\s\S]*plugin bundle changes/i, "TODO must retain the operational restart note");
  });
});

describe("0.2.0 public documentation contract", () => {
  const documentationStatus = markdownSection(README, "Documentation Status");
  const install = `${markdownSection(README, "Install")}\n${markdownSection(README, "Install Locally")}`;
  const packageSurface = markdownSection(README, "Package Surface");
  const releaseChecks = markdownSection(README, "Release Checks");
  const useInOpencode = markdownSection(README, "Use In opencode");
  const profiles = markdownSection(README, "Configure Plugin Options");
  const recommendedProfile = markdownSection(README, "Recommended Model Profile");
  const scriptedMode = markdownSection(README, "Scripted Mode");
  const doctor = markdownSection(README, "Doctor");
  const cleanupAndTui = markdownSection(README, "Cost attribution diagnostics");
  const prRecording = markdownSection(README, "Environment snapshots and PR recording");

  it("classifies current, proposal, historical, and protected documentation authority", () => {
    assert.match(documentationStatus, /README is the current packaged operator contract/i);
    for (const guide of ["CONTRIBUTING.md", "RELEASING.md", "CHANGELOG.md"]) {
      assert.match(documentationStatus, literalPattern(guide), `README must link ${guide}`);
    }
    assert.match(documentationStatus, /repository-only[\s\S]*current companion documentation/i);
    assert.match(SPEC, /Status — proposal \/ internal planning:[\s\S]*not the current operator[\s>]+contract[\s\S]*README\.md[\s\S]*current authority/i);
    for (const [name, text] of documentEntries({ DOGFOOD_LEARNINGS, RUN_LATENCY_FINDINGS })) {
      assert.match(text.slice(0, 500), /Status — historical retrospective[\s\S]*not[\s\S]*(?:current behavior|current[\s\S]*contract)[\s\S]*README\.md/i, `${name} must be historical, not current`);
    }
    assert.match(SIMPLIFICATION.slice(0, 500), /Status — historical implementation plan[\s\S]*not the active specification[\s\S]*README\.md/i);
    assert.match(documentationStatus, /TODO\.md[\s\S]*EXTRACTION-SPEC\.md[\s\S]*non-authoritative/i);
    for (const [name, text] of documentEntries({ CONTRIBUTING, RELEASING, CHANGELOG })) {
      assert.match(text.slice(0, 300), /Status:[\s\S]*current repository-only/i, `${name} must identify itself as a current repository-only guide`);
    }
  });

  it("protects package installation, JSONC rewrite, and single-registration limits", () => {
    assert.match(install, /npm install -g opencode-feature-factory[\s\S]*feature-factory install/i);
    assert.match(install, /npm install -g[\s\S]*does not edit opencode configuration/i);
    assert.match(install, /~\/\.config\/opencode\/opencode\.jsonc[\s\S]*one package plugin entry/i);
    assert.match(install, /rewrites the first matching registration[\s\S]*preferring a tuple entry so its options survive[\s\S]*removes any other duplicate string or tuple registrations/i);
    assert.match(install, /preserves unrelated values and existing tuple options/i);
    assert.match(install, /matching registration is idempotent/i);
    assert.match(install, /formatted strict JSON[\s\S]*comments and trailing commas are not preserved/i);
    assert.match(install, /shadowing[\s\S]*warnings only[\s\S]*not changed/i);
    assert.match(install, /install --local[\s\S]*file:\/\/[\s\S]*package root/i);
    assert.match(install, /restart opencode/i);
    assert.match(install, /does not add a second, independent TUI registration/i);
    assert.match(install, /does not prove host discovery or automatic TUI activation/i);
  });

  it("documents the exact metadata-derived exports and bin", () => {
    assert.deepEqual(PACKAGE.exports, {
      ".": "./src/plugin.js",
      "./server": "./src/plugin.js",
      "./tui": "./dist/tui.js",
      "./cli": "./src/cli.js",
    });
    assert.deepEqual(PACKAGE.bin, { "feature-factory": "src/cli.js" });
    for (const [entry, target] of Object.entries(PACKAGE.exports)) {
      assert.match(packageSurface, new RegExp(`${escapeRegExp(entry === "." ? "Package root `.`" : `\`${entry}\``)}[\\s\\S]{0,100}${escapeRegExp(`\`${target}\``)}`), `README missing export ${entry} -> ${target}`);
    }
    assert.match(packageSurface, new RegExp(`\`${escapeRegExp(Object.keys(PACKAGE.bin)[0])}\` bin[\\s\\S]{0,60}\`${escapeRegExp(Object.values(PACKAGE.bin)[0])}\``));
    assert.match(packageSurface, /dist\/[\s\S]*generated during packing[\s\S]*not edited or committed as source/i);
  });

  it("documents source-derived plugin and TUI registration plus observational limits", () => {
    const sourceAgents = [...PLUGIN.matchAll(/^\s{2}"([a-z-]+)": "(?:planning|story|research|design|builder|test|reviewer|security)",$/gmu)].map((match) => match[1]);
    const tuiId = /id: "([^"]+)"/.exec(TUI)?.[1];
    const tuiOrder = /order: (\d+)/.exec(TUI)?.[1];
    const tuiSlots = [...TUI.matchAll(/^\s{8}([a-z_]+)\(/gmu)].map((match) => match[1]);
    assert.equal(sourceAgents.length, 13);
    assert.match(useInOpencode, /registers `\/feature`, one primary `feature-factory` agent, 12 specialized subagents/i);
    assert.match(useInOpencode, /assets\/skills\/feature\/SKILL\.md/i);
    assert.deepEqual(tuiSlots, ["sidebar_content"]);
    assert.match(useInOpencode, new RegExp(`ID \`${escapeRegExp(tuiId)}\`[\\s\\S]*one \`${tuiSlots[0]}\` slot[\\s\\S]*order \`${tuiOrder}\``));
    assert.match(useInOpencode, /not a promise[\s\S]*automatically discovers or activates/i);
    for (const limit of [/refreshes data every 5 seconds/i, /caches root discovery for 30 seconds/i, /scans at most 2,000 directories/i, /displays at most three run rows/i, /Completed runs are hidden once healthy[\s\S]*most recent completed run stays listed[\s\S]*non-ok diagnostic remains listed until its diagnostics clear/i, /more than one completed run can appear/i, /restart or reload the TUI/i]) {
      assert.match(cleanupAndTui, limit);
    }
  });

  it("publishes exactly the approved 13-agent GPT-5.6 recommendation and routing rules", () => {
    const expected = [
      ["feature-factory", "openai/gpt-5.6-sol", "xhigh"],
      ["backend-builder", "openai/gpt-5.6-sol", "high"],
      ["codebase-researcher", "openai/gpt-5.6-terra", "high"],
      ["design-interpreter", "openai/gpt-5.6-sol", "high"],
      ["frontend-builder", "openai/gpt-5.6-sol", "high"],
      ["implementation-validator", "openai/gpt-5.6-sol", "xhigh"],
      ["security-reviewer", "openai/gpt-5.6-sol", "xhigh"],
      ["spec-writer", "openai/gpt-5.6-sol", "xhigh"],
      ["story-reader", "openai/gpt-5.6-luna", "medium"],
      ["story-writer", "openai/gpt-5.6-sol", "high"],
      ["test-verifier", "openai/gpt-5.6-terra", "high"],
      ["work-decomposer", "openai/gpt-5.6-sol", "xhigh"],
      ["work-reviewer", "openai/gpt-5.6-sol", "high"],
    ];
    const table = recommendedProfile.slice(recommendedProfile.indexOf("Canonical resolved recommendation"), recommendedProfile.indexOf("Rationale:"));
    const actual = [...table.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gmu)].map((match) => match.slice(1));
    assert.deepEqual(actual, expected);
    const sourceAgentNames = [...PLUGIN.matchAll(/^\s{2}"([a-z-]+)": "(?:planning|story|research|design|builder|test|reviewer|security)",$/gmu)].map((match) => match[1]).sort();
    assert.deepEqual(expected.map(([agent]) => agent).sort(), sourceAgentNames);
    assert.match(recommendedProfile, /opt-in exact-agent mapping[\s\S]*package supplies no model or variant defaults/i);
    assert.doesNotMatch(recommendedProfile, /openai\/gpt-5\.[45]/i);
    assert.match(profiles, /Profile precedence is exact agent, then role, then `profiles\.default`, then top-level `profile`, then opencode default/i);
    for (const role of ["story", "research", "design", "planning", "builder", "test", "reviewer", "security"]) assert.match(profiles, literalPattern(`\`${role}\``));
    assert.match(profiles, /security-reviewer` uses `profiles\.security`[\s\S]*falls back to `profiles\.reviewer` for compatibility/i);
    assert.match(profiles, /profile may contain `model`, `variant`, or both/i);
  });

  it("states start dry-run rejection before every launch-mode side effect", () => {
    assert.match(scriptedMode, /`factory start --dry-run` is unsupported/i);
    for (const mode of ["foreground", "headless", "autonomous", "detached"]) assert.match(scriptedMode, literalPattern(mode));
    for (const sideEffect of ["opencode launch", "skill seeding", "factory or worktree creation", "process-state creation", "detached logging", ".git/info/exclude"]) {
      assert.match(scriptedMode, literalPattern(sideEffect), `start dry-run statement missing ${sideEffect}`);
    }
    assert.match(scriptedMode, /rejected before[\s\S]*any other repository side effect/i);
    assert.match(scriptedMode, /Dry-run support[\s\S]*command-specific[\s\S]*does not make start dry-run valid/i);
  });

  it("states every provider-smoke caveat, including accepted-but-help-omitted", () => {
    const usageText = extractFunctionBody("usage");
    assert.match(CLI, /BOOLEAN_FLAGS[\s\S]*"--provider-smoke"/);
    assert.doesNotMatch(usageText, /--provider-smoke/);
    assert.match(doctor, /accepted by the CLI but omitted from the current help text/i);
    assert.match(doctor, /real `opencode run` in the selected working directory/i);
    assert.match(doctor, /once per distinct resolved model string—not once per provider or agent/i);
    assert.match(doctor, /consume quota or incur cost/i);
    assert.match(doctor, /30-second default timeout/i);
    assert.match(doctor, /point-in-time evidence[\s\S]*invocation and authentication/i);
    assert.match(doctor, /not a deterministic release check[\s\S]*does not guarantee future credentials, model availability, capacity, or provider service/i);
  });

  it("derives and protects Node support, tooling, CI, and publish versions", () => {
    const toolNode = /^nodejs (\S+)$/mu.exec(TOOL_VERSIONS)?.[1];
    const ciNodes = /node-version: \[([^\]]+)\]/u.exec(CI_WORKFLOW)?.[1].split(",").map((value) => value.trim());
    const publishNode = /^\s+node-version: (\d+)$/mu.exec(PUBLISH_WORKFLOW)?.[1];
    assert.match(releaseChecks, literalPattern(`Node \`${PACKAGE.engines.node}\``));
    assert.match(releaseChecks, literalPattern(`Node \`${toolNode}\``));
    for (const version of ciNodes) assert.match(releaseChecks, new RegExp(`CI[\\s\\S]{0,80}Node ${version}`));
    assert.match(releaseChecks, new RegExp(`publication uses Node ${publishNode}`));
    assert.match(releaseChecks, /Node 20[\s\S]*not a CI matrix version/i);
    assert.match(CONTRIBUTING, literalPattern(`Node.js \`${PACKAGE.engines.node}\``));
    assert.match(CONTRIBUTING, literalPattern(`Node.js \`${toolNode}\``));
  });

  it("protects contributor commands, check order, and generated output policy", () => {
    for (const command of ["npm ci", "npm run test:unit", "npm run smoke:pack", "npm run check"]) assert.match(CONTRIBUTING, literalPattern(command));
    const checkOrder = PACKAGE.scripts.check.split(" && ");
    assert.match(CONTRIBUTING, orderedPattern(checkOrder));
    assert.match(CONTRIBUTING, /does not currently define a lint or typecheck script/i);
    assert.equal(PACKAGE.scripts.prepack, "npm run build:tui");
    assert.match(PACKAGE.scripts["build:tui"], /--outfile=dist\/tui\.js/u);
    assert.match(CONTRIBUTING, /smoke test packs[\s\S]*invokes `prepack`[\s\S]*generates `dist\/tui\.js` from `src\/tui\.jsx`/i);
    assert.match(CONTRIBUTING, /do not edit it, stage it, or commit it/i);
  });

  it("protects the metadata/workflow-derived pushed-tag release sequence and boundaries", () => {
    const version = PACKAGE.version;
    assert.match(PUBLISH_WORKFLOW, /push:[\s\S]*tags:[\s\S]*- "v\*"/);
    assert.match(RELEASING, new RegExp(`tag matching \`v\\*\` is pushed[\\s\\S]*\`v<version>\`[\\s\\S]*\`v${escapeRegExp(version)}\``));
    for (const step of ["Checks out the pushed tag", "Selects Node.js 24", "Runs `npm ci`", "Verifies that `GITHUB_REF_NAME` exactly equals `v${package.json.version}`", "Runs `npm run check`", "Runs `npm publish`"]) {
      assert.match(RELEASING, literalPattern(step), `release guide missing ${step}`);
    }
    assert.match(RELEASING, orderedPattern(["Checks out the pushed tag", "Runs `npm ci`", "GITHUB_REF_NAME", "Runs `npm run check`", "Runs `npm publish`"]));
    assert.match(PUBLISH_WORKFLOW, orderedPattern(["actions/checkout", "node-version: 24", "npm ci", "Verify release tag", "npm run check", "npm publish"]));
    assert.match(RELEASING, /GitHub Actions `npm` environment[\s\S]*`id-token: write`/i);
    for (const exclusion of [/publish from a branch or support manual dispatch/i, /choose or bump the package version/i, /update the changelog/i, /create or push commits or tags/i, /create a GitHub Release/i]) assert.match(RELEASING, exclusion);
  });

  it("keeps the changelog minimal, verified, and undated", () => {
    assert.equal((CHANGELOG.match(/^## /gmu) || []).length, 1);
    assert.match(CHANGELOG, new RegExp(`^## ${escapeRegExp(PACKAGE.version)}$`, "mu"));
    assert.equal((CHANGELOG.match(/^- /gmu) || []).length, 3);
    assert.match(CHANGELOG, /`\/feature`[\s\S]*one primary `feature-factory` agent[\s\S]*12 specialized subagents[\s\S]*packaged feature skill/i);
    assert.match(CHANGELOG, /package root and `\/server`[\s\S]*`src\/plugin\.js`[\s\S]*`\/tui`[\s\S]*generated `dist\/tui\.js`[\s\S]*`\/cli`[\s\S]*`src\/cli\.js`[\s\S]*`feature-factory` bin/i);
    assert.match(CHANGELOG, /install, doctor, and factory CLI surfaces[\s\S]*separately importable TUI registration object/i);
    assert.doesNotMatch(CHANGELOG, /\b(?:19|20)\d{2}-\d{2}-\d{2}\b|migration|published|released on|guarantee/i);
  });

  it("protects cancel-pending semantics and fail-closed signal boundaries", () => {
    assert.match(scriptedMode, /each invocation sends at most one `SIGTERM`[\s\S]*Only verified exit changes `process\.json\.state` to `cancelled`/i);
    assert.match(scriptedMode, /process remains alive[\s\S]*status:"cancel-pending"[\s\S]*process state remains `running`[\s\S]*process\.json\.cancel/i);
    assert.match(scriptedMode, /rerun performs fresh fail-closed identity checks[\s\S]*exact recorded process remains live and matches the evidence[\s\S]*new invocation may send one more targeted `SIGTERM`[\s\S]*if it has exited[\s\S]*confirms cancellation without signaling/i);
    assert.match(scriptedMode, /missing, invalid, stale, mismatched[\s\S]*status:"failed-closed"[\s\S]*signaled:false[\s\S]*updated:false/i);
    assert.match(scriptedMode, /each invocation sends at most one `SIGTERM`[\s\S]*never retries automatically/i);
    assert.match(scriptedMode, /Failed-closed handling sends no signal[\s\S]*no broad signal, process-group signal, `pkill`, or `killall` fallback/i);
  });

  it("requires a PR fence token in the public creation sequence and every command example", () => {
    assert.match(prRecording, orderedPattern(["factory pr-fence <run-id> --json", "gh pr create", "gh pr view <url>", "factory pr-created <run-id>", "--fence-token TOKEN"]));
    const exampleBlocks = fencedBlocks(README).filter((block) => /feature-factory factory pr-created <run-id>/u.test(block));
    assert.ok(exampleBlocks.length > 0, "README must include a factory pr-created command example");
    for (const block of exampleBlocks) assert.match(block, /--fence-token TOKEN/u, "every factory pr-created command example must carry its fence token");
    assert.match(prRecording, /rejects a missing, mismatched, or stale fence/i);
    assert.match(prRecording, /--clear --fence-token TOKEN/i);
  });

  it("documents only the narrow pre-manifest cleanup exception", () => {
    assert.match(cleanupAndTui, /run with `run\.json`[\s\S]*only runs for terminal statuses[\s\S]*unless `--force`/i);
    assert.match(cleanupAndTui, /narrow pre-manifest exception[\s\S]*known dead before writing `run\.json`/i);
    assert.match(cleanupAndTui, /may be removed only when that evidence validates and records a non-`running` state/i);
    assert.match(cleanupAndTui, /running evidence is refused[\s\S]*cancel first/i);
    assert.match(cleanupAndTui, /malformed, unreadable, or mismatched evidence fails closed[\s\S]*requires verifying the process is dead and rerunning with `--force`/i);
    assert.match(cleanupAndTui, /refuses to remove run directories outside `\.opencode\/factory`/i);
  });

  it("keeps every relative README link resolvable inside the published package", () => {
    // The packaged README must not delegate to repository-only files: any relative
    // link target has to be covered by package.json#files (npm always packs
    // README/LICENSE/package.json). Repository-only guides use absolute URLs.
    const packagedDirs = PACKAGE.files.filter((entry) => !entry.includes("*") && !entry.includes(".")).map((entry) => `${entry}/`);
    const packagedFiles = new Set([...PACKAGE.files.filter((entry) => !entry.includes("*") && entry.includes(".")), "README.md", "LICENSE", "package.json"]);
    const packagedGlobs = PACKAGE.files.filter((entry) => entry.includes("*"));
    const matchesGlob = (target) => packagedGlobs.some((glob) => {
      const [prefix, suffix] = glob.split("**/*");
      return suffix !== undefined ? target.startsWith(prefix) && target.endsWith(suffix) : false;
    });
    const links = [...README.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
    for (const rawTarget of links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || rawTarget.startsWith("#")) continue;
      const target = rawTarget.replace(/^\.\//, "").split("#")[0];
      assert.ok(
        packagedFiles.has(target) || packagedDirs.some((dir) => target.startsWith(dir)) || matchesGlob(target),
        `README relative link '${rawTarget}' must resolve inside the published package (package.json#files)`,
      );
    }
  });
});

function documentEntries(map) {
  return Object.entries(map);
}

function markdownSection(text, heading) {
  const headingPattern = new RegExp(`^(#{2,6}) ${escapeRegExp(heading)}\\s*$`, "mu");
  const match = headingPattern.exec(text);
  assert.ok(match, `missing markdown section ${heading}`);
  const level = match[1].length;
  const bodyStart = match.index + match[0].length;
  const nextHeading = new RegExp(`^#{1,${level}} \\S.*$`, "mu").exec(text.slice(bodyStart));
  return text.slice(match.index, nextHeading ? bodyStart + nextHeading.index : text.length);
}

function readDoc(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function literalPattern(value) {
  return new RegExp(escapeRegExp(value));
}

function orderedPattern(values) {
  return new RegExp(values.map((value) => escapeRegExp(value)).join("[\\s\\S]*"));
}

function assertNear(text, left, right, message) {
  const eitherOrder = new RegExp(`${escapeRegExp(left)}[\\s\\S]{0,320}${escapeRegExp(right)}|${escapeRegExp(right)}[\\s\\S]{0,320}${escapeRegExp(left)}`, "i");
  assert.match(text, eitherOrder, message);
}

function commandPattern(command) {
  return new RegExp(command.split(/\s+/u).map((part) => escapeRegExp(part)).join("\\s+"));
}

function assertCliSurfaceIncludes(command) {
  const parts = command.split(/\s+/u);
  const verb = parts[1];
  for (const flag of commandFlags(command)) assertCliParsesFlag(flag, command);
  if (verb === "env") {
    assert.match(CLI, /sub === "env"/, "CLI missing factory env");
    assert.match(CLI, /action === "record-created"/, "CLI missing env record-created");
    assert.match(CLI, /action === "record-resume"/, "CLI missing env record-resume");
    return;
  }
  assert.match(CLI, new RegExp(`sub === "${escapeRegExp(verb)}"`), `CLI missing factory ${verb}`);
}

function documentedStateWriteVerbs() {
  return new Set(STATE_WRITE_COMMANDS.map((command) => command.split(/\s+/u)[1]));
}

function firstFencedBlockAfter(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return "";
  const rest = text.slice(match.index + match[0].length);
  const block = /```[a-z]*\n([\s\S]*?)\n```/i.exec(rest);
  return block ? block[1] : "";
}

function fencedBlocks(text) {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
}

function implementedStateWriteVerbs() {
  const verbs = [];
  const dispatchPattern = /if \(sub === "([^"]+)"(?: \|\| sub === "[^"]+")?\) return ([A-Za-z0-9]+)\(rest\);/gu;
  for (const [, verb, handler] of CLI.matchAll(dispatchPattern)) {
    const body = extractFunctionBody(handler);
    if (/transition[A-Z]|writeGateAnswer|persistFactoryRun/u.test(body)) verbs.push(verb);
  }
  return verbs;
}

function extractFunctionBody(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`, "u").exec(CLI);
  assert.ok(match, `CLI missing handler function ${name}`);
  const open = CLI.indexOf("{", match.index);
  let depth = 0;
  for (let index = open; index < CLI.length; index += 1) {
    const char = CLI[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return CLI.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated CLI handler function ${name}`);
}

function commandFlags(command) {
  return [...new Set([...command.matchAll(/--[a-z-]+/gu)].map((match) => match[0]))];
}

function assertCliParsesFlag(flag, command) {
  assert.ok(parsedCliFlags().has(flag), `${command} documents ${flag}, but CLI options() does not parse it`);
}

function parsedCliFlags() {
  return new Set([...extractFlagSet("BOOLEAN_FLAGS"), ...extractFlagSet("VALUE_FLAGS")]);
}

function extractFlagSet(name) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\);`, "u").exec(CLI);
  assert.ok(match, `CLI missing ${name}`);
  return [...match[1].matchAll(/"(--[^"]+)"/gu)].map((flagMatch) => flagMatch[1]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
