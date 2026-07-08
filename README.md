# opencode-feature-factory

Hybrid opencode plugin plus CLI for a durable, scriptable feature workflow.

It ships:

- `/feature` command registration for opencode.
- A TUI sidebar panel that monitors active local factory runs.
- Feature-factory skill docs and control-plane schema.
- Specialized subagents for story, research, spec, decomposition, build, tests, review, and validation.
- A `feature-factory` CLI with install/doctor commands and local factory state helpers.

## Trust model and provenance authority

The factory uses three authority layers:

- `untrusted caller claims`: `run.json`, gate answers, `evidence/*`, `reviews/*`, worktree path strings, status booleans, `base_ref`, and `base_commit`.
- `orchestrator observations`: fresh safe Git/filesystem observations, physical durable-root containment, worktree identity, commit/tree/parent relationships, file hashes, and reviewed-worktree guard results.
- `factory-owned attestations`: canonical records under `.opencode/factory/<run-id>/attestations/`.

Accepted provenance requires `attestations/index.json`, canonical `attestation_hash` values, an unbroken `prev_hash` chain from `run-base`, and fresh re-observation of current Git/filesystem facts. Merge history is proven by `merge-chain.json` entries of type `slice_merge` or `direct_reviewed_commit`, not by `merged` / `approved` booleans alone.

`run.json.factory_provenance` is diagnostic-only creation/resume metadata. It helps debug the factory/opencode/plugin substrate, but it is not authority for gates, reviews, merges, or PR URLs. Persisted snapshots omit sensitive keys and redact token-shaped or high-entropy credential values, including GitHub PAT shapes (`ghp_*`, `github_pat_*`, `gho_*`), OpenAI keys (`sk-proj_*`, `sk-*`), Slack tokens (`xoxb_*`), bearer/JWT/AWS-shaped values, credential-bearing URLs, and similar high-entropy secrets.

Pending gates include `pending_snapshot` entries for `question_ref`, `question_hash`, `artifact_ref`, `artifact_hash`, and answer material. Gate answer consumption fails closed if current refs are missing, escaped, stale, or hash-mismatched.

PR URLs become trusted only through the provenanced `pr-created` flow. After a draft PR is created, the factory records `attestations/pr-created.json` with `feature-factory factory pr-created ...`; `run.pr_url` and `terminal_result.pr_url` must match that accepted attestation.

Guarantees:

- bounded local authority with centralized safe Git (`safe_git_policy: "safe-git-v1"`);
- durable-root and worktree identity validation;
- fail closed behavior when proof is missing, hash-mismatched, or unverifiable.

Limits:

- local-only, not cryptographic or tamper-proof;
- a coherent rewrite of local files and Git history is outside the model.

## Install Locally

From this package directory:

```sh
npm link
feature-factory install --local
feature-factory doctor --local
```

Then restart opencode. Config is loaded at startup.

Local installs configure the package root, not `src/plugin.js`, so opencode can discover both the server plugin and the TUI sidebar export.

## Package Surface

The published package exposes only the release-supported entry points declared in `package.json`:

- `import "opencode-feature-factory"` and `import "opencode-feature-factory/server"` load the server plugin registration.
- `import "opencode-feature-factory/tui"` loads the generated TUI sidebar module from `dist/tui.js`.
- The `feature-factory` bin runs the CLI.
- `import "opencode-feature-factory/cli"` remains available as the existing CLI subpath.

`dist/` is generated during packing and included in the published files; it is not edited or committed as source.

## Release Checks

Run the package gates before publishing or handing off a release branch:

```sh
npm run test:unit
npm run smoke:pack
npm run check
```

- `npm run test:unit` runs the deterministic unit test suite.
- `npm run smoke:pack` builds the generated TUI through `prepack`, creates an npm package tarball, installs it into a fresh temporary project, and verifies the published package, bin, exports, plugin registration, and TUI import surfaces.
- `npm run check` is the release-safe aggregate gate and currently runs unit tests followed by package smoke.

Package smoke intentionally avoids launching interactive opencode. It checks deterministic package and registration surfaces only, so failures point to publish/install/export regressions rather than interactive terminal state.

## Local Diagnostics

