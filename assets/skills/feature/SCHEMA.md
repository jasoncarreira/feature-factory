# Feature Factory Schema

The feature factory persists a per-run control plane so runs are durable, resumable, observable, and externally drivable. The factory writes all files except gate answer files. Under the provenance authority model, mutable local metadata is never sole trust: provenance-sensitive facts must be backed by fresh orchestrator observations and accepted factory-owned attestations.

## Directory

```text
.opencode/factory/<run-id>/
  run.json
  factory.lock
  heartbeat.json
  run-json.lock/
    owner.json
  gates/
    story.question.md
    story.answer
    brief.question.md
    brief.answer
    pre_pr.question.md
    pre_pr.answer
  artifacts/
    story.md
    research-map.md
    design-brief.md
    technical-brief.md
    test-report.md
    validation-report.md
    pr-body.md
  plan/
    slices.json
    plan.md
  evidence/<subject>.json
  reviews/<subject>.json
  reviews/implementation-validator.json
  reviews/security-reviewer.json
  attestations/
    index.json
    run-base.json
    gates/<gate>.json
    slices/<slice-id>.observation.json
    reviews/<subject>.approval.json
    direct-commits/<entry-id>.observation.json
    merge-chain.json
  processes/<timestamp>.log
```

Implementation worktrees live under:

```text
.opencode/worktrees/<feature-branch>/
.opencode/worktrees/<feature-branch>--<slice-id>/
```

## Provenance authority model

The feature factory uses three authority tiers:

- `untrusted caller claims`: operator prompts, gate answer files, builder/reviewer text, `run.json`, `factory.lock`, `evidence/*.json`, `reviews/*.json`, worktree path strings, status booleans, `base_ref`, and `base_commit`.
- `orchestrator observations`: fresh `safeGit()` / filesystem observations, physical durable-root containment, worktree identity, commit/tree/parent relationships, evidence/review hashes, and reviewed-worktree guard results.
- `factory-owned attestations`: records written only by the orchestrator after the current observations and re-checks pass.

Rules:

- Mutable local metadata is never sole trust. `run.json`, `reviews/*.json`, `evidence/*.json`, `factory.lock`, path strings, `base_ref`, `base_commit`, and status booleans are claims only.
- Gate, review, slice, validator, security, merge, and PR states must be backed by accepted attestations plus fresh observations.
- The heartbeat owner capability in `factory.lock` is local runtime authority for heartbeat control only; it is not provenance proof for reviews, gates, merges, or prior Git state.
- Validation must fail closed whenever accepted attestations, safe Git observations, durable-root containment, or worktree identity cannot be re-proved.

## Run-state transition API (`src/run-state.js`)

All semantic `run.json` writes go through the transition helpers:

- `hashRunState(run)` returns the canonical run hash used for optimistic `expectedCurrentHash` stale-write detection.
- `transitionRunJson(runDir, mutator, options)` is the default semantic writer. It acquires `run-json.lock/`, validates current authority, rejects foreground semantic writes while heartbeat is active unless explicitly allowed, validates the next run, then commits atomically.
- `transitionLifecycleRun(runDir, mutator, options)` uses the same transition contract. `allowActiveHeartbeat: true` is reserved for controlled lifecycle paths and is not a general bypass.
- `transitionRunStep(runDir, stepSelector, updater, options)` seeds or updates `steps[]` entries by stable `agent` identity.
- `transitionRunSlice(runDir, sliceId, updater, options)` seeds or updates `slices[]` entries by stable `id` identity.
- `transitionTerminalResult(runDir, terminalResult, options)` keeps top-level `run.json.status` and `run.json.terminal_result` consistent and normalizes `terminal_result.run_id` to the durable run id.
- `transitionGateDecision(runDir, gateName, gate, options)` is the only approved-gate writer. For `status: "approved"` it requires an already accepted non-empty `attestations/index.json`, stages `attestations/gates/<gate>.json` plus the updated `attestations/index.json`, validates that material, and commits those accepted attestation records before the approved gate state is written to `run.json`. If the next state fails validation, it rolls back the staged gate attestation/index files and leaves `run.json` unchanged.
- `mutateRunJsonLocked(runDir, mutator, options)` is compatibility-only when `attestations/index.json` is absent. It may write bootstrap-safe non-provenance-sensitive state only. It must fail closed if the current or next state claims approved gates, review-approved or merged slices, passing validator/security verdicts, PR URLs, or run-base fields without accepted attestations.

