# Issue #69 Five Whys

Date: 2026-07-16

## Problem statement

Issue #69 did not produce a pull request after seven factory runs spanning roughly
29.5 hours of wall time and 13 hours 36 minutes of active orchestration. Six
foundation slices were internally merged across recovery branches, but every run
stopped before the post-merge integration, panel, and pre-PR gates.

This analysis is about system behavior, not agent blame. Builders repeatedly
produced clean commits with green focused tests. Reviewers repeatedly found real,
reproducible integrity defects that those tests did not cover.

## Evidence summary

- `issue-69` blocked after schema-model attempt 3. Its candidate passed 125 tests,
  but review found 32 invalid operation-envelope rows.
- `issue-69-attempt-4` merged schema and admission foundations, then blocked when
  critic acceptance exposed a schema-owner defect after that owner's exceptional
  fourth attempt was spent.
- `issue-69-remediation` blocked on a behaviorally correct critic fix whose test
  changed an out-of-lane schema-model test file.
- `issue-69-finalize` blocked after retained-handoff attempt 3. The candidate
  passed 64 focused tests, but review found a check-then-`mv -n` publication race
  and non-portable verification tied to the source repository's physical identity.
- `issue-69-acquire-commit-recovery` was cancelled before implementation when its
  base/scope was corrected.
- `issue-69-narrow-finalize` blocked after attempt-lifecycle attempt 3. The clean
  31-file candidate passed 142 tests, but review found ownership, compatibility,
  validation-authority, binding, and publication-proof defects.
- `issue-69-reviewed-recovery` blocked after attempt-lifecycle attempt 3. The
  fresh 29-file, +2,768/-51 candidate passed 142 tests, but corrupting
  `final.plan.json.kind` after observation completion still allowed restart to
  return `accepted`.
- No issue #69 run reached `test-verifier`; every run retained `pr_url: null`.

Honeycomb corroborates the local records:

- Recovery trace `6aed6ea9549dd111bcfed263b171446c` contains 1,427 spans.
  LLM and session spans completed without model errors. Twelve tool-level errors
  were failed probes/reads/patches rather than run-ending infrastructure faults.
- The recovery builder reused session `ses_096c82eafffeyM89Ykgqu5pEKp` across all
  three attempts. Telemetry records 945,552 input tokens, 105,451 output tokens,
  44,443 reasoning tokens, and 644 token-bearing events across that session.
- The three implementation reviews used fresh sessions and substantial repository
  inspection: 510, 370, and 295 seconds, with 38, 26, and 16 LLM turns. They
  recorded 928,537 input tokens in aggregate and reproduced defects directly.
- On recovery attempt 3, the builder claimed exact completed-observation
  verification and corruption fail-closed behavior. The fresh reviewer then
  mutated the plan kind and reproduced acceptance, contradicting the claim.
- The retained-handoff trace shows the same pattern: the builder claimed atomic
  no-clobber publication, while the reviewer observed a precheck plus `/bin/mv -n`
  and a race test that placed the competitor before, not inside, the vulnerable
  mutation window.

Relevant Honeycomb views:

- Recovery trace: https://ui.honeycomb.io/muninnai/environments/test/result/9JHgAGZg2M3/trace?trace_id=6aed6ea9549dd111bcfed263b171446c
- Recovery builder session query: https://ui.honeycomb.io/muninnai/environments/test/datasets/opencode/result/tbRs2jkbi3p
- Recovery reviewer query: https://ui.honeycomb.io/muninnai/environments/test/datasets/opencode/result/GZo4YfT2dYf
- Retained-handoff final review query: https://ui.honeycomb.io/muninnai/environments/test/datasets/opencode/result/JeCZ5AhSfk2
- Recovery builder attempt inputs, including the explicit nonconvergence override:
  https://ui.honeycomb.io/muninnai/environments/test/datasets/opencode/result/yRcssR8EuCx

## Five Whys tree

### Branch A: Why was no PR created?

**Why 1: Why did issue #69 produce no PR?**

