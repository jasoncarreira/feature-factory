---
name: feature
description: Use when the user invokes /feature or asks to take a feature, ticket, work item, or product idea end-to-end with a durable software-factory workflow. Persists state under .opencode/factory, decomposes work into dependency-ordered slices, builds slices in isolated worktrees, observes evidence, and gates story, implementation plan, and PR creation.
---

# Feature Factory

You are the orchestrator. Run in the main conversation, not as a subagent, so you can pause at approval gates, steer subagents, own durable state, own git/worktree/PR side effects, and keep the engineer or external driver in control.

Two principles make this a durable factory rather than a freeform session:

- State lives in files. Every run has a control plane at `$REPO/.opencode/factory/<run-id>/`: manifest, gates, plan, artifacts, observed evidence, and reviews. A dead session or next-day return resumes from `run.json`.
- Observe, do not trust. A subagent report is a claim. Before accepting build or test work, re-derive the diff and run the named checks yourself. Write observed evidence, then have `work-reviewer` judge that evidence.

For provenance-sensitive state, use this authority ladder:

- `untrusted caller claims`: prompts, gate answers, builder/reviewer text, `run.json`, `evidence/*`, `reviews/*`, worktree path strings, status booleans, `base_ref`, and `base_commit`.
- `orchestrator observations`: fresh safe Git/filesystem observations, physical durable-root containment, worktree identity, commit/tree/parent relationships, file hashes, and reviewed-worktree guard results.
- `factory-owned attestations`: records written only after the current observations and re-checks pass.

`run.json` and gate/review/evidence files are bookkeeping or claim inputs, not proof. Gates, merges, validator/security pass, and PR readiness must not trust status booleans alone.

## Agents

Invoke subagents with the Task tool using `subagent_type` equal to the agent name:

- `story-reader`
- `story-writer`
- `codebase-researcher`
- `design-interpreter`
- `spec-writer`
- `work-decomposer`
- `backend-builder`
- `frontend-builder`
- `test-verifier`
- `work-reviewer`
- `implementation-validator`
- `security-reviewer`

Pass prior structured outputs in each prompt. Subagents do not share memory; you are the bus between them.

## Provenance authority contract

Create and maintain `$RUN/attestations/` alongside the manifest, evidence, and review files. The orchestrator is the only writer for factory-owned attestations.

Rules:

- All provenance-sensitive Git observations and reviewed-worktree guards must use the centralized safe Git policy (`safe_git_policy: "safe-git-v1"`) or equivalent `safeGit()` semantics.
- Re-derive physical worktree identity and durable-root containment before writing or accepting attestations.
- Treat `run.json`, `reviews/*.json`, `evidence/*.json`, `factory.lock`, worktree strings, `base_ref`, `base_commit`, and status booleans as claims only.
- If safe Git, worktree identity, durable-root containment, attestation hashes, or referenced file hashes cannot be re-proved, fail closed.
- Reviewer approval attestations are written only after the reviewed-worktree guard returns `clean`.
- Merge provenance is accepted only from the attested first-parent chain, not from `merged` or `approved` flags alone.

## Reviewer read-only guard

Reviewer-designated agents are only:

- `work-reviewer`
- `implementation-validator`
- `security-reviewer`

Every reviewer prompt must explicitly say the reviewed worktree is read-only: do not edit files, run package normalization commands, update lockfiles, format, generate, install with write side effects, update snapshots, stage files, commit, or otherwise mutate the worktree. If a reviewer needs command output that may write files, it must ask the orchestrator instead of running it.

After every reviewer-designated subagent invocation, and before accepting or writing that review result, check the reviewed worktree with `git -C <reviewed_worktree> status --porcelain=v1 --untracked-files=all` or the equivalent `src/review-guard.js` helper semantics.

Guard semantics:

- Exit `0` and empty stdout => clean; the reviewer output may be accepted normally.
- Exit `0` and non-empty stdout => dirty; the reviewer output is invalid. Prefer bounded recovery and retry before blocking.
- Non-zero exit => unverifiable; the reviewer output is invalid and blocking unless re-observation can prove the issue was transient.

Reviewed worktree mapping:

- `work-reviewer` subject `spec-writer` -> `$FEAT_WT`
- `work-reviewer` subject `work-decomposer` -> `$FEAT_WT`
- `work-reviewer` subject `<slice-id>` -> `$SLICE_WT`
- `work-reviewer` subject `test-verifier` -> `$FEAT_WT`
- `implementation-validator` -> `$FEAT_WT`
- `security-reviewer` -> `$FEAT_WT`

If the guard is dirty, discard the reviewer output as invalid, capture the dirty diff/status in a guard report, then attempt bounded recovery when the dirt is clearly reviewer-created and the reviewed worktree has an attested or observed clean HEAD to restore to. Restore only the reviewed worktree back to the observed commit/tree, recheck the guard, and rerun the same reviewer once with a stronger read-only warning. If recovery cannot be proven safe, the guard remains dirty after recovery, or the retry dirties the worktree again, write the guard-block report and mark the relevant step, slice, or panel blocked. If the guard is unverifiable, block unless a fresh re-observation proves the worktree is clean.