These helpers do not change heartbeat or external-driver semantics: `heartbeat.json` remains liveness-only, and external drivers still write only `gates/<gate>.answer`; approved file-sourced answers still record `approval_source: "external-driver"`.

## `attestations/`

Create attestation records only under the physical `$RUN/attestations/` root:

```text
$RUN/attestations/
  index.json
  run-base.json
  gates/<gate>.json
  slices/<slice-id>.observation.json
  reviews/<subject>.approval.json
  direct-commits/<entry-id>.observation.json
  merge-chain.json
```

Durable-root rules:

- `evidence/`, `artifacts/`, `reviews/`, and `attestations/` must physically resolve under `$RUN`.
- Symlinked durable roots are rejected.
- Worktree identity must be derived from current Git/worktree metadata and physical paths, not from string containment alone.
- Same-branch worktree records that are stale, missing, inaccessible, or resolve to a different path are conflicts unless identity is proven.

### Common attestation fields

Every accepted attestation uses the same common envelope and a canonical JSON hash:

```json
{
  "schema_version": 1,
  "authority_model": "feature-factory-provenance-v1",
  "authority": "feature-factory",
  "type": "run-base|slice-observation|review-approval|direct-reviewed-commit|gate-decision|merge-chain",
  "run_id": "app-123",
  "sequence": 1,
  "prev_hash": null,
  "subject": "run-base",
  "created_at": "2026-07-06T12:00:00Z",
  "observed_by": "feature-factory",
  "safe_git_policy": "safe-git-v1",
  "bindings": {},
  "attestation_hash": "sha256:<64 hex>"
}
```

`attestation_hash` is the canonical JSON hash of the attestation excluding `attestation_hash` itself.

### Accepted attestation graph (`index.json` + `prev_hash`)

Local attestation JSON is not trusted merely because it exists. An attestation is accepted only when all of the following are true:

- `attestations/index.json` is created only with the first accepted attestation and must never be a placeholder-empty file.
- The ref is under the physical `$RUN/attestations/` root.
- `attestations/index.json` contains the matching `ref`, `type`, `sequence`, `prev_hash`, and `attestation_hash`.
- The canonical JSON hash matches `attestation_hash`.
- `prev_hash` forms an unbroken chain from `attestations/run-base.json`.
- Every referenced artifact, evidence, and review hash still matches current file contents.
- Every currently observable Git/filesystem fact is re-observed through safe Git/filesystem checks and still matches the attested bindings.

Unknown types, hash mismatches, out-of-chain records, missing refs, stale worktrees, inaccessible worktrees, same-branch conflicts, or unverifiable observations fail closed.

Bootstrapping rules:

- `attestations/index.json.entries` must be a non-empty array whenever the file exists.
- The first accepted attestation in the graph must be the sequence-1 `attestations/run-base.json` with `prev_hash: null`.
- Approved gate decisions require that accepted run-base anchor already exist; gate decisions cannot bootstrap or precede the graph root.

### Safe Git policy

All provenance-sensitive Git facts must be observed through the centralized safe Git policy. Accepted attestations bind `safe_git_policy: "safe-git-v1"`. Validation re-observes commit existence, tree ids, parents, first-parent order, merge-tree results, and reviewed-worktree cleanliness through safe Git. Caller-controlled Git config, replace refs, hooks, fsmonitor, untrusted `GIT_*`, and similar environment influence are not authority.

### Run-base attestation (`attestations/run-base.json`)

