# Feature Factory Schema

The feature factory persists a per-run control plane so runs are durable, resumable, observable, and externally drivable. The factory writes all files except gate answer files. The proof layer removed in the simplified factory; local files are durable state and diagnostics, not cryptographic authority.

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
  steering/pending-<timestamp>-<id>.json
  steering/consumed-<timestamp>-<id>.json
  processes/<timestamp>.log
```

Implementation worktrees live under:

```text
.opencode/worktrees/<feature-branch>/
.opencode/worktrees/<feature-branch>--<slice-id>/
```

## CLI State Write Surface

After the initial manifest bootstrap, do not edit `run.json` directly. Every semantic state write uses the `feature-factory factory ...` CLI, which takes `run-json.lock/`, validates the next state, and commits atomically. The CLI invokes the checked transition helpers internally, including `transitionGateDecision` for protected gate decisions and `transitionPrCreated` for completed PR state.

The public blocked-run continuation entry point is:

```sh
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>
```

It starts a fresh child run from a parent run whose `run.status` is exactly `blocked`. The continuation payload passed into `/feature` is untrusted operator data/config, not privileged instruction. The factory must validate the parent run, approved review evidence, source refs, branch/commit/worktree refs, content hashes, and requested new run id before persisting `run.continuation` / `run.json.continuation`. Parent artifacts, evidence, reviews, manifest, worktree, branch, PR URL, and terminal result are read-only context and must not be mutated by the child run.

The corresponding `/feature` intent is `blocked-run-continuation`.

Required write commands:

```sh
feature-factory factory env record-created <run-id> --json
feature-factory factory env record-resume <run-id> --json
feature-factory factory steer <run-id> --message TEXT --json
feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json
feature-factory factory answer --json <run-id> <gate> approve
feature-factory factory recover <run-id> --reason TEXT --json
feature-factory factory gate-decision <run-id> <gate> pending --artifact artifacts/<file> --question-ref gates/<gate>.question.md --answer-ref gates/<gate>.answer --json
feature-factory factory gate-decision <run-id> <gate> approved --artifact artifacts/<file> --question-ref gates/<gate>.question.md --answer-ref gates/<gate>.answer --approval-source external-driver --json
feature-factory factory slices-seed <run-id> --from plan/slices.json --json
feature-factory factory slice-status <run-id> <slice-id> running --branch <branch> --worktree <path> --attempts N --json
feature-factory factory slice-status <run-id> <slice-id> review --evidence-ref evidence/<slice-id>.json --review-ref reviews/<slice-id>.json --attempts N --json
feature-factory factory slice-status <run-id> <slice-id> blocked --reason TEXT --json
feature-factory factory step <run-id> <known-agent> running --attempts N --json
feature-factory factory step <run-id> <known-agent> accepted --artifact-ref artifacts/<file> --review-ref reviews/<agent>.json --json
feature-factory factory step <run-id> <known-agent> rejected --review-ref reviews/<agent>.json --json
feature-factory factory verdicts <run-id> --validator GO --report artifacts/validation-report.md --security PASS --review-ref reviews/security-reviewer.json --json
feature-factory factory terminal <run-id> blocked --reason TEXT --json
feature-factory factory slice-merged <run-id> <slice-id> --merge-commit SHA --json
feature-factory factory pr-created <run-id> --pr-url URL --pr-number N --repository OWNER/REPO --json
```

External drivers write only `gates/<gate>.answer`; they may use `feature-factory factory answer --json <run-id> <gate> approve` or write the answer file directly. The factory consumes answer files through `factory gate-decision`; approved file-sourced answers record `approval_source: "external-driver"` and consumed answer files are archived away from the canonical `gates/<gate>.answer` path.

`factory recover` is operator recovery for orphaned/stale running runs; do not use it to bypass active in-flight work or protected gates.

`feature-factory factory resume-check <run-id> --json` is the disrupted-resume recovery surface. It may restore a missing `.opencode/worktrees/<run>` worktree or write a terminal failure, but it must never re-scaffold a missing/disrupted `.opencode/factory/<run-id>` control plane. If `.opencode/factory/<run-id>/run.json` is missing, inaccessible, or invalid, return a synthetic non-durable terminal-shaped blocked result with `ok:false`, `durable:false`, `updated:false`, `recovered:false`, `status:"blocked"`, and `terminal_result.reason` explaining that no durable `terminal_result` can be written without forbidden re-scaffolding. Valid terminal manifests are returned unchanged. Valid non-terminal manifests recover a missing active worktree only when branch/base/merged-slice commit evidence reconciles with branch HEAD, the target is under `.opencode/worktrees`, no unsafe existing path would be overwritten, `git worktree add` succeeds, and final `checkWorktreeIdentity` plus HEAD checks match. Contradictory git evidence writes durable terminal `blocked`; unsafe or inaccessible local paths write durable terminal `needs-human`. Read-only `status`, `list`, `validate`, and `watch` do not call this implicitly.

`factory slice-status` updates only slices that already exist in `run.json.slices[]`; use `factory slices-seed` to create slices from `plan/slices.json`. `factory step` updates only step placeholders bootstrapped in the initial manifest.

Write `run.json` atomically: write a temp file, then rename. The current writer does not fsync the temp file or containing directory before rename; this is a conscious portability/speed tradeoff, so sudden power loss can still lose the most recent write even though readers never observe a partial JSON file.

`$RUN/run-json.lock/` is the ephemeral lock directory used by both foreground manifest writes and heartbeat ticks. `owner.json` records the current lock holder for diagnostics.

`$RUN/factory.lock` records the local factory session owner for diagnostics. It is not a heartbeat credential and it does not authorize `run.json` writes.

```json
{
  "schema_version": 1,
  "run_id": "app-123",
  "session_owner": "session-route-1",
  "updated_at": "2026-07-06T12:00:00Z"
}
```

## heartbeat.json And Locked Liveness Updates

`$RUN/heartbeat.json` is liveness-only display/recovery data for long orchestrator waits. It is written by the heartbeat helper, not by external drivers, and it does not authorize workflow state.

```json
{
  "schema_version": 1,
  "run_id": "app-123",
  "phase": "slice-review",
  "pid": 4242,
  "interval_ms": 30000,
  "last_tick_at": "2026-07-06T12:00:05Z"
}
```

Phase enum values and their conventional long-wait mapping:

- `spec-review` - `spec-writer` Task dispatch/wait and the following `work-reviewer` wait for the technical brief/spec review.
- `decomposition-review` - `work-decomposer` Task dispatch/wait and the following `work-reviewer` wait for the decomposition/plan review.
- `builder-wave` - concurrent builder `Task` dispatch/wait for a dependency wave.
- `slice-review` - `work-reviewer` wait for one or more slice reviews.
- `test-verifier` - `test-verifier` dispatch/wait.
- `test-rerun` - long orchestrator rerun of the named acceptance suite.
- `test-review` - `work-reviewer` wait for test-verifier evidence review.
- `implementation-validator` - implementation-validator dispatch/wait.
- `security-reviewer` - security-reviewer dispatch/wait.
- `remediation` - routed builder or integration/test remediation dispatch/wait.

`phase` is opaque display data. Use the enum above for consistency, but schema validation accepts any non-empty string.

Lifecycle rules:

- Start heartbeat immediately before a long `Task`/subagent/review/test wait while `run.status` is still `running`.
- Start it with `feature-factory factory heartbeat <run-id> --start --phase <phase> --json` and inspect it with `feature-factory factory heartbeat <run-id> --status --json`.
- Treat `heartbeat.json` as data, not authority. PID and sidecar contents alone never authorize freshness or workflow writes.
- Start heartbeat only when the manifest already shows real in-flight factory work via a `running` step or a `running`/`review` slice.
- Do not start heartbeat while the run is stopped at protected gates `story`, `brief`, or `pre_pr`. Pending gates are monitored through `run.json.gates`, not through heartbeat.
- Stop heartbeat in a `finally`/after-return path with `feature-factory factory heartbeat <run-id> --stop --json`. Stop is best-effort: it sends SIGTERM to a live recorded PID and writes a liveness stamp with `pid: null`.
- Before writing terminal `completed`, `blocked`, `partial`, or `needs-human` status, or before writing `terminal_result`, stop heartbeat if it is active. The durable terminal write is still controlled by the run-json lock and transition preconditions, not heartbeat state.

Long-wait heartbeat guard:

- Mark in-flight state first when heartbeat requires it. Before heartbeat starts, `run.json` must already show a `running` step, `running` slice, or `review` slice created through the relevant `feature-factory factory ...` state writer.
- Start heartbeat immediately before long `Task`/subagent dispatch/wait. Start-after-dispatch is too late; start-before-in-flight-state is invalid.
- For Step 2, phase `spec-review` brackets both the `spec-writer` Task dispatch/wait and the following `work-reviewer` dispatch/wait; phase `decomposition-review` brackets both the `work-decomposer` Task dispatch/wait and the following `work-reviewer` dispatch/wait. Each long wait gets its own start/stop cycle, and each stop happens in the after-return/`finally` path before the next semantic `run.json` / factory CLI state write.
- Stop heartbeat in the after-return/`finally` path when the wait completes, fails, or is abandoned.
- Do not perform the next semantic `run.json` / factory CLI state write while the long-wait heartbeat remains active; stop heartbeat, or verify inactive with `feature-factory factory heartbeat <run-id> --status --json`, before writing evidence refs, accepted/rejected steps, slice review/blocked/merged states, verdicts, terminal state, or PR-created state.
- Protected gates `story`, `brief`, and `pre_pr` stay heartbeat-free. Heartbeat is liveness-only, not authority, and the `phase` string remains opaque/non-enforced by validation beyond being non-empty.

Locked heartbeat-only manifest mutation protocol:

- Both the heartbeat helper and foreground manifest writers acquire `$RUN/run-json.lock/` before touching `run.json`.
- While heartbeat is active, the helper updates only `heartbeat_at` under that lock.
- Foreground semantic writes acquire the same lock and are serialized with heartbeat ticks.
- External drivers never write `factory.lock`, `heartbeat.json`, `run-json.lock/`, or `run.json`.

External monitoring semantics:

- Treat `heartbeat.json` plus `run.json.heartbeat_at` as liveness-only. Freshness is derived from `last_tick_at`, `interval_ms`, and whether the recorded PID is alive. A fresh heartbeat has age <= `max(2 * interval_ms, 120000ms)` and a live PID.
- Use pending gate status in `run.json.gates.*` for story/brief/pre-PR waits because heartbeat is intentionally absent there.
- Use terminal `run.status` plus `terminal_result` as the durable completion/blocking signal.

## Detached Run Diagnostics (Output-Only)

Diagnostics are emitted by `factory status`, `factory list`, `factory validate`, `factory watch`, and TUI data. They are output-only and do not change persisted `run.json`, `heartbeat.json`, or gate schemas.

Envelope shape:

```json
{
  "schema_version": 1,
  "checked_at": "2026-07-08T00:00:00.000Z",
  "authoritative": true,
  "status": "ok",
  "severity": "info",
  "classification": "healthy",
  "summary": "No diagnostics",
  "items": [
    {
      "condition": "stale-heartbeat",
      "classification": "recoverable",
      "severity": "warning",
      "status": "warning",
      "message": "Heartbeat has not advanced within the stale threshold.",
      "action": "Inspect the run log and validate durable state before resuming; do not restart blindly.",
      "authoritative": false,
      "checked_at": "2026-07-08T00:00:00.000Z",
      "evidence": {
        "source": "heartbeat.json",
        "liveness_only": true,
        "pid": 4242,
        "process_alive": false
      }
    }
  ]
}
```

Enums:

- `condition`: `stale-heartbeat`, `missing-heartbeat-process`, `missing-worktree`, `invalid-run-state`, `protected-gate`, `terminal-run`.
- `classification`: `healthy`, `recoverable`, `blocked`, `needs-human`, `terminal`, `invalid`. `invalid` is first-class.
- `status`: `ok`, `warning`, `error`.
- `severity`: `info`, `warning`, `error`, `critical`.

Aggregation:

- No items yields `classification: "healthy"`, `status: "ok"`, `severity: "info"`, and `summary: "No diagnostics"`.
- Primary item priority is classification `invalid` > `blocked` > `needs-human` > `recoverable` > `terminal` > `healthy`, severity `critical` > `error` > `warning` > `info`, status `error` > `warning` > `ok`, condition `invalid-run-state` > `missing-worktree` > `missing-heartbeat-process` > `stale-heartbeat` > `protected-gate` > `terminal-run`, then original detection order.
- Top-level `classification`, `status`, `severity`, and `summary` come from the primary item.

Condition mappings and operator actions:

- `stale-heartbeat` -> `recoverable` / `warning` / `warning`; liveness-only; threshold `max(2 * interval_ms, 120000ms)`; inspect logs and validate durable state before resuming, do not restart blindly.
- `missing-heartbeat-process` -> `recoverable` / `warning` / `warning`; heartbeat-helper PID only; liveness-only; the PID is not a detached opencode process.
- `missing-worktree` -> `blocked` / `error` / `error`; restore the worktree or recover from durable state.
- `invalid-run-state` -> `invalid` / `error` / `critical`; invalid JSON/schema/required sidecars; treat as untrusted until validation passes.
- `protected-gate` -> exactly `needs-human` / `warning` / `warning`; answer the pending protected gate (`story`, `brief`, or `pre_pr`) or stop the run.
- `terminal-run`: `completed`/`partial` -> `terminal` / `ok` / `info`; `blocked` -> `blocked` / `error` / `error`; `needs-human` -> `needs-human` / `warning` / `warning`; read `terminal_result`.

Heartbeat/PID/process semantics are liveness-only. `missing-heartbeat-process` refers to the heartbeat helper process recorded in `heartbeat.json`, not to a detached opencode process; no durable run-id-to-opencode-PID registry exists. Heartbeat evidence is always `authoritative: false` with `evidence.liveness_only: true`; PID liveness, process existence, `heartbeat.json`, and mutable `run.json` heartbeat fields cannot prove health or ownership.

Protected gates suppress stale-heartbeat and missing-heartbeat-process diagnostics because `story`, `brief`, and `pre_pr` waits are intentionally heartbeat-free. Valid terminal states suppress heartbeat/worktree liveness alarms.

## debug_snapshot Diagnostic State

`run.json.debug_snapshot` stores redacted diagnostic snapshots for debugging factory environment drift. It is optional and diagnostic-only. Older snapshot keys may still validate for old runs, but new writes use `debug_snapshot`.

```json
"debug_snapshot": {
  "created_with": {
    "collected_at": "2026-07-06T12:00:00Z",
    "event": "created",
    "diagnostic_only": true,
    "env": {
      "feature_factory_version": "0.1.0",
      "opencode_version": "1.17.13",
      "plugin_spec": "opencode-feature-factory",
      "resolved_models": {},
      "driver": {"kind": "cli", "name": "feature-factory"},
      "capabilities": {"git": true, "gh": true}
    }
  },
  "last_resumed_with": null,
  "resume_count": 0
}
```

Rules:

- `created_with` and `last_resumed_with` snapshots have `diagnostic_only: true`, `collected_at`, `event`, and a diagnostic environment object.
- `resume_count` is a non-negative integer incremented by resume recording.
- Use `feature-factory factory env record-created <run-id> --json` after initial manifest creation.
- Use `feature-factory factory env record-resume <run-id> --json` before a mutating resume step.
- Sensitive keys are omitted. Token-shaped or high-entropy credential values are replaced with `[redacted]`; raw `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, and `xoxb_*` values are invalid in persisted diagnostic state.
- If snapshot collection or validation fails, do not persist raw diagnostics.