Limitations:

- This is post-run git-visible dirty-state detection only.
- It is not OS/process sandboxing and does not prevent mutation attempts.
- It does not detect ignored files, committed or reverted mutations, effects outside the reviewed worktree, or non-git-visible side effects.

## Operating Modes

- Interactive mode: stop at gates for the user in chat.
- Headless scripted mode: stop after writing the next pending gate so an external driver can answer through `gates/<gate>.answer`.
- Autonomous scripted mode: explicit operator opt-in from the CLI. The factory itself owns gate policy, records autonomous gate decisions, runs bounded remediation, and stops only at terminal status or human-required ambiguity.

Autonomous mode does not remove evidence, review, security, or PR boundaries. It only removes the external gate relay when the factory already has enough evidence to decide.

## Chain

```text
INTAKE -> [GATE 1: Story] -> RESEARCH + DESIGN -> SPEC -> DECOMPOSE -> [GATE 2: Brief + Plan]
       -> BUILD (dependency waves; parallel file-disjoint slices; observe -> review -> serial merge)
       -> INTEGRATE: ACCEPTANCE TESTS + VALIDATION
       -> [GATE 3: Pre-PR] -> DRAFT PR
```

`work-reviewer` runs on high-risk steps only: spec, decomposition, each slice build, and test verification. It must return APPROVE before you accept the step. Story, research, and design are not auto-reviewed.

Never skip gate accounting. A gate means write the question/artifact and record the gate outcome in `run.json`. Interactive and headless modes wait for `approve`, `changes: <...>`, or `stop` through the gate-answer protocol. Autonomous mode may approve gates itself only under the rules in the Autonomous Mode section.

Escalate when the work needs a decision that is not yours: product/UX ambiguity, security review, production data migration risk, generated/subtree code ownership, external-system policy, or a brief that builders report as impossible. State the question, options, and recommended owner.

## Intent Gate

Classify every `/feature` invocation before Step 0 and before mutating any run state. The goal is to avoid accidental restarts, treating status requests as implementation, or missing a pending gate answer.

Intent types:

- `new-feature`: start a new factory run from a feature idea, ticket/work item, or product request.
- `resume`: continue an existing run by explicit run id, by `resume <run-id>`, or by latest run when unambiguous.
- `gate-answer`: answer the currently pending gate with `approve`, `stop`, or `changes: <...>`.
- `status`: inspect/list/summarize current factory state without advancing the run.
- `scripted-start`: start or resume from an externally supplied, already structured work order or headless driver prompt.
- `autonomous-start`: start or resume from an explicit autonomous driver prompt.
- `pr-continuation`: prepare or retry PR creation for an already-built/validated feature branch.

Classification rules:

- If the input starts with `resume`, classify `resume`.
- If the input is exactly `approve`, exactly `stop`, or starts with `changes:`, classify `gate-answer` only when exactly one run has a pending gate. If multiple runs have pending gates, ask which run/gate it applies to. If no run has a pending gate, ask for the target run/gate or explain there is nothing to answer.
- If the input asks for status, list, summary, current gate, run state, or what is pending, classify `status`.
- If the input references an existing `run-id` or `.opencode/factory/<run-id>`, classify `resume` unless it is clearly status-only.
- If the input asks for PR creation/PR retry and a run already has validated evidence or a feature worktree, classify `pr-continuation`.
- If the prompt includes autonomous driver instructions, classify `autonomous-start` or `resume` based on whether a run id exists.
- If the prompt includes headless/scripted driver instructions, classify `scripted-start` or `resume` based on whether a run id exists.
- Otherwise classify `new-feature`.

Actions by intent:

- `new-feature`: proceed to Step 0.
- `resume`: load `run.json` and continue from the first incomplete point.
- `gate-answer`: write the answer to `gates/<pending-gate>.answer`, consume it, update `run.json`, then continue or stop according to the answer.
- `status`: read `run.json`/artifacts and report state. Do not dispatch agents, create worktrees, write gates, or change run status.
- `scripted-start`: proceed like `new-feature`/`resume`, but in scripted mode stop after writing the next pending gate question if no answer file exists.
- `autonomous-start`: proceed like `new-feature`/`resume`, set `run.json.mode = "autonomous"`, and use the Autonomous Mode rules instead of waiting for external gate answers.
- `pr-continuation`: verify Gate 3 approval and observed evidence before pushing or creating a draft PR. If missing, return to Gate 3 instead of improvising.

## Review Tier Contract

For every non-`status` intent, determine the review tier before the first `run.json` mutation and persist it at top-level `run.json.review_tier` so later steps and resumed runs read the same durable choice. `status` intents remain read-only and must not backfill or rewrite `review_tier`.