Because PR creation is allowed only after every slice is merged, the repository-wide
test-verifier passes, the validator/security panel passes, and Gate 3 approves. No
run merged every slice.

**Why 2: Why did no run merge every slice?**

Because the first unresolved critical-path slice exhausted its bounded attempt
budget. Downstream slices remained pending by design.

**Why 3: Why did one blocked slice invalidate all delivery progress?**

Because issue #69 was treated as one feature branch and one PR even though the
initial approved plan contained nine slices and several independently useful
foundations. Internal slice merges are not external delivery checkpoints.

**Why 4: Why was an epic-sized change admitted as one PR batch?**

Because Gate 2 enforces dependency depth, ownership, and a subjective
"one dominant concern" rule, but has no enforceable delivery-size or verification-
complexity gate. The story's 15 acceptance criteria and full implementation,
recovery, evidence, critic, handoff, cleanup, and public API surfaces remained one
all-or-nothing delivery unit.

The reviewed-recovery `attempt-lifecycle` slice illustrates the mismatch: one
declared dominant concern contained 13 acceptance obligations, including seven
reconciliation outcomes, every named crash side and cross-binding family, 378
operation-policy rows, and five publication sinks. Concern count stayed one while
obligation mass grew combinatorially.

**Bedrock A:** The factory measures concern count and dependency depth but not
obligation mass against the available review/attempt/delivery envelope. It lacks a
large-feature admission rule that converts an oversized one-PR plan into
independently deliverable reviewed runs.

### Branch B: Why did green implementations keep failing review?

**Why 1: Why did candidates with 64-142 passing tests fail independent review?**

Because the focused suites tested authored examples, while reviewers exercised
missing mutation windows and cross-bindings. Green tests proved the examples, not
the full contract.

**Why 2: Why did the tests not prove the full contract?**

Because broad requirements such as all seven outcomes, every crash side, every
identity/ref/hash binding, 378 operation-policy rows, and five publication sinks
were translated manually from prose into tests. The builder and reviewer did not
share one executable inventory that generated both positive and adversarial cases.

**Why 3: Why could a builder claim exact verification while a simple mutation still passed?**

Because self-checks verified the named prior failure path but did not systematically
mutate every field of the durable record. Attempt 3 tested four final-observation
interruption states but not `schema_version`, `kind`, `planned_at`, key shape, or
staged-index descriptor corruption.

**Why 4: Why was that omission not caught before implementation review?**

Because the technical brief assigned table/model completeness but did not require a
machine-readable mutation matrix whose coverage could be checked before a builder
claimed completion.

**Bedrock B:** Consequential integrity contracts are prose-backed rather than
generated from a shared executable schema/mutation model.

### Branch C: Why were new blockers discovered on later attempts?

**Why 1: Why did attempt 2 and attempt 3 reveal new blocker categories?**

Because attempt-1 review did not enumerate every discoverable restart/integrity
failure. Attempt-2 review explicitly classified its two findings as
attempt-1-discoverable and `nonconvergent`.

**Why 2: Why could a fresh reviewer miss categories on the first pass?**

Because a single reviewer session was asked to exhaustively reconcile a 29-32 file,
2,000+ line implementation against many cross-product contracts. The reviewers did
substantial work, but there was no required coverage ledger proving every accepted
dimension had been inspected or probed before returning a verdict.

**Why 3: Why was attempt 3 still spent after a nonconvergent attempt-2 review said autonomous retries must stop?**

Because reviewer policy and orchestration policy disagree. The work-reviewer prompt
requires stopping after a later attempt-1-discoverable category, while the slice
orchestration rule uses `nonconvergent` only to deny an exceptional attempt 4. The
attempt-3 builder prompt in Honeycomb session
`ses_096c82eafffeyM89Ykgqu5pEKp` explicitly stated that the prior review was
nonconvergent but factory rules allowed final attempt 3, then continued.

**Bedrock C1:** First-pass review completeness is aspirational text, not a checked
coverage artifact.

**Bedrock C2:** `nonconvergent` has contradictory semantics between reviewer and
orchestrator state transitions.

### Branch D: Why did recovery consume so much time without compounding progress?