Use doctor checks when diagnosing a developer machine or local opencode install; keep them separate from release gates because they depend on local tools, config, credentials, and repository state:

```sh
feature-factory doctor --local
npm run doctor:local
```

Both commands run the local doctor path; the npm script is a convenience wrapper around `feature-factory doctor --local` for this checkout.

## Use In opencode

```text
/feature APP-123 add the missing approval workflow
```

## Configure Profiles

By default, agents use opencode's normal model resolution. You can override model and variant together through plugin `profiles`.

One profile for all feature-factory agents:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profile": {
          "model": "openai/gpt-5.5",
          "variant": "xhigh"
        }
      }
    ]
  ]
}
```

Role-based profiles:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "story": { "model": "openai/gpt-5.4", "variant": "medium" },
          "research": { "model": "openai/gpt-5.5", "variant": "high" },
          "design": { "model": "openai/gpt-5.5", "variant": "high" },
          "planning": { "model": "openai/gpt-5.5", "variant": "xhigh" },
          "builder": { "model": "openai/gpt-5.4", "variant": "xhigh" },
          "test": { "model": "openai/gpt-5.4", "variant": "medium" },
          "reviewer": { "model": "openai/gpt-5.5", "variant": "xhigh" },
          "security": { "model": "openai/gpt-5.5", "variant": "high" }
        }
      }
    ]
  ]
}
```