Selection and persistence rules:

- Explicit selection is only from prompt or work-order text shaped like `review tier: light|standard|strict` in v1. Do not invent a CLI flag.
- New runs must initialize `run.json.review_tier` during Step 0.
- Resumed runs missing `review_tier` must backfill it before the next state mutation, except `status` intents.
- Persist `selected`, `source`, `risk_reasons`, and a required non-empty `rationale` exactly as documented in `SCHEMA.md`.
- If no explicit tier is selected and risky categories are detected in the prompt, approved story, research map, or technical brief, select `strict` with `source: default` and record matching `risk_reasons`.
- Risky categories for strict defaulting are `security_or_auth`, `schema_or_persistence`, `generated_or_owned_code`, `external_system_policy`, `dependency_or_supply_chain`, `workflow_or_release`, and `destructive_or_broad_scope`.
- If no explicit tier is selected and no risky category is detected, select `standard` with `source: default` and explain that default in `rationale`.
- Any selected tier, including an explicit `light` or `standard`, may be upgraded to `strict` before a later non-status state mutation if newly produced artifacts expose risky categories. Record the new `selected`, `risk_reasons`, and `rationale`; do not automatically downgrade a tier.
- Review tiers do not add or remove unrelated gates, agents, PR behavior, mandatory security review, or workflow redesign in v1. Existing mandatory gates, observed evidence, `work-reviewer`, `implementation-validator`, and `security-reviewer` behavior still applies.

If classification is ambiguous, ask one short clarification question and do not mutate state until answered.

## Control Plane

Create `$RUN=$REPO/.opencode/factory/<run-id>` with:

- `run.json`
- `gates/`
- `artifacts/`
- `plan/`
- `evidence/`
- `reviews/`
- `attestations/`

Use the repo-local schema at `$REPO/.opencode/skills/feature/SCHEMA.md`. The factory CLI seeds this file before starting a run so the workflow stays self-contained under `external_directory: deny`. Write `run.json` atomically after every state change through the transition helpers in `src/run-state.js`: `hashRunState`, `transitionRunJson`, `transitionGateDecision`, `transitionTerminalResult`, `transitionRunStep`, `transitionRunSlice`, and `transitionLifecycleRun`. Keep `mutateRunJsonLocked` only as the legacy compatibility path for no-index bootstrap-safe writes. Include `schema_version`, persist the selected review tier at top-level `run.json.review_tier`, persist non-empty `driver.github_account` at top-level `run.json.github_account`, and refresh `heartbeat_at` whenever you make progress.

Transition contract:

- `hashRunState` provides the canonical current-state hash for optimistic `expectedCurrentHash` compare-and-swap checks. If another writer wins the lock first, the semantic transition must fail closed as a stale `run.json` transition instead of overwriting newer state.
- `transitionRunJson` is the default semantic writer: take `run-json.lock/`, validate current authority, require heartbeat to be stopped for foreground semantic writes, validate the next state, then commit atomically.
- `transitionLifecycleRun` uses the same validation path. `allowActiveHeartbeat: true` is a narrow lifecycle escape hatch, not a general bypass for normal semantic writes.
- `transitionRunStep` and `transitionRunSlice` seed/update `steps[]` and `slices[]` by stable identity (`agent` / `id`) so resumed runs do not depend on hand-maintained array positions.
- `transitionTerminalResult` keeps top-level `run.json.status` and `run.json.terminal_result` consistent and rewrites `terminal_result.run_id` to the durable run id.
- `transitionGateDecision` is the only approved-gate writer. The CLI exposes it through `feature-factory factory gate-decision <run-id> <gate> <status> ...` for scripted harnesses. For `status: approved`, it must write and validate `attestations/gates/<gate>.json` plus the updated accepted `attestations/index.json` chain before the approved gate state becomes durable; if later validation fails, roll back the staged gate attestation/index files and leave `run.json` unchanged.
- `mutateRunJsonLocked` remains compatibility-only when `attestations/index.json` is absent and the current/next state has no provenance-sensitive claims. It must fail closed for approved gates, review-approved or merged slices, passing validator/security verdicts, and run-base fields without accepted attestations. PR URLs remain terminal bookkeeping until a dedicated PR-created attestation type exists.

At run creation, create `attestations/` but do not create placeholder/empty `attestations/index.json`. Create `attestations/index.json` only with the first accepted attestation and non-empty entries. The first accepted attestation must be the sequence-1 `attestations/run-base.json`; gate decisions cannot bootstrap the accepted graph before run-base exists. New runs materialize the feature branch/worktree during Step 0 before Gate 1, then re-observe the branch, worktree identity, base commit, and base tree through safe Git/filesystem checks and write that run-base attestation. Resume paths validate existing attestations instead of blindly rewriting them.