## run.json

```json
{
  "schema_version": 1,
  "run_id": "app-123",
  "external_ref": "APP-123",
  "base_ref": "main",
  "base_commit": "0123456789abcdef",
  "branch": "app-123-short-slug",
  "worktree": "/abs/repo/.opencode/worktrees/app-123-short-slug",
  "github_account": "repo-owner-or-account",
  "mode": "interactive",
  "status": "running",
  "continuation": {
    "schema_version": 1,
    "kind": "blocked-run-continuation",
    "created_at": "2026-07-04T12:05:00Z",
    "operator_summary": "Continue from blocked validation finding.",
    "parent": {
      "run_id": "app-123",
      "status": "blocked",
      "run_ref": ".opencode/factory/app-123/run.json",
      "run_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "branch": "app-123-short-slug",
      "commit": "abc1234",
      "worktree": ".opencode/worktrees/app-123-short-slug"
    },
    "review": {
      "kind": "validator",
      "ref": "reviews/remediation-review.json",
      "hash": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "subject": "app-123-short-slug",
      "verdict": "APPROVE",
      "source": "run.validator.review_ref"
    },
    "target": {
      "run_id": "app-123-continuation-1",
      "branch": "app-123-continuation-1",
      "worktree": ".opencode/worktrees/app-123-continuation-1",
      "base_ref": "main",
      "base_commit": "fedcba9876543210"
    },
    "parent_artifacts": [
      {
        "kind": "story",
        "ref": "artifacts/story.md",
        "hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
      },
      {
        "kind": "technical_brief",
        "ref": "artifacts/technical-brief.md",
        "hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
      }
    ],
    "parent_evidence": [
      {
        "kind": "evidence",
        "ref": "evidence/test-verifier.json",
        "hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333"
      }
    ],
    "parent_reviews": [
      {
        "kind": "review",
        "ref": "reviews/implementation-validator.json",
        "hash": "sha256:4444444444444444444444444444444444444444444444444444444444444444"
      }
    ]
  },
  "created_at": "2026-07-04T11:45:00Z",
  "updated_at": "2026-07-04T12:00:00Z",
  "heartbeat_at": "2026-07-04T12:00:00Z",
  "max_parallel_slices": 3,
  "max_retries": 3,
  "review_tier": "strict",
  "debug_snapshot": {
    "created_with": {
      "collected_at": "2026-07-04T11:45:00Z",
      "event": "created",
      "diagnostic_only": true,
      "env": {"feature_factory_version": "0.1.0", "capabilities": {"git": true}}
    },
    "last_resumed_with": null,
    "resume_count": 0
  },
  "gates": {
    "story": {
      "status": "pending",
      "artifact": "artifacts/story.md",
      "question_ref": "gates/story.question.md",
      "answer_ref": "gates/story.answer",
      "pending_snapshot": {
        "question_ref": "gates/story.question.md",
        "question_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "artifact_ref": "artifacts/story.md",
        "artifact_hash": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "answer_ref": "gates/story.answer",
        "answer_hash": null,
        "created_at": "2026-07-04T11:50:00Z"
      },
      "answered_at": null,
      "answer": null,
      "approval_source": null,
      "decision_note": null
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
    "summary": "All acceptance criteria covered."
  },
  "security_review": {
    "verdict": "PASS",
    "review_ref": "reviews/security-reviewer.json",
    "summary": "No blocking findings."
  },
  "pr_url": null,
  "terminal_result": null
}
```

