# Feature Factory Improvement Spec

Ideas to implement after reviewing `oh-my-openagent`, adapted for this package's tracker-agnostic feature factory.

## Goals

- Preserve the factory as a generic opencode workflow, not tied to any tracker.
- Improve installability, observability, model routing, and scripted operation.
- Keep the core state protocol simple: `.opencode/factory/<run-id>/run.json` plus gate answer files for human/headless runs and `terminal_result` for autonomous harnesses.
- Avoid autonomous loops that bypass evidence, reviewer verdicts, security review, bounded remediation, or the human PR review boundary.
- Fail early on missing credentials, missing CLIs, unsupported opencode surfaces, or PR prerequisites before a long build wastes time.

## Trust-model contract

Current provenance guarantees assume three authority layers:

- `untrusted caller claims`: `run.json`, gate answers, `evidence/*`, `reviews/*`, worktree path strings, status booleans, `base_ref`, and `base_commit`.
- `orchestrator observations`: fresh safe Git/filesystem observations, physical durable-root containment, worktree identity, commit/tree/parent relationships, file hashes, and reviewed-worktree guard results.
- `factory-owned attestations`: canonical records under `.opencode/factory/<run-id>/attestations/`.

Accepted provenance requires `attestations/index.json`, canonical `attestation_hash`, an unbroken `prev_hash` chain from `run-base`, and fresh re-observation of current Git/filesystem facts. Merge history is proven by `merge-chain.json` entries of type `slice_merge` or `direct_reviewed_commit`, not by `merged`/`approved` flags alone.

Expected guarantees:

- bounded local authority with centralized safe Git (`safe_git_policy: "safe-git-v1"`);
- durable-root and worktree identity validation;
- fail closed behavior when attestation proof, worktree identity, or current observations cannot be re-verified.

Explicit limits:

- local-only, not cryptographic or tamper-proof;
- a coherent rewrite of local files and Git history is outside the model.

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
- `pr-continuation`: continue only PR preparation for an already-built branch.

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

Current state now includes the internal heartbeat helper, `$RUN/factory.lock`, `$RUN/heartbeat.json`, and `run-json.lock/` coordination. The helper is for long orchestrator waits only; it must require the trusted heartbeat owner capability from `factory.lock`, treat `heartbeat.json` as data rather than authority, refuse starts unless the manifest already shows real in-flight work, stay off while the factory is stopped at `story`, `brief`, or `pre_pr` gates, and confirm stop before terminal manifest writes.

External monitoring semantics:

- `heartbeat.json` + `run.json.heartbeat_at` are liveness only.
- `factory.lock` holds the trusted heartbeat owner capability; `feature-factory factory heartbeat <run-id> --status --json` and `heartbeat.json` never expose it.
- Pending gate waits are read from `run.json.gates.*`, not from heartbeat.
- Terminal `completed|blocked|partial|needs-human` plus `terminal_result` are the stable outcome contract; heartbeat should already be stopped by then.
- `feature-factory factory heartbeat <run-id> --status --json` is the supported helper/status surface for watchdog tooling.

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

## 7. Substrate And Provenance Stamp

Add a provenance block to `run.json` and relevant evidence records.

Implementation status: helper implemented as `collectProvenance()` and exposed through `feature-factory factory provenance`. It is not yet written into `run.json` by the orchestrator.

Why:

- Version/model/env skew across independently-run components is expensive to debug.
- A single JSON block lets humans and external drivers know what built a run.
- This should be present before serious scripted operation.

Suggested shape:

```json
{
  "provenance": {
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

Rules:

- Do not record secret values.
- Record provider/model ids, not API keys.
- Refresh provenance on resume if the driver/opencode/plugin version changed, while preserving original `created_with` if useful.

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

## 10. Fallback Models

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

## 11. Better Install Flow

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

## 12. OpenTelemetry GenAI Instrumentation

Add opt-in OpenTelemetry tracing for feature-factory runs, shaped to work with the OpenTelemetry GenAI semantic conventions and Honeycomb Agent Timeline. The goal is to make one factory run debuggable as a conversation timeline across the orchestrator, subagents, tool calls, gates, slices, validation, PR creation, and terminal state.

Reference design target: <https://www.honeycomb.io/blog/instrumenting-ai-agents-agent-timeline-opentelemetry-guide>

Current state: the factory has durable local artifacts (`run.json`, `evidence/*`, `reviews/*`, attestations, heartbeat, process logs), but no emitted telemetry. Debugging a failed run requires reading local files and logs manually.

Goals:

- Keep telemetry vendor-neutral through OpenTelemetry APIs and OTLP export.
- Make each factory run appear as one Agent Timeline conversation.
- Show agent swim lanes for `feature-factory`, story/spec/decomposition agents, builders, reviewers, validators, and security review.
- Show tool calls and downstream factory operations with enough metadata to debug failures.
- Correlate local durable artifacts with spans through stable refs and hashes, not raw large payloads.
- Keep telemetry optional and safe by default.

Non-goals for the first implementation:

- No telemetry enabled by default.
- No Honeycomb-only API dependency in core code.
- No default capture of prompts, responses, tool arguments, tool outputs, gate answers, diffs, reviews, or evidence bodies.
- No use of telemetry as provenance authority. Local attestations and fresh observations remain the authority model.
- No opencode core fork as a prerequisite for the first useful version.

### Conversation And Span Model

Use `run.run_id` as `gen_ai.conversation.id` once a run exists. Before run creation is observable, use a generated `feature_factory.execution_id` or `sessionID` as a temporary correlation key and attach the eventual `run_id` when it is known.

Every feature-factory GenAI span should include:

- `gen_ai.conversation.id`: factory `run_id` when available.
- `gen_ai.agent.name`: the agent that owns the operation.
- `gen_ai.operation.name`: one of `invoke_agent`, `chat`, `execute_tool`, `gate_decision`, `validate`, `create_pr`, `cleanup`, or `heartbeat`.
- `feature_factory.run_id`: duplicate run id under the package namespace for non-GenAI queries.
- `feature_factory.mode`: `interactive`, `headless`, or `autonomous`.
- `feature_factory.review_tier`: selected review tier when known.
- `feature_factory.status`: current run/slice/gate status when relevant.

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
| `chat <model>` | opencode `chat.params`/future model events | `gen_ai.operation.name=chat`, `gen_ai.request.model` | Phase 1 may only record request metadata; completion/token usage needs opencode event or core telemetry support. |
| `execute_tool <tool>` | plugin `tool.execute.before/after` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id` | Store spans in memory by `sessionID:callID` between before/after hooks. |
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

When content capture is explicitly enabled, redact before setting span attributes or events. Reuse or share the same token-shaped redaction rules as diagnostic provenance redaction so telemetry cannot leak values like `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, `xoxb_*`, bearer tokens, SSH keys, or high-entropy credential-shaped strings.

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
OTEL_SERVICE_NAME=opencode-feature-factory
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=${HONEYCOMB_API_KEY},x-honeycomb-dataset=feature-factory
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
- whether package instrumentation can be loaded.
- whether content capture is enabled and redaction is active.

### Implementation Plan

1. Add `src/telemetry.js` with a no-op default, lazy SDK setup, redaction helpers, and small wrappers such as `withSpan()`, `recordError()`, and `runAttributes()`.
2. Add optional dependencies for OpenTelemetry API/SDK and OTLP HTTP export. Keep package startup cheap when telemetry is disabled.
3. Instrument CLI/control-plane boundaries in `src/factory.js`: start, detached start, validate, cleanup, gate answer, heartbeat start/stop/tick.
4. Propagate trace context and `feature_factory.execution_id` into spawned `opencode run` processes through environment variables. Use W3C `traceparent` where possible and a package-specific fallback env var for the conversation/execution id.
5. Instrument plugin hooks in `src/plugin.js`: `command.execute.before`, `chat.message`, `chat.params`, `tool.execute.before`, `tool.execute.after`, and `event` where useful.
6. Instrument durable state transition helpers in `src/run-state.js` so spans/events are emitted when opencode-run node scripts update gates, steps, slices, PR-created/opened state, validation, or terminal results.
7. Add tests with an in-memory span exporter covering disabled mode, enabled mode, redaction, tool span lifecycle, and error status.
8. Extend package smoke tests to prove telemetry dependencies do not break published install/import surfaces when no OTel env is configured.
9. Document setup for Honeycomb through OTLP while keeping the generic OpenTelemetry path first.

### Known Limitations And Open Questions

- Plugin-only tool spans may miss failed tool executions if opencode does not call `tool.execute.after` on failure. If this matters, add or consume an opencode hook that fires in `finally` with error metadata.
- `chat.params` exposes request metadata but not guaranteed final token usage or response model. Full `gen_ai.usage.*`, `gen_ai.response.model`, and finish reason support may require opencode core telemetry or richer events.
- Subagent handoffs are visible through task/tool flows only if opencode surfaces enough tool metadata to identify the target agent reliably.
- Detached runs need careful context propagation because parent and child processes are separate. The parent should inject trace context into the child environment; the child/plugin should extract it.
- Telemetry cardinality must be controlled. Use run ids and artifact refs intentionally, but do not attach large or unbounded values.

### Acceptance Criteria

- Telemetry is off by default and adds no exporter/network side effects unless explicitly enabled.
- With telemetry enabled, `factory start --detached` and normal foreground starts produce a trace rooted at `factory.start` or `invoke_agent feature-factory`.
- Spans include the three Agent Timeline attributes where applicable: `gen_ai.conversation.id`, `gen_ai.agent.name`, and `gen_ai.operation.name`.
- Tool spans include `gen_ai.tool.name` and `gen_ai.tool.call.id`.
- Errors set OpenTelemetry error status and `error.type`.
- Secret-shaped values are redacted before export, including token-shaped values that do not contain literal `secret`, `token`, or `password` words.
- Tests prove disabled mode, enabled mode, redaction, and package smoke behavior.

## 13. Non-Goals

- No default telemetry.
- No tracker-specific logic in core.
- No infinite autonomous loop that bypasses evidence, reviewer/security verdicts, remediation bounds, or PR review.
- No direct merge to base branches.
- No replacing opencode's edit tools or permissions model.
- No mandatory Team Mode/tmux visualization until the core workflow is stable.

## Suggested Implementation Order

1. Credential-aware doctor + capability detection.
2. Provenance stamp in `run.json` and evidence.
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