These transition helpers do not change heartbeat or external-driver semantics: `heartbeat.json` remains liveness-only bookkeeping, and external drivers still write only `gates/<gate>.answer`; approved answers sourced from that file still record `approval_source: external-driver`.

One-writer rule:

- The factory writes `run.json`, artifacts, plans, evidence, reviews, gate question files, branches, commits, pushes, and PRs.
- External drivers write only `gates/<gate>.answer`.
- The factory consumes answer files, records the result in `run.json`, and continues.

## Heartbeat Protocol

Use the internal heartbeat helper only for long `Task`/subagent waits that happen while `run.json.status` is still `running`.

- Start heartbeat immediately before the long wait begins.
- Require the trusted heartbeat owner capability from `$RUN/factory.lock` for detached `--start`, internal `--foreground`, and internal `--once` paths. Do not expose that capability through `heartbeat.json` or `factory heartbeat <run-id> --status --json`.
- Treat `heartbeat.json` as data, not authority. Token, PID, or sidecar contents alone never authorize heartbeat freshness.
- Start heartbeat only when the manifest already shows real in-flight factory work via a `running` step or a `running`/`review` slice.
- Stop heartbeat in a `finally`/after-return path before any foreground semantic `run.json` write. While a heartbeat is active, do not accept agent output, mutate steps/slices/gates, or write any other semantic manifest fields besides locked `heartbeat_at` ticks.
- Do not start heartbeat while stopped at Gate 1 (`story`), Gate 2 (`brief`), or Gate 3 (`pre_pr`). Gate waits are intentionally heartbeat-free.
- Before writing terminal `completed`, `blocked`, `partial`, or `needs-human` status, or before writing `terminal_result`, stop heartbeat with wait/force semantics and require a confirmed stopped lease.

Required heartbeat phases:

- `spec-review`
- `decomposition-review`
- `builder-wave`
- `slice-review`
- `test-verifier`
- `test-rerun`
- `test-review`
- `implementation-validator`
- `security-reviewer`
- `remediation`

## Gate Protocol

For every gate:

1. Write a human-readable question file, e.g. `gates/story.question.md`.
2. Mark the gate `pending` in `run.json` with `question_ref` and `answer_ref`.
3. If `gates/<gate>.answer` already exists, consume it and record `approval_source: external-driver` for approved answers.
4. Otherwise, in interactive mode ask the user in chat, write their response to the answer file, and record `approval_source: human` for approved answers.
5. In scripted mode, stop after writing the pending gate. An external driver can write the answer file and reinvoke `/feature resume <run-id>`.

Allowed answer contents:

```text
approve
changes: <specific requested change>
stop
```

On `approve`, set the gate to `approved`, copy the answer into `run.json`, set `answered_at`, and use only an allowed semantic `approval_source`: `external-driver`, `human`, `autonomous`, or `override`. Do not put the answer file path in `approval_source`. On `changes`, rerun the relevant producing step with the feedback and re-present the gate. On `stop`, set status `needs-human` or `blocked` with the reason.

After every gate decision, hash the question/artifact/answer material and write `attestations/gates/<gate>.json`, updating `attestations/index.json` and the `prev_hash` chain. A gate marked `approved` in `run.json` is bookkeeping, not proof; later validators and gates must not trust status booleans alone.

In gate-decision attestations, `question_ref` and `answer_ref` stay under `gates/`, while `artifact_ref` stays under `artifacts/`. Do not write gate question or answer refs under `artifacts/`.

## Autonomous Mode

Autonomous mode is allowed only when the invocation explicitly includes the autonomous driver instructions inserted by `factory start --autonomous`. Do not infer it from vague wording.

Rules:

- Keep writing `gates/<gate>.question.md` files for auditability.
- Record autonomous approvals in `run.json.gates.<gate>` with `status: approved`, `answer: approve`, `approval_source: autonomous`, `answered_at`, and a short `decision_note` explaining the evidence used.
- Gate 1 (story) may be autonomously approved only when the normalized story has clear acceptance criteria, scope, assumptions, and no unresolved product/UX/security/external-policy decision. If not, set `status: needs-human`, write `terminal_result`, and stop.
- Gate 2 (technical brief and slice plan) may be autonomously approved only after `work-reviewer` approves the spec and decomposition and the plan covers all acceptance criteria with file-disjoint same-wave slices or justified serialization. If not, set `status: needs-human`, write `terminal_result`, and stop.
- Gate 3 (pre_pr) is decided by the strictest result from the implementation-validator and security-reviewer panel. GO/PASS may approve autonomously. Any validator NO-GO or security-reviewer BLOCK is NO-GO.
- On Gate 3 NO-GO, run the bounded remediation loop from Step 5: route top findings to the owning builder or integration/test fix path, observe evidence, and rerun the panel. Do not exceed `run.json.max_retries` or 3 attempts if unset.
- If remediation exhausts or the fix owner is ambiguous, set `status: blocked` or `needs-human`, write `terminal_result`, and stop.
- Never auto-merge. A draft PR is the final autonomous side effect.
- At every terminal state, write `run.json.terminal_result` with the stable external-driver contract described in `SCHEMA.md`.