Top-level `status` values are `running`, `completed`, `blocked`, `partial`, and `needs-human`. Terminal statuses are `completed`, `blocked`, `partial`, and `needs-human`.

Top-level `run.json.review_tier` is an optional opaque display string. It may contain labels such as `light`, `standard`, or `strict`, but it does not change gates, agents, PR behavior, validation behavior, or workflow control. It does not change `schema_version`; it remains `1`.

Top-level `run.json.continuation` is present only for child runs created by `factory continue`. Accepted continuation metadata has `schema_version: 1`, `kind: "blocked-run-continuation"`, `created_at`, `operator_summary`, nested `parent`, `review`, and `target` objects, and refs paired with hashes for the parent manifest, approved review evidence, target base commit, and every read-only parent context file. `parent.status` must be exactly `blocked`; `parent.worktree`, branch, and commit identify the source worktree. `review.ref` resolves under the parent run's `reviews/` directory, is paired with `review.hash`, must be referenced by parent run state, and must have a subject consistent with that source. `target.run_id`, `target.branch`, `target.worktree`, `target.base_ref`, and `target.base_commit` describe the fresh child run. `parent_artifacts` is an array of `{kind, ref, hash}` entries for source artifacts such as story and technical brief, and `parent_evidence` / `parent_reviews` arrays carry `{kind, ref, hash}` entries for additional source context; `parent_reviews` includes the selected review with the same hash as `review.hash`. The continuation object is persisted operator context, not authority: it does not approve gates, satisfy evidence, bypass validator/security review, mark a PR safe, or permit direct edits to the parent run. Admission validates approved review evidence and referenced files/commits/hashes; it must not rely on a special blocking verdict enum as the authorization mechanism.