Exact agent profiles take precedence over role/default/top-level profiles:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "default": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "spec-writer": { "model": "openai/gpt-5.5", "variant": "xhigh" },
          "implementation-validator": { "model": "openai/gpt-5.5", "variant": "xhigh" },
          "security-reviewer": { "model": "openai/gpt-5.5", "variant": "xhigh" }
        }
      }
    ]
  ]
}
```

Supported roles: `story`, `research`, `design`, `planning`, `builder`, `test`, `reviewer`, `security`. The dedicated primary orchestrator agent, `feature-factory`, is mapped to `planning`. `security-reviewer` uses `profiles.security` when present and falls back to `profiles.reviewer` for compatibility.

Factory agents are configured with scoped non-interactive permissions (`bash`, `edit` where appropriate, `webfetch`, task delegation, and read/search tools) so `factory start --headless` cannot deadlock on opencode permission prompts. `external_directory` is explicitly denied. This permission scope applies to the factory command and factory agents, not to your global opencode sessions.

Before each `factory start`, the CLI seeds the feature skill into the target repo at `.opencode/skills/feature/SKILL.md` and `.opencode/skills/feature/SCHEMA.md`, and adds `.opencode/skills/feature/` to the repo-local `.git/info/exclude` when available. The schema is the authoritative control-plane reference for `run.json`, `factory.lock`, `heartbeat.json`, `plan/slices.json`, `evidence/*`, `reviews/*`, and `run-json.lock/`; keeping it repo-local lets agents read it without relaxing `external_directory: deny`.

Profile precedence is exact agent, then role, then `profiles.default`, then top-level `profile`, then opencode default. A profile may contain `model`, `variant`, or both.

### Reviewer Read-Only Guard

Reviewer-designated agents are `work-reviewer`, `implementation-validator`, and `security-reviewer`. They run with `edit: deny`, but that is not a runtime sandbox: they may still mutate through allowed `bash` or other tool paths.

Current enforcement is post-run git dirty-state detection only. After one of those agents returns, the orchestrator checks the reviewed worktree with `git -C <reviewed_worktree> status --porcelain=v1 --untracked-files=all` before accepting the result. If that status is dirty or unverifiable, the review is blocked and the reviewer output is discarded.

Limitations: this catches only git-visible changes in the reviewed worktree after the reviewer returns. It does not catch ignored files, committed or reverted changes, non-git-visible effects, or effects outside the reviewed worktree, and it does not provide OS/process sandboxing or prevention.

### Recommended Model Profile

For serious feature-factory runs, use the strongest model/effort where architectural mistakes are most expensive: planning, decomposition, review, and final validation. Builders should still run strong, but story normalization and acceptance-test writing can usually run lower.

Recommended mapping, using OpenAI model IDs as examples. If your opencode provider ID differs, keep the same shape and adjust the model strings.

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "story": { "model": "openai/gpt-5.4", "variant": "medium" },
          "research": { "model": "openai/gpt-5.5", "variant": "high" },
          "design": { "model": "openai/gpt-5.5", "variant": "high" },
          "planning": { "model": "openai/gpt-5.5", "variant": "xhigh" },
          "builder": { "model": "openai/gpt-5.4", "variant": "xhigh" },
          "test": { "model": "openai/gpt-5.4", "variant": "medium" },
          "reviewer": { "model": "openai/gpt-5.5", "variant": "xhigh" },
          "security": { "model": "openai/gpt-5.5", "variant": "high" }
        }
      }
    ]
  ]
}
```

Resolved agent profile:

| Agents | Model | Variant |
|---|---|---|
| `story-reader`, `story-writer` | `gpt-5.4` | `medium` |
| `codebase-researcher` | `gpt-5.5` | `high` |
| `design-interpreter` | `gpt-5.5` | `high` |
| `feature-factory`, `spec-writer`, `work-decomposer` | `gpt-5.5` | `xhigh` |
| `backend-builder`, `frontend-builder` | `gpt-5.4` | `xhigh` |
| `test-verifier` | `gpt-5.4` | `medium` |
| `work-reviewer`, `implementation-validator` | `gpt-5.5` | `xhigh` |
| `security-reviewer` | `gpt-5.5` | `high` |

Rationale:

- Planning/decomposition needs the highest reasoning budget because it determines architecture, slice boundaries, dependencies, and merge safety.
- Review/validation also needs the highest budget because it catches cross-slice correctness gaps before PR creation.
- Security review is isolated as its own profile so teams can tune adversarial review cost separately. Use `high` by default and raise to `xhigh` for high-risk auth, permission, prompt-injection, shell, SQL, or dependency changes.
- Builders benefit from high effort but can usually use a slightly cheaper model because the brief and slice spec constrain the work.
- Story reading/writing and acceptance-test authoring are important but narrower, so medium effort is usually sufficient.

### Anthropic Profile

This profile uses Sonnet for implementation/research/test work and Opus for high-judgment planning, decomposition, design interpretation, review, and validation. Because `story-reader` and `story-writer` use different strengths in this setup, it uses exact agent overrides instead of only role keys.

Adjust model IDs to the Anthropic models available in your opencode installation.

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "feature-factory": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "story-reader": { "model": "anthropic/claude-sonnet-5", "variant": "low" },
          "story-writer": { "model": "anthropic/claude-opus-4-8", "variant": "high" },
          "codebase-researcher": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "design-interpreter": { "model": "anthropic/claude-opus-4-8", "variant": "high" },
          "spec-writer": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "work-decomposer": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "backend-builder": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "frontend-builder": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "test-verifier": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "work-reviewer": { "model": "anthropic/claude-opus-4-8", "variant": "high" },
          "implementation-validator": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "security-reviewer": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" }
        }
      }
    ]
  ]
}
```

Resolved profile:

| Agent | Model | Variant |
|---|---|---|
| `story-reader` | Sonnet | `low` |
| `story-writer` | Opus | `high` |
| `codebase-researcher` | Sonnet | `medium` |
| `design-interpreter` | Opus | `high` |
| `feature-factory`, `spec-writer`, `work-decomposer` | Opus | `xhigh` |
| `backend-builder`, `frontend-builder` | Sonnet | `medium` |
| `test-verifier` | Sonnet | `medium` |
| `work-reviewer` | Opus | `high` |
| `implementation-validator` | Opus | `xhigh` |
| `security-reviewer` | Opus | `xhigh` |

Interactive `/feature` stores durable run state in the target repo:

```text
.opencode/factory/<run-id>/
.opencode/worktrees/<branch>/
```

## Scripted Mode

The scripted path is tracker-agnostic. Any external system can monitor the local factory state and write gate answers. The package does not know about any external queue.

Every `/feature` invocation starts with an intent gate. It classifies the request as `new-feature`, `resume`, `gate-answer`, `status`, `scripted-start`, or `pr-continuation` before mutating state. This prevents accidental restarts and lets external drivers answer gates with the same protocol as interactive users.

Start a run through opencode:

```sh
feature-factory factory start "APP-123 add the missing approval workflow"
```

Run against a specific repo and exit at the next gate for an external driver:

```sh
feature-factory factory start --repo /path/to/repo --headless "APP-123 add the missing approval workflow"
```

Run autonomously through the factory's own reviewed gates and open a draft PR when safe:

```sh
feature-factory factory start --repo /path/to/repo --autonomous "APP-123 add the missing approval workflow"
```

Run in the background for external watchers or CI-style adapters:

```sh
feature-factory factory start --repo /path/to/repo --headless --detached "APP-123 add the missing approval workflow"
```

Detached mode returns a PID and writes stdout/stderr to `.opencode/factory/processes/<timestamp>.log`.

Autonomous mode is explicit opt-in. It still writes gate question files, observed evidence, reviews, and `run.json`; it records story/brief approvals only when the artifacts are complete and unambiguous, decides pre-PR from the implementation-validator/security-reviewer panel, runs bounded remediation on NO-GO, and never auto-merges.

Monitor local state:

```sh
feature-factory factory list
feature-factory factory status <run-id> --json
feature-factory factory watch <run-id>
feature-factory factory watch --all
feature-factory factory validate <run-id>
feature-factory factory provenance
feature-factory factory provenance record-created <run-id> --json
feature-factory factory provenance record-resume <run-id> --json
feature-factory factory pr-created <run-id> --pr-url URL --pr-number N --pr-body-ref artifacts/pr-body.md --provider github --repository OWNER/REPO --remote origin --github-account ACCOUNT --head-branch BRANCH --head-commit SHA --base-ref REF --base-commit SHA --draft --json
```

`factory status`, `factory answer`, and `factory validate` apply code-level schema validation to `run.json`; `factory validate` also validates `plan/slices.json` when present. Invalid runs appear as `invalid` in `factory list` instead of crashing the whole list.

Clean up terminal runs after their PRs are merged or their artifacts are no longer needed:

```sh
feature-factory factory cleanup <run-id> --dry-run
feature-factory factory cleanup <run-id>
```

Cleanup removes `.opencode/factory/<run-id>`, recorded worktrees under `.opencode/worktrees/`, and recorded local branches. It only runs for terminal statuses (`completed`, `blocked`, `partial`, or `needs-human`) unless `--force` is supplied. Cleanup refuses to remove run directories outside `.opencode/factory`. For non-`completed` terminal runs, unmerged branches are preserved unless `--force` is supplied. Use `--dry-run` first when you want to preview what would be removed.

When opencode is running in the TUI on a session route, the sidebar also shows a `Feature Factory` panel for runs found under `.opencode/factory/*/run.json` in the current session directory or any nested repo below it. It lists active runs across those repos, including status, mode, pending gate, slice progress, validation/security verdicts, PR URL, terminal reason, and branch. Completed runs are hidden except for the most recent completed run.

For autonomous runs, external adapters should read `run.json.terminal_result` or `factory status <run-id> --json` after the run exits. Terminal statuses are `completed`, `blocked`, `partial`, and `needs-human`; successful PR creation records trusted `pr_url` only after the `pr-created` attestation validates.

### Provenance and draft PR recording

The factory records diagnostic substrate provenance explicitly:

```sh
feature-factory factory provenance record-created <run-id> --json
feature-factory factory provenance record-resume <run-id> --json
```

These commands update `run.json.factory_provenance.created_with`, `last_resumed_with`, and `resume_count` using redacted snapshots. They must not persist raw token-shaped or high-entropy credentials.

After Gate 3 and successful draft PR creation, the normal flow is to record the PR through the attested transition instead of editing the manifest directly:

```sh
feature-factory factory pr-created <run-id> \
  --pr-url URL \
  --pr-number N \
  --pr-body-ref artifacts/pr-body.md \
  --provider github \
  --repository OWNER/REPO \
  --remote origin \
  --github-account ACCOUNT \
  --head-branch BRANCH \
  --head-commit SHA \
  --base-ref REF \
  --base-commit SHA \
  --draft \
  --json
