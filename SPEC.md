# Feature Factory Improvement Spec

Ideas to implement after reviewing `oh-my-openagent`, adapted for this package's tracker-agnostic feature factory.

## Goals

- Preserve the factory as a generic opencode workflow, not tied to any tracker.
- Improve installability, observability, model routing, and scripted operation.
- Keep the core state protocol simple: `.opencode/factory/<run-id>/run.json` plus gate answer files for human/headless runs and `terminal_result` for autonomous harnesses.
- Avoid autonomous loops that bypass evidence, reviewer verdicts, security review, bounded remediation, or the human PR review boundary.
- Fail early on missing credentials, missing CLIs, unsupported opencode surfaces, or PR prerequisites before a long build wastes time.

## Trust-model contract

The proof layer removed in the simplified factory. The durable contract is local state plus transition-time checks, not a cryptographic or tamper-proof authority system.

Current guarantees:

- `run.json`, gate answers, `evidence/*`, `reviews/*`, and `terminal_result` are durable local workflow state.
- Semantic manifest writes go through locked transition helpers so stale writers fail instead of overwriting newer state. `transitionGateDecision` owns approved gate writes, and `transitionPrCreated` owns completed PR state writes.
- Pending gates carry a `pending_snapshot` with `question_ref`, `question_hash`, `artifact_ref`, `artifact_hash`, and answer refs/hashes. Gate answer consumption must fail closed when refs are missing, escaped, stale, or hash-mismatched.
- The normal draft PR flow calls `feature-factory factory pr-created` after successful PR creation. That transition requires `pre_pr` approval, validator `GO` or `GO-WITH-NITS` with a report file, security `PASS` with a review file, completed slice state, and a canonical GitHub PR URL before writing `run.pr_url` and `terminal_result.pr_url`.
- Blocked-run continuation uses `feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>`. The continuation payload is untrusted operator data/config, not privileged instruction; admission validates a parent run whose status is exactly `blocked`, validates recognized subject-consistent approved review evidence without relying on a special blocking verdict enum, persists read-only parent context in `run.json.continuation`, and then runs the ordinary gates/evidence/review/PR-created checks for the child.
- Diagnostic `run.json.debug_snapshot` records redacted factory/opencode/plugin creation and resume snapshots for debugging only. Snapshot persistence must omit sensitive keys and redact token-shaped/high-entropy credential values such as `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, `xoxb_*`, bearer/JWT/AWS-shaped values, credential-bearing URLs, and similar secrets.

Explicit limits:

- Local-only, not cryptographic or tamper-proof.
- A coherent rewrite of local files and Git history is outside the model.

## 1. Category-Based Model Routing

Current state: plugin options support `profile` plus `profiles.default`, exact agent names, and role keys. Each profile may contain `model`, `variant`, or both.

Implementation status: role/exact/default profile routing is implemented in `src/plugin.js`. Operator plugin options override shipped agent frontmatter defaults. Keep this invariant; it prevents package defaults from trapping operators on the wrong model or effort level.

Improve the public interface by documenting roles as categories:

- `story`: `story-reader`, `story-writer`
- `research`: `codebase-researcher`
- `design`: `design-interpreter`
- `planning`: `feature-factory`, `spec-writer`, `work-decomposer`
- `builder`: `backend-builder`, `frontend-builder`
- `test`: `test-verifier`
- `reviewer`: `work-reviewer`, `implementation-validator`, `security-reviewer`

Implementation notes:

- Keep exact-agent overrides as highest precedence.
- Operator config must override shipped agent frontmatter defaults.
- Add `feature-factory doctor --profiles` to print resolved agent -> model/variant mapping.

Future optional shape:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "planning": { "model": "openai/gpt-5.5", "variant": "xhigh" },
          "builder": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "reviewer": { "model": "openai/gpt-5.5", "variant": "xhigh" }
        }
      }
    ]
  ]
}
```

Recommended production profile:

| Agents | Model | Variant |
|---|---|---|
| `story-reader`, `story-writer` | `gpt-5.4` | `medium` |
| `codebase-researcher` | `gpt-5.5` | `high` |
| `design-interpreter` | `gpt-5.5` | `high` |
| `feature-factory`, `spec-writer`, `work-decomposer` | `gpt-5.5` | `xhigh` |
| `backend-builder`, `frontend-builder` | `gpt-5.4` | `xhigh` |
| `test-verifier` | `gpt-5.4` | `medium` |
| `work-reviewer`, `implementation-validator`, `security-reviewer` | `gpt-5.5` | `xhigh` |

Rationale: use the highest model/variant for planning, decomposition, review, and validation; use strong but cheaper builders; keep story normalization and acceptance-test authoring at medium unless a run proves they need more.

Anthropic profile to document and keep supported:

| Agent | Model class | Variant |
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

This profile requires exact agent overrides because `story-reader` and `story-writer` intentionally use different model/variant settings.

## 2. Credential-Aware Doctor And Capability Detection

Current `doctor` only checks basic config and CLIs.

Implementation status: first pass implemented. It checks opencode run flags, plugin registration, command/agent/skill registration, `HOME`, model provider prefixes, provider auth visibility through opencode auth/env heuristics, optional provider smoke, `git`, `gh`, `gh auth`, base branch detection, and gitignore state.