- Type: `run-base`
- Must be sequence `1` with `prev_hash: null`.
- Binds `repo_root`, `run_dir`, `git_common_dir`, `feature_branch`, `feature_worktree`, `base_ref`, `base_commit`, and `base_tree`.
- Provides bounded local authority only: validation proves `base_commit` exists, `base_tree` matches, `base_commit` is an ancestor of the current feature HEAD, and if `base_ref` currently resolves then `base_commit` is an ancestor of that ref. It does not cryptographically prove the creation-time fact.

### Slice-observation attestation (`attestations/slices/<slice-id>.observation.json`)

- Type: `slice-observation`
- Binds `slice_id`, `attempt`, `branch`, physical `worktree`, `base_commit`, `slice_commit`, `slice_tree`, `evidence_ref`, and `evidence_hash`.
- Validation re-derives the worktree path, checks same-branch worktree conflicts, verifies commit/tree existence, and hashes the current evidence file.

### Review-approval attestation (`attestations/reviews/<subject>.approval.json`)

- Type: `review-approval`
- Binds `subject_type`, `subject`, `reviewer`, approving `verdict`, `review_ref`, `review_hash`, `evidence_ref`, `evidence_hash`, `subject_commit`, `subject_tree`, `guard_result_hash`, and `guard`.
- Required guard fields include `status: "clean"`, `safe_git_policy`, `worktree`, `head_commit`, `head_tree`, `dirty_paths: []`, and `hidden_index_paths: []`.
- Approval JSON without a matching accepted review/evidence hash, clean guard, correct subject commit/tree, or verifiable worktree/guard data is rejected.

### Direct-reviewed-commit attestation (`attestations/direct-commits/<entry-id>.observation.json`)

- Type: `direct-reviewed-commit`
- Binds `entry_id`, `purpose: "test" | "remediation" | "validation-fix"`, `commit`, `parent_commit`, `tree`, `diff_hash`, `evidence_ref`, `evidence_hash`, `producing_role`, and the matching review/guard hashes when present.
- Validation recomputes the tree, requires exactly one parent, and hashes the canonical `git diff-tree -r --full-index <parent> <commit>` output.

### Gate-decision attestation (`attestations/gates/<gate>.json`)

- Type: `gate-decision`
- Binds `gate`, `decision`, `approval_source`, `question_ref`, `question_hash`, `artifact_ref`, `artifact_hash`, and either `answer_ref` + `answer_hash` or `answer_text_hash`.
- `question_ref` must be rooted under `gates/`.
- `answer_ref`, when present, must be rooted under `gates/`.
- `artifact_ref` remains rooted under `artifacts/`; gate questions and answers are never laundered through `artifacts/`.
- Approved gate state in `run.json` is committed only after `transitionGateDecision()` writes and validates `attestations/gates/<gate>.json` plus the updated accepted `attestations/index.json` chain under the same transition lock; those accepted attestation records land before the approved gate state becomes durable.
- If approved-gate validation fails after staging those files, `transitionGateDecision()` must roll back the staged gate attestation/index files and leave `run.json` unchanged.
- Gate status booleans in `run.json` are bookkeeping only. Later validation must not trust status booleans alone.

### Merge-chain attestation (`attestations/merge-chain.json`)

- Type: `merge-chain`
- Binds `feature_branch`, `base_attestation_ref`, `base_attestation_hash`, `base_commit`, `head_commit`, `head_tree`, and ordered `entries[]`.
- Validation computes `git rev-list --first-parent --reverse <base_commit>..<head_commit>` and requires one proof entry per first-parent commit, in exact order.
- Any first-parent commit without proof fails closed.

`slice_merge` entry requirements:

- `commit` is the corresponding first-parent merge commit.
- Parents are exactly `[previous_first_parent_commit, slice_commit]`.
- The entry must reference accepted `slice-observation` and `review-approval` attestations whose hashes, commit/tree bindings, evidence hash, review hash, and clean guard all agree.
- `git merge-tree --write-tree <previous_first_parent_commit> <slice_commit>` must reproduce the actual merge tree.