```

The command writes and validates `attestations/pr-created.json` plus `attestations/index.json` first. Only then can `run.pr_url`, `status: completed`, and `terminal_result.pr_url` be trusted. Missing or mismatched PR-created authority fails closed.

## Heartbeat helper and monitoring

The orchestrator has an internal heartbeat helper for long builder/reviewer/test waits:

```sh
feature-factory factory heartbeat <run-id> --status --json
```

Operational semantics:

- The factory keeps a trusted heartbeat owner capability in `$RUN/factory.lock`; detached `--start`, internal `--foreground`, and internal `--once` use it, but `factory heartbeat <run-id> --status --json` and `heartbeat.json` never expose it.
- During a long wait, the helper writes `$RUN/heartbeat.json` and advances `run.json.heartbeat_at` under the shared `run-json.lock/` lock.
- Treat `heartbeat.json` as data, not authority. External watchers should not infer ownership or freshness authority from PID/token/sidecar contents alone.
- Heartbeat starts only while the manifest already shows real in-flight factory work through a `running` step or a `running`/`review` slice.
- Heartbeat is intentionally absent while the factory is paused at the `story`, `brief`, or `pre_pr` gates; external monitors should read `run.json.gates` for those waits.
- Before any foreground semantic manifest write, especially terminal `completed|blocked|partial|needs-human` plus `terminal_result`, the helper must stop and confirm the stopped lease.
- External watchers should treat `heartbeat.json` as liveness only and use `factory status <run-id> --json` / `terminal_result` for durable workflow meaning.

## Detached run diagnostics

`factory status`, `factory list`, `factory validate`, `factory watch`, and the TUI expose detached-run diagnostics as output-only observations. Diagnostics do not change `run.json`, `heartbeat.json`, attestations, or gate schemas.

Diagnostic envelopes use this shape:

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
      "evidence": { "source": "heartbeat.json", "liveness_only": true }
    }
  ]
}
```