`factory start` also seeds `.opencode/skills/feature/SKILL.md` and `.opencode/skills/feature/SCHEMA.md` into the target repo before invoking opencode, and excludes `.opencode/skills/feature/` through the repo-local `.git/info/exclude` when available. This keeps the authoritative control-plane schema readable inside the repo while `external_directory` remains denied.

This is the highest-leverage next item. It directly prevents long factory runs from failing late because the subprocess cannot authenticate a provider, cannot open a PR, or lacks the expected opencode run surface.

Add checks for:

- opencode installed.
- opencode version supports `opencode run --command` and `--dir`.
- plugin is configured.
- plugin assets are resolvable.
- command registration works by loading `src/plugin.js`.
- the `feature-factory` primary agent and all 12 subagents are registered.
- feature skill path exists.
- configured models are present and provider-prefixed.
- configured model providers are authenticated and usable, not merely well-formed strings.
- scripted subprocess environment has the credentials opencode needs.
- `HOME` and provider credential env vars survive from the driver into `opencode run`.
- `git` is available.
- `gh` is available if PR creation is desired.
- `gh auth status` succeeds before any run expected to create a PR.
- current repo has a base branch or detectable default branch.
- `.opencode/factory/` and `.opencode/worktrees/` are ignored by git.

Provider auth checks should be pragmatic and fail-safe:

- Read resolved models from plugin options and opencode config.
- Extract provider prefixes from model ids.
- For each provider, check known auth surfaces when possible.
- Prefer an opencode-native provider/auth command if one exposes machine-readable status.
- Otherwise perform a lightweight `opencode run` smoke in a temp directory with the resolved model and a harmless prompt, using the same env that scripted runs will use.
- Mark 401/auth failures as `missing`, not `warn`.
- Do not print secret values.

Possible output:

```text
ok: opencode CLI 1.17.13
ok: plugin configured
ok: /feature command registered
ok: feature-factory primary agent registered
ok: 12 subagents registered
ok: provider openai authenticated for openai/gpt-5.5
missing: provider anthropic credentials for anthropic/claude-sonnet-4-6
warn: gh CLI missing; draft PR creation will fail
missing: .opencode/worktrees is not gitignored
```

Capability detection belongs with doctor, not as a later standalone feature. Detect available tools and expose them through doctor/status output:

- `git`
- `gh`
- opencode version/features
- provider authentication
- LSP availability
- AST search tools
- package manager commands
- test scripts
- default base branch

Use cases:

- Warn before a long run fails at PR creation.
- Agents can prefer LSP/AST tools if available.
- Scripted drivers can decide whether a run is safe to start.
- Factory state can record what substrate built the run.

Avoid hard dependencies on optional tools.

## 3. Intent Gate

Add explicit intent classification at the beginning of `/feature`.

Implementation status: prompt-level intent gate implemented in `assets/command/feature.md` and `assets/skills/feature/SKILL.md`. It classifies before Step 0 and defines actions for each intent. Remaining work is live-run validation.

Boundary note: this is prompt-level enforcement. The hard guarantee for scripted read-only inspection is the CLI surface (`feature-factory factory status/list/watch`), not asking `/feature` for status. The intent gate is a safety belt for interactive and headless orchestrator runs; external drivers should use the read-only CLI when they need mechanically inert inspection.

Classify the invocation as one of:

- `new-feature`: start a new factory run.
- `resume`: resume existing run by id or latest run.
- `gate-answer`: answer a pending gate.
- `status`: inspect current run state.
- `scripted-start`: start from an already structured external work order.
- `autonomous-start`: start or resume from an explicit autonomous driver prompt.
- `pr-continuation`: continue only PR preparation for an already-built branch.
- `blocked-run-continuation`: start a new child run from a terminal blocked parent by using `factory continue` metadata.

Why:

- Prevent accidental restart when a run already exists.
- Make scripted workflows more reliable.
- Avoid treating status/answer prompts as implementation requests.

Implementation notes:

- The `/feature` command should instruct the orchestrator to classify intent before Step 0.
- If ambiguous, ask one short clarification question.
- If a pending gate exists and user input looks like `approve`, `stop`, or `changes:`, write it to the pending gate answer file.
- Bare `approve` / `stop` / `changes:` is valid only when exactly one run has a pending gate. If multiple runs are pending, ask for or require an explicit run id.
- This is the natural adapter boundary for scripted drivers: a `gate-answer` intent consumes `gates/<gate>.answer` and resumes without knowing what external system produced the answer.

## 4. Planner Interview Mode

Strengthen Gate 1.

Before producing a story, if the request is underspecified, interview the user with focused questions:

- What problem is this solving?
- Who is the user/persona?
- What behavior changes?
- What is explicitly out of scope?
- What edge cases matter?
- What design/API constraints exist?
- What should prove this is done?

Rules:

- Ask questions before architecture design.
- Do not generate a weak story from vague input.
- In scripted mode, the load-bearing behavior is to record missing requirements as `needs-human` or a pending story gate rather than guessing.