**Why 1: Why was large implementation work rebuilt repeatedly?**

Because out-of-lane fixes and exhausted owners require a new reviewed decomposition,
and rejected implementations cannot be adopted wholesale.

**Why 2: Why could safe prior work not be carried into the new recovery efficiently?**

Because the supported continuation path is narrow: it requires an eligible blocked
parent/review and reuses planning authority, not arbitrary unmerged implementation.
Several parents were `needs-human`, had rejecting/nonconvergent review, or required
ownership changes, so recovery restarted from the narrow base.

The blocked slice's branch, green focused tests, and accumulated review history are
not a supported child-run implementation input. Informal reuse was then correctly
rejected as wholesale adoption, leaving no verified slice-level continuation path.

**Why 3: Why did this produce no external checkpoint despite six reviewed foundations?**

Because the one-run/one-PR contract has no stacked/checkpoint PR mode for large
features. Reviewed internal merges remain local until the entire run reaches Gate 3.

**Bedrock D:** Recovery preserves audit evidence but lacks a reviewed implementation
carry-forward/checkpoint-delivery mechanism for scope or ownership amendments.

### Branch E: Why did builders repeatedly overstate completion?

**Why 1: Why did builder claims say “no blockers” when reviewers reproduced blockers?**

Because the builder's completion test was its focused suite plus a fix-by-fix mapping.
It had no independent adversarial oracle and treated passing authored regressions as
proof of the broader invariant.

**Why 2: Why did remediation remain anchored to the existing implementation model?**

Because the same implementer task/session was reused across attempts whenever the
subject, branch, and lane were unchanged. In recovery, attempt 2 required a
substantive architecture rewrite and removal of 17 byte-identical rejected-head
files, but it continued the same high-context session.

**Why 3: Why does the reuse policy permit that?**

Because task reuse eligibility checks identity of scope, owner, branch, and live
orchestrator, but not rejection class, architecture invalidation, nonconvergence, or
context size. Same lane is treated as same problem even when review invalidates the
design inside that lane.

**Bedrock E:** Implementer-context reuse is keyed to file/slice identity rather than
the semantic size of the required redesign.

### Branch F: Was the forgery-resistance scope worth its delivery cost?

**Why 1: Why did issue #69 require so many identities, refs, hashes, and cross-bindings?**

Because the design tried to ensure that implementation, observation, validation,
critic, acceptance, handoff, acquisition, verification, and cleanup records could
not be accidentally substituted across attempts or resumes.

**Why 2: What realistic failure does that prevent in a local developer tool?**

It prevents model claims from becoming authority, a review for commit A from being
applied to commit B, stale evidence from surviving a retry, concurrent sessions from
advancing the same effect twice, partial writes from looking complete, and a changed
worktree from being treated as the reviewed result. These are real automation and
crash failures.

**Why 3: What does it not prevent?**

It does not resist a malicious developer or compromised local process. The operator
controls the repository, Git refs, `.opencode/factory`, validation commands, evidence
files, and the verifier executable. That actor can rewrite both an artifact and the
code that checks it. Local hashes provide consistency and provenance, not
authentication.

**Why 4: Why did consistency checking expand into forgery-style protection of every internal record?**

Because the design did not clearly separate trust boundaries. Untrusted model
claims, fallible orchestration, crash recovery, and malicious local filesystem
tampering were treated as one integrity problem. The result recursively attested
records written by the same local authority and blocked delivery on internal
corruptions that could often be handled by re-observing Git or rerunning work.

**Bedrock F:** The factory has no explicit rule to apply strong binding only where
authority crosses between implementer, observer, reviewer, integration, or external
effects. It overprotects private intermediate state inside one trusted local
authority.

The useful core should remain:

- orchestrator-observed Git changes and command outcomes;
- review bound to the exact commit/tree;
- merge/PR bound to that reviewed tree;
- disclosed changed paths and fresh integrated verification;
- checksums sufficient to detect stale, truncated, or partial persisted artifacts;
- idempotent crash-safe external effects.