`direct_reviewed_commit` entry requirements:

- `commit` is the corresponding first-parent commit.
- The parent list is exactly `[previous_first_parent_commit]`.
- The entry must reference accepted `direct-reviewed-commit` and `review-approval` attestations whose commit/tree/diff/evidence/review/guard bindings all agree.
- Unknown entry types, optional proof gaps, missing refs, hash mismatches, parent mismatches, or commit/tree mismatches fail closed.

### Local-only limits

- This model provides bounded local authority, not cryptographic remote attestation.
- Forged mutable local claims are rejected unless current Git/filesystem observations also match the accepted attestation graph.
- A coherent local rewrite of both files and Git history is outside this local-only model.

Write `run.json` atomically: write a temp file, then rename.

`$RUN/run-json.lock/` is the ephemeral lock directory used by both foreground manifest writes and heartbeat ticks. `owner.json` records the current lock holder for diagnostics.

`$RUN/factory.lock` is the internal owner/capability file for heartbeat authority. The factory writes a trusted heartbeat owner capability there and keeps it out of `heartbeat.json` and `factory heartbeat <run-id> --status --json`.

```json
{
  "schema_version": 1,
  "run_id": "app-123",
  "heartbeat_owner": "hb-owner-capability",
  "session_owner": "session-route-1",
  "updated_at": "2026-07-06T12:00:00Z"
}
```

## heartbeat.json and locked liveness updates

`$RUN/heartbeat.json` is a sidecar lease for long orchestrator waits. It is written by the internal heartbeat helper, not by external drivers.

```json
{
  "schema_version": 1,
  "run_id": "app-123",
  "token": "hb-token-1",
  "phase": "slice-review",
  "status": "running",
  "pid": 4242,
  "started_at": "2026-07-06T12:00:00Z",
  "last_tick_at": "2026-07-06T12:00:05Z",
  "stop_requested_at": null,
  "stopped_at": null,
  "interval_ms": 1000,
  "deadline_at": "2026-07-06T12:05:00Z",
  "stop_reason": null
}
```

Phase enum values:

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

Heartbeat status values: `active`, `running`, `stopping`, `stopped`, `error`.

Lifecycle rules:

- Start heartbeat immediately before a long `Task`/subagent/review/test wait while `run.status` is still `running`.
- Require the trusted heartbeat owner capability from `$RUN/factory.lock` for detached `--start`, internal `--foreground`, and internal `--once` paths.
- Treat `heartbeat.json` as data, not authority. Tokens, caller PID, and sidecar contents alone never authorize a heartbeat tick or lease start.
- Start heartbeat only when the manifest already shows real in-flight factory work via a `running` step or a `running`/`review` slice.
- Do not start heartbeat while the run is stopped at Gate 1 (`story`), Gate 2 (`brief`), or Gate 3 (`pre_pr`). Pending gates are monitored through `run.json.gates`, not through heartbeat.
- Stop heartbeat in a `finally`/after-return path before any foreground semantic `run.json` mutation.
- Before writing terminal `completed`, `blocked`, `partial`, or `needs-human` status, or before writing `terminal_result`, stop heartbeat with wait/force semantics and require a confirmed stopped lease.

Locked heartbeat-only manifest mutation protocol:

- Both the heartbeat helper and foreground manifest writers acquire `$RUN/run-json.lock/` before touching `run.json`.
- While heartbeat is active, the only allowed `run.json` mutation is the helper updating `heartbeat_at` under that lock.
- Foreground semantic writes must first stop heartbeat, wait for a confirmed `stopped`/`error` lease (or force-stop on timeout), then acquire the lock and write the next semantic `run.json` state.
- External drivers never write `factory.lock`, `heartbeat.json`, `run-json.lock/`, or `run.json`.

External monitoring semantics:

- Treat `heartbeat.json` plus `run.json.heartbeat_at` as liveness only. `heartbeat.json` is not authority.
- Use pending gate status in `run.json.gates.*` for story/brief/pre-PR waits because heartbeat is intentionally absent there.
- Use terminal `run.status` plus `terminal_result` as the durable completion/blocking signal; heartbeat must already be stopped before those terminal writes land.