Scripted-mode fallback:

- Write `gates/story.question.md` with the missing questions.
- Mark `gates.story.status = pending`.
- Stop cleanly so the external driver can collect answers and write `gates/story.answer`.
- Do not proceed to research/spec/decomposition from an underspecified story.

## 5. Stale-Run And Watchdog Helpers

Current state now includes the internal heartbeat helper, `$RUN/heartbeat.json`, and `run-json.lock/` coordination. The helper is for long orchestrator waits only. Start heartbeat immediately before a long `Task` wait begins; `heartbeat.json` is liveness-only data with `{ schema_version, run_id, phase, pid, interval_ms, last_tick_at }`, not authority for workflow state. It must refuse starts unless the manifest already shows real in-flight work, stay off while the factory is stopped at `story`, `brief`, or `pre_pr` gates, and stop heartbeat best-effort before terminal manifest writes.

External monitoring semantics:

- `heartbeat.json` + `run.json.heartbeat_at` are liveness only.
- Freshness is derived at read time from `last_tick_at`, `interval_ms`, and whether the recorded PID is alive; no token, owner, deadline, or expiry state exists.
- Pending gate waits are read from `run.json.gates.*`, not from heartbeat.
- Terminal `completed|blocked|partial|needs-human` plus `terminal_result` are the stable outcome contract.
- `feature-factory factory heartbeat <run-id> --status --json` is the supported helper/status surface for watchdog tooling.

Implemented detached-run diagnostics are output-only and appear on `factory status`, `factory list`, `factory validate`, `factory watch`, and TUI data. The canonical envelope fields are `schema_version`, `checked_at`, `authoritative`, `status`, `severity`, `classification`, `summary`, and `items[]`; each item carries `condition`, `classification`, `severity`, `status`, `message`, `action`, `authoritative`, `checked_at`, and `evidence`. The condition enum is `stale-heartbeat`, `missing-heartbeat-process`, `missing-worktree`, `invalid-run-state`, `protected-gate`, `terminal-run`. The classification enum is `healthy`, `recoverable`, `blocked`, `needs-human`, `terminal`, `invalid`; `invalid` is first-class. Status enum is `ok`, `warning`, `error`; severity enum is `info`, `warning`, `error`, `critical`.

Aggregation chooses the primary item using exact priority: classification `invalid` > `blocked` > `needs-human` > `recoverable` > `terminal` > `healthy`; severity `critical` > `error` > `warning` > `info`; status `error` > `warning` > `ok`; condition `invalid-run-state` > `missing-worktree` > `missing-heartbeat-process` > `stale-heartbeat` > `protected-gate` > `terminal-run`; then original detection order. The top-level diagnostic tuple and summary come from that primary item.

Condition mappings and operator actions are stable: `stale-heartbeat` is `recoverable` / `warning` / `warning` and tells operators to inspect logs and validate durable state before resuming, not restart blindly; `missing-heartbeat-process` is `recoverable` / `warning` / `warning` and means the heartbeat helper PID in `heartbeat.json` is not alive; `missing-worktree` is `blocked` / `error` / `error` and asks the operator to restore the worktree or recover from durable state; `invalid-run-state` is `invalid` / `error` / `critical`; `protected-gate` is exactly `needs-human` / `warning` / `warning` and tells operators to answer the pending protected gate or stop; `terminal-run` maps `completed`/`partial` to `terminal` / `ok` / `info`, `blocked` to `blocked` / `error` / `error`, and `needs-human` to `needs-human` / `warning` / `warning`.

Heartbeat/PID/process diagnostics are liveness-only. `missing-heartbeat-process` refers to the heartbeat helper process, not a detached opencode process, because there is no durable run-id-to-opencode-PID registry. Heartbeat evidence must include `evidence.liveness_only: true` and remain `authoritative: false`; PID liveness, process existence, `heartbeat.json`, and mutable `run.json` heartbeat fields cannot prove health or ownership. Stale heartbeat uses `max(2 * interval_ms, 120000ms)`.

Protected gates and terminal states suppress inappropriate liveness alarms. A pending protected `story`, `brief`, or `pre_pr` gate suppresses stale-heartbeat and missing-heartbeat-process and always displays the same `needs-human` / `warning` / `warning` tuple. Valid terminal states suppress heartbeat/worktree liveness alarms; operators should read `terminal_result` rather than revive zombie state.

Diagnostics must fail closed for invalid local state. `diagnostics.authoritative` is true only when `run.json` schema and required sidecars pass. Invalid runs must not be treated as healthy, must not be silently restarted, and must not infer health from heartbeat/PID/process data, status booleans, worktree strings, or mutable `run.json` claims.

Add commands:

```sh
feature-factory factory stale [--after 30m]
feature-factory factory watch <run-id> --summary
feature-factory factory recover <run-id>
```

`stale` should report:

- run id
- status
- last heartbeat
- pending gate if any
- running/review slices
- blocked slices
- suggested next action

Example:

```text
app-123 stale 48m pending_gate=brief action="answer gates/brief.answer or resume"
app-456 stale 2h running_slice=be-api action="resume and re-observe slice"
```