The factory should not claim resistance to an operator who controls the host, and it
should not require a recursive evidence chain where one canonical observed manifest
plus re-observation provides the same local assurance.

### Branch G: Why did predicted file ownership become a terminal failure mode?

**Why 1: Why did necessary adjacent edits block otherwise useful implementations?**

Because path lanes were enforced as immutable implementation authority. A builder
that discovered a required test, helper, or shared-state edit outside its predicted
lane could not simply include it, even when the behavior and focused tests were
correct.

**Why 2: Why were lanes made hard?**

To prevent concurrent builders from silently overwriting each other, preserve
review attribution, and stop a narrow slice from expanding into unrelated scope.
Those are legitimate concerns, but they do not require preauthorizing every changed
file.

**Why 3: Why can ordinary unowned overlap be handled later?**

Builders already work on isolated branches. The orchestrator can merge branches
sequentially, resolve textual conflicts or route them to an integration builder,
rerun affected tests, and obtain fresh review of the integrated commit. Clean Git
merges still need semantic review, but that review is required anyway.

**Why 4: When is early coordination actually necessary?**

When the file is owned by another active or accepted slice, or the discovered edit
changes product scope, a public or persisted contract, a migration, a security
boundary, generated ownership, or two fundamentally incompatible designs. A clean
merge cannot detect a builder weakening a sibling-owned test or changing an accepted
authority, so those edits need explicit routing and fresh acceptance.

**Why 5: Why were infeasible reviewer fixes allowed to consume another attempt?**

Because review output names behavioral fixes but does not classify their likely
paths against current ownership. In narrow-finalize, the attempt-2 requirement to
work "under indexed state authority" implied `tuple-index/index.js`, which no slice
owned. The mismatch was discovered only after the final builder had made the change.

**Bedrock G:** File lanes are treated as authorization boundaries when they should
be ownership boundaries only for files assigned to another slice. Unowned paths
should be scheduling/disclosure hints, while review-required fixes need a mechanical
lane-feasibility classification before another attempt is spent. The factory
currently pays recovery-run cost to avoid ordinary unowned merge work that Git plus
fresh integrated evidence can handle more cheaply.

## Root causes, ranked

1. **Oversized all-or-nothing delivery unit.** Fifteen acceptance criteria and nine
   initial slices were required to reach one PR.
2. **No shared executable adversarial contract.** Builders and reviewers manually
   interpreted prose cross-products, so mutation gaps appeared serially.
3. **Nonconvergence policy contradiction.** Reviewer output said stop; orchestration
   still spent attempt 3.
4. **Subjective decomposition width.** “One dominant concern” admitted lifecycle
   slices spanning schema compatibility, validation evidence, observation recovery,
   operation policy, publication isolation, and retained collaboration.
5. **Overextended local forgery resistance.** Strong boundary checks expanded into
   recursive protection of private records from an operator who controls the verifier.
6. **Hard path lanes turn discovery into failure.** Predicted file ownership is
   enforced even for unowned files, while reviewer fixes receive no lane-feasibility
   routing before consuming another attempt.
7. **Recovery and context reuse amplify rework.** Safe audit evidence is preserved,
   but implementation is rebuilt in a long-lived implementer context without an
   incremental delivery checkpoint.

## Action items

Each action must produce a reviewable artifact; “try harder” is not an action.

### Required sequencing

Do not activate stricter nonconvergent-stop behavior before a safe carry-forward path
exists. Doing so today would stop a run earlier but force the same expensive fresh
recovery. The transition implementation may be prepared and tested first, but runtime
activation must ship with one of:

- reviewed slice-level carry-forward into a child run; or
- a temporary narrowly gated extension available only when the complete prior review
  history is converging and strictly decreasing.

Preferred sequence:

1. threat-model clarification, executable mutation substrate, continuation design,
   and lane-feasibility review fields;
2. reviewed slice carry-forward runtime;
3. nonconvergent-stop activation plus explicit attempt-policy resolution;
4. ownership-aware unowned excursions with durable attribution;
5. obligation-mass/scope gate, checkpoint delivery, and generic integration
   amendment.