## run.json

```json
{
  "schema_version": 1,
  "run_id": "app-123",
  "external_ref": "APP-123",
  "base_ref": "main",
  "branch": "app-123-short-slug",
  "worktree": "/abs/repo/.opencode/worktrees/app-123-short-slug",
  "github_account": "repo-owner-or-account",
  "mode": "interactive",
  "status": "running",
  "created_at": "2026-07-04T11:45:00Z",
  "updated_at": "2026-07-04T12:00:00Z",
  "heartbeat_at": "2026-07-04T12:00:00Z",
  "max_parallel_slices": 3,
  "max_retries": 3,
  "review_tier": {
    "selected": "strict",
    "source": "default",
    "risk_reasons": ["security_or_auth", "schema_or_persistence"],
    "rationale": "Defaulted to strict because the run touches auth and persistence risks."
  },
  "gates": {
    "story": {
      "status": "pending",
      "artifact": "artifacts/story.md",
      "question_ref": "gates/story.question.md",
      "answer_ref": "gates/story.answer",
      "answered_at": null,
      "answer": null,
      "approval_source": null,
      "decision_note": null
    },
    "brief": {
      "status": "pending",
      "artifact": "artifacts/technical-brief.md",
      "question_ref": "gates/brief.question.md",
      "answer_ref": "gates/brief.answer",
      "answered_at": null,
      "answer": null,
      "approval_source": null,
      "decision_note": null
    },
    "pre_pr": {
      "status": "pending",
      "artifact": "artifacts/validation-report.md",
      "question_ref": "gates/pre_pr.question.md",
      "answer_ref": "gates/pre_pr.answer",
      "answered_at": null,
      "answer": null,
      "approval_source": null,
      "decision_note": null,
      "override": null
    }
  },
  "steps": [
    {
      "agent": "spec-writer",
      "status": "accepted",
      "attempts": 1,
      "artifact_ref": "artifacts/technical-brief.md",
      "review_ref": "reviews/spec-writer.json",
      "evidence_ref": null
    }
  ],
  "slices": [
    {
      "id": "be-api",
      "stack": "backend",
      "depends_on": [],
      "status": "merged",
      "branch": "app-123-short-slug--be-api",
      "worktree": ".opencode/worktrees/app-123-short-slug--be-api",
      "attempts": 1,
      "evidence_ref": "evidence/be-api.json",
      "review_ref": "reviews/be-api.json",
      "merge_commit": "abc1234",
      "blocked_reason": null
    }
  ],
  "validator": {
    "verdict": "GO",
    "report": "artifacts/validation-report.md",
    "loops": 0
  },
  "security_review": {
    "verdict": "PASS",
    "review_ref": "reviews/security-reviewer.json",
    "loops": 0
  },
  "pr_url": null,
  "terminal_result": null
}
```

Authority note: this example shows bookkeeping state. `run.json` remains mutable local metadata; approved/merged/validator/security booleans, worktree paths, `base_ref`, `base_commit`, and `pr_url` require accepted attestations plus current observations before they count as provenance.

Run status values: `running`, `completed`, `blocked`, `partial`, `needs-human`.

Run mode values: `interactive`, `headless`, `autonomous`.

## review_tier

Top-level `run.json.review_tier` stores the selected review tier so later factory steps and resumed runs read the same durable choice without reparsing prior chat context. In v1 this metadata lives only at `run.json.review_tier`; do not mirror it into plan metadata.

`review_tier` is optional for backward compatibility with older runs. Adding this optional field does not change `schema_version`; it remains `1`.

```json
"review_tier": {
  "selected": "light|standard|strict",
  "source": "explicit|default",
  "risk_reasons": [
    "security_or_auth",
    "schema_or_persistence",
    "generated_or_owned_code",
    "external_system_policy",
    "dependency_or_supply_chain",
    "workflow_or_release",
    "destructive_or_broad_scope"
  ],
  "rationale": "Non-empty explanation of why this tier was selected."
}
```