Do not auto-steal or auto-recover without explicit operator action.

## 6. Layered Package Architecture

As the package grows, split code by responsibility:

```text
src/
  core/
    run-state.js
    gates.js
    schema.js
    status.js
  opencode/
    plugin.js
    assets.js
  cli/
    install.js
    doctor.js
    factory.js
  adapters/
    README.md
```

Principles:

- Core knows only local `.opencode/factory` state.
- opencode adapter registers commands/agents/skills.
- CLI provides operator/script conveniences.
- External tracker adapters live outside core or in optional modules.

Do this after there is enough code to justify the split. Premature layering is a tax; the first priority is making the current driver safe and diagnosable.

## 7. Environment Snapshot

Add a diagnostic environment snapshot block to `run.json` and relevant evidence records.

Implementation status: helper implemented as `collectRunDebugSnapshot()` and exposed through `feature-factory factory env`. Run creation/resume recording is exposed as `feature-factory factory env record-created <run-id> --json` and `feature-factory factory env record-resume <run-id> --json`, storing redacted diagnostic snapshots under `run.json.debug_snapshot`.

Why:

- Version/model/env skew across independently-run components is expensive to debug.
- A single JSON block lets humans and external drivers know what built a run.
- This should be present before serious scripted operation.

Suggested shape:

```json
{
  "env": {
    "feature_factory_version": "0.1.0",
    "opencode_version": "1.17.13",
    "plugin_spec": "opencode-feature-factory",
    "resolved_models": {
      "story-reader": "openai/gpt-5.5",
      "backend-builder": "anthropic/claude-sonnet-4-6"
    },
      "driver": {
      "kind": "interactive | cli | external",
      "name": "feature-factory",
      "version": "0.1.0"
    },
    "capabilities": {
      "git": true,
      "gh": true,
      "lsp": false,
      "ast_grep": false
    }
  }
}
```

Implemented `run.json.debug_snapshot` shape:

```json
{
  "debug_snapshot": {
    "created_with": {
      "collected_at": "2026-07-06T12:00:00Z",
      "event": "created",
      "diagnostic_only": true,
      "env": {
        "feature_factory_version": "0.1.0",
        "opencode_version": "1.17.13",
        "resolved_models": {},
        "capabilities": {"git": true, "gh": true}
      }
    },
    "last_resumed_with": null,
    "resume_count": 0
  }
}
```

Rules:

- Do not record secret values.
- Omit sensitive keys and redact token-shaped or high-entropy credential values, including `ghp_*`, `github_pat_*`, `gho_*`/`ghu_*`/`ghs_*`/`ghr_*`, `sk-proj_*`, `sk-*`, `xoxb_*`/`xoxp_*`/`xoxa_*`, `glpat-*`, bearer/JWT/AWS-shaped values, credential-bearing URLs, and single-token high-entropy strings.
- Record provider/model ids, not API keys.
- Refresh the snapshot on resume if the driver/opencode/plugin version changed, while preserving original `created_with` if useful.
- Treat `debug_snapshot` as diagnostic-only. It must never be used as authority for gates, merges, reviews, or PR URL trust.

## 8. Scripted Environment And Credential Contract

Scripted runs inherit the driver's environment. Document and validate this explicitly.

Required environment behavior:

- `HOME` must point at the home where opencode provider auth/config lives, unless `OPENCODE_CONFIG` or equivalent config overrides are intentionally used.
- Provider credential env vars needed by configured models must be present in the subprocess environment or already stored in opencode's auth/config store.
- `GITHUB_TOKEN` or `gh` auth must be available before PR creation.
- The driver must not strip opencode config/auth env vars when spawning `feature-factory factory start` or `opencode run`.
- Doctor should run under the same environment as the eventual factory run.

Suggested doctor additions:

```text
ok: HOME=/home/agent
ok: opencode config found under HOME
ok: provider openai smoke passed
missing: provider anthropic auth failed under scripted env
missing: gh auth unavailable for draft PR creation
```

If credentials are missing, fail before starting a long build.

## 9. Headless And Autonomous Driver Modes

Add first-class CLI support for external drivers that want to advance the factory without an interactive terminal.

Implementation status: first pass implemented. `factory start` accepts `--repo`; `--headless` / `--detached` injects driver instructions into the `/feature` invocation. The orchestrator prompt already requires stopping after pending gates in scripted mode. `--autonomous` now injects explicit autonomous instructions so the factory can approve story/brief from its own complete artifacts, decide pre-PR from its implementation/security panel, run bounded remediation, write `terminal_result`, and open a draft PR without an external gate relay.

Required behavior:

- `feature-factory factory start` accepts `--repo <path>` and runs against that repo root regardless of caller cwd.
- Add a detached/headless mode, e.g. `--headless` or `--detached`, that runs until the next gate and exits after writing the gate question file.
- Add an autonomous mode, e.g. `--autonomous`, that runs until terminal status and writes `run.json.terminal_result`.
- On reaching a gate, the factory writes `gates/<gate>.question.md`, marks the gate pending in `run.json`, and exits cleanly with a recognizable status/output.
- External drivers can loop:
  1. `feature-factory factory start --repo <repo> --headless "<prompt or resume>"`
  2. Read `.opencode/factory/<run-id>/gates/<gate>.question.md`.
  3. Decide externally.
  4. Write `gates/<gate>.answer` via `feature-factory factory answer <run-id> <gate> "approve|changes: ...|stop"`.
  5. Resume with `feature-factory factory start --repo <repo> --headless "resume <run-id>"`.