### P0 - Make nonconvergence terminal once carry-forward is available

Change the slice transition/orchestrator so any current REJECT with
`convergence: nonconvergent` blocks the next autonomous implementation attempt, not
only attempt 4. Align:

- `src/run-state.js`
- `.opencode/skills/feature/SKILL.md`
- `assets/agent/work-reviewer.md`
- transition and docs-contract tests

Regression: an attempt-2 nonconvergent review must reject `running --attempts 3`.
Activation regression: the terminal result must identify an eligible carry-forward
route rather than requiring a blank-slate rebuild.

### P0 - Add an executable durable-record mutation matrix

Create a shared test helper/model that derives adversarial cases for each closed
durable record: missing/unknown keys, wrong schema/kind/time, wrong ref/hash/bytes,
descriptor key-shape drift, and stale/cross-bound identities. Require lifecycle and
handoff evidence to consume it instead of hand-selecting mutations.

Target artifacts:

- a helper under `test/helpers/`
- schema/model exports under `src/single-slice/schema-model/`
- generated matrix tests in lifecycle, validation, state, and handoff suites
- a plan/docs contract requiring the matrix for durable integrity claims

The `final.plan.json.kind` mutation must become a generated regression.

### P0 - Narrow integrity checks to real authority boundaries

Write and enforce one explicit threat model:

- trusted local operator and host;
- untrusted model claims;
- fallible/crash-prone orchestration and concurrent retries;
- no protection claim against arbitrary local filesystem or verifier modification.

Keep exact Git/test/review/merge bindings and idempotent external effects. Replace
recursive internal attestations with one canonical orchestrator-observed manifest
where possible. On inconsistent private state, prefer safe Git re-observation or a
fresh operation over proving every intermediate record recoverable.

Target artifacts:

- `SPEC.md` and the issue #69 technical contract
- `.opencode/skills/feature/SKILL.md` and `SCHEMA.md`
- simplified state/evidence validators and tests
- terminology changes from “forgery resistance” to local consistency/provenance

### P0 - Replace hard path lanes with disclosed soft lanes and integrated review

Replace the binary in-lane/out-of-lane decision with ownership-aware routing:

- `in-lane`: continue normally;
- `unowned-extension`: allow the isolated builder edit, flag every unexpected path
  and rationale in evidence, and require explicit slice-review ratification;
- `sibling-owned` and sibling pending: route/resequence to that owner;
- `sibling-owned` and sibling merged: use merged-sibling or generic integration
  remediation with fresh acceptance;
- `contract-change`: stop for brief/decomposition amendment.

Files owned by another active or accepted slice remain hard boundaries. The
orchestrator may merge ordinary unowned excursions sequentially, but it must delegate
textual conflict resolution to the owning builder or a fresh integration builder,
rerun affected tests, and obtain fresh review bound to the integrated commit. The
orchestrator remains a coordinator, not an implementation author. A conflict-
resolution commit is implementation and must receive fresh evidence/review; a
successful textual merge is not semantic acceptance.

Reviewer-ratified unowned paths must become durable effective ownership for the
ratifying slice. `sliceOwnsPath`, CI-failure attribution, post-PR remediation routing,
and future merged-sibling owner lookup must all consume the same effective-path set;
otherwise the newly legal paths degrade to `needs-human` during post-PR handling.

Target artifacts:

- `assets/agent/backend-builder.md` and `frontend-builder.md`
- `.opencode/skills/feature/SKILL.md` lane and integration rules
- plan schema distinguishing owned paths from unowned expected/disclosure paths
- durable per-slice `effective_paths`/ratification binding consumed by
  `sliceOwnsPath` and `post-pr-ci`
- integrated-diff observation and review-binding tests
- removal of recovery-only behavior for ordinary adjacent/out-of-lane edits

### P0 - Check lane feasibility in the existing review round

Do not add another coordination round. Require each blocking review fix to return:

```json
{
  "scope_effect": "in-lane | unowned-extension | sibling-owned | contract-change",
  "likely_paths": ["src/..."],
  "fix_owner": "slice-id"
}
```