Rules:

- `selected`: required when `review_tier` is present. Allowed values: `light`, `standard`, `strict`.
- `source`: required when `review_tier` is present. Allowed values: `explicit`, `default`.
- `risk_reasons`: required array when `review_tier` is present. Every entry must be one of `security_or_auth`, `schema_or_persistence`, `generated_or_owned_code`, `external_system_policy`, `dependency_or_supply_chain`, `workflow_or_release`, or `destructive_or_broad_scope`.
- `rationale`: required non-empty string when `review_tier` is present.
- Later factory steps should read the persisted selection from top-level `run.json.review_tier`.
- Later factory steps may update any selected tier to `strict` before a non-status state mutation if newly produced artifacts expose risky categories. Do not automatically downgrade a tier.

## github_account

Top-level `run.json.github_account` stores the GitHub account the factory should select before authenticated GitHub remote access and draft PR creation. The factory CLI derives it from `remote.origin.url` when the remote is hosted on GitHub, or from explicit `factory start --gh-account <account>`.

`github_account` is optional for backward compatibility with older runs and non-GitHub remotes. Adding this optional field does not change `schema_version`; it remains `1`.

Before pushing or creating a PR, run `gh auth switch -h github.com -u <github_account>` when this field is present. If that account is unavailable or cannot access `origin`, stop with `status: partial` and write a clear `terminal_result.reason` instead of trying another active account implicitly.

Gate status values: `pending`, `approved`, `changes_requested`, `stopped`.

Gate `approval_source` values: `human`, `external-driver`, `autonomous`, or `override`.

Slice status values: `pending`, `running`, `review`, `merged`, `blocked`.

Step status values: `running`, `accepted`, `rejected`, `blocked`.

Reviewer-designated agents are only `work-reviewer`, `implementation-validator`, and `security-reviewer`. After each invocation, before accepting or writing the reviewer result, check the reviewed worktree with `git -C <reviewed_worktree> status --porcelain=v1 --untracked-files=all` or equivalent `src/review-guard.js` semantics:

- `clean`: exit `0` and empty stdout
- `dirty`: exit `0` and non-empty stdout
- `unverifiable`: non-zero exit

These are guard/helper outcomes, not new normal review verdict enums. If the guard is `dirty` or `unverifiable`, discard the reviewer output and write a separate blocked report shape.

This schema documents post-run git-visible dirty-state detection only, not OS/process sandboxing. Ignored files, committed or reverted mutations, effects outside the reviewed worktree, and non-git-visible side effects remain out of scope.

## Gate Protocol

The factory writes question files and records pending gates in `run.json`. External drivers write only answer files.

Allowed answer file contents:

```text
approve
```

```text
stop
```

```text
changes: <specific requested change>
```

The factory consumes the answer, records it in `run.json.gates.<gate>`, and continues. Approved answers from gate answer files must use `approval_source: "external-driver"`; interactive chat approvals use `approval_source: "human"`; autonomous approvals use `approval_source: "autonomous"`. Do not store the answer file path in `approval_source`. If the answer file is missing in scripted mode, the factory stops after writing the pending gate.

One-writer rule: external drivers must not modify `run.json`, artifacts, evidence, reviews, plans, branches, or PRs.

## Autonomous Mode

Autonomous mode is explicit opt-in through `factory start --autonomous`. It keeps the same control plane but removes the external gate-answer relay when the factory has enough evidence to decide.

Rules:

- Gate question files are still written for auditability.
- Story and brief gates may be recorded as `approved` with `answer: "approve"`, `approval_source: "autonomous"`, and a concise `decision_note` only when the artifacts are internally complete and no human product/security/UX/external-policy decision remains.
- The pre-PR gate may be recorded as autonomously approved only when the strictest implementation-validator/security-reviewer panel verdict is clear. Validator NO-GO or security-reviewer BLOCK requires bounded remediation or terminal blocked/needs-human status.
- Autonomous remediation loops are bounded by `max_retries` or 3 if unset.
- Draft PR creation is allowed after autonomous pre-PR approval. Auto-merge is never allowed.