## Step 0 - Intake, Run ID, Manifest

Parse the invocation and determine:

1. Existing work item: a ticket key, issue URL, branch reference, or external ref in the input.
2. No existing work item: raw feature idea.
3. Design input: Figma/design URL, screenshot path, design doc, or visual requirements.

Choose the story agent:

- Existing work item with accessible details -> `story-reader`.
- Raw idea -> `story-writer`.

Establish the run:

- `run-id` = lowercased external ref if one exists, otherwise a short kebab slug.
- Determine `BASE` from the repo default branch (usually `main`), `BRANCH=<run-id>-<short-slug>`, and `FEAT_WT=$REPO/.opencode/worktrees/$BRANCH`.
- Fetch `origin/$BASE` and create the feature branch/worktree immediately: `git -C "$REPO" worktree add -b "$BRANCH" "$FEAT_WT" "origin/$BASE"`. If it already exists on resume, reuse it only after validating identity.
- Before Gate 1 or any approved gate decision, re-observe `repo_root`, `run_dir`, `git_common_dir`, feature branch/worktree identity, `base_ref`, `base_commit`, and `base_tree` through safe Git/filesystem checks. Write `attestations/run-base.json`, create non-empty `attestations/index.json`, and treat that accepted run-base as the graph root.
- Initialize `run.json` with `schema_version`, `run_id`, `external_ref`, `base_ref`, `branch`, `worktree`, `status: running`, timestamps, `heartbeat_at`, `max_parallel_slices: 3`, `max_retries: 3`, top-level `review_tier`, top-level `github_account` when provided by the driver, empty `steps`, empty `slices`, gate refs, and null `validator`/`pr_url`.
- Initialize `$RUN/factory.lock` with `schema_version`, `run_id`, and a trusted heartbeat owner capability used only by the factory lifecycle.
- If `run.json` exists, this is a resume. Read it, backfill top-level `review_tier` before the next non-status state mutation when it is missing, and continue from the first incomplete point. Never redo side effects that `run.json` shows already happened.

The caller checkout is only the launcher/control-plane location. All code-reading, planning, spec/decomposition review guards, implementation, test, validation, and PR work uses the clean `$FEAT_WT` created here so uncommitted caller-checkout edits do not block factory runs.

Run the story agent and write `$RUN/artifacts/story.md`. If design input exists, run `design-interpreter` in parallel when useful and write `$RUN/artifacts/design-brief.md`.

### Gate 1 - Story

Present the normalized story, acceptance criteria, scope, assumptions, and any design summary. Write `gates/story.question.md`, mark the gate pending, and wait for an answer.

On approval, record `gates.story.status = approved`. Do not create or mutate external tickets unless the user explicitly asks in the interactive run.

## Step 1 - Research And Design

Fan out in parallel when possible:

- `codebase-researcher` with the approved story and `$FEAT_WT` as the repository context. Write `$RUN/artifacts/research-map.md`.
- `design-interpreter` with design input if not already complete. Write `$RUN/artifacts/design-brief.md`.

The research map must identify real files, patterns, tests, integration hotspots, generated code, migration/schema risks, and open questions. Do not proceed to spec from guessed paths.

## Step 2 - Spec (Reviewed)

Run `spec-writer` with the approved story, research map, and design brief. It produces a decision-complete technical brief. Write `$RUN/artifacts/technical-brief.md`.

Review the brief:

- Run `work-reviewer` with subject `spec-writer`, the brief, and its inputs.
- After it returns, before accepting or writing `$RUN/reviews/spec-writer.json`, guard `$FEAT_WT`.
- If the guard is clean, write `$RUN/reviews/spec-writer.json` and continue the normal APPROVE/REJECT loop.
- If the guard is dirty, discard the reviewer output, capture the guard report, recover the feature worktree to the observed clean head only if safe, then retry the reviewer once with an explicit read-only warning. If recovery/retry fails or the guard is unverifiable, write the guard-block report to `$RUN/reviews/spec-writer.json`, mark the spec step `blocked`, and stop.
- On REJECT, rerun `spec-writer` with required fixes up to `max_retries`.
- Record attempts in `run.json.steps`.

Do not decompose until the spec is accepted.

## Step 3 - Decompose Into Slices (Reviewed)

Run `work-decomposer` with the accepted story, research map, technical brief, and design brief. It produces:

- `$RUN/plan/slices.json`: a dependency DAG.
- `$RUN/plan/plan.md`: human-readable waves and rationale.

Each slice must include:

- `id`
- `stack`: backend | frontend | fullstack | test | docs | other
- `paths`: files/directories the slice owns
- `depends_on`: slice ids that must merge before this slice can run
- `acceptance`: acceptance criteria covered by the slice
- `test_plan`: commands/assertions proving the slice

Rules the plan must satisfy:

- Every acceptance criterion maps to at least one slice.
- Same-wave slices are file-disjoint.
- Dependencies are real consumption dependencies, not blanket ordering.
- Shared hotspots are serialized into different waves.
- Generated files have a single owning slice.
- If a feature is indivisible, emit one slice and say why.

Review the decomposition:

- Run `work-reviewer` with subject `work-decomposer`.
- After it returns, before accepting or writing `$RUN/reviews/work-decomposer.json`, guard `$FEAT_WT`.
- If the guard is clean, write `$RUN/reviews/work-decomposer.json` and continue the normal APPROVE/REJECT loop.
- If the guard is dirty, discard the reviewer output, capture the guard report, recover the feature worktree to the observed clean head only if safe, then retry the reviewer once with an explicit read-only warning. If recovery/retry fails or the guard is unverifiable, write the guard-block report to `$RUN/reviews/work-decomposer.json`, mark the decomposition step `blocked`, and stop.
- It checks output contract, AC coverage, dependency correctness, file-disjoint same waves, and hotspot serialization.
- Loop on REJECT up to `max_retries`.
- Seed `run.json.slices[]` from `slices.json` with `status: pending`, `attempts: 0`, branch/worktree null, evidence/review refs null, and merge commit null.

### Gate 2 - Technical Brief And Slice Plan

Present the technical brief and the slice plan: waves, each slice's paths, acceptance coverage, dependency edges, tests, and serialized hotspots. The gate approves both implementation approach and parallelization plan.

On `changes`, rerun `spec-writer`, `work-decomposer`, or both depending on feedback, then re-present.

## Step 4 - Build Slices In Dependency Order

Reuse the feature branch/worktree created during Step 0. This is the single integration branch and final PR branch:

```sh
REPO=$(git rev-parse --show-toplevel)
BASE=<repo default base branch, e.g. main or development>
BRANCH=<run-id>-<short-slug>
FEAT_WT=$REPO/.opencode/worktrees/$BRANCH
git -C "$FEAT_WT" rev-parse --show-toplevel
```

If the branch/worktree already exists on resume, reuse it. `branch`, `base_ref`, and `worktree` must already be recorded in `run.json` from Step 0. Keep the caller's checkout untouched. Do not `cd`; use `git -C` and absolute paths.

Before treating the feature branch as authoritative, re-observe `repo_root`, `run_dir`, `git_common_dir`, feature branch/worktree identity, `base_ref`, `base_commit`, and `base_tree` through safe Git/filesystem checks and ensure the run-base attestation is present and accepted.

If a fresh worktree needs shared dependencies, generated hooks, or package caches, link or install them only after verifying repo conventions. Record any setup in evidence or notes.

### Wave Scheduling

Compute waves by topological sort of `depends_on`:

- A wave is every `pending` slice whose dependencies are all `merged`.
- Cap concurrent slices at `run.json.max_parallel_slices`.
- Same-wave slices should already be file-disjoint by plan. If you discover overlap, stop and treat it as a decomposition bug.
- If any slice becomes `blocked`, do not dispatch dependents.

For each slice in a wave:

1. Isolate it in a slice worktree from the current feature branch HEAD:
   ```sh
   SLICE_BRANCH=$BRANCH--<slice-id>
   SLICE_WT=$REPO/.opencode/worktrees/$SLICE_BRANCH
   git -C "$REPO" worktree add -b "$SLICE_BRANCH" "$SLICE_WT" "$BRANCH"
   ```
2. Mark the slice `running` in `run.json`, set branch/worktree, increment attempts, and refresh heartbeat.
3. Dispatch the builder in parallel for all eligible slices in the wave:
   - backend/fullstack backend-heavy -> `backend-builder`
   - frontend -> `frontend-builder`
   - test/docs/other -> use the most appropriate builder or ask if ambiguous
4. Give each builder exactly one slice spec, `$SLICE_WT`, branch, story, research map, technical brief, design brief if relevant, dependency outputs it consumes, and test plan.
5. Builders may edit only inside `$SLICE_WT`, only in slice paths plus directly required test paths, and must commit their changes on the slice branch.

### Observe Each Slice

When a builder returns, re-derive evidence yourself in the slice worktree:

- `git -C $SLICE_WT diff --stat $BRANCH...HEAD`
- `git -C $SLICE_WT diff --name-only $BRANCH...HEAD`
- `git -C $SLICE_WT rev-parse HEAD`
- Run the slice's named test command(s) from `test_plan`.

Write `$RUN/evidence/<slice-id>.json`. Reconcile the builder's claim block against observed evidence. `review_ready` requires non-empty observed diff, diff observed successfully, and tests observed passing or explicitly skipped with a reason.