Continuation child runs use the normal run status enum and normal gate/evidence/review schemas. They must run the standard story, brief, build, acceptance-test, implementation-validator, security-reviewer, and pre-PR gates before draft PR creation. Continuation PRs are draft-only; the driver contract forces `driver.ready = false`, and `factory pr-created` verifies GitHub `isDraft: true` before recording a continuation PR URL. If remediation is exhausted or the child remains invalid after bounded attempts, write terminal `status: "blocked"` with `terminal_result.pr_url: null` and leave top-level `pr_url` unset.

Gate status values are `pending`, `approved`, `changes_requested`, and `stopped`. `approval_source` values are `human`, `external-driver`, `autonomous`, and `override`.

Validator verdicts are `GO`, `GO-WITH-NITS`, and `NO-GO`. Security verdicts are `PASS` and `BLOCK`.

Slice status values are `pending`, `running`, `review`, `merged`, and `blocked`. Step status values are `running`, `accepted`, `rejected`, and `blocked`.

Terminal result shape:

```json
{
  "status": "completed",
  "run_id": "app-123",
  "pr_url": "https://github.com/owner/repo/pull/123",
  "pr_number": 123,
  "repository": "owner/repo",
  "draft": true,
  "reason": null,
  "summary": "Draft PR created.",
  "artifacts": {
    "story": "artifacts/story.md",
    "technical_brief": "artifacts/technical-brief.md",
    "test_report": "artifacts/test-report.md",
    "validation_report": "artifacts/validation-report.md",
    "pr_body": "artifacts/pr-body.md"
  }
}
```