## terminal_result

External harnesses should read `run.json.terminal_result` instead of parsing gate internals when `status` is terminal.

```json
{
  "status": "completed",
  "run_id": "app-123",
  "pr_url": "https://github.com/org/repo/pull/123",
  "reason": null,
  "summary": "Implemented approval workflow and opened draft PR.",
  "artifacts": {
    "story": "artifacts/story.md",
    "technical_brief": "artifacts/technical-brief.md",
    "plan": "plan/plan.md",
    "validation_report": "artifacts/validation-report.md",
    "security_review": "reviews/security-reviewer.json",
    "pr_body": "artifacts/pr-body.md"
  }
}
```

For `blocked`, `partial`, or `needs-human`, set `reason` to the concise operator-actionable blocker and leave `pr_url` null unless a PR already exists.

If a reviewer guard block causes a terminal stop, use existing `run.status = "blocked"` and copy the guard-block `reason` into `terminal_result.reason`.

## plan/slices.json

```json
{
  "slices": [
    {
      "id": "be-api",
      "stack": "backend",
      "paths": ["src/server/api/", "src/server/domain/"],
      "depends_on": [],
      "acceptance": ["AC1"],
      "test_plan": ["npm test -- api.feature.test"]
    },
    {
      "id": "fe-screen",
      "stack": "frontend",
      "paths": ["src/ui/feature/"],
      "depends_on": ["be-api"],
      "acceptance": ["AC2", "AC3"],
      "test_plan": ["npm test -- feature-screen.test"]
    }
  ]
}
```

The dependency graph must be acyclic. A slice is eligible when every id in `depends_on` has status `merged`.

## Code-Level Validation

The CLI enforces this schema with `feature-factory factory validate [run-id]`. Validation covers `run.json`, gates, run slices, terminal results, accepted attestation graph semantics, physical durable-root/worktree identity, and `plan/slices.json` when present. Provenance-sensitive states fail closed unless backed by accepted attestations plus current safe-Git/filesystem observations. `factory status` and `factory answer` reject invalid `run.json`; `factory list` marks invalid runs instead of failing the whole listing.

`factory start --detached` writes stdout/stderr logs under `.opencode/factory/processes/` for external watchers.

## evidence/<subject>.json

For slices and reviewed test steps, the orchestrator writes observed evidence:

```json
{
  "subject": "be-api",
  "attempt": 1,
  "branch": "app-123-short-slug--be-api",
  "base_ref": "app-123-short-slug",
  "worktree": ".opencode/worktrees/app-123-short-slug--be-api",
  "status": "completed",
  "blocked_reason": null,
  "files_changed": ["src/server/api/foo.ts"],
  "diff_stat": "1 file changed, 40 insertions(+)",
  "diff_observed": true,
  "commands": [
    {"cmd": "git diff --stat app-123-short-slug...HEAD", "exit": 0, "summary": "1 file changed"}
  ],
  "tests": {
    "cmd": "npm test -- api.feature.test",
    "exit": 0,
    "observed": true,
    "skipped_reason": null
  },
  "commit": "abc1234",
  "observed_by": "feature-factory",
  "review_ready": true
}
```

`review_ready` requires status completed, non-empty observed diff, `diff_observed=true`, and tests observed passing or explicitly skipped with a reason.

## reviews/<subject>.json

```json
{
  "subject": "be-api",
  "reviewer": "work-reviewer",
  "verdict": "APPROVE",
  "attempt": 1,
  "findings": [
    {
      "severity": "blocker",
      "note": "Acceptance criterion AC1 is not implemented",
      "path": "src/server/api/foo.ts:42",
      "fix_owner": "backend-builder"
    }
  ],
  "required_fixes": [],
  "checked_against": ["output-contract", "technical-brief", "observed-evidence", "repo-guidelines"]
}
```