After safe Git re-derives the diff, commit, tree, evidence hash, and physical slice worktree identity, write `attestations/slices/<slice-id>.observation.json` and append it to `attestations/index.json`.

### Review Each Slice

Run `work-reviewer` with subject `<slice-id>`, the builder output, observed evidence, slice spec, technical brief, story, and relevant repo rules. Tell the reviewer the slice worktree is read-only and must not be modified.

- After it returns, before accepting or writing `$RUN/reviews/<slice-id>.json`, guard `$SLICE_WT`.
- If the guard is dirty, discard the reviewer output, capture the guard report, recover the slice worktree to the observed slice commit/tree only if safe, then retry the reviewer once with an explicit read-only warning. If recovery/retry fails or the guard is unverifiable, write the guard-block report to `$RUN/reviews/<slice-id>.json`, mark the slice `blocked`, record the blocker reason, and stop dispatching dependents.
- If the guard is clean and the review verdict is accepted, hash the review output, evidence, subject commit/tree, and clean guard result, then write `attestations/reviews/<slice-id>.approval.json` before treating the slice as approved.

- APPROVE -> mark slice ready to merge.
- REJECT -> route required fixes back to the same builder in the same slice worktree, re-observe, and re-review.
- After `max_retries`, mark the slice `blocked`, record reason, and stop dispatching dependents.

### Merge Approved Slices Serially

Merge approved slices into the feature worktree one at a time:

```sh
git -C "$FEAT_WT" merge --no-ff "$SLICE_BRANCH" -m "<run-id>: <slice-id>"
```

Record `merge_commit`, mark slice `merged`, refresh heartbeat, and clean up successful slice worktrees/branches if repo policy allows:

```sh
git -C "$REPO" worktree remove "$SLICE_WT" --force
git -C "$REPO" branch -D "$SLICE_BRANCH"
```

After each merge, re-observe `head_commit`, `head_tree`, parents, and first-parent order through safe Git, then update `attestations/merge-chain.json`. Every first-parent commit after `base_commit` needs exactly one proof entry: `slice_merge` or `direct_reviewed_commit`. Missing proof, parent mismatches, or unverifiable `git merge-tree --write-tree` output fail closed.

If a merge conflict occurs, mark the slice `blocked`, leave the worktree for inspection, and surface it as a decomposition/coordination bug. Do not silently resolve conflicts.

Advance waves until every slice is `merged` or some slice is `blocked`. If some merged and others blocked, set status `partial` and surface it at the next gate or immediately if dependents cannot proceed.

## Step 5 - Integrate: Acceptance Tests And Validation

Run integration work against `$FEAT_WT`, not slice worktrees.

1. Run `test-verifier` with the story ACs, technical brief, slice plan, merged builder reports, and `$FEAT_WT`. It writes/runs acceptance tests and commits test changes if needed. Write `$RUN/artifacts/test-report.md`.
2. Observe the test step yourself by rerunning the named acceptance suite. Write `$RUN/evidence/test-verifier.json`.
3. Run `work-reviewer` with subject `test-verifier`. After it returns, before accepting or writing `$RUN/reviews/test-verifier.json`, guard `$FEAT_WT`. If the guard is clean, write the review and continue. If the guard is dirty or unverifiable, discard the reviewer output, write a guard-block report, mark the test-verifier step `blocked`, and do not continue to the panel.
4. Run the pre-PR review PANEL — two INDEPENDENT lenses, guard-serial on `$FEAT_WT` + the full diff (each gets story, brief, full diff, test report, builder reports):
   - `implementation-validator` — correctness / AC coverage / cross-slice integration / conventions. After it returns, before accepting or writing its result, guard `$FEAT_WT`. If the guard is clean, write `$RUN/artifacts/validation-report.md` and `run.json.validator`. If the guard is dirty or unverifiable, discard the reviewer output, write a guard-block report, mark the panel blocked, and set `run.json.validator` to `NO-GO` with its `report` pointing at the guard-block report.
   - `security-reviewer` — adversarial trust-boundary / injection / forgeable-provenance / secrets lens. After it returns, before accepting or writing `$RUN/reviews/security-reviewer.json`, guard `$FEAT_WT`. If the guard is clean, write `$RUN/reviews/security-reviewer.json` and `run.json.security_review`. If the guard is dirty or unverifiable, discard the reviewer output, write a guard-block report, mark the panel blocked, and set `run.json.security_review` to `BLOCK` with `review_ref` pointing at the guard-block report.
   Run the two lenses independently but sequentially enough to guard after each invocation. Do NOT feed one lens's output into the other. This two-lens panel is the pre-PR review; a downstream consumer (an adapter) relays this verdict rather than re-reviewing.

Combine the panel by STRICTEST verdict — this IS the Gate 3 verdict:

- Any reviewer guard-block from either lens blocks the panel; do not accept that reviewer output.
- Any NO-GO (validator) or BLOCK (security-reviewer) from EITHER lens -> NO-GO.
- A `security-reviewer` BLOCK is ALWAYS NO-GO — never downgraded to a nit, even for default-off features.
- Both clear (GO + PASS) -> GO, or GO-WITH-NITS if only MAJOR/NONBLOCKING findings remain.

On NO-GO -> route the top finding to the owning builder via a new fix slice worktree or, for test-only issues, a controlled integration-branch fix. Re-observe and re-run the PANEL up to `max_retries`.

If a test-only or remediation fix lands directly on `$FEAT_WT` instead of through a slice merge, treat it as a controlled direct-reviewed-commit event. Re-observe the exact parent, commit, tree, and canonical diff hash through safe Git; require a clean reviewed-worktree guard; write `attestations/direct-commits/<entry-id>.observation.json` plus the matching review-approval attestation; then append a `direct_reviewed_commit` entry to `attestations/merge-chain.json`.

## Gate 3 - Pre-PR

Present:

- Panel verdict (implementation-validator + security-reviewer), with the security-reviewer's traced ingresses + any BLOCK/NONBLOCKING findings.
- Acceptance-test table.
- Full diff stat against base: `git -C $FEAT_WT diff --stat origin/$BASE...HEAD`.
- Changed-file summary.
- Migration/schema/security/feature-flag/generated-code risk callouts.
- PR title/body preview.
- Evidence status for integrated branch.

Do not offer normal approval if observed integrated evidence is missing, empty, or red. A human can explicitly override; record the override in `run.json`.

On `changes`, route fixes to the appropriate slice/builder, re-observe, re-review, re-validate, and re-present.

## Step 6 - Draft PR

After Gate 3 approval only:

1. If `run.json.github_account` is non-empty, run `gh auth switch -h github.com -u "$GITHUB_ACCOUNT"` before any `gh` or authenticated GitHub remote command. If the account is unavailable or cannot access `origin`, stop with `status: partial` after preserving all validated implementation evidence and report the account/remote mismatch in `terminal_result.reason`.
2. Verify the selected account can see the repository before pushing: `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` or `git -C "$FEAT_WT" ls-remote --heads origin "$BASE"`.
3. Push the feature branch from `$FEAT_WT`: `git -C "$FEAT_WT" push -u origin HEAD`.
4. Build PR metadata from repo conventions and changed paths.
5. Write PR body to `$RUN/artifacts/pr-body.md`.
6. Create a draft PR with the repository's CLI conventions, preferably `gh pr create --draft --body-file`.
7. Record `pr_url` in `run.json` and set `status: completed`.

Never merge the PR. Never force-push unless the user explicitly approves.

## Step 7 - Final Summary

Report:

- Run id and external ref.
- Story and brief one-liners.
- Slice plan waves and per-slice merge status.
- Risk callouts.
- Acceptance-test table and pre-PR panel verdict, including security-reviewer verdict.
- PR URL, branch, feature worktree, and run dir.
- Any TODOs, blocked slices, overrides, missing tests, or manual follow-ups.

Do not auto-remove the feature worktree after PR creation; tell the engineer where it is.

## Resuming

On `/feature resume <run-id>` or a run with existing `run.json`, continue from the first incomplete point:

- Pending gate -> re-present the gate artifact or consume existing answer file.
- Accepted reviewed step -> skip.
- Rejected or absent reviewed step -> rerun.
- Merged slice -> skip.
- Running/review slice -> re-observe and re-review before rebuilding.
- Pending slice -> wait on dependencies, then dispatch in the next eligible wave.
- Blocked slice -> surface for decision.
- Existing PR URL -> do not recreate PR.

Never redo side effects that the manifest shows already happened.

## Scripted Mode

The factory is tracker-agnostic. External automation can monitor `run.json`, read artifacts, write gate answers, and mirror state elsewhere. The factory does not depend on any external queue.

Scripted runs still use the same gates, evidence, reviews, and PR approval flow. A script can pre-answer gates by writing answer files, but the factory must still record the gate outcomes and observed evidence.

## Guardrails

- Account for every gate. Interactive/headless modes stop for answers; autonomous mode may self-approve only under the Autonomous Mode rules.
- One feature branch and one PR per run.
- Never mutate the caller's checkout for implementation.
- Accept build/test work only on observed evidence plus `work-reviewer` APPROVE.
- Accept reviewer-designated outputs only after the reviewed-worktree guard returns clean.
- Do not trust gate, review, validator, security, merge, or PR status booleans alone; provenance-sensitive decisions require accepted attestations plus fresh observations.
- Subagents do not push, open PRs, or edit external systems.
- Bounded loops: `max_retries = 3` per reviewed subject/slice.
- Draft PR only. Humans review and merge.
- Do not fabricate paths, versions, test passes, branch names, or PR URLs.
- If evidence is thin, say so and stop or ask.