This is the generic adapter contract. External drivers should not need to parse chat output, keep an interactive session open, or mutate anything except gate answers.

Autonomous adapter contract:

1. `feature-factory factory start --repo <repo> --autonomous "<prompt or resume>"`.
2. Wait for process exit.
3. Read `.opencode/factory/<run-id>/run.json` and consume `terminal_result`.
4. Mirror only stable terminal fields (`status`, `pr_url`, `reason`, summary/artifact refs) to the external tracker.

External autonomous drivers should not parse gate internals or write answer files.

Draft PR completion contract:

1. Gate 3 must be approved through the same transition-gated path as interactive runs.
2. After `gh pr create --draft` or equivalent succeeds, verify it with `gh pr view <url>`, then call `feature-factory factory pr-created <run-id> --pr-url URL --pr-number N --repository OWNER/REPO --json`.
3. The command validates the approved `pre_pr` gate, validator `GO` or `GO-WITH-NITS` with a report file, security `PASS` with a review file, completed slice state, matching PR number, and canonical GitHub PR URL, then writes `run.pr_url` / `terminal_result.pr_url` and completed status.
4. Drivers must not mirror PR URLs from direct manifest edits.

## 10. Blocked-Run Continuation

Current planned public command:

```sh
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>
```

This command is a recovery path for automated runs that reached terminal `blocked` after bounded remediation. It must create a fresh child run instead of mutating or reviving the parent.

Required continuation contract:

- Treat the injected continuation payload and all CLI arguments as untrusted operator data/config, not privileged instructions.
- Require the parent `run.json.status` to be exactly `blocked`; do not continue from `completed`, `partial`, `needs-human`, `running`, missing, or invalid parent state.
- Validate `--review <review-ref>` as an approved review-evidence ref under the parent run that is referenced by parent run state, including referenced artifacts/evidence/reviews, hashes, and subject consistency. Do not authorize continuation by checking for a special blocking verdict enum.
- Persist `run.continuation` / `run.json.continuation` in the child with `schema_version: 1`, `kind: "blocked-run-continuation"`, nested `parent`, `review`, and `target` objects, parent worktree, target base ref/commit, hashes for validated refs, `parent_artifacts` `{kind, ref, hash}` entries, parent evidence/review `{kind, ref, hash}` entries, `created_at`, and `operator_summary`.
- Treat all parent context as read-only. The child must not edit the parent manifest, gates, artifacts, evidence, reviews, branch, worktree, PR URL, or terminal result.
- Run the normal factory flow for the child: story gate, research/design, brief/spec/decomposition gate, build slices, acceptance tests, implementation-validator, security-reviewer, pre-PR gate, and PR-created transition.
- Continuation PRs are always draft-only. Force `driver.ready=false` even if operator payload asks to mark ready.
- Before recording PR creation for a continuation, verify the live GitHub PR reports `isDraft: true`.
- `factory continue` rejects `--ready` and `--no-draft`; the continuation entry point has no ready-for-review or non-draft override.
- If bounded remediation is exhausted, ownership is ambiguous, or validator/security remains blocking, end the child at terminal `blocked` with no PR URL (`run.pr_url` unset and `terminal_result.pr_url: null`).

## 11. Fallback Models

Current config supports one profile per role/agent.

Future config idea:

```jsonc
{
  "profiles": {
    "planning": {
      "primary": { "model": "openai/gpt-5.5", "variant": "xhigh" },
      "fallbacks": [{ "model": "anthropic/claude-sonnet-5", "variant": "high" }]
    }
  }
}
```

Open question:

- Can opencode plugin hooks enforce fallback behavior, or should this stay documentation-only until opencode supports per-agent fallback chains?

Do not implement fake fallback behavior that silently changes models without observable state.

## 12. Better Install Flow

Improve `feature-factory install`:

- Support `--local` for development.
- Support npm package install shape.
- Preserve existing opencode config fields.
- Validate JSONC safely.
- Print exact restart instruction.
- Optionally prompt for profile category mappings.

Non-interactive mode:

```sh
feature-factory install --profile '{"model":"openai/gpt-5.5","variant":"xhigh"}'
feature-factory install --profiles-file profiles.json
```

## 13. OpenTelemetry GenAI Instrumentation

Add opt-in OpenTelemetry tracing for feature-factory runs, shaped to work with the OpenTelemetry GenAI semantic conventions and Honeycomb Agent Timeline. The goal is to make one factory run debuggable as a conversation timeline across the orchestrator, subagents, tool calls, gates, slices, validation, PR creation, and terminal state.

Reference design target: <https://www.honeycomb.io/blog/instrumenting-ai-agents-agent-timeline-opentelemetry-guide>

Relevant upstream context:

- `anomalyco/opencode#5245` is an old, still-open, merge-conflicted attempt to add direct OpenTelemetry setup to opencode.
- The useful comments on that PR say current opencode can emit AI SDK spans when `experimental.openTelemetry` is enabled and an OpenTelemetry SDK/exporter is initialized.
- Those native AI SDK spans were reported as `ai.streamText`, `ai.toolCall`, and `ai.streamText.doStream`, and may include full prompt text.
- Current opencode has native OTLP setup under `packages/core/src/observability/otlp.ts`, gates AI SDK telemetry with `experimental.openTelemetry`, and reads standard `OTEL_EXPORTER_OTLP_*` env vars.
- The external `@devtheops/opencode-plugin-otel` plugin provides mature generic opencode telemetry, metrics, logs, trace export, and `traceparent` support, but it does not know feature-factory run/gate/slice context and uses OpenInference-style attributes rather than Honeycomb Agent Timeline's `gen_ai.*` contract.

Current feature-factory state: the factory has durable local artifacts (`run.json`, `evidence/*`, `reviews/*`, heartbeat, process logs), but no factory-specific emitted telemetry. Debugging a failed run requires reading local files and logs manually.

Goals:

- Keep telemetry vendor-neutral through OpenTelemetry APIs and OTLP export.
- Prefer native opencode/AI SDK telemetry for generic LLM and tool execution spans when available.
- Avoid duplicating generic opencode telemetry that native opencode or `@devtheops/opencode-plugin-otel` already provides.
- Make each factory run appear as one Agent Timeline conversation.
- Show agent swim lanes for `feature-factory`, story/spec/decomposition agents, builders, reviewers, validators, and security review.
- Show tool calls and downstream factory operations with enough metadata to debug failures.
- Correlate local durable artifacts with spans through stable refs and hashes, not raw large payloads.
- Keep telemetry optional and safe by default.

Non-goals for the first implementation:

- No telemetry enabled by default.
- No Honeycomb-only API dependency in core code.
- No first-pass generic OTLP exporter/metrics clone inside feature-factory.
- No default capture of prompts, responses, tool arguments, tool outputs, gate answers, diffs, reviews, or evidence bodies.
- No use of telemetry as workflow authority. Local transition checks and durable state remain the workflow contract.
- No opencode core fork as a prerequisite for the first useful version. If native opencode span enrichment is needed later, design it as an upstream contribution.

### Native OpenCode Interop

Feature-factory telemetry should compose with three possible operator setups:

1. Native opencode OTel: `experimental.openTelemetry: true` plus `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`.
2. Companion plugin: `@devtheops/opencode-plugin-otel` or similar initializes SDK/exporters and emits generic opencode metrics/logs/traces.
3. Feature-factory-only metadata spans: feature-factory emits run/gate/slice spans, but generic LLM/tool spans may be absent.

The preferred first implementation is option 1 or 2 plus feature-factory-specific correlation. Do not add heavyweight exporter dependencies to feature-factory until we prove native opencode and companion plugin paths cannot provide enough plumbing.

Initial feature-factory code should depend only on `@opentelemetry/api` if possible. That lets the plugin and CLI create spans when a provider is already initialized, while remaining a no-op when telemetry is disabled or no SDK exists. Add SDK/exporter dependencies only for a later phase that explicitly needs root CLI spans from the `feature-factory` process itself.

Native AI SDK spans are valuable but insufficient for the Agent Timeline by themselves because they may not include `gen_ai.conversation.id`, `gen_ai.agent.name`, or factory run metadata. Feature-factory must either emit bridge/parent spans with the required GenAI attributes or, in a later upstream opencode change, enrich native AI SDK spans with conversation and agent attributes.

### Conversation And Span Model

Use `run.run_id` as `gen_ai.conversation.id` once a run exists. Before run creation is observable, use a generated `feature_factory.execution_id` or `sessionID` as a temporary correlation key and attach the eventual `run_id` when it is known.

Every feature-factory GenAI span should include:

- `gen_ai.conversation.id`: factory `run_id` when available.
- `gen_ai.agent.name`: the agent that owns the operation.
- `gen_ai.operation.name`: one of `invoke_agent`, `chat`, `execute_tool`, `gate_decision`, `validate`, `create_pr`, `cleanup`, or `heartbeat`.
- `feature_factory.run_id`: duplicate run id under the package namespace for non-GenAI queries.
- `feature_factory.mode`: `interactive`, `headless`, or `autonomous`.
- `feature_factory.review_tier`: optional display-only review tier label when known.
- `feature_factory.status`: current run/slice/gate status when relevant.

Native opencode spans may only carry generic attributes such as `session.id` or AI SDK span names. For phase 1, it is acceptable if those spans live in the same trace but do not independently satisfy Agent Timeline grouping, as long as feature-factory emits adjacent/parent spans with `gen_ai.conversation.id` and stable artifact refs. Phase 2 should pursue native span enrichment if Honeycomb Agent Timeline requires every model/tool span to carry the conversation id.

Prefer additional package-scoped attributes for factory-specific concepts instead of overloading GenAI attributes:

- `feature_factory.gate.name`
- `feature_factory.gate.status`
- `feature_factory.slice.id`
- `feature_factory.slice.stack`
- `feature_factory.slice.attempt`
- `feature_factory.step.agent`
- `feature_factory.artifact.ref`
- `feature_factory.review.ref`
- `feature_factory.evidence.ref`
- `feature_factory.pr.url`
- `feature_factory.terminal.status`
- `feature_factory.terminal.reason_type`

Avoid absolute local paths by default. When a path is needed, prefer repo-relative refs already present in durable artifacts. If an absolute path is operationally useful, put it behind an explicit `includePaths` option.

### Span Taxonomy

| Span name | Source | Required attributes | Notes |
|---|---|---|---|
| `factory.start` | `src/factory.js` `startFactory()` | `feature_factory.mode`, `feature_factory.repo`, `feature_factory.execution_id` | Root CLI/control-plane span for `feature-factory factory start`. |
| `invoke_agent feature-factory` | plugin `command.execute.before` and CLI launch | `gen_ai.agent.name=feature-factory`, `gen_ai.operation.name=invoke_agent` | Correlates `/feature` command admission with the factory run. |
| `invoke_agent <agent>` | opencode task/tool hooks when visible | caller `gen_ai.agent.name`, `feature_factory.target_agent.name` | Shows multi-agent handoffs. The caller emits the handoff span. |
| `chat <model>` | native opencode AI SDK OTel, plus feature-factory bridge spans when needed | `gen_ai.operation.name=chat`, `gen_ai.request.model` | Native spans may be named `ai.streamText` / `ai.streamText.doStream`; feature-factory should not duplicate payload capture. |
| `execute_tool <tool>` | native opencode AI SDK OTel or plugin events | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id` | Native spans may be named `ai.toolCall`; feature-factory adds run/slice/gate context when available. |
| `factory.gate <gate>` | `transitionGateDecision()` / CLI gate commands | gate attributes and answer source | Do not attach raw gate answers unless content capture is explicitly enabled. |
| `factory.step <agent>` | `transitionRunStep()` | step agent/status/attempt | Records spec/decomposition/test/validation/security phase transitions. |
| `factory.slice <slice>` | slice state transitions | slice id/stack/status/attempt | Records builder/reviewer/remediation progress. |
| `factory.validate` | `validateState()` | validation ok/error counts | Includes authority validation failures as span errors. |
| `factory.heartbeat` | heartbeat helper | heartbeat phase/status | Useful for detecting stalls and zombie runs. |
| `factory.cleanup` | `cleanupRun()` | removed/skipped counts | Operator span, not part of normal build timeline unless `run_id` is available. |

Use OpenTelemetry error status and `error.type` on failed spans. This is required for Agent Timeline failure filtering.

### Content Capture And Redaction

Default content policy:

- `captureMessages: false`
- `captureToolArguments: false`
- `captureToolResults: false`
- `captureReviews: false`
- `captureEvidence: false`

Important native-opencode caveat: AI SDK telemetry may capture full prompt and tool payload data outside feature-factory's own redaction path. `doctor --telemetry` should warn when native opencode OTel is enabled and the current opencode/AI SDK setup is known or suspected to record inputs/outputs. Production use should require one of:

- upstream opencode/AI SDK settings that disable prompt/output recording;
- an OpenTelemetry Collector redaction processor;
- a trusted non-production telemetry environment;
- or feature-factory telemetry only, without native AI SDK content spans.

When content capture is explicitly enabled, redact before setting span attributes or events. Reuse or share the same token-shaped redaction rules as diagnostic environment redaction so telemetry cannot leak values like `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, `xoxb_*`, bearer tokens, SSH keys, or high-entropy credential-shaped strings.

All captured content should be capped before export:

- default max string attribute bytes: `4096`;
- default max array entries: `20`;
- default max object depth: `4`;
- replace truncated content with a marker and byte count.

Telemetry should record artifact refs and content hashes by default, not artifact bodies.

### Configuration

Prefer standard OpenTelemetry environment variables for exporter configuration:

```sh
FEATURE_FACTORY_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=${HONEYCOMB_API_KEY},x-honeycomb-dataset=feature-factory
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev,feature_factory.enabled=true
```

Native opencode LLM/tool spans also require opencode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "experimental": {
    "openTelemetry": true
  }
}
```

Plugin options may override package-specific behavior, but should not require secrets in `opencode.jsonc`:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "telemetry": {
          "enabled": true,
          "mode": "native-opencode",
          "captureMessages": false,
          "captureToolArguments": false,
          "captureToolResults": false,
          "includePaths": false,
          "maxAttributeBytes": 4096
        }
      }
    ]
  ]
}
```

`feature-factory doctor --telemetry` should validate telemetry setup without requiring a real factory run:

- OTel enabled/disabled status.
- service name.
- exporter endpoint configured or missing.
- headers present without printing values.
- whether opencode config enables `experimental.openTelemetry`.
- whether a companion opencode telemetry plugin is configured.
- whether current opencode is expected to emit native AI SDK spans.
- whether package instrumentation can be loaded.
- whether content capture is enabled and redaction is active.
- whether native AI SDK spans may include full prompt/output content.

### Implementation Plan