Condition enum: `stale-heartbeat`, `missing-heartbeat-process`, `missing-worktree`, `invalid-run-state`, `invalid-authority`, `unverifiable-authority`, `protected-gate`, `terminal-run`. Classification enum: `healthy`, `recoverable`, `blocked`, `needs-human`, `terminal`, `invalid`; `invalid` is first-class and must not be collapsed into `blocked`. Status enum: `ok`, `warning`, `error`. Severity enum: `info`, `warning`, `error`, `critical`.

When multiple diagnostic items are present, the top-level `classification`, `status`, `severity`, and `summary` come from one primary item using this priority order: classification `invalid` > `blocked` > `needs-human` > `recoverable` > `terminal` > `healthy`; severity `critical` > `error` > `warning` > `info`; status `error` > `warning` > `ok`; condition `invalid-run-state` > `invalid-authority` > `unverifiable-authority` > `missing-worktree` > `missing-heartbeat-process` > `stale-heartbeat` > `protected-gate` > `terminal-run`; then original detection order.

Operator-facing condition mapping:

| Condition | Classification / status / severity | Operator action |
|---|---|---|
| `stale-heartbeat` | `recoverable` / `warning` / `warning` | Inspect logs and validate durable state before resuming; do not restart blindly. |
| `missing-heartbeat-process` | `recoverable` / `warning` / `warning` | Treat as heartbeat-helper liveness only; inspect logs/state before deciding recovery. |
| `missing-worktree` | `blocked` / `error` / `error` | Restore the provenance-validated trusted worktree or clean up/recover from validated durable state. |
| `invalid-run-state` | `invalid` / `error` / `critical` | Treat `run.json` or required sidecars as untrusted until schema/JSON validation passes. |
| `invalid-authority` | `invalid` / `error` / `critical` | Do not trust contradictory mutable claims; inspect accepted attestations and current observations. |
| `unverifiable-authority` | `blocked` / `error` / `critical` | Restore missing proof or inspect inaccessible proof before trusting status, branch, PR, gate, or worktree claims. |
| `protected-gate` | `needs-human` / `warning` / `warning` | Answer the pending protected gate (`story`, `brief`, or `pre_pr`) or stop the run. |
| `terminal-run` | `completed`/`partial` => `terminal` / `ok` / `info`; `blocked` => `blocked` / `error` / `error`; `needs-human` => `needs-human` / `warning` / `warning` | Read `terminal_result`; no heartbeat/worktree liveness action is required for valid terminal runs. |

