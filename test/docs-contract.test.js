import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DIAGNOSTIC_CLASSIFICATIONS,
  DIAGNOSTIC_CONDITIONS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_STATUSES,
} from "../src/factory-diagnostics.js";
import { HEARTBEAT_PHASES, TERMINAL_RUN_STATUSES, validateRun } from "../src/validate.js";
import { LAUNCH_CLAIM_PHASES, LAUNCH_KINDS } from "../src/process-evidence.js";

const SKILL = readDoc("../assets/skills/feature/SKILL.md");
const SCHEMA = readDoc("../assets/skills/feature/SCHEMA.md");
const COMMAND = readDoc("../assets/command/feature.md");
const README = readDoc("../README.md");
const CONTINUATION_SCOPE_DESIGN = readDoc("../CONTINUATION-SCOPE-DESIGN.md");
const SPEC = readDoc("../SPEC.md");
const CONTRIBUTING = readDoc("../CONTRIBUTING.md");
const RELEASING = readDoc("../RELEASING.md");
const CHANGELOG = readDoc("../CHANGELOG.md");
const DOGFOOD_LEARNINGS = readDoc("../DOGFOOD-LEARNINGS.md");
const RUN_LATENCY_FINDINGS = readDoc("../RUN-LATENCY-FINDINGS.md");
const SIMPLIFICATION = readDoc("../SIMPLIFICATION.md");
const DURABLE_AUTHORITY_LEDGER = readDoc("../DURABLE-AUTHORITY-LEDGER.md");
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
const TEST_VERIFIER_PROMPT = readDoc("../assets/agent/test-verifier.md");
const BACKEND_BUILDER_PROMPT = readDoc("../assets/agent/backend-builder.md");
const FRONTEND_BUILDER_PROMPT = readDoc("../assets/agent/frontend-builder.md");
const IMPLEMENTATION_VALIDATOR_PROMPT = readDoc("../assets/agent/implementation-validator.md");
const SECURITY_REVIEWER_PROMPT = readDoc("../assets/agent/security-reviewer.md");
const BLOCKED_CONTINUE_COMMAND = "feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>";
const BASE_ADVANCE_COMMAND = "feature-factory factory base-advance <run-id> --json";
const BASE_ADVANCE_DOCS = Object.freeze({
  README: markdownSection(README, "Checked Active-Run Base Advancement"),
  SKILL: markdownSection(SKILL, "Checked Active-Run Base Advancement"),
  SCHEMA: markdownSection(SCHEMA, "Checked Active-Run Base Advancement"),
});

describe("checked active-run base advancement operator contract", () => {
  it("documents the exact JSON command, CLI API export, closed exits, and caller-authority rejection", () => {
    for (const [name, text] of documentEntries(BASE_ADVANCE_DOCS)) {
      assert.equal(text.includes(BASE_ADVANCE_COMMAND), true, `${name} must contain the exact base-advance command`);
      assert.match(text, /JSON-only/i, name);
      assert.match(text, /advanceFactoryRunBase\(runId, \{ cwd \}\)/u, name);
      assert.match(text, /opencode-feature-factory\/cli/u, name);
      assert.match(text, /trim(?: that primitive string)? exactly once|trim once|one ECMAScript trim/i, name);
      assert.match(text, /the concatenation of `\^\[A-Za-z0-9\]` and `\(\?:\[A-Za-z0-9\._-\]\*\[A-Za-z0-9\]\)\?\$`/u, name);
      assert.match(text, /Success (?:returns|is|exits).*exit 0|success exits 0/i, name);
      assert.match(text, /failures? exit 1|rejection is one terminal-safe JSON document and exit 1/i, name);
      assert.match(text, /caller-supplied repo|caller authority for a repo|caller Git authority/i, name);
      assert.match(text, /ref(?:\/SHA)?|target ref\/SHA/i, name);
      assert.match(text, /force/i, name);
      assert.match(text, /worktree/i, name);
    }
  });

  it("documents eligibility, fixed lock order, FF-only identity, preservation, replay, and crash states", () => {
    for (const [name, text] of documentEntries(BASE_ADVANCE_DOCS)) {
      assert.match(text, /ordinary/i, name);
      assert.match(text, /`running`|status: "running"/i, name);
      assert.match(text, /pre-PR/i, name);
      assert.match(text, /no continuation\/checkpoint authority/i, name);
      assert.match(text, /no .*merged or blocked slice|merged or blocked slice/i, name);
      assert.match(text, /`run-json\.lock`[\s\S]{0,80}(?:then|and then) the existing external launch fence/i, name);
      assert.match(text, /concurrent normal resume|normal resume cannot launch concurrently/i, name);
      assert.match(text, /one canonical GitHub `origin`/i, name);
      assert.match(text, /`refs\/heads\/main`/u, name);
      assert.match(text, /`git merge --ff-only`/u, name);
      assert.match(text, /only `run\.json\.base_commit` and `run\.json\.updated_at` may change|only top-level `base_commit` and `updated_at`/i, name);
      assert.match(text, /candidate ref(?:s)?\/commit(?:s)?\/worktree/i, name);
      assert.match(text, /`already-current`/u, name);
      assert.match(text, /before Git movement/i, name);
      assert.match(text, /after Git movement but before binding|Git advanced but manifest unbound|Git-advanced\/unbound/i, name);
      assert.match(text, /after binding|already bound current|bound\/current/i, name);
      assert.match(text, /fails? closed without reset or repair/i, name);
    }
  });

  it("distinguishes active advancement from fresh initialization, rebaseline, and blocked continuation", () => {
    for (const [name, text] of documentEntries(BASE_ADVANCE_DOCS)) {
      assert.match(text, /not fresh-run initialization or rebaseline|not fresh initialization\/rebaseline|neither fresh initialization\/rebaseline/i, name);
      assert.match(text, /`factory start`[\s\S]{0,100}(?:new|fresh).*run/i, name);
      assert.match(text, /not blocked-run continuation|not blocked continuation|nor blocked continuation|terminal blocked parent/i, name);
      assert.match(text, /`factory continue`[\s\S]{0,100}(?:new child|creates a new child)/i, name);
      assert.match(text, /does not resume|does not resume or dispatch/i, name);
      assert.match(text, /does not (?:advance\/rebase|rewrite) candidate|candidate history/i, name);
    }
  });
});