Verdict values for `work-reviewer` review files: `APPROVE`, `REJECT`.

Severity values: `blocker`, `major`, `minor`.

### Guard-block review report

Use a separate blocked report shape when a reviewer-designated agent returns but the reviewed worktree guard is `dirty` or `unverifiable`. Do not add new normal verdict enum values for this case.

```json
{
  "status": "blocked",
  "reason": "reviewer left reviewed worktree dirty (1 git-visible path)",
  "reviewer": "work-reviewer",
  "subject": "be-api",
  "attempt": 1,
  "reviewed_worktree": ".opencode/worktrees/app-123-short-slug--be-api",
  "review_output_valid": false,
  "dirty_paths": [
    {
      "path": "src/server/api/foo.ts",
      "original_path": null,
      "raw": " M src/server/api/foo.ts",
      "xy": " M",
      "index_status": " ",
      "worktree_status": "M",
      "staged": false,
      "unstaged": true,
      "deleted": false,
      "conflicted": false,
      "untracked": false
    }
  ],
  "guard": {
    "ok": false,
    "status": "dirty",
    "worktree": ".opencode/worktrees/app-123-short-slug--be-api",
    "command": "git -C .opencode/worktrees/app-123-short-slug--be-api status --porcelain=v1 --untracked-files=all",
    "exit_code": 0,
    "stdout": " M src/server/api/foo.ts\n",
    "stderr": "",
    "dirty_paths": [
      {
        "path": "src/server/api/foo.ts",
        "original_path": null,
        "raw": " M src/server/api/foo.ts",
        "xy": " M",
        "index_status": " ",
        "worktree_status": "M",
        "staged": false,
        "unstaged": true,
        "deleted": false,
        "conflicted": false,
        "untracked": false
      }
    ]
  }
}
```

Write the guard-block report at the relevant review ref (`reviews/<subject>.json`, `reviews/security-reviewer.json`, or `reviews/implementation-validator.json`). State updates use existing statuses:

- Reviewed step blocked (`spec-writer`, `work-decomposer`, or `test-verifier` via `work-reviewer`): set `run.json.steps[].status = "blocked"` and point `review_ref` at the guard-block report.
- Slice review blocked: set `slice.status = "blocked"`, set `slice.blocked_reason` from the guard-block `reason`, and point `slice.review_ref` at the guard-block report.
- `implementation-validator` guard block: set `run.json.validator.verdict = "NO-GO"` and point `run.json.validator.report` at the guard-block report.
- `security-reviewer` guard block: set `run.json.security_review.verdict = "BLOCK"` and point `run.json.security_review.review_ref` at the guard-block report.
- If the guard block stops the run, use existing `run.status = "blocked"` and `run.json.terminal_result.reason`.

## reviews/security-reviewer.json

The pre-PR security panel writes a separate review shape because its verdict feeds the Gate 3 panel directly rather than the normal `work-reviewer` approve/reject loop.

```json
{
  "subject": "integrated-feature",
  "reviewer": "security-reviewer",
  "verdict": "PASS",
  "attempt": 1,
  "ingresses_reviewed": ["src/server/api/foo.ts:12 POST /foo"],
  "findings": [
    {
      "severity": "block",
      "note": "Untrusted request metadata can forge a trusted source marker",
      "path": "src/server/api/foo.ts:42",
      "bypass": "POST /foo with source=system bypasses server-side ownership checks",
      "fix": "derive source from server auth context and ignore request body source"
    }
  ],
  "bypass_attempts": [
    {
      "attempt": "Forge trusted source marker through alternate endpoint",
      "result": "exploitable",
      "detail": "Alternate endpoint accepts source from request body"
    }
  ]
}
```

Security reviewer verdict values: `PASS`, `BLOCK`.

Security reviewer severity values: `block`, `nonblocking`.

When `security-reviewer` leaves `$FEAT_WT` dirty or unverifiable, discard its reviewer output and use the guard-block review report shape instead of this normal PASS/BLOCK payload.