1. Add `src/telemetry.js` with a no-op default, `@opentelemetry/api` wrappers, redaction helpers, and helpers such as `withSpan()`, `recordError()`, and `runAttributes()`.
2. Add `feature-factory doctor --telemetry` to detect native opencode OTel config, OTLP env vars, companion telemetry plugins, and risky native prompt/output capture.
3. Propagate `OTEL_EXPORTER_OTLP_*`, `OTEL_RESOURCE_ATTRIBUTES`, W3C trace context when available, and `feature_factory.execution_id` into spawned `opencode run` processes. Do not strip operator-provided OTel env.
4. Instrument feature-factory plugin hooks in `src/plugin.js`: `command.execute.before`, `chat.message`, `chat.params`, `tool.execute.before`, `tool.execute.after`, and `event` where useful. Prefer adding run/gate/slice attributes and bridge spans over duplicating generic model/tool payload spans.
5. Instrument durable state transition helpers in `src/run-state.js` so spans/events are emitted when opencode-run node scripts update gates, steps, slices, PR-created/opened state, validation, or terminal results.
6. Instrument CLI/control-plane boundaries in `src/factory.js`: start, detached start, validate, cleanup, gate answer, heartbeat start/stop/tick. If no SDK is initialized in the CLI process, these spans may be no-op in phase 1; the important part is trace/context propagation into opencode.
7. Add tests with an in-memory span exporter covering disabled mode, enabled mode, redaction, tool span lifecycle, run-id correlation, and error status.
8. Extend package smoke tests to prove telemetry dependencies do not break published install/import surfaces when no OTel env is configured.
9. Document setup for native opencode OTel, companion plugin OTel, and Honeycomb OTLP, including prompt-capture warnings.
10. Only after phase 1 evidence, decide whether feature-factory needs its own SDK/exporter dependency for CLI root spans.

### Known Limitations And Open Questions

- Native opencode OTel may provide AI SDK spans without Agent Timeline `gen_ai.*` attributes. We may need bridge spans or an upstream opencode contribution to enrich native spans.
- Native AI SDK spans may include full prompts/tool payloads outside feature-factory redaction. This requires upstream controls or collector redaction before production use.
- Plugin-only tool spans may miss failed tool executions if opencode does not call `tool.execute.after` on failure. If this matters, add or consume an opencode hook that fires in `finally` with error metadata.
- `chat.params` exposes request metadata but not guaranteed final token usage or response model. Full `gen_ai.usage.*`, `gen_ai.response.model`, and finish reason support may require native opencode telemetry, opencode events, or richer hooks.
- Subagent handoffs are visible through task/tool flows only if opencode surfaces enough tool metadata to identify the target agent reliably.
- Detached runs need careful context propagation because parent and child processes are separate. The parent should inject trace context into the child environment; the child/plugin should extract it.
- Telemetry cardinality must be controlled. Use run ids and artifact refs intentionally, but do not attach large or unbounded values.
- `@devtheops/opencode-plugin-otel` is useful as a companion/reference, but it is MPL-2.0 licensed. Do not copy its code into this MIT package without explicit license review.

### Acceptance Criteria

- Telemetry is off by default and adds no exporter/network side effects unless explicitly enabled.
- `doctor --telemetry` reports native opencode OTel readiness, OTLP env readiness, companion plugin presence, and content-capture risk.
- With telemetry enabled and native opencode OTel configured, `factory start --detached` and normal foreground starts produce native opencode AI SDK spans plus feature-factory correlation spans in the same trace when possible.
- Spans include the three Agent Timeline attributes where applicable: `gen_ai.conversation.id`, `gen_ai.agent.name`, and `gen_ai.operation.name`.
- Factory tool/bridge spans include `gen_ai.tool.name` and `gen_ai.tool.call.id` when tool metadata is available.
- Errors set OpenTelemetry error status and `error.type`.
- Secret-shaped values are redacted before export, including token-shaped values that do not contain literal `secret`, `token`, or `password` words.
- The docs warn that native opencode/AI SDK spans may capture prompts unless upstream or collector redaction is configured.
- Tests prove disabled mode, enabled mode, redaction, and package smoke behavior.

## 14. Non-Goals

- No default telemetry.
- No tracker-specific logic in core.
- No infinite autonomous loop that bypasses evidence, reviewer/security verdicts, remediation bounds, or PR review.
- No direct merge to base branches.
- No replacing opencode's edit tools or permissions model.
- No mandatory Team Mode/tmux visualization until the core workflow is stable.

## Suggested Implementation Order

1. Credential-aware doctor + capability detection.
2. Diagnostic environment stamp in `run.json` and evidence.
3. Scripted environment/credential contract docs and checks.
4. `factory start --repo` plus headless/detached run-to-next-gate mode.
5. Intent gate prompt update.
6. Planner interview mode prompt update.
7. Stale/watch helpers.
8. Better install flow.
9. OpenTelemetry GenAI instrumentation, metadata-only and opt-in first.
10. Package layering refactor, once code volume warrants it.
11. Optional fallback model design, pending opencode support.

None of these are prerequisites for a first supervised run. The factory is runnable now; one real run should feed the next reprioritization pass.