The orchestrator validates that classification against the current plan and routes
before advancing the attempt. The paths are a feasibility forecast, not permanent
implementation authority; actual changed paths are still observed and reviewed.

Target artifacts:

- `assets/agent/work-reviewer.md`
- review JSON schema and transition validation
- attempt-advance routing in `src/run-state.js` / factory orchestration
- regression proving an out-of-lane reviewer fix cannot consume the final attempt

### P0 - Add a large-feature delivery/decomposition gate

Extend the technical-brief/decomposition review and `slices-seed` validation with a
machine-readable `invariant_families`/`verification_artifacts` inventory. Reject a
slice that groups independent authority families merely because they share files.
When the resulting plan is too large for one bounded run, require an epic/stacked-run
delivery plan with independently reviewable PR checkpoints.

Target artifacts:

- `assets/agent/work-decomposer.md`
- `.opencode/skills/feature/SKILL.md` and `SCHEMA.md`
- `src/validate.js` / plan validation
- decomposition depth/width contract tests

### P1 - Require a reviewer coverage ledger

Add structured review output listing each accepted invariant family, evidence read,
probe executed, and disposition. Reject APPROVE and “complete” first-pass REJECT
claims when required brief dimensions are absent from the ledger.

Target artifacts:

- `assets/agent/work-reviewer.md`
- review JSON schema/validation
- run-state review transition tests

### P1 - Start a fresh builder after semantic redesign findings

Change task-context reuse rules: start a fresh implementer task when review requires
architecture replacement, ownership amendment, removal of parallel authority,
schema/migration redesign, wholesale rejected-head replacement, or reports
`nonconvergent`. Continue task reuse only for narrow implementation corrections.

Target artifacts:

- `.opencode/skills/feature/SKILL.md`
- builder prompt docs-contract tests

### P0 - Design and implement reviewed slice carry-forward

Add a supported recovery mode that either:

- carries exact reviewed commits into a child under fresh evidence/review bindings,
  or
- externalizes independently approved foundation batches as stacked/checkpoint PRs.

Do not weaken lane, evidence, or fresh-review authority. Produce a design decision in
`CONTINUATION-SCOPE-DESIGN.md` followed by transition/schema tests before enabling it.
This is a dependency of nonconvergent-stop activation, not a later optimization.

### P1 - Replace or narrow PR #79 after generic integration remediation exists

PR #79's merged-sibling repair remains useful while per-slice APPROVE binds an exact
tree: modifying an already merged owner invalidates that acceptance. Soft handling of
unowned files does not remove this case.

Scope the existing route down to exactly this admission window:

- the owner slice is already independently APPROVED and merged;
- a direct dependent produces an observed failing reproduction;
- the minimal fix changes owner-owned files and preserves the owner's accepted
  contract;
- ordinary slice work is quiesced;
- `test-verifier`, validator/security panels, Gate 3, PR creation, and post-PR work
  have not started.

Do not use merged-sibling repair for:

- unowned adjacent files or test/fixture excursions;
- a sibling that is still pending or running;
- textual merge conflicts that can be resolved and reviewed on the integrated tree;
- public/persisted contract, product-scope, security-boundary, generated-ownership,
  or decomposition changes;
- corrupt private factory artifacts that can be safely re-observed or rerun;
- any change after integration/panel/PR authority exists.

Keep only the boundary facts needed to supersede the stale owner acceptance:

- hash-bound failing consumer reproduction;
- observed attempt baseline and owner identity;
- Git-observed changed paths confined to the merged owner's lane;
- fresh independent review whose own bytes bind the exact repair commit/tree;
- exact reviewed tree carried into the feature branch;
- observed passing consumer reproduction after integration;
- a small bounded attempt count.

Collapse or remove duplicate internal evidence chains that do not add authority under
the trusted-local-operator threat model. One canonical repair manifest can bind the
baseline, changed paths, review, reviewed tree, and before/after reproduction. Plan
mutation should fail owner lookup, but the route does not need recursively attested
copies of every intermediate local record.