## Evidence And Review Files

Builder claim blocks are not accepted directly as durable truth. The orchestrator translates builder claim `status: pass|blocked` into observed evidence fields: `status` records the observed outcome, and `review_ready` is true only when the orchestrator observed the diff and required checks itself.

Remediation attempts use attempt-suffixed evidence refs. A rejected slice fix writes a new file such as `evidence/be-api.attempt-2.json` and updates `run.json.slices[].evidence_ref` to that attempt before re-review.

Slice evidence shape:

```json
{
  "subject": "be-api",
  "attempt": 2,
  "status": "pass",
  "review_ready": true,
  "head": "abc1234",
  "commands": [
    {"command": "npm test -- api", "status": "pass"}
  ]
}
```

Slice review shape:

```json
{
  "subject": "be-api",
  "verdict": "APPROVE",
  "required_fixes": []
}
```

`reviews/implementation-validator.json` shape:

```json
{
  "subject": "app-123-short-slug",
  "verdict": "GO",
  "summary": "All acceptance criteria are covered.",
  "required_fixes": []
}
```

Allowed implementation-validator verdicts are `GO`, `GO-WITH-NITS`, and `NO-GO`. The `subject` is the integrated feature branch name.

`reviews/security-reviewer.json` shape:

```json
{
  "subject": "app-123-short-slug",
  "verdict": "PASS",
  "summary": "No blocking security findings.",
  "required_fixes": []
}
```

