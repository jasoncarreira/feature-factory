---
name: feature
description: Use when the user invokes /feature or asks to take a feature, ticket, work item, or product idea end-to-end with a durable software-factory workflow. Persists state under .opencode/factory, decomposes work into dependency-ordered slices, builds slices in isolated worktrees, observes evidence, and gates story, implementation plan, and PR creation.
---

# Feature Factory

You are the orchestrator. Run in the main conversation, not as a subagent, so you can pause at approval gates, steer subagents, own durable state, own git/worktree/PR side effects, and keep the engineer or external driver in control.

Two principles make this a durable factory rather than a freeform session:

- State lives in files. Every run has a control plane at `$REPO/.opencode/factory/<run-id>/`: manifest, gates, plan, artifacts, observed evidence, and reviews. A dead session or next-day return resumes from `run.json`.
- Observe, do not trust. A subagent report is a claim. Before accepting build or test work, re-derive the diff and run the named checks yourself. Write observed evidence, then have `work-reviewer` judge that evidence.

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

## Reviewer read-only guard

Reviewer-designated agents are only:

- `work-reviewer`
- `implementation-validator`
- `security-reviewer`

After every reviewer-designated subagent invocation, and before accepting or writing that review result, check the reviewed worktree with `git -C <reviewed_worktree> status --porcelain=v1 --untracked-files=all` or the equivalent `src/review-guard.js` helper semantics.

Guard semantics:

- Exit `0` and empty stdout => clean; the reviewer output may be accepted normally.
- Exit `0` and non-empty stdout => dirty; the reviewer output is invalid and blocking.
- Non-zero exit => unverifiable; the reviewer output is invalid and blocking.

Reviewed worktree mapping:

- `work-reviewer` subject `spec-writer` -> `$REPO`
- `work-reviewer` subject `work-decomposer` -> `$REPO`
- `work-reviewer` subject `<slice-id>` -> `$SLICE_WT`
- `work-reviewer` subject `test-verifier` -> `$FEAT_WT`
- `implementation-validator` -> `$FEAT_WT`
- `security-reviewer` -> `$FEAT_WT`

If the guard is dirty or unverifiable, discard the reviewer output as invalid, write a guard-block report, and mark the relevant step, slice, or panel blocked. Do not auto-revert.

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
- Explicit `light` or `standard` is not automatically overwritten later.
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

Use the repo-local schema at `$REPO/.opencode/skills/feature/SCHEMA.md`. The factory CLI seeds this file before starting a run so the workflow stays self-contained under `external_directory: deny`. Write `run.json` atomically after every state change. Include `schema_version`, persist the selected review tier at top-level `run.json.review_tier`, and refresh `heartbeat_at` whenever you make progress.

One-writer rule:

- The factory writes `run.json`, artifacts, plans, evidence, reviews, gate question files, branches, commits, pushes, and PRs.
- External drivers write only `gates/<gate>.answer`.
- The factory consumes answer files, records the result in `run.json`, and continues.

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
- Initialize `run.json` with `schema_version`, `run_id`, `external_ref`, `status: running`, timestamps, `heartbeat_at`, `max_parallel_slices: 3`, `max_retries: 3`, top-level `review_tier`, empty `steps`, empty `slices`, gate refs, and null `validator`/`pr_url`.
- If `run.json` exists, this is a resume. Read it, backfill top-level `review_tier` before the next non-status state mutation when it is missing, and continue from the first incomplete point. Never redo side effects that `run.json` shows already happened.

Run the story agent and write `$RUN/artifacts/story.md`. If design input exists, run `design-interpreter` in parallel when useful and write `$RUN/artifacts/design-brief.md`.

### Gate 1 - Story

Present the normalized story, acceptance criteria, scope, assumptions, and any design summary. Write `gates/story.question.md`, mark the gate pending, and wait for an answer.

On approval, record `gates.story.status = approved`. Do not create or mutate external tickets unless the user explicitly asks in the interactive run.

## Step 1 - Research And Design

Fan out in parallel when possible:

- `codebase-researcher` with the approved story. Write `$RUN/artifacts/research-map.md`.
- `design-interpreter` with design input if not already complete. Write `$RUN/artifacts/design-brief.md`.

The research map must identify real files, patterns, tests, integration hotspots, generated code, migration/schema risks, and open questions. Do not proceed to spec from guessed paths.

## Step 2 - Spec (Reviewed)

Run `spec-writer` with the approved story, research map, and design brief. It produces a decision-complete technical brief. Write `$RUN/artifacts/technical-brief.md`.

Review the brief:

- Run `work-reviewer` with subject `spec-writer`, the brief, and its inputs.
- After it returns, before accepting or writing `$RUN/reviews/spec-writer.json`, guard `$REPO`.
- If the guard is clean, write `$RUN/reviews/spec-writer.json` and continue the normal APPROVE/REJECT loop.
- If the guard is dirty or unverifiable, discard the reviewer output, write a guard-block report to `$RUN/reviews/spec-writer.json`, mark the spec step `blocked`, and stop. Do not auto-revert.
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
- After it returns, before accepting or writing `$RUN/reviews/work-decomposer.json`, guard `$REPO`.
- If the guard is clean, write `$RUN/reviews/work-decomposer.json` and continue the normal APPROVE/REJECT loop.
- If the guard is dirty or unverifiable, discard the reviewer output, write a guard-block report to `$RUN/reviews/work-decomposer.json`, mark the decomposition step `blocked`, and stop. Do not auto-revert.
- It checks output contract, AC coverage, dependency correctness, file-disjoint same waves, and hotspot serialization.
- Loop on REJECT up to `max_retries`.
- Seed `run.json.slices[]` from `slices.json` with `status: pending`, `attempts: 0`, branch/worktree null, evidence/review refs null, and merge commit null.

### Gate 2 - Technical Brief And Slice Plan

Present the technical brief and the slice plan: waves, each slice's paths, acceptance coverage, dependency edges, tests, and serialized hotspots. The gate approves both implementation approach and parallelization plan.

On `changes`, rerun `spec-writer`, `work-decomposer`, or both depending on feedback, then re-present.

## Step 4 - Build Slices In Dependency Order

Create one feature branch/worktree. This is the single integration branch and final PR branch:

```sh
REPO=$(git rev-parse --show-toplevel)
BASE=<repo default base branch, e.g. main or development>
BRANCH=<run-id>-<short-slug>
FEAT_WT=$REPO/.opencode/worktrees/$BRANCH
git -C "$REPO" fetch origin "$BASE"
git -C "$REPO" worktree add -b "$BRANCH" "$FEAT_WT" "origin/$BASE"
```

If the branch/worktree already exists on resume, reuse it. Record `branch`, `base_ref`, and `worktree` in `run.json`. Keep the caller's checkout untouched. Do not `cd`; use `git -C` and absolute paths.

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

### Review Each Slice

Run `work-reviewer` with subject `<slice-id>`, the builder output, observed evidence, slice spec, technical brief, story, and relevant repo rules.

- After it returns, before accepting or writing `$RUN/reviews/<slice-id>.json`, guard `$SLICE_WT`.
- If the guard is dirty or unverifiable, discard the reviewer output, write a guard-block report to `$RUN/reviews/<slice-id>.json`, mark the slice `blocked`, record the blocker reason, and stop dispatching dependents. Do not auto-revert.

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

1. Push the feature branch from `$FEAT_WT`: `git -C "$FEAT_WT" push -u origin HEAD`.
2. Build PR metadata from repo conventions and changed paths.
3. Write PR body to `$RUN/artifacts/pr-body.md`.
4. Create a draft PR with the repository's CLI conventions, preferably `gh pr create --draft --body-file`.
5. Record `pr_url` in `run.json` and set `status: completed`.

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
- Subagents do not push, open PRs, or edit external systems.
- Bounded loops: `max_retries = 3` per reviewed subject/slice.
- Draft PR only. Humans review and merge.
- Do not fabricate paths, versions, test passes, branch names, or PR URLs.
- If evidence is thin, say so and stop or ask.