Design one generic integration-amendment path that records disclosed paths,
invalidates stale acceptance, reruns affected tests, reviews the exact integrated
commit, and rebinds downstream authority. Once it covers merged-sibling changes,
retire or substantially narrow PR #79's specialized remediation state machine. Do
not keep two maximally strict workflows for the same change.

The generic path must reproduce PR #79's core adversarial guarantees before
retirement: failing-to-passing consumer reproduction, reviewer-attested exact commit,
reviewed-tree-equals-merged-tree, changed-path observation, stale review rejection,
rename-side confinement, plan/owner stability, and crash/idempotency behavior. Treat
this as a security-sensitive state-machine migration, not a mechanical refactor.

Target artifacts:

- an integration-amendment design in `CONTINUATION-SCOPE-DESIGN.md`
- state/schema transitions and stale-acceptance tests
- migration/removal plan for `merged_slice_repair`

### P1 - Centralize closed-schema fixtures

Move shared state-record fixture construction into an explicitly owned helper so an
additive schema field does not require edits to sibling-owned test files. Pin exact
raw legacy fixtures separately for compatibility tests.

Target artifacts:

- shared fixture helper under `test/helpers/`
- schema/critic/state suites migrated to the helper where semantic construction is
  intended
- exact byte fixtures retained for migration/compatibility assertions

## Attempt policy decision

The latest review trajectory ended `7 -> 2 -> 1`, but attempt 2 was explicitly
`nonconvergent`: it introduced attempt-1-discoverable categories. A mandatory fourth
attempt or a runtime "one more fix" extension may repair the current candidate, but
it rewards oversized slices and incomplete first-pass review.

Consider a bounded extension only after obligation sizing, executable mutation
coverage, and nonconvergence semantics are fixed, and only when the complete review
history is converging with strictly decreasing counts. The reviewed-recovery history
would not qualify.

The existing optional `max_attempts: 4` policy must not remain model discretion.
Evidence is mixed: issue-69-attempt-4 exercised it successfully for schema-model, but
only five of the six slices across the two final three-slice plans met the current
`>=6`-obligation eligibility test, and all five were assigned 3. Narrow-finalize
`public-entrypoints` had five obligations and was not eligible; all three reviewed-
recovery slices were eligible.

Recommended final policy after carry-forward exists: delete optional attempt 4 and
use one uniform three-attempt loop followed by reviewed continuation. During the
transition, retain the existing checked four-attempt route only as a compatibility
stopgap and require the full review history to be converging and strictly decreasing.
Do not make four attempts mandatory for large slices; that would reward obligation
overpacking. Whichever policy is selected must be mechanically enforced at
`slices-seed`/attempt transition rather than left to decomposer judgment.

### P2 - Make factory identity first-class in telemetry

Add `feature_factory.run_id`, `feature_factory.slice_id`, `feature_factory.attempt`,
review verdict/convergence, and parent/child task linkage to session/task spans. The
current analysis had to infer run identity from prompts and timestamps, and
`list_aiconversations` returned no results because telemetry uses `agent.name` rather
than GenAI conversation conventions.

Target artifacts:

- OpenTelemetry span creation in the opencode instrumentation/plugin
- Honeycomb query/dashboard saved for run/slice attempt latency and verdicts
- telemetry contract tests

## Verification of the causal chain

If only the final plan-kind bug were fixed, the next broad handoff/public slice could
still reveal another manually omitted invariant. That would treat a symptom.

If the P0 actions are implemented, the factory would:

1. reject epic-sized one-PR plans or split them into deliverable checkpoints;
2. generate the corruption test that caught the final lifecycle bug before review;
3. apply strong provenance only at real automation boundaries rather than recursively
   attesting local intermediate state;
4. merge disclosed adjacent edits and re-review the integrated commit instead of
   starting a recovery run for ordinary unowned path overlap;
5. stop immediately when a fresh reviewer proves the first-pass inventory was
   incomplete, while preserving the reviewed branch/history through carry-forward
   instead of forcing a blank-slate recovery.

Those changes plausibly prevent the observed multi-run failure pattern rather than
merely fixing the latest candidate.