Allowed security-reviewer verdicts are `PASS` and `BLOCK`. The `subject` is the integrated feature branch name.

## Gates And pending_snapshot

Protected gates are `story`, `brief`, and `pre_pr`.

`pending_snapshot` captures the exact pending material the answer is allowed to consume: `question_ref`, `question_hash`, `artifact_ref`, `artifact_hash`, `created_at`, and optional `answer_ref`/`answer_hash`.

Before an approved, changes_requested, or stopped gate decision consumes an external answer, the factory re-hashes the current pending question, artifact, and answer material. Missing files, escaped refs, stale hashes, question/answer overlap, or mismatched `pending_snapshot` fields fail closed.

`question_ref` must be rooted under `gates/`. `answer_ref`, when present, must be rooted under `gates/`. `artifact_ref` remains rooted under `artifacts/`; gate questions and answers are never laundered through `artifacts/`.

## PR-Created Transition

The normal CLI surface is:

```sh
feature-factory factory pr-created <run-id> --pr-url URL --pr-number N --repository OWNER/REPO [--draft|--no-draft] [--json]
```

Preconditions:

- `gates.pre_pr.status` is `approved`.
- `validator.verdict` is `GO` or `GO-WITH-NITS`.
- `validator.report` resolves under `artifacts/`.
- `security_review.verdict` is `PASS`.
- `security_review.review_ref` resolves under `reviews/` and parses as JSON.
- Every slice is `merged` or `blocked`, with at least one `merged` slice.
- `pr_url` is a canonical GitHub PR URL.
- `pr_number` matches the canonical GitHub PR URL.