describe("cleanup sweep operator contract", () => {
  it("documents preview, digest-bound execution, and the closed no-force grammar", () => {
    assert.match(README, /cleanup --all --dry-run \[--repo PATH\] \[--json\]/i);
    assert.match(README, /cleanup --all --digest ff-cleanup-v1\.<repository-sha256>\.<envelope-sha256>/i);
    assert.match(README, /never accepts a positional run id, `--force`, or unrelated options/i);
    assert.match(README, /repository- and evidence-bound digest/i);
  });

  it("documents positive eligibility, lock-held revalidation, and fail-closed uncertainty", () => {
    for (const contract of [
      /status is exactly `completed`/i,
      /exact merged or closed PR/i,
      /freshly fetched trustworthy PR base/i,
      /safe containment and exact identity/i,
      /acquires each candidate's run-state lock without reclaiming/i,
      /repeats the complete eligibility check while holding that lock/i,
      /uncertainty are skipped rather than deleted/i,
    ]) assert.match(README, contract);
  });

  it("documents reports, exits, partial retention, and manual protected-run handling", () => {
    for (const contract of [
      /aggregate `eligible`, `protected`, `skipped`, `deleted`, and `failed` counts/i,
      /Preview exits 0/i,
      /Refused digests and report-level failures exit 1/i,
      /continues with independent candidates after a cleanup failure/i,
      /exits 1 if any candidate's cleanup was actually attempted and failed/i,
      /run directory is retained whenever an earlier worktree or branch operation fails/i,
      /`blocked`, `partial`, or `needs-human` status are protected recoverable work/i,
      /handle them manually/i,
    ]) assert.match(README, contract);
  });
});
const STATE_WRITE_COMMANDS = Object.freeze([
  "factory base-advance <run-id> --json",
  "factory env record-created <run-id> --json",
  "factory env record-resume <run-id> --json",
  "factory provenance review-dispatch <run-id> --agent AGENT --subject SUBJECT --attempts N --hash sha256:<hash> --prompt-bytes N --json",
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
  "factory repair <run-id> reported --owner-slice",
  "factory pr-created <run-id> --fence-token TOKEN --json",
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
  it("aligns the spec writer with the reviewer's shared bar and separates producer self-checks", () => {
    // Alignment, not accretion: every recent run paid a guaranteed one-round spec
    // rejection because the reviewer's acceptance rubric was richer than the
    // writer's output contract. The writer carries the reviewer's bar as a
    // pre-return self-check. Shared invariants must appear in BOTH prompts so the
    // producer checklist and reviewer rubric cannot silently drift apart;
    // producer-only self-checks are deliberately NOT asserted against the
    // reviewer — they are observed rejection causes, not reviewer contract text.
    assert.match(SPEC_WRITER_PROMPT, /## Self-review before returning/i);
    assert.match(SPEC_WRITER_PROMPT, /The reviewer's bar \(shared invariants/i);
    assert.match(SPEC_WRITER_PROMPT, /Producer self-checks \(not reviewer contract text/i);
    const sharedBar = [
      ["decided per-sink policy", /decided policy/i, /decided policy/i],
      ["mandatory test mapping", /every AC maps to a mandatory, named test or command/i, /every row maps to a test/i],
      ["no unresolved consequential decision", /No unresolved consequential decision/i, /missing consequential decision/i],
      ["implementation mechanics remain build-time choices", /Implementation mechanics are acceptable build-time choices/i, /Builders may choose private helper signatures/i],
      ["every consequential under-specification dimension", /Every consequential dimension specified/i, /every consequential dimension of under-specification/i],
      ["story-authorized deferral", /only when the approved story or scope authorizes it/i, /only when the approved story or scope authorizes it/i],
      ["feasible envelope", /implementable within the brief's allowed mechanisms, dependencies, compatibility constraints, and non-goals/i, /cannot be implemented within its allowed mechanisms, dependencies, compatibility constraints, or explicit non-goals/i],
      ["spec altitude defers mechanical cross-products", /defer exhaustive field-nullability, outcome\/code, state\/field, and crash-point cross-products/i, /Do \*\*not\*\* require private helper signatures[\s\S]*exhaustive field-nullability, outcome\/code, state\/field, or crash-point cross-product matrices/i],
    ];
    for (const [name, writerPattern, reviewerPattern] of sharedBar) {
      assert.match(SPEC_WRITER_PROMPT, writerPattern, `spec-writer must self-check shared invariant: ${name}`);
      assert.match(WORK_REVIEWER_PROMPT, reviewerPattern, `work-reviewer must enforce shared invariant: ${name}`);
    }
    // Producer-only self-checks (observed first-review rejection causes).
    assert.match(SPEC_WRITER_PROMPT, /hunting for contradictions/i);
    assert.match(SPEC_WRITER_PROMPT, /Every in-scope existing, public, generated, shared, or contested path and every fixed source-mandated artifact has an exact path and clear owner/i);
    assert.match(SPEC_WRITER_PROMPT, /every builder-chosen private file must remain inside a declared path lane/i);
  });

  it("requires source assessment and minimum architecture before specification", () => {
    const writerAssessment = markdownSection(SPEC_WRITER_PROMPT, "Source and work assessment");
    const writerArchitecture = markdownSection(SPEC_WRITER_PROMPT, "Minimum architecture rule");
    const stepTwo = markdownSection(SKILL, "Step 2 - Spec And Decomposition");
    assert.ok(SPEC_WRITER_PROMPT.indexOf("## Source and work assessment") < SPEC_WRITER_PROMPT.indexOf("## Decide"), "source assessment must precede implementation design");
    assert.ok(SPEC_WRITER_PROMPT.indexOf("### Source and work assessment") < SPEC_WRITER_PROMPT.indexOf("### Implementation plan"), "source assessment must precede the implementation plan in the output template");

    for (const text of [writerAssessment, stepTwo]) {
      assert.match(text, /what (?:story )?decisions(?: and contracts|\/contracts)? are already authoritative/i);
      assert.match(text, /what (?:behavioral or technical )?decisions (?:actually )?remain unresolved/i);
      assert.match(text, /what repository mapping or evidence is still required/i);
      assert.match(text, /what is the simplest repository-native design/i);
      assert.match(text, /distinguish work (?:that is )?already handed/i);
      assert.match(text, /how (?:every|each) identified gap was resolved[\s\S]*repository evidence used/i);
    }
    assert.match(writerAssessment, /Use repository evidence and your delegated technical judgment to resolve the remaining consequential decisions within the specification-altitude boundary/i);
    assert.match(writerAssessment, /Stop instead of emitting a technical brief only when required repository evidence is still missing or a remaining decision needs product, UX, security, external-policy, or other owner input outside the spec writer's authority/i);
    assert.match(WORK_REVIEWER_PROMPT, /writer must resolve the remaining consequential decisions within the specification-altitude boundary using repository evidence and delegated technical judgment/i);
    assert.match(WORK_REVIEWER_PROMPT, /reject and request the exact decision or targeted research only when required evidence is missing or a remaining decision needs product, UX, security, external-policy, or other owner input outside the writer's authority/i);
    assert.match(stepTwo, /writer resolves the remaining consequential decisions within the specification-altitude boundary using repository evidence and delegated technical judgment/i);
    assert.match(stepTwo, /Stop instead of emitting a brief only when required evidence remains missing or a remaining decision needs product, UX, security, external-policy, or other owner input outside the writer's authority/i);
    for (const text of [SPEC_WRITER_PROMPT, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.doesNotMatch(text, /ordinary implementation decisions/i);
    }

    for (const text of [writerArchitecture, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.match(text, /prefer (?:extending|extension) or (?:extracting|extraction)|prefer existing seams and extraction/i);
      assert.match(text, /(?:new|add a) service, sidecar, plugin, daemon, durable root, protocol, state machine, compatibility layer/i);
      assert.match(text, /approved story[\s\S]*specific acceptance criterion[\s\S]*binding repository requirement/i);
    }
    for (const column of ["Addition", "Required by", "Existing seam considered", "Why insufficient", "Smallest viable extension"]) {
      assert.match(SPEC_WRITER_PROMPT, literalPattern(column), `architectural-additions table missing ${column}`);
    }
    assert.match(writerArchitecture, /For every unavoidable new architectural element, including one named by the story, identify its story\/acceptance-criterion\/repository driver, the existing seam considered, why that seam is insufficient, and the smallest viable extension/i);
    assert.match(WORK_REVIEWER_PROMPT, /Require one row in the architectural-additions table for every such addition, including one named by the story, with that driver, the existing seam considered, why it is insufficient, and the smallest viable extension/i);
    assert.match(stepTwo, /Require one architectural-additions table row for every unavoidable addition, including one named by the story, with that driver, the existing seam considered, why it is insufficient, and the smallest viable extension/i);

    for (const text of [writerArchitecture, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.match(text, /new file or module used only (?:to organize code|for code organization)[\s\S]*no new process, service, durable state, protocol, lifecycle, compatibility, authority, or security boundary/i);
    }

    assert.match(writerAssessment, /technical brief adds repository mapping and closes genuine decision gaps/i);
    assert.match(WORK_REVIEWER_PROMPT, /Reject unnecessary restatement, reinterpretation, or strengthening of story decisions/i);
    assert.match(WORK_REVIEWER_PROMPT, /removing or simplifying it still satisfies the story/i);
    assert.match(stepTwo, /remove or simplify the mechanism rather than expanding the specification around it/i);
  });

  it("keeps implementation mechanics at build-and-test altitude", () => {
    const writerAltitude = markdownSection(SPEC_WRITER_PROMPT, "Specification altitude boundary");
    const stepTwo = markdownSection(SKILL, "Step 2 - Spec And Decomposition");

    for (const text of [writerAltitude, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.match(text, /externally observable behavior/i);
      assert.match(text, /public(?:\/| or )wire contract/i);
      assert.match(text, /persisted compatibility\/migration\/recovery/i);
      assert.match(text, /security(?:\/| or )authority/i);
      assert.match(text, /failure policy/i);
      assert.match(text, /semantic state transitions/i);
      assert.match(text, /acceptance tests/i);
      assert.match(text, /ownership seams\/path lanes/i);
      assert.match(text, /private helper signatures/i);
      assert.match(text, /exhaustive field-nullability, outcome\/code, state\/field, (?:or|and) crash-point cross-product matrices/i);
      assert.match(text, /executable schema or state model plus table-driven or model-based(?: build)? tests/i);
      assert.match(text, /closed schema[\s\S]*fields[\s\S]*variants[\s\S]*bounds/i);
      assert.match(text, /(?:pin an )?(?:individual|specific) combination (?:is blocking )?only when (?:the )?(?:approved )?source makes it normative/i);
    }

    assert.match(writerAltitude, /A builder choosing among mechanically equivalent implementations is not an unresolved design decision/i);
    assert.match(WORK_REVIEWER_PROMPT, /Mechanical implementation detail and absent prose cross-product enumeration are not required omissions/i);
    assert.match(stepTwo, /implementation mechanics are nonblocking/i);

    const writerDecide = markdownSection(SPEC_WRITER_PROMPT, "Decide");
    assert.doesNotMatch(writerDecide, /Files to add\/change by path/i);
    assert.match(writerDecide, /Ownership seams and path lanes/i);
    assert.match(writerDecide, /Name exact paths and owners for every in-scope existing, public, generated, shared, or contested path and every fixed source-mandated artifact/i);
    assert.match(writerDecide, /let builders choose new private files and module layout within the declared lane/i);
    assert.match(SPEC_WRITER_PROMPT, /<existing path \| path lane>/i);
    assert.match(SPEC_WRITER_PROMPT, /Do not enumerate private files merely to choose module layout before implementation/i);
    assert.doesNotMatch(SPEC_WRITER_PROMPT, /Include it normally in the implementation plan/i);
    for (const text of [SPEC_WRITER_PROMPT, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.match(text, /every (?:in-scope )?existing, public, generated, shared, or contested path/i);
      assert.match(text, /every fixed source-mandated artifact/i);
      assert.match(text, /builder-chosen private files?[^.]*(?:inside a declared path lane|within an owned path lane|inside an owned lane)/i);
    }

    assert.match(stepTwo, /The specification-altitude rule applies to every brief, including a bounded capability/i);
    assert.ok(
      stepTwo.indexOf("The specification-altitude rule applies to every brief") < stepTwo.indexOf("For class-wide work"),
      "general altitude policy must precede the separately scoped class-wide matrix rule",
    );
  });

  it("separates consequential persisted and security policy from builder-owned mechanisms", () => {
    const writerAltitude = markdownSection(SPEC_WRITER_PROMPT, "Specification altitude boundary");
    const stepTwo = markdownSection(SKILL, "Step 2 - Spec And Decomposition");
    for (const text of [writerAltitude, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.match(text, /existing readers, compatibility promises, external tooling, or the approved story/i);
      assert.match(text, /private persisted record/i);
      assert.match(text, /internal field layout/i);
      assert.match(text, /trust model, protected asset, actor capability, authority rule/i);
      assert.match(text, /exact guard helpers?, validation plumbing/i);
      assert.match(text, /outside the declared trust model|outside the trust model/i);
    }
  });

  it("requires the decomposer to derive dependencies from each test command's validated outputs", () => {
    // Producer invariant from the observed remediation-exposed rejection: adding
    // focused test commands to a slice without depending on the sibling whose
    // changed output those commands validate. Narrow by design: broad regression
    // commands must not imply dependencies on unaffected code.
    assert.match(WORK_DECOMPOSER_PROMPT, /identify the changed slice outputs it validates/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /every sibling slice whose changed output must exist before that command runs/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /Broad regression commands do not imply dependencies on unaffected code/i);
  });

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
    const stepTwo = markdownSection(SKILL, "Step 2 - Spec And Decomposition");

    assert.match(SPEC_WRITER_PROMPT, /research map must contain a finite surface inventory/i);
    assert.match(SPEC_WRITER_PROMPT, /Class-wide implementation matrix \(required when applicable\)/i);
    for (const column of ["Source", "Sink / call site", "Required primitive / policy", "Compatibility / exclusion", "Test"]) {
      assert.match(SPEC_WRITER_PROMPT, literalPattern(column), `spec matrix missing ${column}`);
    }
    assert.match(SPEC_WRITER_PROMPT, /stop and request targeted research/i);
    assert.match(SPEC_WRITER_PROMPT, /Do not use open-ended phrases such as "apply everywhere"/i);
    assert.match(SPEC_WRITER_PROMPT, /<existing test `path:line` \\\| owned test lane \+ named command\/assertion>/i);
    assert.doesNotMatch(
      SPEC_WRITER_PROMPT,
      /\| <input\/source> \| `path:line` \| <exact behavior> \| <preserve, migrate, or exclude with reason> \| `path:line` \|/i,
    );
    for (const text of [SPEC_WRITER_PROMPT, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.match(text, /Builder-chosen private tests map by owned test lane plus named command\/assertion/i);
      assert.match(text, /exact test artifact path only when it is existing, public, generated, shared, contested, or source-fixed/i);
    }
  });

  it("requires finite registration before claiming durable-authority integrity coverage", () => {
    const writerMatrix = markdownSection(SPEC_WRITER_PROMPT, "Durable authority integrity matrix (required when applicable)");
    const schemaCatalog = markdownSection(SCHEMA, "Durable Authority Integrity Catalog");

    for (const column of ["Authority record / state variant", "Writer / checked transition", "Every decision-making consumer / reader", "Required adversarial mutation families", "Exclusion reason", "Named test"]) {
      assert.match(writerMatrix, literalPattern(column), `durable authority matrix missing ${column}`);
    }
    assert.match(SPEC_WRITER_PROMPT, /newly introduced durable authority record has no integrity-coverage claim until it is registered/i);
    assert.match(schemaCatalog, /cannot claim integrity coverage until it is registered in the finite matrix/i);
    assert.match(schemaCatalog, /missing and unknown keys[\s\S]*wrong schema, kind, time, and type[\s\S]*wrong ref, hash, and bytes[\s\S]*descriptor key-shape drift[\s\S]*stale and cross-bound identity/i);
    assert.match(schemaCatalog, /excluded with a non-empty record-specific reason/i);
    assert.match(SPEC_WRITER_PROMPT, /One aggregate row or one mutation elsewhere in the authority class never covers a sibling record or variant/i);
    assert.match(schemaCatalog, /wrong ref does not count as wrong bytes/i);
    assert.match(schemaCatalog, /reject completeness unless every required per-record entry passes/i);
    assert.match(schemaCatalog, /Registration, mutation emission, and catalog completeness are necessary but not sufficient for a production-integrity-coverage claim/i);
    assert.match(schemaCatalog, /every applicable emitted mutation case for that row must also be asserted rejected through the row's named production validator, consistency checker, or checked transition/i);
    assert.match(schemaCatalog, /https:\/\/github\.com\/jasoncarreira\/opencode-feature-factory\/issues\/82/i);
    assert.match(schemaCatalog, /manifest remains an inventory oracle rather than an automatic production-coverage claim/i);
    assert.match(writerMatrix, /independently authored closed completeness oracle/i);
    assert.match(writerMatrix, /exact writer, all readers, named tests, authority facts, sidecar byte bindings, all mutation-family target-or-exclusion dispositions/i);
    assert.match(schemaCatalog, /independently authored closed manifests are not generated from or derived from the catalog under test/i);
    assert.match(schemaCatalog, /omission or substitution at the source boundary fails completeness/i);
    assert.match(schemaCatalog, /absent targets never receive automatic exclusions/i);
    assert.match(writerMatrix, /authority class, id, record, variant, canonical (?:persisted )?source path and exact shape/i);
    assert.match(writerMatrix, /path-plus-expected-value authority facts/i);
    assert.match(writerMatrix, /source deletion\/substitution[\s\S]*record(?: or |\/)variant relocation[\s\S]*fact deletion\/relocation\/value contradiction[\s\S]*synthetic keys/i);
    assert.match(schemaCatalog, /current canonical-source manifest has 196 variants[\s\S]*195 production-covered rows[\s\S]*`final-plan-descriptor`/i);
    for (const id of [
      "test-execution-claim-active", "test-execution-claim-completed-pass", "test-execution-claim-completed-fail",
      "test-execution-claim-unknown-process-outcome-indeterminate", "test-execution-claim-unknown-authority-changed",
      "test-execution-claim-unknown-receipt-publication-indeterminate", "test-execution-receipt-pass",
      "test-execution-receipt-failed-nonzero-exit", "test-execution-receipt-failed-signal",
      "test-execution-receipt-failed-launch-error", "test-execution-receipt-failed-timeout", "test-execution-receipt-failed-output-limit",
    ]) assert.match(schemaCatalog, literalPattern(id), `SCHEMA authority matrix missing ${id}`);
    assert.match(schemaCatalog, /legacy plan\/slices[\s\S]*v2 required-command plan variant[\s\S]*future-only `final\.plan` descriptor[\s\S]*run envelopes[\s\S]*PR-created result[\s\S]*existing continuation rows[\s\S]*all post-PR rows[\s\S]*all PR79 repair rows/i);
    assert.match(schemaCatalog, /source deletion or substitution[\s\S]*record\/variant relocation[\s\S]*fact deletion\/relocation\/value contradiction[\s\S]*synthetic keys/i);
    assert.match(schemaCatalog, /seven B0M\.1 rows[\s\S]*named exported validator or checked transition[\s\S]*every applicable generated mutation/i);
    assert.match(schemaCatalog, /`final\.plan` remains explicitly future-only and descriptor-only[\s\S]*without claiming production coverage or claiming that current `validateRun` consumes it/i);
    for (const text of [writerMatrix, schemaCatalog]) {
      assert.match(text, /target-or-exclusion dispositions/i);
      assert.match(text, /complete target definition/i);
      assert.match(text, /path[\s\S]*value[\s\S]*from[\s\S]*to[\s\S]*key[\s\S]*sidecar[\s\S]*label/i);
      assert.match(text, /target deletion/i);
      assert.match(text, /target-to-exclusion[\s\S]*exclusion-to-target/i);
      assert.match(text, /mutation of any bound target field|target-field mutation/i);
    }
    assert.match(schemaCatalog, /not generated from or derived from the catalog under test/i);

    const manifestProcedure = markdownSection(schemaCatalog, "Oracle-manifest update procedure");
    assert.match(manifestProcedure, /Edit the readable catalog values first/i);
    assert.match(manifestProcedure, /Never start by replacing a digest/i);
    assert.match(manifestProcedure, /never use a generated or blind bulk digest replacement as the review object/i);
    assert.match(manifestProcedure, /For every row whose literal digest would change/i);
    assert.match(manifestProcedure, /renderDurableAuthorityOracleReviewSnapshot/i);
    assert.match(manifestProcedure, /retain both the old and new snapshots/i);
    assert.match(manifestProcedure, /review their metadata, descriptor, and canonical-source value diff/i);
    assert.match(manifestProcedure, /must never be generated from the catalog or from the snapshot/i);
    assert.match(manifestProcedure, /readable old\/new value diff independently reviewed/i);
    assert.match(manifestProcedure, /Only after the value diff is independently reviewed may the corresponding literal digest be deliberately updated/i);
    assert.match(manifestProcedure, /Opaque hash churn alone is not review evidence/i);

    for (const authorityClass of [
      "Plan and slices graph",
      "Run envelope and terminal result",
      "Gates, pending snapshot, and handoff receipt",
      "Steps and acceptance inheritance",
      "Slices and review/evidence bindings",
      "Validator, security, and PR-created result",
      "Continuation and planning/draft reuse",
      "Post-PR nested records",
      "PR79 merged slice repair",
    ]) {
      assert.match(schemaCatalog, literalPattern(authorityClass), `durable authority catalog missing ${authorityClass}`);
    }
    for (const variant of [
      "gate-pending",
      "gate-approved-without-receipt",
      "gate-approved-interactive",
      "gate-changes-requested",
      "gate-stopped",
      "step-running",
      "step-rejected",
      "step-blocked",
      "step-accepted",
      "step-inherited-acceptance",
      "slice-pending",
      "slice-running",
      "slice-review",
      "slice-merged",
      "slice-blocked",
      "steering-boundary",
      "steering-action-claim",
      "steering-last-action",
      "post-pr-phase-disabled",
      "post-pr-phase-awaiting-pr",
      "post-pr-phase-observing",
      "post-pr-phase-failure-recording",
      "post-pr-phase-remediation-planned",
      "post-pr-phase-remediation-running",
      "post-pr-phase-changes-observed",
      "post-pr-phase-committed",
      "post-pr-phase-revalidating",
      "post-pr-phase-validated",
      "post-pr-phase-push-pending",
      "post-pr-phase-remote-confirmed",
      "post-pr-phase-succeeded",
      "post-pr-phase-blocked",
      "post-pr-phase-needs-human",
      "post-pr-observation-null",
      "post-pr-observation-active",
      "post-pr-observation-last-error",
      "post-pr-observation-review-request",
      "post-pr-observation-snapshot",
      "post-pr-remediation-null",
      "post-pr-remediation-active",
      "post-pr-remediation-owner",
      "post-pr-remediation-changes",
      "post-pr-remediation-change-entry",
      "post-pr-dispatch-planned",
      "post-pr-dispatch-running",
      "post-pr-dispatch-returned",
      "post-pr-revalidation-empty",
      "post-pr-revalidation-bound",
      "post-pr-canonical-job-planned",
      "post-pr-canonical-job-running",
      "post-pr-canonical-job-retry-wait",
      "post-pr-canonical-job-bound",
      "post-pr-validator-job-planned",
      "post-pr-validator-job-running",
      "post-pr-validator-job-retry-wait",
      "post-pr-validator-job-bound",
      "post-pr-security-job-planned",
      "post-pr-security-job-running",
      "post-pr-security-job-retry-wait",
      "post-pr-security-job-bound",
      "post-pr-push-last-error",
      "post-pr-continuation-review-null",
      "post-pr-continuation-review-bound",
      "post-pr-terminal-fact-null",
      "post-pr-terminal-fact-account-switch-failed-github-auth",
      "post-pr-terminal-fact-account-switch-failed-push",
      "post-pr-terminal-fact-dispatch-start-unknown",
      "post-pr-terminal-fact-path-lane-violation",
      "post-pr-terminal-fact-remote-head-diverged",
      "post-pr-terminal-fact-panel-runner-result-malformed",
      "post-pr-terminal-fact-push-failed",
      "post-pr-terminal-fact-panel-attribution-unsafe",
      "repair-reported",
      "repair-repairing",
      "repair-review-approve",
      "repair-review-reject",
      "repair-merged",
      "repair-blocked-from-reported",
      "repair-blocked-from-repairing",
      "repair-blocked-from-review",
    ]) assert.match(schemaCatalog, literalPattern(`\`${variant}\``), `durable authority catalog missing variant ${variant}`);
    assert.match(schemaCatalog, /does not persist a `gate` field; `story` is map-key metadata/i);
    assert.match(schemaCatalog, /Only the interactive approved gate has the exact nested `handoff_receipt`/i);
    assert.match(schemaCatalog, /separate external-source declarations rather than a `sidecar_bytes` member of the gate/i);
    assert.match(schemaCatalog, /No step variant joins `rejected` and `blocked`/i);
    assert.match(schemaCatalog, /no synthetic nested `review_binding`/i);
    assert.match(schemaCatalog, /top-level `\{evidence_hash, review_hash, reviewed_commit\}` fields are required current review\/merge authority/i);
    assert.match(schemaCatalog, /B2 adds required append-only `attempt_reviews`/i);
    assert.match(SPEC_WRITER_PROMPT, /retain the real append-only `attempt_reviews`[\s\S]*checked dispatch-required claim\/closure ref-plus-hash fields/i);
    assert.doesNotMatch(SPEC_WRITER_PROMPT, /do not invent[^\n]*`attempt_reviews`/i);
    assert.match(schemaCatalog, /successor validator source is exactly `\{verdict, report, report_hash, review_ref, review_hash, reviewed_head_sha\}` and the successor security source exactly `\{verdict, review_ref, review_hash, reviewed_head_sha\}`/i);
    assert.match(schemaCatalog, /no token is invented at the `post_pr` root, remediation container, dispatch, or push/i);
    assert.match(schemaCatalog, /closed to exactly `schema_version`, `policy`, `phase`, `attempt`, optional successor `pr_operation`, `observation`, `remediation`, `evidence_refs`, `continuation_review`, and `terminal_fact`/i);
    assert.match(schemaCatalog, /never persists synthetic `run_status` or `sidecar_bytes`/i);
    assert.match(schemaCatalog, /All fifteen phase rows are complete enclosing records/i);
    assert.match(schemaCatalog, /failure fingerprint\/head\/evidence ref-plus-hash/i);
    assert.match(schemaCatalog, /candidate head, remediation evidence ref-plus-hash, revalidation, and push/i);
    assert.match(schemaCatalog, /running requires `action_token` and `started_at`; bound requires `returned_at`, result ref\/hash, and an activity-valid verdict/i);
    assert.match(schemaCatalog, /`retry-wait` is a schema-valid intermediate consumed only by the checked post-PR job transition\/retry path/i);
    assert.match(schemaCatalog, /non-null push error is the closed structured[\s\S]*never a string/i);
    assert.match(schemaCatalog, /Evidence refs and retry-exhaustion continuation review are exact `\{ref, hash\}` objects/i);
    assert.match(schemaCatalog, /Terminal fact is null or one of the eight validator-accepted forms/i);
    assert.match(schemaCatalog, /Mutation coverage changes each ref, each hash, and the actual external bytes independently/i);
    assert.match(schemaCatalog, /checked by `checkRunConsistency`/i);
    assert.match(schemaCatalog, /`changes-observed`, `committed`, `revalidating`, `validated`, `push-pending`, and `remote-confirmed` phase rows each bind five independent authority targets/i);
    assert.match(schemaCatalog, /remediation-evidence ref drift, hash drift, actual file-byte drift, stale candidate-head identity, and cross-bound candidate-head identity/i);
    assert.match(schemaCatalog, /exported `transitionPostPrState` consumes the candidate identity and once-bound remediation bindings/i);
    assert.match(SPEC_WRITER_PROMPT, /canonical-source oracle covers every catalog row/i);
    assert.match(SPEC_WRITER_PROMPT, /future-only `final\.plan` descriptor/i);
    assert.match(SPEC_WRITER_PROMPT, /post-PR phases `changes-observed`, `committed`, `revalidating`, `validated`, `push-pending`, and `remote-confirmed`/i);
    assert.match(schemaCatalog, /Reported persists exactly schema version, plan hash, owner\/consumer ids, defect path, original evidence ref\/hash[\s\S]*attempts zero[\s\S]*max_attempts: 2/i);
    assert.match(schemaCatalog, /Repairing has `status: "repairing"`, attempts one or two, `baseline_commit`, and optional branch\/worktree/i);
    assert.match(schemaCatalog, /review sources persist `status: "review"`[\s\S]*`APPROVE` or `REJECT` exists only in the separately bound review JSON/i);
    assert.match(schemaCatalog, /Merged adds `status: "merged"`, `merge_commit`, and verification ref\/hash[\s\S]*Reviewed-tree\/merge-tree equality is re-observed[\s\S]*not a persisted field/i);
    assert.match(schemaCatalog, /blocked source persists `status: "blocked"` and `reason`[\s\S]*origin is inferred from retained fields[\s\S]*never a `blocked_from` field/i);
    assert.match(schemaCatalog, /Plan, original evidence, repair evidence, review, and verification are separate fixture files whose refs, hashes, and bytes mutate independently/i);
    assert.match(schemaCatalog, /never gains synthetic `plan_ref`, `owner_snapshot`, `quiescent`, `review_verdict`, `reviewed_tree`, `merge_tree`, or `sidecar_bytes`/i);
    assert.match(schemaCatalog, /exported `transitionMergedSliceRepair` consumer/i);
    assert.match(SPEC_WRITER_PROMPT, /For PR #79 `merged_slice_repair`[\s\S]*eight canonical persisted variants separately/i);
    assert.match(SPEC_WRITER_PROMPT, /verdict exists only in the bound external review JSON and catalog metadata tied to the checked consumer/i);

    for (const excluded of [
      "run.json.debug_snapshot",
      "run.json.provenance",
      "run.json.cost_attribution",
      "heartbeat.json",
      "factory.lock",
      "process.json",
    ]) {
      assert.match(schemaCatalog, literalPattern(`\`${excluded}\``), `durable authority catalog must explicitly exclude ${excluded}`);
    }
    assert.match(schemaCatalog, /test\/docs-only, non-enforcing contracts/i);
    assert.match(schemaCatalog, /do not create `src\/single-slice\/schema-model`, add a production validator, authorize a runtime transition, or change production behavior/i);
    assert.match(schemaCatalog, /Baseline acceptance by a production validator or consumer is not a substitute for asserting every applicable emitted mutation rejected at that production seam/i);
  });

  it("documents exactly the seven B0M.1 production rows and their closed production envelopes", () => {
    const schemaCatalog = markdownSection(SCHEMA, "Durable Authority Integrity Catalog");
    const adopted = ["plan-slices-json", "run-envelope-running", "run-envelope-terminal", "terminal-result-completed", "terminal-result-blocked", "terminal-result-partial", "terminal-result-needs-human"];
    const adoptionSentence = schemaCatalog.match(/B0M\.1 production adoption[\s\S]*?No other catalog row gains production-integrity coverage from B0M\.1\./iu)?.[0] || "";
    for (const id of adopted) assert.match(adoptionSentence, literalPattern(`\`${id}\``), `${id} must be explicitly production-covered`);
    assert.equal((adoptionSentence.match(/`(?:plan-slices-json|run-envelope-(?:running|terminal)|terminal-result-(?:completed|blocked|partial|needs-human))`/gu) || []).length, 7);
    assert.doesNotMatch(adoptionSentence, /final-plan-descriptor/u);
    assert.match(schemaCatalog, /No other catalog row gains production-integrity coverage from B0M\.1/i);

    const runSchema = markdownSection(SCHEMA, "run.json");
    assert.match(runSchema, /root is closed to exactly `schema_version`, `run_id`, `mode`, `status`, `created_at`, `updated_at`, `heartbeat_at`, `base_ref`, `base_commit`, `branch`, `worktree`, `github_account`, `pr_mode`, `pr_url`, `max_parallel_slices`, `max_retries`, `review_tier`, `debug_snapshot`, `provenance`, `merged_slice_repair`, `special_builder_dispatch`, `continuation`, `checkpoint_source`, `checkpoint_progress`, `steering`, `post_pr`, `gates`, `slices`, `cost_attribution`, `steps`, `validator`, `security_review`, and `terminal_result`/i);
    assert.match(runSchema, /Unknown root keys have no legacy fallback[\s\S]*`schema_version` is required and equals `1`/i);
    assert.match(runSchema, /Ordinary checked `run\.json` transitions keep `run_id`, `base_commit`, `branch`, and `worktree` immutable/i);
    assert.match(runSchema, /`recoverDisruptedRun` is the sole worktree-rebinding exception[\s\S]*may change only top-level `worktree`/i);
    assert.match(runSchema, /terminal result is closed to common keys `status`, `run_id`, `pr_url`, `reason`, `summary`, and `artifacts`/i);
    assert.match(runSchema, /completed result may additionally contain `pr_number`, `pr_node_id`, `repository`, `operation_id`, `head_ref`, `head_sha`, `base_ref`, `base_sha`, and `draft`/i);
    assert.match(runSchema, /repository-relative durable artifact-ref grammar/i);
    assert.doesNotMatch(runSchema, /"external_ref"/u);

    const planSchema = markdownSection(SCHEMA, "plan/slices.json");
    assert.match(planSchema, /plan root is closed to `slices` plus compatibility-optional `integration_gate` and `delivery_envelope`/i);
    assert.match(planSchema, /planned slice is closed to exactly `id`, `stack`, `paths`, `depends_on`, `acceptance`, and `test_plan`/i);
    assert.match(planSchema, /stale or non-existent `depends_on` identity is invalid/i);
  });

  it("documents B0MR.1 reviewed-code bindings, exact merge proof, upgrades, and fence re-observation", () => {
    const schemaCatalog = markdownSection(SCHEMA, "Durable Authority Integrity Catalog");
    const runSchema = markdownSection(SCHEMA, "run.json");
    const buildSlices = markdownSection(SKILL, "Step 4 - Build Slices");
    const integrate = markdownSection(SKILL, "Step 5 - Integrate And Validate");

    assert.match(schemaCatalog, /B0MR\.1 additionally gives production-consumer coverage to exactly `slice-review`, `slice-merged`, `validator-verdict-binding`, and `security-verdict-binding`/i);
    assert.match(schemaCatalog, /current canonical-source manifest has 196 variants/i);

    for (const text of [README, SPEC, SCHEMA]) {
      assert.match(text, /`?evidence_hash`?.*`?review_hash`?.*`?reviewed_commit`?/is);
      assert.match(text, /`?report_hash`?.*`?review_hash`?.*`?reviewed_head_sha`?/is);
    }
    assert.match(runSchema, /For slice `review` and `merged`, `evidence_hash`, `review_hash`, and `reviewed_commit` are all required/i);
    assert.match(runSchema, /Validator and security must both use their successor tuples or both use the legacy ref-only form/i);
    assert.match(buildSlices, /full 40-character lowercase `head_sha`/i);
    assert.match(buildSlices, /`reviewed_commit` equal to the exact full SHA the reviewer inspected/i);
    assert.match(integrate, /Both review JSON files must carry the integration branch as `subject`, the same positive `attempt`, and `reviewed_head_sha`/i);

    for (const text of [SPEC, SCHEMA, SKILL]) {
      assert.match(text, /exact two-parent merge|exactly ordered parents/is);
      assert.match(text, /unique full (?:`git )?merge-base --all/i);
      assert.match(text, /NUL-delimited.*no-renames|NUL-delimited, rename-disabled/is);
      assert.match(text, /mode\/type\/object identity/i);
    }
    assert.match(runSchema, /earlier merged slice commit must already be an ancestor of `P1`/i);

    for (const text of [README, SPEC, SCHEMA, SKILL]) {
      assert.match(text, /legacy slice review\/merged rows.*reject/is);
      assert.match(text, /partial successor.*reject/is);
      assert.match(text, /legacy completed.*read-only/is);
      assert.match(text, /re-hash.*slice\/panel|re-hash.*bound slice\/panel/is);
      assert.match(text, /current clean integration (?:branch\/worktree )?HEAD/i);
    }
    assert.match(WORK_REVIEWER_PROMPT, /machine-readable review JSON.*exact slice `subject`, positive `attempt`.*`reviewed_commit`/is);
    assert.match(WORK_REVIEWER_PROMPT, /Reviewed commit.*full 40-character lowercase Git SHA/i);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /machine-readable verdict JSON.*positive panel `attempt`.*`reviewed_head_sha`/is);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /Reviewed head SHA.*full 40-character lowercase Git SHA/i);
    assert.match(SECURITY_REVIEWER_PROMPT, /machine-readable verdict JSON.*positive panel `attempt`.*`reviewed_head_sha`/is);
    assert.match(SECURITY_REVIEWER_PROMPT, /Reviewed head SHA.*full 40-character lowercase Git SHA/i);
  });

  it("documents B0MR.2 deterministic PR-operation reconciliation and catalog closure", () => {
    const activeDocs = [README, SPEC, SKILL, SCHEMA, COMMAND];
    const contract = [...activeDocs, DURABLE_AUTHORITY_LEDGER].join("\n");
    for (const text of activeDocs) {
      assert.match(text, /factory pr-created <run-id> --fence-token (?:TOKEN|<token>|<fence\.token>).*--json/i);
      assert.doesNotMatch(text, /factory pr-created <run-id>[^\n]*--(?:pr-url|pr-number|repository|draft|no-draft|head-sha|node-id)/i);
    }
    assert.match(contract, /\{operation_id,repository,head_ref,head_sha,base_ref,base_sha,draft\}.*all-or-none/is);
    assert.match(contract, /ffpr-v1-.*lowercase SHA-256.*canonical UTF-8 JSON.*base_commit.*branch.*created_at.*repository.*run_id.*lexical key order/is);
    assert.match(contract, /exactly one standalone `?<!-- opencode-feature-factory:pr-operation=<(?:(?:operation_)?id)> -->`?/i);
    assert.match(contract, /GET repos\/\{repository\}\/pulls\?state=all&head=\{owner\}:\{head_ref\}&base=\{base_ref\}&per_page=100/i);
    assert.match(contract, /account-switched.*shell-free.*(?:at most|maximum-)10.*Link/is);
    assert.match(contract, /unique exact open.*unique exact merged.*closed-unmerged.*needs-human.*ambiguous.*unknown.*retain/is);
    assert.match(contract, /only complete checked absence.*clear/i);
    assert.match(contract, /legacy-pr-fence-operation-identity-missing.*retain/is);
    assert.match(contract, /\{pr_url,pr_number,pr_node_id,repository,operation_id,head_ref,head_sha,base_ref,base_sha,draft\}/i);
    assert.match(SCHEMA, /current canonical-source manifest has 196 variants[\s\S]*195 production-covered rows[\s\S]*`final-plan-descriptor`/i);
    assert.match(SCHEMA, /`steering-pr-fence`/i);
    assert.match(WORK_REVIEWER_PROMPT, /deterministic marker identity.*account-switched GitHub observer/is);
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /deterministic operation identity.*account-switched observer/is);
    assert.match(SECURITY_REVIEWER_PROMPT, /caller-forged URL\/number\/repository\/draft\/SHA fields.*marker ambiguity.*pagination substitution/is);
  });

  it("keeps the boundary-retention ledger finite and aligned with all nine authority classes", () => {
    const authorityClasses = [
      "Plan and slices graph",
      "Run envelope and terminal result",
      "Gates, pending snapshot, and handoff receipt",
      "Steps and acceptance inheritance",
      "Slices and review/evidence bindings",
      "Validator, security, and PR-created result",
      "Continuation and planning/draft reuse",
      "Post-PR nested records",
      "PR79 merged slice repair",
    ];
    const classHeadings = [...DURABLE_AUTHORITY_LEDGER.matchAll(/^## (\d+)\. Authority class: (.+)$/gmu)];
    assert.equal(classHeadings.length, 9, "boundary-retention ledger must contain exactly nine authority-class sections");
    assert.deepEqual(
      classHeadings.map((match) => [Number(match[1]), match[2]]),
      authorityClasses.map((authorityClass, index) => [index + 1, authorityClass]),
      "boundary-retention ledger authority classes must exactly match the B0.3 catalog",
    );
    for (const disposition of ["`RETAIN`", "`REOBSERVE`", "`CONSOLIDATE/REMOVE`"]) {
      assert.match(DURABLE_AUTHORITY_LEDGER, literalPattern(disposition), `ledger missing disposition ${disposition}`);
    }
    for (const doc of [SPEC, SCHEMA]) assert.match(doc, /DURABLE-AUTHORITY-LEDGER\.md/, "schema/spec must link the canonical ledger");
    assert.match(SCHEMA, /https:\/\/github\.com\/jasoncarreira\/opencode-feature-factory\/blob\/main\/DURABLE-AUTHORITY-LEDGER\.md/);
    assert.doesNotMatch(SCHEMA, /\]\(\.\.\/\.\.\/\.\.\/DURABLE-AUTHORITY-LEDGER\.md\)/u, "packaged schema must not use a repository-relative link that escapes the package");
  });

  it("requires each finite authority class to decide retention, re-observation, and duplicate consolidation", () => {
    for (const heading of [
      "1. Authority class: Plan and slices graph",
      "2. Authority class: Run envelope and terminal result",
      "3. Authority class: Gates, pending snapshot, and handoff receipt",
      "4. Authority class: Steps and acceptance inheritance",
      "5. Authority class: Slices and review/evidence bindings",
      "6. Authority class: Validator, security, and PR-created result",
      "7. Authority class: Continuation and planning/draft reuse",
      "8. Authority class: Post-PR nested records",
      "9. Authority class: PR79 merged slice repair",
    ]) {
      const authorityClass = markdownSection(DURABLE_AUTHORITY_LEDGER, heading);
      for (const disposition of ["`RETAIN`", "`REOBSERVE`", "`CONSOLIDATE/REMOVE`"]) {
        assert.match(authorityClass, literalPattern(disposition), `${heading} must decide ${disposition}`);
      }
    }
  });

  it("preserves observation, evidence, review, merge, continuation, handoff, and external-effect controls", () => {
    for (const control of [
      /model claim[\s\S]*mutable working-tree file[\s\S]*never a substitute for Git observation/i,
      /Test\/reproduction evidence exact bytes[\s\S]*command bytes[\s\S]*exact result[\s\S]*observed head[\s\S]*changed_paths/i,
      /Independent review exact bytes[\s\S]*review ref\/hash[\s\S]*exact reviewed commit/i,
      /merge_commit\^\{tree\} = reviewed_commit\^\{tree\}/i,
      /Parent and child continuation identity[\s\S]*exact parent\/child run ids, commits, hashes, and review bytes survive/i,
      /handoff_receipt[\s\S]*approval fingerprint[\s\S]*steering generation/i,
      /PR\/GitHub external identities[\s\S]*external creation operation identity/i,
      /unknown external outcome[\s\S]*re-observed before retry/i,
      /process-launch\.lock\/owner\.json[\s\S]*nonce/i,
      /action-claim token[\s\S]*Unknown start outcome is reconciled, not repeated/i,
      /PR fence token[\s\S]*Never clear after a PR exists/i,
    ]) assert.match(DURABLE_AUTHORITY_LEDGER, control);
  });

  it("records the complete PR 79 disposition without weakening legacy or single-repair authority", () => {
    const pr79 = markdownSection(DURABLE_AUTHORITY_LEDGER, "9. Authority class: PR79 merged slice repair");
    for (const retained of [
      "Original reproduction `evidence_ref` and `evidence_hash`",
      "`baseline_commit`",
      "`reviewed_commit`, `review_ref`, and `review_hash`",
      "`verification_ref` and `verification_hash`",
      "`merge_commit` and the equality `merge_commit^{tree} = reviewed_commit^{tree}`",
    ]) assert.match(pr79, literalPattern(retained), `PR 79 ledger missing retained boundary ${retained}`);
    assert.match(pr79, /`plan_hash`[\s\S]*`CONSOLIDATE\/REMOVE`[\s\S]*canonical owner\/effective-path snapshot[\s\S]*re-observe that snapshot/i);
    assert.match(pr79, /Owner slice, consumer slice, defect path, status, attempt, and fixed attempt ceiling[\s\S]*`RETAIN`/i);
    assert.match(pr79, /`repair_evidence_ref` and `repair_evidence_hash`[\s\S]*`CONSOLIDATE\/REMOVE` only when the repair facts exist exactly once in the canonical amendment manifest[\s\S]*Consumption must re-observe/i);
    assert.match(pr79, /A local\/model statement that the repair was reviewed, merged, or verified[\s\S]*`CONSOLIDATE\/REMOVE`/i);
    assert.match(DURABLE_AUTHORITY_LEDGER, /Persisted legacy records keep their original schema/i);
    assert.match(DURABLE_AUTHORITY_LEDGER, /No two repair authorities may be active for one run/i);
    assert.match(DURABLE_AUTHORITY_LEDGER, /B0MR\.1 is[\s\S]*narrow successor exception[\s\S]*without adding a second[\s\S]*authority class or rewriting legacy records eagerly/i);
  });

  it("requires first review to consolidate same-class findings across every consequential dimension", () => {
    assert.match(WORK_REVIEWER_PROMPT, /First-attempt completeness rule:[\s\S]*`attempt: 1`[\s\S]*every consequential dimension of under-specification/i);
    assert.match(WORK_REVIEWER_PROMPT, /do not surface one example, or one category, while withholding equivalent findings for later rounds/i);
    assert.match(WORK_REVIEWER_PROMPT, /new category that was discoverable at `attempt: 1`[\s\S]*first-pass miss/i);
    assert.match(WORK_REVIEWER_PROMPT, /class-wide requirements[\s\S]*finite source-to-sink implementation matrix/i);
    assert.match(WORK_REVIEWER_PROMPT, /Delta rule:[\s\S]*`attempt > 1`/i);
  });

  it("uses one canonical full brief and stops nonconvergent spec retries", () => {
    const remediation = markdownSection(SPEC_WRITER_PROMPT, "Remediation protocol");
    const stepTwo = markdownSection(SKILL, "Step 2 - Spec And Decomposition");
    assert.match(remediation, /complete canonical `artifacts\/technical-brief\.md` in place/i);
    assert.match(remediation, /not an appended amendment, patch-only response, or replacement artifact/i);
    assert.match(stepTwo, /pass `attempt: N`, the prior attempt-suffixed review ref, the complete prior `required_fixes`, and the orchestrator-observed remediation delta/i);
    assert.match(stepTwo, /fresh `work-reviewer` Task on the complete canonical brief/i);
    assert.match(stepTwo, /reviews\/spec-writer\.attempt-N\.json/i);
    assert.match(WORK_REVIEWER_PROMPT, /newly raised implementation mechanic or optional hardening detail is NONBLOCKING and never creates a required fix or retry/i);
    assert.match(WORK_REVIEWER_PROMPT, /first-pass miss[\s\S]*mark the review `nonconvergent`[\s\S]*stop autonomous spec retries/i);
    assert.match(stepTwo, /terminalize through the normal blocked\/needs-human boundary/i);
  });

  it("routes merged-sibling defects through the bounded owner repair, never out-of-lane edits", () => {
    // The observed critic-acceptance incident: a consumer exposed a defect in a
    // merged dependency, edited the sibling's test file, and burned its final
    // attempt on the lane rejection. The repair route gives the defect a legal
    // owner without reopening the merged slice's immutable history.
    for (const [name, prompt] of [["backend", BACKEND_BUILDER_PROMPT], ["frontend", FRONTEND_BUILDER_PROMPT]]) {
      assert.match(prompt, /Cross-slice defects are reported, never edited/i, `${name} builder must report cross-slice defects`);
      assert.match(prompt, /Regression tests for consumed sibling behavior belong in your own test files, never in the sibling's/i, `${name} builder must keep sibling regressions in its own lane`);
    }
    assert.match(WORK_REVIEWER_PROMPT, /merged-sibling repair \(subject `repair:<owner-slice-id>`\)/i);
    assert.match(WORK_REVIEWER_PROMPT, /REJECT the entire repair route when it matches an unresolved item from those reviews/i);
    assert.match(WORK_REVIEWER_PROMPT, /never become a backdoor around an exhausted review/i);
    assert.match(WORK_REVIEWER_PROMPT, /must fail before the repair and pass after it, on observed evidence/i);
    assert.match(WORK_REVIEWER_PROMPT, /verdict JSON must record `attempt`[\s\S]*and `commit`/i, "reviewer must self-bind attempt and commit");
    assert.match(SKILL, /rejects a stale local verdict\/commit pairing/i);
    assert.match(SCHEMA, /rejects a stale local verdict\/commit pairing/i);
    assert.match(SKILL, /### Merged-Sibling Repair \(bounded\)/);
    assert.match(SKILL, /Only one repair incident is allowed per run/i);
    assert.match(SKILL, /never charged to the merged slice's immutable history and never drawn from `run\.max_retries`/i);
    assert.match(SKILL, /factory repair <run-id> reported --owner-slice/);
    assert.match(SKILL, /no slice may start or merge/i);
    assert.match(SKILL, /final `test-verifier` integration gate and the full pre-PR panel still run unchanged/i);
    assert.match(SCHEMA, /merged_slice_repair/);
    assert.match(SCHEMA, /`merged` and `blocked` are terminal, and a further defect requires a recovery run/i);
    assert.match(SCHEMA, /attempt 1 is the initial correction, attempt 2 the single remediation after a finite rejecting review/i);
    assert.match(README, /one bounded merged-sibling repair per run/i);
  });

  it("requires rejecting reviews to enumerate explicit finite fixes", () => {
    assert.match(WORK_REVIEWER_PROMPT, /Explicit required-fix rule:[\s\S]*each `required_fixes` item finite and directly actionable/i);
    assert.match(WORK_REVIEWER_PROMPT, /Name every exact missing record, alias, sink\/call site, state transition, policy, test, path, or artifact/i);
    assert.match(WORK_REVIEWER_PROMPT, /cite the source requirement and the artifact location/i);
    assert.match(WORK_REVIEWER_PROMPT, /equivalent omissions share one fix[\s\S]*complete closed list/i);
    assert.match(WORK_REVIEWER_PROMPT, /Never use an umbrella instruction[\s\S]*without the exhaustive names/i);
    assert.match(WORK_REVIEWER_PROMPT, /later reviews must not serialize a broad category into one newly named omission per attempt/i);
    assert.match(WORK_REVIEWER_PROMPT, /Every rejecting finding and `required_fixes` item follows the explicit required-fix rule/i);
  });

  it("uses one fixed three-attempt slice model with hash-bound atomic review history", () => {
    assert.match(WORK_DECOMPOSER_PROMPT, /same fixed three-attempt runtime limit/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /Do not emit `max_attempts`, `dominant_concern`, obligation-count eligibility, or any fourth-attempt policy/i);
    assert.match(WORK_REVIEWER_PROMPT, /`remaining_fix_count` equals its length/i);
    assert.match(WORK_REVIEWER_PROMPT, /APPROVE requires zero fixes; REJECT requires at least one/i);
    assert.match(WORK_REVIEWER_PROMPT, /exactly three attempts; never recommend attempt 4/i);
    assert.match(SKILL, /mechanically enforced attempts 1 through 3/i);
    assert.match(SKILL, /appends the complete evidence\/review\/head\/verdict\/convergence\/count plus exact dispatch claim\/closure tuple to immutable `attempt_reviews`/i);
    assert.match(SCHEMA, /append-only `attempt_reviews`/i);
    assert.match(SCHEMA, /checked consumers re-hash historical sidecars before progress/i);
    assert.match(SKILL, /FEATURE_FACTORY_SLICE_DISPATCH/);
    assert.match(SKILL, /production plugin rejects a missing, malformed, stale, cross-role, or cross-slice marker/i);
    assert.match(SCHEMA, /plugin `tool\.execute\.before` hook/i);
    assert.match(SCHEMA, /same live session, role, slice, branch, (?:and )?worktree/i);
    for (const prompt of [BACKEND_BUILDER_PROMPT, FRONTEND_BUILDER_PROMPT]) assert.match(prompt, /Require exactly one plugin-owned `PLUGIN_CHECKED_SLICE_CONTEXT_START` or `PLUGIN_CHECKED_SPECIAL_BUILDER_CONTEXT_START` block/i);
    for (const text of [WORK_DECOMPOSER_PROMPT, WORK_REVIEWER_PROMPT, SKILL, SCHEMA]) {
      assert.doesNotMatch(text, /max_attempts.{0,80}(?:equal|=|of) 4/i);
      assert.doesNotMatch(text, /attempt 4 (?:is|may be) (?:allowed|eligible)/i);
    }
  });

  it("gives nonconvergent slice reviews one checked terminal carry-forward meaning", () => {
    assert.match(WORK_REVIEWER_PROMPT, /`nonconvergent` has one terminal meaning/i);
    assert.match(WORK_REVIEWER_PROMPT, /must not receive another autonomous builder attempt/i);
    assert.match(SKILL, /current REJECT marked `nonconvergent` never receives another autonomous attempt/i);
    assert.match(SKILL, /atomically terminalizes the run as `slice-review-nonconvergent`/i);
    assert.match(SKILL, /factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> --carry-forward --json/i);
    assert.match(SKILL, /Do not create the child automatically/i);
    assert.match(SCHEMA, /`source_review` equals the exact current latest append-only attempt entry/i);
    assert.match(SCHEMA, /alternate parent-referenced review/i);
    assert.match(SCHEMA, /carry-forward construction, publication, adoption, resume, and launch check/i);
  });

  it("gives the spec review an acceptance bar so it converges", () => {
    assert.match(WORK_REVIEWER_PROMPT, /Spec acceptance bar/i);
    assert.match(WORK_REVIEWER_PROMPT, /every in-scope sink carries a decided policy[\s\S]*maps to a test/i);
    assert.match(WORK_REVIEWER_PROMPT, /Reject only for a genuinely missing consequential decision, sink, policy, compatibility decision, security boundary, ownership assignment, or test — not for achievable depth or implementation mechanics/i);
    assert.match(SKILL, /Accept the brief once the inventory is finite[\s\S]*decided per-sink policy/i);
    assert.match(SKILL, /Builders own private helper signatures/i);
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

  it("requires consequential decisions while leaving implementation mechanics to builders", () => {
    assert.match(
      WORK_REVIEWER_PROMPT,
      /implementation residual is acceptable when the brief fixes externally observable behavior[\s\S]*Builders may choose private helper signatures, internal code organization, and mechanically equivalent representations/i,
      "work-reviewer must distinguish consequential decisions from implementation mechanics",
    );
    assert.match(
      SKILL,
      /The brief must decide externally observable behavior[\s\S]*Builders own private helper signatures, new private file\/module layout inside those lanes, mechanically equivalent representations/i,
      "SKILL must mirror the implementation-altitude boundary",
    );
  });

  it("lands every deferred mechanical completeness obligation in an owned build slice", () => {
    const stepTwo = markdownSection(SKILL, "Step 2 - Spec And Decomposition");

    assert.match(
      SPEC_WRITER_PROMPT,
      /Deferred mechanical completeness \(omit when none\) -> <declared dimensions> -> <executable schema or state model> \+ <table-driven or model-based test file\/command\/assertion>/i,
    );
    assert.match(SPEC_WRITER_PROMPT, /Record each deferred completeness obligation in the test plan so decomposition must assign it/i);
    assert.match(
      WORK_DECOMPOSER_PROMPT,
      /Every deferred mechanical completeness obligation in the brief maps to exactly one owning slice[\s\S]*declared dimensions[\s\S]*owned path lane for the builder-selected executable schema or state model[\s\S]*table-driven or model-based verification/i,
    );
    assert.match(WORK_DECOMPOSER_PROMPT, /Deferred mechanical completeness -> <brief obligation -> owning slice -> executable schema or state model -> table-driven or model-based test, or none>/i);
    assert.match(
      WORK_REVIEWER_PROMPT,
      /For build\/test subjects[\s\S]*When the brief defers a mechanical cross-product[\s\S]*observed evidence[\s\S]*executable schema or state model[\s\S]*cover every declared dimension/i,
    );
    assert.match(
      WORK_REVIEWER_PROMPT,
      /For decomposition, REJECT[\s\S]*deferred mechanical completeness obligation not assigned to exactly one slice with its declared dimensions, an owned lane for the builder-selected executable schema or state model, and a table-driven or model-based test plan/i,
    );
    assert.match(
      stepTwo,
      /assign every deferred mechanical completeness obligation to exactly one slice with its declared dimensions, an owned lane for the builder-selected executable schema or state model, and a table-driven or model-based test plan/i,
    );
    for (const text of [WORK_DECOMPOSER_PROMPT, WORK_REVIEWER_PROMPT, stepTwo]) {
      assert.match(text, /exact (?:schema\/model )?artifact path only when it is existing, public, generated, shared, contested, or source-fixed/i);
      assert.doesNotMatch(text, /executable schema or state model path/i);
    }
  });

  it("keeps a required late-discovered omission blocking without another autonomous retry", () => {
    // Precedence: a genuinely required sink/policy/compat/test omission is blocking regardless of
    // attempt number; the delta rule's NONBLOCKING carve-out is only for unrelated new scope or
    // optional depth — otherwise an attempt-2 discovery could be approved as nonblocking.
    assert.match(
      WORK_REVIEWER_PROMPT,
      /Precedence for late discoveries:[\s\S]*blocking regardless of attempt number[\s\S]*NONBLOCKING carve-out applies only to \*unrelated\* new scope or \*optional\* additional depth[\s\S]*never downgrades a required in-scope omission to optional/i,
      "work-reviewer must state that required omissions stay blocking regardless of attempt",
    );
    assert.match(WORK_REVIEWER_PROMPT, /newly introduced attempt-1-discoverable category[\s\S]*nonconvergent stop rule/i);
    assert.match(SKILL, /attempt-1-discoverable consequential category[\s\S]*stop autonomous spec retries/i);
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
      "**Verdict:** APPROVE | APPROVE-CHECKPOINT | REJECT",
      "**Checked against:** output-contract, technical-brief, observed-evidence, repo-guidelines",
      "**Claim vs observed:** consistent | MISMATCH - <details>",
      "**Findings:**",
      "- [BLOCKER] <what> - `path:line` - <why it fails> - fix_owner: <agent>",
      "- [MAJOR] <...>",
      "- [MINOR] <...>",
      "**Required fixes (if REJECT):**",
      "1. [classification: <closed classification>] [scope_effect: <in-lane | unowned-extension | sibling-owned | contract-change>] [likely_paths: <canonical concrete repository paths>] [fix_owner: <existing plan slice id>] <specific fix>",
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
    for (const decompositionFailure of ["orphan acceptance criteria", "cyclic dependencies", "same-wave path overlap", "un-serialized hotspots", "dependency path deeper than four waves"]) {
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
  it("requires ordinary child runs to enforce a four-wave maximum with depth secondary to width", () => {
    assert.match(WORK_DECOMPOSER_PROMPT, /longest dependency path admitted as one ordinary child run may span at most four waves; a root slice is wave 1/i);
    // The old "combine into one coherent slice rather than a fourth wave" collapse rule that
    // produced god-slices must be gone; a fourth wave is now allowed to keep width bounded.
    assert.doesNotMatch(WORK_DECOMPOSER_PROMPT, /combine tightly serialized work into one coherent slice instead of creating a fourth wave/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /use a fourth wave when it is needed to keep each slice within the width budget/i);
    assert.match(WORK_REVIEWER_PROMPT, /valid probe decision of `checkpoint` due to a dependency path deeper than four waves \(root is wave 1\)[\s\S]*valid checkpoint routing, not a rejection/i);
  });

  it("makes per-slice width the primary decomposition limit", () => {
    assert.match(WORK_DECOMPOSER_PROMPT, /Per-slice width budget \(primary constraint\)/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /one dominant hard concern/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /When "fewer slices" and the width budget conflict, the width budget wins/i);
    assert.match(WORK_REVIEWER_PROMPT, /overflows the per-slice width budget by bundling multiple independent hard concerns/i);
    assert.match(SKILL, /keep every slice within the per-slice width budget \(one dominant hard concern/i);
  });

  it("routes over-depth plans through the deterministic delivery-envelope checkpoint", () => {
    assert.match(WORK_DECOMPOSER_PROMPT, /Deterministic admission route/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /routes `checkpoint`[\s\S]*dependency graph exceeds four waves/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /Do not emit[\s\S]*`REDESIGN-REQUIRED` substitute/i);
    assert.match(WORK_REVIEWER_PROMPT, /do not make admission or checkpoint decisions/i);
  });

  it("defers implementation-grade artifacts out of the spec stage (altitude)", () => {
    assert.match(SPEC_WRITER_PROMPT, /Spec altitude — pin consequences, defer implementation mechanics/i);
    assert.match(WORK_REVIEWER_PROMPT, /Spec altitude — pin consequences, defer implementation mechanics/i);
    assert.match(WORK_REVIEWER_PROMPT, /exhaustive field-nullability, outcome\/code, state\/field, or crash-point cross-product matrices[\s\S]*executable schema or state model plus table-driven or model-based build tests/i);
    assert.match(SKILL, /Builders own private helper signatures[\s\S]*exhaustive field-nullability, outcome\/code, state\/field, and crash-point cross-product matrices[\s\S]*executable schema or state model plus table-driven or model-based build tests/i);
  });

  it("requires golden vectors to be independent, and pins story/protocol-required vectors", () => {
    // Guard against the two failure modes GPT-5.6 surfaced: circular self-generated fixtures,
    // and blanket-forbidding vectors an approved story or external protocol genuinely requires.
    for (const prompt of [SPEC_WRITER_PROMPT, WORK_REVIEWER_PROMPT]) {
      assert.match(prompt, /independently[- ]generated or source-cited/i, "vectors must be independent, not self-generated");
      assert.match(prompt, /never .*produced by the same serializer under test/i, "self-validated fixtures prove nothing");
      assert.match(prompt, /(?:approved )?story or (?:an )?external (?:wire )?protocol requires specific interop vectors/i, "required interop vectors are contract");
    }
    assert.match(WORK_REVIEWER_PROMPT, /REJECT a fixture that validates the serializer against a value the serializer itself produced/i);
  });

  it("scopes the class-wide sweep bar away from bounded new capabilities without dropping security sinks", () => {
    assert.match(WORK_REVIEWER_PROMPT, /Scope guard:\*\* a single bounded new capability does not become a sweep merely because its own contract uses universal quantifiers/i);
    assert.match(SKILL, /A class-wide sweep bar targets genuine repository-wide class changes, not a single bounded capability/i);
    // The scope guard must not exempt reachable security-sensitive sinks from spec coverage.
    assert.match(WORK_REVIEWER_PROMPT, /never exempts reachable authority, publication\/side-effect, or vulnerability-class sinks \*within\* the capability/i);
    assert.match(SKILL, /never exempts reachable authority, publication, or vulnerability-class sinks within the capability/i);
  });

  it("documents derived depth separately from concurrency", () => {
    for (const [name, text] of Object.entries({ SKILL, SCHEMA, README })) {
      assert.match(text, /root(?: slice)? is wave 1/i, `${name} must define root depth`);
      assert.match(text, /(?:at most|capped at|within) four waves/i, `${name} must document the depth cap`);
      assert.match(text, /max_parallel_slices[\s\S]{0,120}(?:concurrency|concurrently)[\s\S]{0,120}(?:does not|not)[\s\S]{0,80}(?:depth cap|cap)/i, `${name} must distinguish concurrency from depth`);
    }
  });

  it("branches checked admission while binding reviewed checkpoint authority before routing", () => {
    for (const [name, text] of [["SKILL", SKILL], ["command", COMMAND]]) {
      assert.match(text, /slices-probe[\s\S]*typed[^\n]*decision[^\n]*reasons[^\n]*plan_hash/i, `${name} must use the typed non-mutating probe`);
      assert.match(text, /work-decomposer[^\n]*explicit checkpoint plan[\s\S]*slices-probe[\s\S]*(?:dispatch )?`?work-reviewer`?/i, `${name} must probe explicit plan bytes before review`);
      assert.match(text, /(?:`admit`|For `admit`)[^\n]*seed[^\n]*(?:before|first)[^\n]*accept/i, `${name} must seed admit before acceptance`);
      assert.match(text, /APPROVE-CHECKPOINT[^\n]*dispositions/i, `${name} must require checkpoint dispositions`);
      assert.match(text, /(?:For `checkpoint`|A `checkpoint` decision)[^\n]*bind[^\n]*slices remain empty[^\n]*terminal[- ]boundary/i, `${name} must accept checkpoint before terminal routing`);
      assert.match(text, /terminal[- ]boundary[\s\S]*slices-seed[^\n]*(?:boundary-token|token-bound)|terminal[- ]boundary[^\n]*token-bound[^\n]*slices-seed/i, `${name} must route checkpoint through token-bound slices-seed`);
    }
  });

  it("documents encoded verification artifact refs without losing receipt subject identity", () => {
    for (const [name, text] of [["SCHEMA", SCHEMA], ["README", README]]) {
      assert.match(text, /SHA-256 base64url[\s\S]*(?:UTF-8|UTF8)[\s\S]*(?:slice|artifact)/i, `${name} must document canonical encoded refs`);
      assert.match(text, /(?:preserve|retain)[^\n]*(?:subject|original identity)/i, `${name} must retain semantic identity inside records`);
    }
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

describe("producer self-check contract", () => {
  it("gives both builders a pre-submit self-check mirroring the reviewer bar", () => {
    // Alignment, not accretion: surface the reviewer's build-slice bar to the
    // producer as a pre-return self-check (same pattern as the spec-writer
    // acceptance-bar alignment), so builders stop paying a guaranteed rejection
    // round. Each concept below is enforced by work-reviewer AND self-checked by
    // both builders — the pair must not drift apart.
    for (const [name, prompt] of [["backend", BACKEND_BUILDER_PROMPT], ["frontend", FRONTEND_BUILDER_PROMPT]]) {
      assert.match(prompt, /## Pre-submit self-check/i, `${name}-builder must carry the pre-submit self-check`);
      assert.match(prompt, /Imports resolve to real exports[\s\S]*do not invent a similar name or a guessed path/i, `${name}-builder must self-check import resolution`);
      assert.match(prompt, /No vaporware[\s\S]*TODO[\s\S]*STUB[\s\S]*stub bodies/i, `${name}-builder must self-check vaporware`);
      assert.match(prompt, /Mechanically complete[\s\S]*unused imports[\s\S]*unreachable\/dead code/i, `${name}-builder must self-check mechanical completeness`);
      assert.match(prompt, /Ownership disclosure[\s\S]*outside `slice\.ownership\.declared_paths`[\s\S]*nonempty, trimmed, NFC-normalized/i, `${name}-builder must self-check soft-lane disclosure`);
      assert.match(prompt, /Every AC is implemented and tested[\s\S]*exact-value assertion/i, `${name}-builder must self-check AC test coverage`);
      assert.match(prompt, /Verified, not masked[\s\S]*never worked around by weakening an assertion/i, `${name}-builder must self-check honest verification`);
    }
    // Reviewer still owns the enforcing bar these self-checks mirror.
    assert.match(WORK_REVIEWER_PROMPT, /out-of-lane edits outside slice `paths`/i, "work-reviewer must classify lane feasibility");
  });

  it("gives test-verifier a self-review with an exact-value assertion floor", () => {
    assert.match(TEST_VERIFIER_PROMPT, /## Self-review before reporting/i);
    assert.match(TEST_VERIFIER_PROMPT, /every acceptance criterion maps to at least one real assertion/i);
    assert.match(TEST_VERIFIER_PROMPT, /No presence-only checks \(`toBeTruthy`\/`toBeDefined`[\s\S]*test theater/i);
    assert.match(TEST_VERIFIER_PROMPT, /a real source bug is reported as a `fail`[\s\S]*never silenced/i);
    assert.match(TEST_VERIFIER_PROMPT, /Never weaken to pass[\s\S]*A `fail` is a valid, correct result/i);
  });
});

describe("test-verifier integration gate contract", () => {
  it("requires every authoritative argv entry with no prose or shell-command fallback", () => {
    for (const [name, text] of [["SKILL", SKILL], ["test-verifier", TEST_VERIFIER_PROMPT], ["work-decomposer", WORK_DECOMPOSER_PROMPT]]) {
      assert.match(text, /every ordered.*\{program,args\}.*(?:exactly|same order)|every.*\{program,args\}.*in order/is, `${name} must require every ordered entry`);
      assert.match(text, /no (?:singular )?canonical command|not (?:a )?singular canonical command/i, `${name} must reject singular-command fallback`);
      assert.match(text, /no.*(?:shell text|`cmd`)|never.*(?:shell text|`cmd`)/i, `${name} must reject shell-text cmd fallback`);
      assert.match(text, /human.*mirror.*all entr(?:y|ies)|all entr(?:y|ies).*human.*mirror/i, `${name} must mirror every JSON entry`);
      assert.match(text, /(?:execute|rerun|report).*every.*entry|every.*entry.*(?:execute|rerun|report)/i, `${name} must account for every entry`);
    }
  });

  it("documents the B1C structured required-command authority and compatibility boundary", () => {
    const contract = [README, SPEC, CONTINUATION_SCOPE_DESIGN, DURABLE_AUTHORITY_LEDGER, SCHEMA, SKILL, SPEC_WRITER_PROMPT, WORK_DECOMPOSER_PROMPT, TEST_VERIFIER_PROMPT].join("\n");
    assert.match(contract, /integration_gate\.required_commands/i);
    assert.match(contract, /1-32[\s\S]*structured[\s\S]*\{program,args\}/i);
    assert.match(contract, /program[\s\S]*trimmed[\s\S]*1-255 UTF-8 bytes[\s\S]*NUL\/control/i);
    assert.match(contract, /0-64[\s\S]*4096 UTF-8 bytes[\s\S]*without NUL/i);
    assert.match(contract, /(?:64 KiB|65,536 UTF-8 bytes)/i);
    assert.match(contract, /\{program:\"npm\",args:\[\"run\",\"check\"\]\}[\s\S]*(?:once|exactly once)[\s\S]*last/i);
    assert.match(contract, /structured argv[\s\S]*never shell text|never shell text[\s\S]*structured argv/i);
    assert.match(contract, /legacy v1[\s\S]*(?:readable|reads)[\s\S]*(?:omit|without)/i);
    assert.match(contract, /schema-v2[\s\S]*construction[\s\S]*publication[\s\S]*adoption[\s\S]*replay/i);
    assert.match(contract, /exact plan bytes(?:\/hash)?[\s\S]*(?:order|ordered)|plan_hash[\s\S]*exact bytes[\s\S]*order/i);
    assert.match(contract, /exact run-relative[\s\S]*plan\/slices\.json[\s\S]*(?:regular non-symlink|non-symlink)[\s\S]*(?:fatal UTF-8|fatally decodes UTF-8)/i);
    assert.match(contract, /work-decomposer[\s\S]*accepted[\s\S]*artifact_ref(?::|.*)\s*[`"]?plan\/slices\.json[\s\S]*review_ref[\s\S]*(?:artifact_hash|exact plan)[\s\S]*(?:review_hash|review bytes)/i);
    assert.match(contract, /after (?:observing|target).*target.*(?:absence|observation)[\s\S]*immediately before[\s\S]*(?:no-replace|no-overwrite|atomic).*move/i);
    assert.match(SCHEMA, /current canonical-source manifest has 196 variants[\s\S]*195 production-covered rows/i);
    assert.match(SCHEMA, /`plan-v2-integration-gate`/i);
    assert.match(SCHEMA, /`step-work-decomposer-accepted-plan`/i);
    assert.match(SCHEMA, /sole future row `final-plan-descriptor`/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /"integration_gate"[\s\S]*"required_commands"[\s\S]*"program": "npm"[\s\S]*"args": \["run", "check"\]/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /exact repository-relative file path[\s\S]*recursive directory lane ending in `\/\*\*`/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /trailing slash alone and every other glob form are invalid/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /"paths": \["src\/server\/api\/\*\*", "src\/server\/domain\/\*\*"\]/u);
    assert.doesNotMatch(WORK_DECOMPOSER_PROMPT, /"paths": \[[^\]]*"[^"\n]+\/"/u);
  });

  it("documents the active B4 delivery envelope, checked review ledger, and checkpoint child route", () => {
    const contract = [README, SPEC, DURABLE_AUTHORITY_LEDGER, SCHEMA, SPEC_WRITER_PROMPT].join("\n");
    const planSchema = markdownSection(SCHEMA, "plan/slices.json");
    const reviewSchema = SCHEMA;
    const schemaCatalog = markdownSection(SCHEMA, "Durable Authority Integrity Catalog");
    const planAuthorityRow = markdownTableRow(schemaCatalog, "Plan and slices graph");
    const reviewAuthorityRow = markdownTableRow(schemaCatalog, "Slices and review/evidence bindings");

    assert.match(planSchema, /every plan carrying `integration_gate` requires `delivery_envelope`/i);
    assert.match(planSchema, /schema version 1[\s\S]*exact plan-slice order[\s\S]*exactly one per slice/i);
    assert.match(planSchema, /lowercase kebab-case[\s\S]*globally unique/i);
    assert.match(planSchema, /obligations[\s\S]*one family[\s\S]*one artifact/i);
    assert.match(planSchema, /test_plan_index[\s\S]*test_plan_entry[\s\S]*exactly equals the indexed string/i);
    assert.match(reviewSchema, /every slice-review attempt for a delivery-envelope plan requires closed `invariant_family_ledger` schema v1/i);
    assert.match(reviewSchema, /family and artifact[\s\S]*paired by at least one obligation/i);
    assert.match(reviewSchema, /evidence refs[\s\S]*SHA-256[\s\S]*probe[\s\S]*reviewed_commit[\s\S]*unresolved findings/i);
    assert.match(reviewSchema, /outcome` is `pass`, `fail`, or `skipped`[\s\S]*APPROVE authority requires every current outcome to be `pass`/i);
    assert.match(contract, /multiple invariant families and at least six obligations[\s\S]*deeper than four waves/i);
    assert.match(contract, /factory artifact-execute <run-id> <slice-id> <artifact-id> --json/i);
    assert.match(contract, /run, slice, attempt[\s\S]*plan hash[\s\S]*HEAD[\s\S]*artifact ID[\s\S]*program\/argv[\s\S]*observed/i);
    assert.match(SCHEMA, /Admission decisions are `admit\|checkpoint`[\s\S]*review decisions are `approve\|reject`/i);
    assert.match(SCHEMA, /entries are contiguous and follow `reserved -> child-published -> launched -> merged`/i);
    assert.match(SCHEMA, /artifact-execute[\s\S]*before spawn[\s\S]*claim[\s\S]*receipt[_ ]hash/i);
    assert.match(SCHEMA, /ordinary normal run[\s\S]*immutable `checkpoint_source`/i);
    assert.match(contract, /do not (?:create|invent)[\s\S]*(?:second|another) run root|do not (?:create|invent)[\s\S]*(?:second|another) plan\/review hash chain/i);
    assert.equal(planAuthorityRow.entryIds.includes("plan-delivery-envelope-v1"), true, "Plan and slices graph row must register plan-delivery-envelope-v1");
    assert.equal(planAuthorityRow.entryIds.includes("review-invariant-family-ledger-v1"), false, "Plan and slices graph row must not absorb the review ledger");
    for (const id of [
      "checkpoint-reviewed-plan-v1", "checkpoint-admission-probe-valid", "checkpoint-child-disposition-v1",
      "checkpoint-child-publication-v1", "checkpoint-source-v1", "checkpoint-progress-reserved",
      "checkpoint-progress-child-published", "checkpoint-progress-launched", "checkpoint-progress-merged",
      "checkpoint-progress-closed", "checkpoint-merged-completion-v1", "checkpoint-final-closure-v1",
    ]) assert.equal(planAuthorityRow.entryIds.includes(id), true, `Plan and slices graph row must register ${id}`);
    assert.match(planAuthorityRow.decisionSurface, /reviewed checkpoint-plan identity[\s\S]*typed probe[\s\S]*creation-only publication[\s\S]*monotonic parent progress[\s\S]*content-addressed closure/i);
    assert.equal(reviewAuthorityRow.entryIds.includes("review-invariant-family-ledger-v1"), true, "Slices and review/evidence bindings row must register review-invariant-family-ledger-v1");
    assert.equal(reviewAuthorityRow.entryIds.includes("plan-delivery-envelope-v1"), false, "Slices and review/evidence bindings row must not absorb the plan envelope");
    assert.match(reviewAuthorityRow.decisionSurface, /delivery-unit\/family\/artifact mapping[\s\S]*evidence ref\/hash[\s\S]*typed probe\/result[\s\S]*reviewed commit[\s\S]*unresolved findings[\s\S]*typed review-extension decision/i);
    assert.equal(planAuthorityRow.entryIds.includes("checkpoint-routing-artifact-v1"), true, "Plan and slices graph row must register checkpoint-routing-artifact-v1");
    const terminalAuthorityRow = markdownTableRow(schemaCatalog, "Run envelope and terminal result");
    assert.equal(terminalAuthorityRow.entryIds.includes("terminal-result-blocked-checkpoint-routing"), true, "terminal row must register checkpoint routing result");
  });

  it("keeps repository-wide checks out of implementation slices", () => {
    assert.match(SPEC_WRITER_PROMPT, /Repository integration gate[\s\S]*test-verifier after all slices merge/i);
    assert.match(WORK_DECOMPOSER_PROMPT, /Do not assign the repository-wide full-suite\/build\/package command to any implementation slice[\s\S]*test-verifier integration gate/i);
    assert.match(WORK_REVIEWER_PROMPT, /REJECT[\s\S]*repository-wide full-suite\/build\/package command assigned to an implementation slice[\s\S]*test-verifier/i);
    assert.match(SKILL, /never make the final slice an accidental integration gate/i);
  });

  it("runs one bounded post-merge gate through durable test-verifier attempts", () => {
    assert.match(TEST_VERIFIER_PROMPT, /after every implementation slice is merged[\s\S]*ordered structured argv only from `plan\.integration_gate\.required_commands`/i);
    assert.match(TEST_VERIFIER_PROMPT, /red repository-wide command is a valid `fail` result[\s\S]*do not repair production code/i);
    assert.match(SKILL, /Verify every durable slice is `merged`[\s\S]*test-verifier running --attempts N[\s\S]*never exceeds `run\.json\.max_retries`/i);
    assert.match(SKILL, /evidence\/test-verifier\.attempt-N\.json[\s\S]*failed receipt[\s\S]*`rejected`[\s\S]*only pre-panel integration-remediation loop/i);
    assert.match(SKILL, /without creating a standalone integration-remediation review subject/i);
    assert.match(SCHEMA, /test-verifier.*post-merge integration gate[\s\S]*attempts <= run\.max_retries[\s\S]*Integration remediation has no separate free-form review subject/i);
    assert.match(COMMAND, /repository-wide check only through the bounded `test-verifier` integration gate[\s\S]*never leave the final slice running or create an uncounted integration-remediation loop/i);
  });

  it("documents the B1R checked claim, process, receipt, replay, fail-closed reconciliation, and consumer contract", () => {
    const contract = [README, SPEC, CONTINUATION_SCOPE_DESIGN, DURABLE_AUTHORITY_LEDGER, SCHEMA, SKILL, COMMAND, TEST_VERIFIER_PROMPT].join("\n");
    assert.match(contract, /factory test-execute <run-id> --json/i);
    assert.match(contract, /no (?:caller )?command[\s\S]*result[\s\S]*status[\s\S]*(?:receipt )?ref[\s\S]*attempt[\s\S]*cwd[\s\S]*environment/i);
    assert.match(contract, /nonce-bound[\s\S]*(?:active )?claim[\s\S]*before (?:any )?(?:spawn|process)/i);
    assert.match(contract, /shell:false[\s\S]*sequential[\s\S]*300[- ]second[\s\S]*(?:1 MiB|1-MiB)[\s\S]*SIGKILL[\s\S]*(?:ten|10)[- ]second/i);
    assert.match(contract, /GIT_TERMINAL_PROMPT=0[\s\S]*PATH.*required/i);
    assert.match(contract, /evidence\/test-verifier\.attempt-N\.json[\s\S]*create-only/i);
    assert.match(contract, /Raw output is never persisted or emitted|never persist(?:ing)? or return(?:ing)? raw output/i);
    for (const outcome of ["exited", "signaled", "timeout", "output-limit", "launch-error"]) assert.match(SCHEMA, literalPattern(outcome));
    for (const reason of ["process-outcome-indeterminate", "authority-changed", "receipt-publication-indeterminate"]) assert.match(SCHEMA, literalPattern(reason));
    assert.match(contract, /completed (?:pass\/fail|pass or fail|pass|failure)[\s\S]*(?:no-write\/no-process|no process.*no file|process-free\/write-free)/i);
    for (const doc of [README, SPEC, CONTINUATION_SCOPE_DESIGN, DURABLE_AUTHORITY_LEDGER, SCHEMA, SKILL, COMMAND]) {
      assert.match(doc, /out-of-band operator\/process reconciliation/i);
      assert.match(doc, /no (?:supported |autonomous )?(?:factory )?(?:command|path|reconciliation|recovery|retry|terminal)/i);
    }
    assert.match(contract, /factory recover[\s\S]*former `?test-execution-reconciliation`?[\s\S]*reject/i);
    assert.match(contract, /TEST_EXECUTION_ACTIVE[\s\S]*TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED/i);
    assert.match(contract, /clear[\s\S]*replace[\s\S]*terminaliz[\s\S]*retry[\s\S]*advance/i);
    assert.doesNotMatch(contract, /only `?factory recover[^\n]*test-execution-reconciliation/i);
    assert.match(contract, /completed passing[\s\S]*artifacts\/test-report\.md[\s\S]*independent[\s\S]*APPROVE[\s\S]*(?:same attempt|same-attempt)[\s\S]*(?:same HEAD|same-HEAD)/i);
    assert.match(SCHEMA, /current canonical-source manifest has 196 variants[\s\S]*terminal-result-blocked-nonconvergence[\s\S]*checked-dispatch authority/i);
  });
});

describe("interactive handoff durable schema docs", () => {
  it("keeps approval receipt fields and launch claim enums aligned with implementation", () => {
    const receipt = markdownSection(SCHEMA, "Interactive approval handoff receipt");
    for (const field of [
      "schema_version",
      "interactive-approval-handoff",
      "gate",
      "approval_fingerprint",
      "pending_snapshot_hash",
      "answer_hash",
      "steering_generation",
      "accepted_at",
    ]) {
      assert.match(receipt, literalPattern(field), `approval handoff receipt docs missing ${field}`);
    }
    assert.match(receipt, /preserved unchanged/i);
    assert.match(receipt, /fails closed/i);

    const claim = markdownSection(SCHEMA, "process-launch.lock/owner.json Launch Claim");
    for (const field of [
      "schema_version",
      "opencode-launch-claim",
      "run_id",
      "execution_id",
      "launch_kind",
      "phase",
      "pid",
      "hostname",
      "acquired_at",
      "identity",
      "inspector",
      "start_marker",
      "command_name",
      "cwd",
      "approval",
      "nonce",
    ]) {
      assert.match(claim, literalPattern(field), `launch claim docs missing ${field}`);
    }
    for (const value of [...LAUNCH_KINDS, ...LAUNCH_CLAIM_PHASES]) {
      assert.match(claim, literalPattern(value), `launch claim docs missing implementation enum ${value}`);
    }
    assert.match(claim, /exact nonce/i);
    assert.match(claim, /matching directory\/file identity/i);
    assert.match(claim, /preserve it and fail closed with manual ownership reconciliation/i);
    assert.match(SCHEMA, /process-launch\.lock\/[\s\S]*owner\.json/i);
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

  it("keeps protected gates heartbeat-free", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /Protected gates?[\s\S]*`story`[\s\S]*`brief`[\s\S]*`pre_pr`[\s\S]*(?:heartbeat-free|stay off|intentionally absent)/i, `${name} must keep protected gates heartbeat-free`);
      assert.match(text, /liveness-only[\s\S]*(?:not authority|not.*authority)|not authority[\s\S]*liveness-only/i, `${name} must keep heartbeat liveness-only and non-authoritative`);
    }
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
  it("pins the trusted-host threat boundary and fallible workflow inputs", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /local operator and host are trusted for integrity/i, `${name} must trust the local operator and host for integrity`);
      assert.match(text, /Model and subagent claims and stale evidence are untrusted/i, `${name} must distrust model claims and stale evidence`);
      assert.match(text, /reject stale or mismatched evidence/i, `${name} must reject stale or mismatched evidence`);
      assert.match(text, /Crashes and concurrent retries are fallible operating conditions/i, `${name} must treat crashes and concurrent retries as fallible`);
      assert.match(text, /Operator text shown to a model is still data rather than privileged instructions/i, `${name} must separate trusted operator integrity from prompt authority`);
    }
  });

  it("denies hostile-local protection claims and scopes internal checks to local consistency", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /no protection claim against arbitrary modification of the local filesystem/i, `${name} must deny arbitrary local-filesystem protection`);
      assert.match(text, /Git history[\s\S]*factory code[\s\S]*test commands[\s\S]*reviewer\/verifier implementations/i, `${name} must enumerate the hostile-local limit`);
      assert.match(text, /outside the threat model[\s\S]*rewrite both state and the checks that read it/i, `${name} must explain why hostile-local modification is out of scope`);
      assert.match(text, /local consistency and provenance checks, not cryptographic authentication or generic forgery resistance/i, `${name} must scope internal durable checks`);
      assert.match(text, /trusted local substrate remains intact/i, `${name} must condition local checks on the trusted substrate`);
    }
  });

  it("retains exact provenance and idempotent external-effect controls inside the boundary", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /exact Git\/test\/review\/merge provenance/i, `${name} must retain the four provenance classes`);
      assert.match(text, /full Git SHAs[\s\S]*locally observed diffs, trees, and ancestry/i, `${name} must retain exact Git provenance`);
      assert.match(text, /exact test commands, results, attempts, and heads/i, `${name} must retain exact test provenance`);
      assert.match(text, /review subjects, attempts, refs, hashes, and exact reviewed commits/i, `${name} must retain exact review provenance`);
      assert.match(text, /merge commits plus their reviewed-tree relation/i, `${name} must retain exact merge provenance`);
      assert.match(text, /idempotent external-effect controls/i, `${name} must retain idempotent external-effect controls`);
      assert.match(text, /unknown crash outcomes are re-observed before retry/i, `${name} must re-observe unknown external effects`);
      assert.match(text, /after a PR exists[\s\S]*record that existing PR; do not create another/i, `${name} must not duplicate PR creation after a crash`);
    }
  });

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

  it("continues an unaccepted draft without carrying acceptance or resetting retries", () => {
    for (const [name, text] of documentEntries({ SKILL, COMMAND, SCHEMA, README })) {
      assert.match(text, /draft_spec_reuse/i, `${name} must document draft spec reuse`);
      assert.match(text, /hash-bound|artifact_hash/i, `${name} must bind draft bytes`);
      assert.match(text, /max_retries/i, `${name} must inherit the retry ceiling`);
      assert.match(text, /fresh (?:normal )?spec review|fresh review/i, `${name} must require a fresh review`);
      assert.match(text, /(?:no|never|without)[\s\S]*(?:acceptance|adopt)/i, `${name} must not carry draft acceptance`);
      assert.match(text, /exhausted[\s\S]*(?:reject|fail)[\s\S]*(?:reset|retry)|(?:reject|fail)[\s\S]*exhausted[\s\S]*(?:reset|retry)/i, `${name} must reject exhausted draft budgets`);
    }
    assert.match(SKILL, /parent_step_attempts \+ 1/i);
    assert.match(SKILL, /spec-writer rejected --attempts N --artifact-ref artifacts\/technical-brief\.md --review-ref reviews\/spec-writer\.attempt-N\.json/i);
    assert.match(SKILL, /spec-writer blocked --attempts N --artifact-ref artifacts\/technical-brief\.md --review-ref reviews\/spec-writer\.attempt-N\.json/i);
    assert.match(SCHEMA, /draft_spec_reuse requires this durable `artifact_ref`|`draft_spec_reuse` requires this durable `artifact_ref`/i);
    assert.match(SCHEMA, /parent_step_attempts/i);
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

});

describe("implemented v2 reviewed carry-forward docs contract", () => {
  const futureDocs = Object.freeze({ CONTINUATION_SCOPE_DESIGN, README, SCHEMA, SPEC, SKILL, COMMAND });
  const design = CONTINUATION_SCOPE_DESIGN;
  const futureSchema = markdownSection(SCHEMA, "Implemented continuation schema v2 (explicit pre-PR carry-forward)");

  it("records A(a)/D as implemented while preserving readable v1 and post-PR behavior", () => {
    for (const [name, text] of documentEntries(futureDocs)) {
      assert.match(text, /schema v2|schema-v2|continuation\.schema_version.*2|schema_version: 2|`schema_version` is 2/i, `${name} must document v2`);
      assert.match(text, /explicit[\s\S]*--carry-forward|--carry-forward[\s\S]*explicit/i, `${name} must require the explicit selector`);
      assert.match(text, /unflagged[\s\S]*schema v1|schema v1[\s\S]*unflagged|schema-v1[\s\S]*unflagged/i, `${name} must preserve unflagged v1`);
      assert.match(text, /post-PR[\s\S]*v1[\s\S]*unchanged|v1 post-PR continuation[^.]*unchanged/i, `${name} must preserve post-PR v1`);
    }
    assert.match(design, /Status — implemented v2 reviewed carry-forward/i);
    assert.doesNotMatch(design, /Decision needed|open decision/i);
    assert.match(futureSchema, /B1C registers its `plan-v2-integration-gate` and accepted work-decomposer plan\/review dependency/i);
    assert.match(futureSchema, /remaining carry-forward publication records stay outside these rows/i);
  });

  it("closes carry_forward and classifies every plan slice exactly once in plan order", () => {
    for (const text of [design, futureSchema]) {
      assert.match(text, /closed to exactly `scope`, `plan_ref`, `plan_hash`, `start_commit`, `accepted_slices`, and `remaining_slice_ids`/i);
      assert.match(text, /`scope` is exactly `full-remaining-plan`|`scope: "full-remaining-plan"`/i);
      assert.match(text, /closed to exactly `id`, `declared_paths`, `effective_paths`, `attempts`, (?:exact )?`attempt_reviews`, `evidence_ref`, `evidence_hash`, `review_ref`, `review_hash`, `reviewed_commit`, and `merge_commit`/i);
      assert.match(text, /ownership arrays[^.]*exact immutable parent values/i);
      assert.match(text, /`accepted_slices` contains every parent slice whose status is exactly `merged`, in PLAN order/i);
      assert.match(text, /`remaining_slice_ids` contains every nonmerged slice ID, in PLAN order/i);
      assert.match(text, /unique[\s\S]*disjoint[\s\S]*set union[\s\S]*exactly[\s\S]*(?:complete `slices\[\]\.id` set|full plan)/i);
      assert.match(text, /remaining[\s\S]*inherit[^.]*no|Remaining rows inherit only[\s\S]*never status/i);
      assert.doesNotMatch(text, /accepted (?:is|slices are)[^.]*exact prefix|remaining[^.]*non-empty suffix/i);
    }
  });

  it("permits non-prefix accepted slices and out-of-plan-order integration merges", () => {
    for (const text of [design, futureSchema, README]) {
      assert.match(text, /`accepted_slices` contains every parent slice whose status is exactly `merged`, in PLAN order/i);
      assert.match(text, /`remaining_slice_ids` contains every nonmerged slice ID, in PLAN order/i);
      assert.match(text, /PLAN order `\[A, B, C\]`[\s\S]*merged `A` and `C`[\s\S]*`accepted_slices: \[A, C\]`[\s\S]*`remaining_slice_ids: \[B\]`[\s\S]*valid/i);
      assert.match(text, /actual integration merge order may differ from PLAN and dependency-execution order/i);
      assert.match(text, /does not require `accepted_slices` order to equal first-parent chain order/i);
      assert.match(text, /`accepted_slices: \[A, C\]`[\s\S]*first-parent chain `\[C, A\]`[\s\S]*valid/i);
      assert.doesNotMatch(text, /first-parent chain in PLAN order|accepted merge commits[^.]*in PLAN order/i);
    }
  });

  it("limits v2 to pre-PR blocked parents and proves the exact accepted integration chain", () => {
    for (const text of [design, futureSchema]) {
      assert.match(text, /pre-PR[\s\S]*status is exactly `blocked`/i);
      assert.match(text, /no PR[\s\S]*no active post-PR/i);
      assert.match(text, /complete B0MR successor tuple|complete unchanged B0MR/i);
      assert.match(text, /first-parent range from `target\.base_commit` exclusive through `start_commit` inclusive/i);
      assert.match(text, /exactly once[\s\S]*set of `accepted_slices\[\]\.merge_commit` values/i);
      assert.match(text, /no extra commit/i);
      assert.match(text, /chain length equals `accepted_slices\.length`|length exactly `accepted_slices\.length`/i);
      assert.match(text, /each first-parent commit|Every first-parent commit/i);
      assert.match(text, /`start_commit` is (?:the )?parent branch HEAD[\s\S]*last actual merge[\s\S]*`target\.base_commit` when `accepted_slices` is empty/i);
      assert.match(text, /parent panel[\s\S]*optional[\s\S]*`reviewed_head_sha`[\s\S]*`start_commit`|optional parent[\s\S]*`reviewed_head_sha`[\s\S]*`start_commit`/i);
      assert.match(text, /never inherited[\s\S]*fresh (?:validator\/security |final )?panel/i);
    }
  });

  it("defines the four ordered origin-base outcomes and all three recheck boundaries", () => {
    for (const text of [design, futureSchema]) {
      assert.match(text, orderedPattern(["unchanged", "contains start", "moved", "unavailable"]));
      assert.match(text, /contains start[\s\S]*rebaseline-required/i);
      assert.match(text, /moved[\s\S]*stale-parent-base-moved/i);
      assert.match(text, /unavailable[\s\S]*fail/i);
      assert.match(text, /candidate build[\s\S]*(?:resource )?publication[\s\S]*(?:semantic )?adoption\/activation[\s\S]*(?:re-read and )?recheck|candidate build[\s\S]*B1\.3 allocation[\s\S]*staging[\s\S]*commit boundary/i);
    }
  });

  it("defines closed deterministic parent identity and claim blob bytes", () => {
    for (const text of [design, futureSchema]) {
      assert.match(text, /parent identity is closed to exactly `schema_version`, `kind`, `parent_run_id`, `parent_run_ref`, `parent_run_hash`, `parent_branch_ref`, `target_base_ref`, `target_base_commit`, `plan_ref`, `plan_hash`, and `start_commit`/i);
      assert.match(text, /recursively[\s\S]*lexicographic[\s\S]*canonical UTF-8 JSON[\s\S]*no (?:insignificant )?whitespace[\s\S]*no trailing newline/i);
      assert.match(text, /literal claim ref is|claim ref is literally/i);
      assert.match(text, /refs\/opencode\/continuations\/<64hex>/i);
      assert.match(text, /64-character lowercase[\s\S]*SHA-256/i);
      assert.match(text, /claim[\s\S]{0,100}blob/i);
      assert.match(text, /closed to exactly `schema_version`, `kind`, `parent_identity`, `child_run_id`, `child_branch_ref`, and `start_commit`/i);
      assert.match(text, /no self data[\s\S]*no (?:`)?claim_ref|no self data[\s\S]*no claim ref/i);
    }
  });

  it("requires one zero-old transaction, exact replay, post-transaction worktree, and monotonic tombstone recovery", () => {
    for (const text of [design, futureSchema]) {
      assert.match(text, /one atomic[\s\S]*`?git update-ref --stdin`? transaction/i);
      assert.match(text, /claim ref[\s\S]*child_branch_ref|claim ref[\s\S]*child branch/i);
      assert.match(text, /both|each[\s\S]*all-zero old OID|zero old OIDs/i);
      assert.match(text, /Only (?:an )?exact replay/i);
      assert.match(text, /worktree[\s\S]*(?:after|follows only)/i);
      assert.match(text, /crash before[\s\S]*neither ref[\s\S]*crash after[\s\S]*both/i);
      assert.match(text, /half-state[\s\S]*(?:conflict|fails closed)/i);
      assert.match(text, /different child|different children/i);
      assert.match(text, /permanent tombstone/i);
      assert.match(text, /same-child recovery[\s\S]*exact replay|exact same-child[\s\S]*recovery/i);
    }
  });

  it("documents atomic publication, closed child state, activation, payload, and replay", () => {
    const ownership = markdownSection(design, "Atomic semantic publication and activation");
    for (const text of [ownership, futureSchema, README, SPEC]) {
      assert.match(text, /staging|staged/i);
      assert.match(text, /outside (?:factory )?run discovery|outside run discovery/i);
      assert.match(text, /no-overwrite[\s\S]*atomic directory rename|atomic[\s\S]*no-overwrite[\s\S]*directory/i);
      assert.match(text, /accepted[\s\S]*immutable|immutable[\s\S]*accepted/i);
      assert.match(text, /dependency-ready|dependencies are merged/i);
      assert.match(text, /fresh[\s\S]*test-verifier[\s\S]*validator[\s\S]*security[\s\S]*(?:whole-story|pre-PR)/i);
    }
    assert.match(ownership, /Before rename[\s\S]*no v2 payload, skill seed, or launch/i);
    assert.match(ownership, /root[\s\S]*schema_version: 1[\s\S]*continuation[\s\S]*schema_version[\s\S]*2/i);
    assert.match(ownership, /candidate, claim, branch, worktree, or caller payload alone is never authority/i);
    assert.match(ownership, /Replay preserves progressed[\s\S]*Terminal replay[\s\S]*without launching/i);
    assert.match(ownership, /mode[\s\S]*account[\s\S]*PR mode[\s\S]*post-PR policy[\s\S]*limits and retries[\s\S]*no review tier/i);
    assert.match(futureSchema, /continuation\.configuration[\s\S]*mode[\s\S]*github_account[\s\S]*pr_mode[\s\S]*max_parallel_slices[\s\S]*max_retries[\s\S]*post_pr_policy/i);
    assert.match(futureSchema, /"agent": "test-verifier", "status": "blocked", "attempts": 0/i);
    assert.match(SCHEMA, /artifact_ref[\s\S]*artifact_hash[\s\S]*evidence_ref[\s\S]*evidence_hash[\s\S]*review_ref[\s\S]*review_hash[\s\S]*reviewed_head_sha/i);
    assert.match(SCHEMA, /cannot transition directly to accepted[\s\S]*running[\s\S]*same positive attempt/i);
    assert.match(SKILL, /passing receipt leaves the step `running`[\s\S]*artifacts\/test-report\.md[\s\S]*fresh independent `work-reviewer`[\s\S]*reviewed_head_sha/i);
    assert.match(SKILL, /schema_version: 2[\s\S]*jump to Step 4's normal dependency-ready remaining work/i);
  });
});

describe("blocked-work restart pattern docs contract", () => {
  const restartPatterns = markdownSection(README, "Choosing continuation, rebaseline, or recovery");

  it("distinguishes continuation by its still-valid bounded review authority", () => {
    assert.match(restartPatterns, /Continuation run[\s\S]*parent is still based on an acceptable target[\s\S]*validated review's `required_fixes`/i);
    assert.match(restartPatterns, literalPattern(BLOCKED_CONTINUE_COMMAND));
    assert.match(restartPatterns, /continuation decomposition covers `continuation\.review\.required_fixes`[\s\S]*not every concern/i);
  });

  it("documents current-main rebaseline as a fresh run with read-only old evidence", () => {
    assert.match(restartPatterns, /Rebaseline run[\s\S]*parent base or implementation branch is stale[\s\S]*current `main` contains authoritative behavior/i);
    assert.match(restartPatterns, /factory start --autonomous --run-id <rebaseline-run-id>/i);
    assert.match(restartPatterns, /read-only references[\s\S]*never merge or cherry-pick the stale branch wholesale/i);
    assert.match(restartPatterns, /fresh gates, decomposition, observed evidence, tests, validator\/security verdicts, and PR state/i);
  });

  it("documents scope-expanding recovery without confusing state recovery commands", () => {
    assert.match(restartPatterns, /Recovery run[\s\S]*multiple findings[\s\S]*scope\/ownership amendment[\s\S]*foundation change forbidden by the old brief/i);
    assert.match(restartPatterns, /factory start --autonomous --run-id <recovery-run-id>/i);
    assert.match(restartPatterns, /names every unresolved finding|every unresolved validator and security finding/i);
    assert.match(restartPatterns, /`factory recover <run-id>` handles an orphaned or stale run-state heartbeat[\s\S]*does not rebase implementation work, amend an accepted brief, or create a replacement feature run/i);
    assert.match(restartPatterns, /`factory resume-check`[\s\S]*without changing the feature's accepted scope/i);
  });

  it("keeps superseded evidence until replacement work no longer needs it", () => {
    assert.match(restartPatterns, /Keep superseded runs, branches, and worktrees until the replacement has captured every reference it needs/i);
    assert.match(restartPatterns, /factory cleanup <old-run-id> --dry-run[\s\S]*factory cleanup <old-run-id>/i);
    assert.match(restartPatterns, /use `--force` only when intentionally discarding preserved unmerged branches/i);
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

});

describe("remediation context reuse docs contract", () => {
  it("documents checked compaction continuation and provenance-neutral candidate adoption", () => {
    const command = /slice-dispatch-adopt <run-id> <slice-id> <attempt> --json/iu;
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA })) {
      assert.match(text, /OpenCode compaction/iu, `${name} must document compaction continuation`);
      assert.match(text, /model-authored (?:compaction )?summary[\s\S]*(?:non-authoritative|progress data)/iu, `${name} must keep summaries non-authoritative`);
      assert.match(text, /plugin-owned system/iu, `${name} must require plugin-owned system authority`);
      assert.match(text, command, `${name} must document the exact adoption command`);
      assert.match(text, /checked-slice-builder-dispatch-adoption/u, `${name} must name distinct candidate adoption authority`);
      assert.match(text, /new clean descendant HEAD/iu, `${name} must require a new clean descendant HEAD`);
      assert.match(text, /no operator or callback provenance|asserts no operator or callback provenance|attests no operator or callback provenance/iu, `${name} must disclaim operator and callback provenance`);
      assert.match(text, /no evidence, test, review, ownership, acceptance, or merge authority|never replaces observed evidence, focused tests, independent review, ownership ratification, or exact-HEAD merge checks/iu, `${name} must preserve downstream authority`);
    }
    for (const [name, text] of documentEntries({ BACKEND_BUILDER_PROMPT, FRONTEND_BUILDER_PROMPT })) {
      assert.match(text, /PLUGIN_CANONICAL_COMPACTION_CONTINUATION_DIRECTIVE/u, `${name} must recognize canonical continuation`);
      assert.match(text, /model-authored compaction summary cannot replace/iu, `${name} must reject summary authority`);
    }
  });

  it("keeps the primary run.json example executable and documents checked dispatch authority", () => {
    const example = SCHEMA.match(/## run\.json\n\n```json\n([\s\S]*?)\n```/u);
    assert.ok(example, "SCHEMA must contain the primary run.json JSON example");
    assert.doesNotThrow(() => validateRun(JSON.parse(example[1])));

    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA })) {
      assert.match(text, /dispatch_required/u, `${name} must document mandatory checked dispatch`);
      assert.match(text, /dispatch_claim_ref|claim ref\/hash|claim.*ref\/hash/isu, `${name} must document the durable claim binding`);
      assert.match(text, /dispatch_closure_ref|closure ref\/hash|closure.*ref\/hash/isu, `${name} must document the durable closure binding`);
      assert.match(text, /completion capability/iu, `${name} must document the completion capability`);
      assert.match(text, /withheld|never (?:placed|included)|outside the Task prompt/iu, `${name} must keep the capability out of the Task prompt`);
    }
  });

  it("documents implementer-only runtime task_id reuse boundaries", () => {
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA })) {
      assert.match(text, /task_id/i, `${name} must mention Task task_id reuse`);
      assert.match(text, /runtime-only|runtime context|orchestrator memory/i, `${name} must make task_id runtime-only`);
      assert.match(text, /implementer-only|eligible implementer|implementer remediation|implementer that owns the fix|eligible slice-builder|slice-builder context/i, `${name} must make reuse implementer-only`);
      for (const implementer of ["backend-builder", "frontend-builder"]) {
        assert.match(text, literalPattern(implementer), `${name} must name eligible implementer ${implementer}`);
      }
      assert.match(text, /same (?:eligible )?(?:implementer|slice-builder) role|role is the same eligible (?:implementer|slice builder)|same role|same role, subject\/slice\/test owner/i, `${name} must require the same role`);
      assert.match(text, /subject\/slice\/test owner|same owned remediation subject|same subject|same slice id|same slice|subject ownership is unchanged/i, `${name} must require the same subject/slice/test owner`);
      assert.match(text, /same[^.\n]*worktree|worktree[^.\n]*unchanged/i, `${name} must require the same worktree`);
      assert.match(text, /same[^.\n]*branch|branch[^.\n]*unchanged/i, `${name} must require the same branch`);
      assert.match(text, /same live orchestrator session|live orchestrator session is unchanged|same[^.\n]*orchestrator session/i, `${name} must require the same live orchestrator session`);
      assert.match(text, /same[^.\n]*bounded remediation loop|bounded remediation loop[^.\n]*(?:unchanged|only)|current bounded remediation loop/i, `${name} must require the same bounded remediation loop`);
    }

    assert.match(COMMAND, /bounded remediation loop/i, "COMMAND must route NO-GO through bounded remediation");
    assert.match(COMMAND, /`backend-builder` or `frontend-builder` context/i, "COMMAND must limit reuse to checked slice-builder context");
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

  it("forces fresh implementer context for every non-narrow classified fix", () => {
    for (const classification of ["architecture-replacement", "ownership-amendment", "parallel-authority-removal", "schema-redesign", "migration-redesign", "wholesale-head-replacement", "nonconvergent", "narrow-correction"]) {
      assert.match(WORK_REVIEWER_PROMPT, literalPattern(classification), `work-reviewer must emit ${classification}`);
    }
    assert.match(WORK_REVIEWER_PROMPT, /schema_version: 2[\s\S]*exactly one ordered `\{required_fix_index, classification, scope_effect, likely_paths, fix_owner\}` entry for every `required_fixes` item/i);
    for (const scopeEffect of ["in-lane", "unowned-extension", "sibling-owned", "contract-change"]) {
      assert.match(WORK_REVIEWER_PROMPT, literalPattern(`\`${scopeEffect}\``), `work-reviewer must emit ${scopeEffect}`);
    }
    assert.match(WORK_REVIEWER_PROMPT, /`likely_paths` is a nonempty unique list of canonical concrete repository paths[\s\S]*without globs/i);
    assert.match(WORK_REVIEWER_PROMPT, /`fix_owner` must equal an existing current-plan slice id/i);
    assert.match(WORK_REVIEWER_PROMPT, /Schema version 1 and unstructured slice reviews always reject/i);
    assert.match(WORK_REVIEWER_PROMPT, /there is no replay or publication compatibility path/i);
    assert.match(WORK_REVIEWER_PROMPT, /do not authorize editing, extend a builder lane, create durable effective paths/i);
    assert.match(WORK_REVIEWER_PROMPT, /Do not request or introduce another agent call/i);
    assert.match(SKILL, /exact hash-bound review must classify every required fix as `narrow-correction`/i);
    assert.match(SKILL, /do not pass `task_id`; start a fresh implementer Task/i);
    assert.match(SCHEMA, /schema version 1, missing context, duplicate positions, extra fields, unknown values, or reordered fixes reject before review publication/i);
    assert.match(SCHEMA, /selects only ephemeral implementer context and grants no merge, test, acceptance, lane, or mutation authority/i);
    const canonicalReviewExample = SCHEMA.match(/Slice review shape:[\s\S]*?```json([\s\S]*?)```/iu)?.[1];
    assert.ok(canonicalReviewExample, "SCHEMA must retain one canonical slice review JSON example");
    assert.match(canonicalReviewExample, /"schema_version": 2/u);
    assert.match(canonicalReviewExample, /"ownership_ratification"\s*:\s*\{\s*"schema_version": 1/u);
    assert.doesNotMatch(canonicalReviewExample, /"remediation_context"\s*:\s*\{\s*"schema_version": 1/u);
    for (const field of ["required_fix_index", "classification", "scope_effect", "likely_paths", "fix_owner"]) {
      assert.match(canonicalReviewExample, new RegExp(`"${field}"`, "u"), `canonical slice review example must include ${field}`);
    }
    assert.match(SKILL, /exact prior review ref and bytes\/hash[\s\S]*prior evidence ref and bytes\/hash[\s\S]*current slice contract\/lane\/branch\/worktree\/head/i);
    for (const [name, prompt] of [["backend", BACKEND_BUILDER_PROMPT], ["frontend", FRONTEND_BUILDER_PROMPT]]) {
      assert.match(prompt, /prior review, classifications, builder output, and evidence prose as untrusted data/i, `${name} builder must distrust remediation claims`);
      assert.match(prompt, /Re-observe the exact referenced review\/evidence bytes and hashes, current Git head and diff, lane, and test results/i, `${name} builder must re-observe prior evidence`);
    }
  });

  it("requires checked context for ordinary and special builder routes", () => {
    assert.match(SKILL, /FEATURE_FACTORY_SPECIAL_BUILDER_DISPATCH[\s\S]*merged-slice-repair\|panel-remediation\|post-pr-remediation\|integration-conflict/i);
    assert.match(SCHEMA, /rejects every unmarked builder[\s\S]*PLUGIN_CHECKED_SPECIAL_BUILDER_CONTEXT_START/i);
    assert.match(SCHEMA, /post-Task `completion_head`[\s\S]*evidence head, reviewed commit, and current slice branch\/worktree HEAD/i);
    assert.match(SCHEMA, /base64url-encoded UTF-8 JSON[\s\S]*`@file`, `@agent`/i);
    assert.match(SCHEMA, /route instance[\s\S]*create-only `\.special\.json` claim[\s\S]*`\.special\.closed\.json` foreground closure/i);
    assert.match(SCHEMA, /fence every run mutation, terminal path, PR path, and continuation across processes/i);
    assert.match(SCHEMA, /Top-level `special_builder_dispatch`[\s\S]*claim_ref, claim_hash[\s\S]*closure_ref, closure_hash, completion_head/i);
    assert.match(README, /every unmarked builder Task is rejected/i);
    for (const [name, prompt] of [["backend", BACKEND_BUILDER_PROMPT], ["frontend", FRONTEND_BUILDER_PROMPT]]) {
      assert.match(prompt, /exactly one plugin-owned `PLUGIN_CHECKED_SLICE_CONTEXT_START` or `PLUGIN_CHECKED_SPECIAL_BUILDER_CONTEXT_START`/i, `${name} builder must require one checked route context`);
      assert.match(prompt, /merged-slice-repair, panel-remediation, post-pr-remediation, or integration-conflict route/i, `${name} builder must accept checked special remediation and conflict delegation`);
    }
  });

  it("documents soft-lane disclosure, hard routing, and delegated integrated acceptance", () => {
    for (const text of [SKILL, SCHEMA]) {
      assert.match(text, /ownership_disclosure[\s\S]*path[\s\S]*rationale/i);
      assert.match(text, /APPROVE[\s\S]*ratification[\s\S]*exactly equal/i);
      assert.match(text, /REJECT[\s\S]*ratification is empty/i);
      assert.match(text, /pending\/running\/review sibling|pending\/running\/review siblings/i);
      assert.match(text, /contract-change[\s\S]*plan\/brief amendment/i);
      assert.match(text, /orchestrator[\s\S]*never edit|orchestrator[\s\S]*never edits/i);
      assert.match(text, /fresh checked test-verifier[\s\S]*independent (?:approving )?review[\s\S]*holistic panels/i);
      assert.match(text, /newly added private regular[\s\S]*privileged\/control-plane/i);
      assert.match(text, /workflow[\s\S]*CI[\s\S]*(?:agent\/skill\/command|assets\/agent[\s\S]*assets\/skills[\s\S]*assets\/command)[\s\S]*dependency[\s\S]*migration[\s\S]*generated/i);
      assert.match(text, /unique merge base[\s\S]*both parent diffs[\s\S]*rename\/copy/i);
      assert.match(text, /merged slice(?:'s)?[\s\S]*(?:append-only|own|integration_conflict)[\s\S]*(?:conflict|authority)/i);
      assert.match(text, /carry-forward[\s\S]*copies[\s\S]*proof[\s\S]*sidecars/i);
    }
    assert.match(SCHEMA, /exact integration baseline[\s\S]*current feature HEAD[\s\S]*MERGE_HEAD[\s\S]*effective owner/i);
    assert.match(SKILL, /privileged\/control-plane policy rejects undeclared[\s\S]*Symlink, delete, ambiguous, and non-textual conflicts never dispatch/i);
  });

});

  describe("delegated generic integration amendment docs contract", () => {
  it("keeps orchestration ordered and excludes caller process or Git authority", () => {
    assert.match(SKILL, /### Generic Integration Amendment/u);
    for (const fragment of [
      /factory amendment <run-id> report --owner-slice <owner> --consumer-slice <consumer> --defect-path <path> --artifact-id <consumer-artifact>/u,
      /create-publishes the fixed claim before spawn/u,
      /FEATURE_FACTORY_SPECIAL_BUILDER_DISPATCH \{"run_id":"<run-id>","route":"integration-amendment","agent":"<owner-stack>-builder"\}/u,
      /fresh `work-reviewer` with no `task_id`/u,
      /FEATURE_FACTORY_INTEGRATION_AMENDMENT_REVIEW \{"run_id":"<run-id>","amendment_id":"<amendment-id>","attempt":<N>,"agent":"work-reviewer"\}/u,
      /factory amendment <run-id> integrate/u,
      /factory amendment <run-id> verify/u,
      /Do not automatically run `merge`/u,
    ]) assert.match(SKILL, fragment);
    assert.match(SKILL, /Do not run the command yourself or supply command text, result, ref, hash, HEAD, cwd, worktree, or outcome/u);
    assert.match(SKILL, /orchestrator must not edit, stage, commit, switch, or repair/u);
    assert.match(SKILL, /checked immutable reviewer claim\/closure is the narrowly scoped nonsemantic amendment-review provenance path/u);
    assert.match(SCHEMA, /complete all-slice ownership snapshot[\s\S]*same-session\/same-call\/same-agent callback[\s\S]*never replaces bytes/u);
    assert.match(SCHEMA, /exact 48[\s\S]*reviewer-dispatch variants/u);
    assert.match(SCHEMA, /active-claim-only[\s\S]*review-published-without-closure[\s\S]*closed-unconsumed[\s\S]*consumed/u);
  });

    it("confines builders and requires an exact fresh seven-disposition review", () => {
    for (const prompt of [BACKEND_BUILDER_PROMPT, FRONTEND_BUILDER_PROMPT]) {
      assert.match(prompt, /For `integration-amendment`/u);
      assert.match(prompt, /authority\.path_policy\.effective_paths/u);
      assert.match(prompt, /Do not expand ownership, edit the pending consumer, or alter factory control-plane files/u);
      assert.match(prompt, /Do not invoke Task or delegate recursively/u);
      assert.match(prompt, /new clean descendant commit/u);
    }
    assert.match(WORK_REVIEWER_PROMPT, /subject `integration-amendment:<amendment-id>`/u);
    assert.match(WORK_REVIEWER_PROMPT, /independently run `git rev-parse HEAD`/u);
    assert.match(WORK_REVIEWER_PROMPT, /derive the baseline-to-candidate paths with rename detection disabled/u);
    assert.match(WORK_REVIEWER_PROMPT, /Every path must have exactly one owner in the complete snapshot/u);
    for (const disposition of ["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"]) {
      assert.match(WORK_REVIEWER_PROMPT, new RegExp(`"${disposition}": "preserved"`, "u"));
    }
    });

    it("documents the implemented generic cutover and retained legacy compatibility", () => {
      for (const text of [README, SKILL, SCHEMA]) {
        assert.match(text, /pristine attempt-zero pending|pristine-pending/i);
        assert.match(text, /blocked, previously attempted, or branch-only/i);
        assert.match(text, /persisted legacy|already-persisted legacy|existing legacy/i);
      }
      assert.match(README, /new generic-eligible legacy report rejects before publication/i);
      assert.match(SKILL, /never fall back after any generic claim, settled tombstone, unknown outcome, or manifest exists/i);
      assert.match(SCHEMA, /implemented B5 class-9 migration/i);
      assert.match(CLI, /retained legacy: blocked, previously-attempted, or branch-only consumer/i);
    });

    it("binds post-amendment slice dispatch and merge coverage to the checked feature baseline", () => {
      for (const text of [README, SPEC, SKILL, SCHEMA, CONTINUATION_SCOPE_DESIGN]) {
        assert.match(text, /authorized_baseline_commit/u);
      }
      assert.match(SKILL, /ahead or substituted branch rejects before state publication/u);
      assert.match(SCHEMA, /exact Git merge base[\s\S]*ownership-reviewed path set[\s\S]*integrated path set/u);
      assert.match(CONTINUATION_SCOPE_DESIGN, /First dispatch and every[\s\S]*diff_base_commit[\s\S]*retries start only at the immediately prior[\s\S]*reviewed commit/u);
    });
  });

describe("interrupt steer resume docs contract", () => {
  it("documents run-scoped process evidence and SIGTERM-only fail-closed cancellation", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /process\.json/i, `${name} must document process.json`);
      assert.match(text, /processes\/<timestamp>\.log|processes\/\S+\.log/i, `${name} must document run-scoped process logs`);
      assert.match(text, /validated run-owned/i, `${name} must require validated run-owned launches for run-scoped process evidence`);
      assert.match(text, /generic[\s\S]*detached[\s\S]*(?:allocates|validates)[\s\S]*(?:safe available )?run id/i, `${name} must bind a generic detached start to a durable run id before spawn`);
      assert.match(text, /pre-manifest[\s\S]*(?:process\.json|run-scoped evidence)|(?:process\.json|run-scoped evidence)[\s\S]*pre-manifest/i, `${name} must document pre-manifest cancellation evidence`);
      assert.match(text, /--run-id <run-id>[\s\S]*(?:does not|never|not)[\s\S]*(?:authority over an existing run|existing run)[\s\S]*(?:collision|rejected)|(?:collision|rejected)[\s\S]*--run-id <run-id>/i, `${name} must reject explicit run-id collisions before spawn`);
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
    for (const [name, text] of documentEntries({ SCHEMA, README, SPEC })) {
      assert.match(text, /terminal_result\.artifacts`? (?:is|remains) empty/i, `${name} must keep scalar steering diagnostics out of terminal artifacts`);
      assert.match(text, /steering history[\s\S]*ref\/hash/i, `${name} must retain durable steering authority outside terminal artifacts`);
    }
  });

  it("preserves PR review boundary and no-merge rule in docs", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, README, SPEC })) {
      assert.match(text, /Never auto-merge|Never merge the PR|never auto-merges/i, `${name} must forbid automatic merge`);
      assert.match(text, /Humans review and merge|human PR review boundary|review and merge/i, `${name} must keep PR human review boundary`);
      assert.match(text, /implementation-validator[\s\S]*security-reviewer|security-reviewer[\s\S]*implementation-validator/i, `${name} must require final review panel before PR`);
    }
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

  it("preserves explicit resume semantics", () => {
    assert.match(markdownSection(SCHEMA, "`/feature resume` Contract"), /Preserve existing resume semantics[\s\S]*calls `record-resume` before any other mutating resume work whether or not steering is pending/i, "SCHEMA must preserve explicit resume semantics");
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

});

describe("effective-content provenance docs contract", () => {
  it("stamps creation, resume, and every review dispatch without persisting raw prompts", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README })) {
      assert.match(text, /effective-content provenance/i, `${name} must identify effective-content provenance`);
      assert.match(text, /creation|created/i, `${name} must cover creation`);
      assert.match(text, /resume/i, `${name} must cover resume`);
      assert.match(text, /review(?: Task)? dispatch/i, `${name} must cover review dispatch`);
      assert.match(text, /rendered (?:feature )?command/i, `${name} must hash the effective command`);
      assert.match(text, /resolved agent prompts?/i, `${name} must hash resolved agent prompts`);
      assert.match(text, /repo-seeded (?:feature )?skills?/i, `${name} must hash selected skills`);
      assert.match(text, /loaded plugin source/i, `${name} must identify loaded plugin source`);
      assert.match(text, /OpenCode version/i, `${name} must record OpenCode version`);
      assert.match(text, /Git HEAD\/dirty state|Git HEAD plus only a dirty boolean/i, `${name} must record bounded git state`);
      assert.match(text, /never raw (?:dynamic )?prompts?|Do not persist raw prompt text|without storing raw prompts/i, `${name} must exclude raw prompts`);
      assert.match(text, /configured model[\s\S]*(?:not|distinct)[\s\S]*actual provider|actual provider[\s\S]*(?:not|distinct)[\s\S]*configured model/i, `${name} must distinguish configured and actual models`);
    }
    assert.match(SKILL, /factory provenance review-dispatch <run-id>[\s\S]*--hash sha256:<hash>[\s\S]*--prompt-bytes/i);
    assert.match(SCHEMA, /prompt_hash[\s\S]*prompt_bytes/i);
  });
});

describe("telemetry readiness docs contract", () => {
  it("defines the OpenCode 1.18.3 B6.1 correlation seam without claiming native enrichment", () => {
    for (const [name, text] of Object.entries({ SPEC, SCHEMA })) {
      assert.match(text, /OpenCode \*\*1\.18\.3\*\*/i, `${name} must pin the verified OpenCode version`);
      assert.match(text, /event\(\{event\}\)[\s\S]*session\.created[\s\S]*session\.updated[\s\S]*session\.deleted/i, `${name} must document public session events`);
      assert.match(text, /session\.status[\s\S]*session\.idle[\s\S]*session\.compacted/i, `${name} must document session-ID lifecycle events`);
      assert.match(text, /tool\.execute\.before\/after[\s\S]*sessionID[\s\S]*callID/i, `${name} must document the Task hook composite key`);
      assert.match(text, /command\.execute\.before[\s\S]*(?:run id|driver\.run_id)[\s\S]*untrusted (?:correlation )?candidate[\s\S]*(?:nonce-bearing live launch claim|durable builder|durable dispatch)/i, `${name} must keep parsed run ids candidate-only`);
      assert.match(text, /invalid (?:or|and) unencoded feature commands?[\s\S]{0,100}clear(?:s|ing)? (?:their )?exact (?:command-)?session binding|invalid (?:or|and) unencoded commands? bind nothing/i, `${name} must reject unvalidated run binding`);
      assert.match(text, /no native span handle/i, `${name} must deny a native span handle`);
      assert.match(text, /cannot mutate or enrich|cannot mutate native|no supported API for mutating or enriching/i, `${name} must deny native span enrichment`);
      assert.match(text, /factory-owned spans[\s\S]*withSpan\(\)/i, `${name} must reserve adjacent spans for withSpan`);
      assert.match(text, /B6\.1[^.]*no production span emission|B6\.1 emits no production spans|B6\.1 performs no production span emission/i, `${name} must keep emission out of B6.1`);
    }
  });

  it("defines bounded non-durable correlation identity and the canonical B6 taxonomy", () => {
    const fields = [
      "run_id", "slice_id", "attempt", "verdict", "convergence", "session_id", "parent_session_id", "call_id",
      "call_relationship", "target_agent", "route", "lane", "task_context", "continuation_kind", "span_event", "span_operation",
    ];
    const formerDottedAliases = [
      "feature_factory.gate.name",
      "feature_factory.gate.status",
      "feature_factory.slice.id",
      "feature_factory.slice.stack",
      "feature_factory.slice.attempt",
      "feature_factory.step.agent",
      "feature_factory.artifact.ref",
      "feature_factory.review.ref",
      "feature_factory.evidence.ref",
      "feature_factory.pr.url",
      "feature_factory.terminal.status",
      "feature_factory.terminal.reason_type",
      "feature_factory.target_agent.name",
    ];
    for (const [name, text] of Object.entries({ SPEC, SCHEMA })) {
      assert.match(text, /process-local[\s\S]*256 sessions[\s\S]*512 active (?:Task )?calls/i, `${name} must bound in-memory state`);
      assert.match(text, /delet(?:ing|ion).*session|Session deletion\/eviction/i, `${name} must clean deleted sessions`);
      assert.match(text, /Restart (?:begins|starts) empty|Restart starts empty/i, `${name} must deny durability`);
      assert.match(text, /session_id[^\n]*\+[^\n]*call_id|sessionID[^\n]*plus[^\n]*callID/i, `${name} must define the composite call key`);
      assert.match(text, /task_id[\s\S]*never[\s\S]*(?:telemetry identity|persisted|exported)/i, `${name} must exclude raw task_id`);
      assert.match(text, /fresh\|reuse/i, `${name} must bound task context`);
      assert.match(text, /128 UTF-8 bytes/i, `${name} must bound identifiers`);
      assert.match(text, /credential-shaped or high entropy[\s\S]*SHA-256 pseudonyms[\s\S]*workflow[\s\S]*session\/call identifier/i, `${name} must protect high-entropy identifiers`);
      assert.match(text, /at most 32[\s\S]*ASCII tokens/i, `${name} must bound enum cardinality`);
      assert.match(text, /verdicts retain their canonical uppercase ASCII spellings[\s\S]*APPROVE[\s\S]*REJECT[\s\S]*GO-WITH-NITS[\s\S]*NO-GO[\s\S]*REDESIGN-REQUIRED/i, `${name} must preserve canonical workflow verdicts`);
      assert.match(text, /every other enum token is lowercase ASCII/i, `${name} must keep non-verdict enums lowercase`);
      for (const field of fields) assert.match(text, literalPattern(`feature_factory.${field}`), `${name} missing canonical ${field}`);
      for (const alias of formerDottedAliases) assert.doesNotMatch(text, literalPattern(alias), `${name} must not retain former alias ${alias}`);
    }
  });

  it("keeps B6 metadata content-free, opt-in, best-effort, and linked only by standard OTel context", () => {
    for (const [name, text] of Object.entries({ SPEC, SCHEMA })) {
      for (const excluded of ["prompts", "messages", "tool arguments/results", "reviews", "evidence", "raw paths", "refs", "hashes", "URLs", "secrets", "traceparent", "tracestate", "arbitrary model output"]) {
        assert.match(text, literalPattern(excluded), `${name} must exclude ${excluded}`);
      }
      assert.match(text, /active OpenTelemetry context[\s\S]*(?:FEATURE_FACTORY_TRACEPARENT|standard propagation)[\s\S]*(?:remote parent|parent context)/i, `${name} must use standard W3C/OTel linkage`);
      assert.match(text, /hooks? (?:expose|exposes) neither native OpenCode span context|event\/tool hooks do not expose native context/i, `${name} must deny unsupported hook extraction`);
      assert.match(text, /explicitly enabled/i, `${name} must keep telemetry opt-in`);
      assert.match(text, /best-effort/i, `${name} must make telemetry best effort`);
      assert.match(text, /never change|never affect/i, `${name} must protect workflow behavior`);
    }
    for (const [name, text] of Object.entries({ SPEC, SCHEMA })) {
      assert.match(text, /B6 factory-owned[\s\S]*(?:never contain|categorically exclude)[\s\S]*artifact, review, (?:or|and) evidence refs[\s\S]*content hashes[\s\S]*raw gate answers/i, `${name} must prohibit all B6 authority/content refs`);
      assert.match(text, /General feature-factory[\s\S]*native OpenCode\/AI SDK[\s\S]*(?:cannot widen|does not alter)/i, `${name} must keep general/native capture from widening B6`);
    }
    assert.doesNotMatch(SPEC, /stable artifact refs|raw gate answers unless|record artifact refs and content hashes by default/i);
  });

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

});

describe("TUI sidebar live refresh docs contract", () => {
  it("keeps an empty sidebar mounted without rendering internal refresh metadata", () => {
    assert.match(TUI, /<b>Feature Factory<\/b>[\s\S]*fallback=\{<text fg=\{theme\(\)\.textMuted\}>No factory runs yet<\/text>\}/, "TUI must keep a visible empty state mounted under the Feature Factory header");
    assert.doesNotMatch(TUI, /sidebar v|plugin changes need TUI restart|refreshMetadata/, "TUI must not render internal refresh metadata");
  });

  it("keeps polling signals in the host-tracked plugin lifecycle", () => {
    assert.match(TUI, /async tui\(api\)[\s\S]*createSignal\(initialRuns[\s\S]*sidebar_content\(ctx, props\)[\s\S]*runs=\{runs\(\)\}[\s\S]*version=\{version\(\)\}/, "the registered slot must directly consume plugin-lifecycle signals so host tracking observes poll updates");
    assert.match(TUI, /scheduleRefresh\(\)[\s\S]*api\.lifecycle\?\.onDispose\?\.\([\s\S]*clearTimeout\(timer\)/, "the plugin lifecycle must own and dispose the refresh timer");
    assert.doesNotMatch(TUI, /let runStore|sharedRunStore|setInterval\(/, "component-local or module-global polling can escape host reactivity and lifecycle disposal");
  });

  it("documents empty-start polling and the root discovery cache", () => {
    assert.match(README, /No factory runs yet[\s\S]*keeps the panel mounted[\s\S]*runs start/i, "README must document live refresh after an empty startup");
    assert.match(README, /30s root-cache TTL|30-second root-cache TTL|30 second root-cache TTL|caches root discovery for 30 seconds/i, "README must document the root-cache TTL behind sidebar refreshes");
  });

});

describe("public documentation contract", () => {
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
    assert.match(documentationStatus, /Future work is tracked in[\s\S]*GitHub issues/i);
    assert.match(documentationStatus, /EXTRACTION-SPEC\.md[\s\S]*CONTINUATION-SCOPE-DESIGN\.md[\s\S]*non-authoritative/i);
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
    const tuiSlots = [...TUI.matchAll(/^\s{8}([a-z_]+)\([^)]*\) \{$/gmu)].map((match) => match[1]);
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

  it("documents the exact TUI plugin entry and the host-shared module contract", () => {
    // The sidebar entry is detected by the host from exports["./tui"]; the
    // root export is the server plugin and must never be documented as the
    // sidebar. The compatibility contract is module identity with the host's
    // solid/opentui copies, not exact version equality — a file:// reference
    // into a checkout loads a second instance that renders once and never
    // repaints.
    assert.match(useInOpencode, /"plugin": \["opencode-feature-factory"\]/, "README must show the exact tui.json entry (bare package name)");
    assert.match(useInOpencode, /detects the sidebar entry from `exports\["\.\/tui"\]`/i);
    assert.match(useInOpencode, /root export is the server plugin and has no `tui\(\)` hook/i);
    assert.match(useInOpencode, /module identity, not exact version equality/i);
    assert.match(useInOpencode, /renders once and never repaints/i);
    assert.equal(PACKAGE.exports["./tui"], "./dist/tui.js");
    assert.ok(PACKAGE.peerDependencies["solid-js"], "solid-js must be a peerDependency resolved from the host installation");
    assert.ok(PACKAGE.peerDependencies["@opentui/solid"], "@opentui/solid must be a peerDependency resolved from the host installation");
    assert.equal(PACKAGE.dependencies["solid-js"], undefined, "solid-js must not be a regular dependency — it would create a second module instance");
    assert.equal(PACKAGE.dependencies["@opentui/solid"], undefined, "@opentui/solid must not be a regular dependency — it would create a second module instance");
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
      ["story-reader", "openai/gpt-5.6-terra", "low"],
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
    assert.match(recommendedProfile, /Temporary OpenCode OAuth compatibility note[\s\S]*anomalyco\/opencode\/issues\/36140/i);
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
    const headings = [...CHANGELOG.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    const current = markdownSection(CHANGELOG, PACKAGE.version);
    const initial = markdownSection(CHANGELOG, "0.2.0");
    assert.equal(headings[0], PACKAGE.version);
    assert.deepEqual(headings, [PACKAGE.version, "0.2.0"]);
    assert.equal((current.match(/^- /gmu) || []).length, 2);
    assert.match(current, /cleanup[\s\S]*current canonical base head[\s\S]*mutation boundary/i);
    assert.match(current, /descriptive run names[\s\S]*credentials[\s\S]*opaque tokens[\s\S]*identity mismatches/i);
    assert.equal((initial.match(/^- /gmu) || []).length, 3);
    assert.match(initial, /`\/feature`[\s\S]*one primary `feature-factory` agent[\s\S]*12 specialized subagents[\s\S]*packaged feature skill/i);
    assert.match(initial, /package root and `\/server`[\s\S]*`src\/plugin\.js`[\s\S]*`\/tui`[\s\S]*generated `dist\/tui\.js`[\s\S]*`\/cli`[\s\S]*`src\/cli\.js`[\s\S]*`feature-factory` bin/i);
    assert.match(initial, /install, doctor, and factory CLI surfaces[\s\S]*separately importable TUI registration object/i);
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

  it("documents conservative repository cleanup preview, confirmation, and reporting", () => {
    const sweep = markdownSection(README, "Repository-wide conservative cleanup");
    assert.match(sweep, /cleanup --all --dry-run --repo \/path\/to\/repo/i);
    assert.match(sweep, /cleanup --all --digest ff-cleanup-v1\.<repository-sha256>\.<envelope-sha256>/i);
    assert.match(sweep, /repository-and-candidate-set digest[\s\S]*exact confirmation command/i);
    for (const classification of ["eligible", "protected", "skipped", "failed", "deleted"]) {
      assert.match(sweep, literalPattern(classification), `cleanup sweep docs missing ${classification}`);
    }
    assert.match(sweep, /status is exactly `completed`[\s\S]*GitHub PR is currently merged or closed[\s\S]*freshly fetched PR base/i);
    assert.match(sweep, /recomputes[\s\S]*`DIGEST_FOREIGN`[\s\S]*`DIGEST_STALE`/i);
    assert.match(sweep, /physical root, device\/inode identity, Git common-directory identity, and object format bind authorization/i);
    assert.match(sweep, /Both refusals preserve the recomputed unattempted candidates and counts[\s\S]*no confirmation action[\s\S]*fresh preview/i);
    assert.match(sweep, /fully revalidated immediately before mutation/i);
    assert.match(sweep, /retains the run directory after a partial target failure[\s\S]*continues processing independent candidates/i);
    assert.match(sweep, /attempted-cleanup failure[\s\S]*exit nonzero/i);
    assert.match(sweep, /Human diagnostics apply sensitive-value projection and terminal-safe encoding[\s\S]*displayed repository[\s\S]*never authorization input/i);
    assert.match(sweep, /confirmation\.argv[\s\S]*exact authorized physical root[\s\S]*POSIX `\/bin\/sh` octal variable[\s\S]*trailing newlines/i);
    assert.match(sweep, /JSON is the exact normalized machine report[\s\S]*not semantically redacted/i);
    assert.match(sweep, /Execute, refused, and failed reports always have null confirmation/i);
    assert.match(sweep, /flags may appear in any order[\s\S]*exactly one mode[\s\S]*no repository inspection/i);
    assert.match(sweep, /one complete selected report on stdout with empty stderr[\s\S]*grammar rejection[\s\S]*stderr/i);
    assert.match(sweep, /`blocked`, `partial`, or `needs-human`[\s\S]*protected recoverable work[\s\S]*never automatically deleted/i);
    assert.match(sweep, /handle that work/i);
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

function markdownTableRow(text, authorityClass) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells[0] !== authorityClass) continue;
    assert.equal(cells.length, 3, `${authorityClass} authority table row must have exactly three cells`);
    return {
      entryIds: [...cells[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
      decisionSurface: cells[2],
    };
  }
  assert.fail(`missing authority table row ${authorityClass}`);
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