Heartbeat and PID evidence is liveness-only, never authority. `missing-heartbeat-process` refers to the heartbeat helper PID recorded in `heartbeat.json`, not a detached opencode process; there is no durable run-id-to-opencode-PID registry. PID checks are race-prone and may be affected by PID reuse, so diagnostic items from heartbeat/process evidence carry `authoritative: false` and `evidence.liveness_only: true`.

Protected gate waits are intentionally heartbeat-free. A pending protected `story`, `brief`, or `pre_pr` gate uses the exact tuple `needs-human` / `warning` / `warning` everywhere and suppresses stale-heartbeat and missing-heartbeat-process alarms. Valid terminal states suppress heartbeat/worktree liveness alarms.

Diagnostics preserve the provenance authority model and fail closed. `diagnostics.authoritative` is true only when `run.json` schema validation and run-authority checks required for trusted fields pass. Heartbeat data, PID liveness, process existence, worktree strings, status booleans, and mutable `run.json` claims are not enough to infer a healthy run. Invalid or unverifiable status responses return a minimal fail-closed envelope and must not trust or emit PR, gate, branch, or worktree claims that require accepted attestations plus fresh observations.

Answer gates by writing the same files an interactive user would approve through chat:

```sh
feature-factory factory answer <run-id> story approve
feature-factory factory answer <run-id> brief "changes: split frontend and backend slices"
feature-factory factory answer <run-id> pre_pr stop
```

The factory writes:

- `.opencode/factory/<run-id>/run.json`
- `.opencode/factory/<run-id>/gates/<gate>.question.md`
- artifacts, plan, evidence, review files, gate `pending_snapshot` state, and accepted attestations

External drivers write only:

```text
.opencode/factory/<run-id>/gates/<gate>.answer
```

Allowed answers:

```text
approve
changes: <specific requested change>
stop
```

After writing an answer, resume by invoking `/feature resume <run-id>` or:

```sh
feature-factory factory start --repo /path/to/repo --headless "resume <run-id>"
```

External driver loop:

1. Start with `factory start --repo <repo> --headless "<prompt or resume>"`.
2. Read `.opencode/factory/<run-id>/gates/<gate>.question.md`.
3. Decide externally.
4. Write the answer with `factory answer`.
5. Resume with `factory start --headless "resume <run-id>"`.

This lets end users run the workflow interactively from opencode, while automated systems can monitor and drive it without the factory depending on any one tracker.

Thin autonomous adapter loop:

1. Claim external work.
2. Check out the repo.
3. Run `feature-factory factory start --repo <repo> --autonomous "<work order>"`.
4. Read `run.json.terminal_result`.
5. Mirror `status`, `pr_url`, and `reason` back to the external system.

## Doctor

`feature-factory doctor` checks the local opencode/plugin environment before a long run:

```sh
feature-factory doctor --local
feature-factory doctor --local --profiles
feature-factory doctor --local --provider-smoke
```

It checks opencode run support, plugin registration, command/agent/skill registration, provider auth visibility, `HOME`, `git`, `gh`, base branch detection, and whether `.opencode/factory/` / `.opencode/worktrees/` are gitignored.

`--provider-smoke` runs a lightweight opencode call for each configured model provider. Use it when you want stronger credential validation and accept that it may consume model quota.

## Slice Execution Model

The factory decomposes an approved technical brief into a dependency DAG:

```text
.opencode/factory/<run-id>/plan/slices.json
```

Each slice records `id`, `stack`, `paths`, `depends_on`, `acceptance`, and `test_plan`.

The orchestrator computes waves from `depends_on`:

- A slice can run when all dependencies are `merged`.
- Same-wave slices must be file-disjoint.
- Shared hotspots are serialized into later waves.
- Up to `max_parallel_slices` run concurrently.
- Each slice builds in its own `.opencode/worktrees/<feature-branch>--<slice-id>` worktree.
- The orchestrator observes diff/tests, runs `work-reviewer`, then merges approved slices serially into the feature worktree.

This matches the original software-factory pattern while keeping the package tracker-agnostic.