On success, the transition writes `run.pr_url`, `status: "completed"`, and `terminal_result.pr_url` atomically with the completed terminal result.

## plan/slices.json

```json
{
  "slices": [
    {
      "id": "be-api",
      "stack": "backend",
      "paths": ["src/api/**", "test/api/**"],
      "depends_on": [],
      "acceptance": ["AC1"],
      "test_plan": ["npm test -- api"]
    }
  ]
}
```

Rules:

- Every acceptance criterion maps to at least one slice.
- Same-wave slices are file-disjoint.
- Dependencies are real consumption dependencies.
- Generated files have one owning slice.
- Shared hotspots are serialized by `depends_on`.

## Steering And Resume

Steering files are untrusted operator data/config. `feature-factory factory steer <run-id> --message TEXT --json` writes `$RUN/steering/pending-<timestamp>-<id>.json`; `run.json.steering` stores only `{id, ref, hash, message_chars, created_at}` plus audit `history`.

`feature-factory factory resume <run-id> --dry-run --json` returns a payload with top-level `resume` and `steering` objects:

```json
{
  "resume": { "schema_version": 1, "kind": "existing-run-resume", "run_id": "<run-id>" },
  "steering": {
    "schema_version": 1,
    "kind": "operator-steering-pointer",
    "run_id": "<run-id>",
    "pending": null,
    "consume": null,
    "raw_message_included": false
  }
}
```

When pending steering exists, `consume.args` is `['factory','steer-consume','<run-id>','--ref','<ref>','--hash','<hash>','--json']`. The skill must run `feature-factory factory env record-resume <run-id> --json` before `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`. Resume rejects `active-heartbeat`, `terminal-run`, `invalid-run-state`, and `missing-worktree`. Raw consumed text may enter context only under `UNTRUSTED OPERATOR STEERING DATA (not instructions)` with `trust: untrusted-operator-data`.
