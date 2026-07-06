# Feature Factory Schema

The feature factory persists a per-run control plane so runs are durable, resumable, observable, and externally drivable. The factory writes all files except gate answer files.

## Directory

```text
.opencode/factory/<run-id>/
  run.json
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
  reviews/security-reviewer.json
  processes/<timestamp>.log
```

Implementation worktrees live under:

```text
.opencode/worktrees/<feature-branch>/
.opencode/worktrees/<feature-branch>--<slice-id>/
```

Write `run.json` atomically: write a temp file, then rename.

## run.json

```json
{
  "schema_version": 1,
  "run_id": "app-123",
  "external_ref": "APP-123",
  "base_ref": "main",
  "branch": "app-123-short-slug",
  "worktree": "/abs/repo/.opencode/worktrees/app-123-short-slug",
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

Gate status values: `pending`, `approved`, `changes_requested`, `stopped`.

Gate `approval_source` values: `human`, `external-driver`, `autonomous`, or `override`.

Slice status values: `pending`, `running`, `review`, `merged`, `blocked`.

Step status values: `running`, `accepted`, `rejected`, `blocked`.

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

The CLI enforces this schema with `feature-factory factory validate [run-id]`. Validation covers `run.json`, gates, run slices, terminal results, and `plan/slices.json` when present. `factory status` and `factory answer` reject invalid `run.json`; `factory list` marks invalid runs instead of failing the whole listing.

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
