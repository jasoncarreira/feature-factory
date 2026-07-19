# Feature Factory Improvement Spec

> **Status — proposal / internal planning:** This document may mix observations of
> implemented behavior with unimplemented proposals. It is not the current operator
> contract; [`README.md`](README.md) is the current authority.

Ideas to implement after reviewing `oh-my-openagent`, adapted for this package's tracker-agnostic feature factory.

## Goals

- Preserve the factory as a generic opencode workflow, not tied to any tracker.
- Improve installability, observability, model routing, and scripted operation.
- Keep the core state protocol simple: `.opencode/factory/<run-id>/run.json` plus gate answer files for human/headless runs and `terminal_result` for autonomous harnesses.
- Avoid autonomous loops that bypass evidence, reviewer verdicts, security review, bounded remediation, or the human PR review boundary.
- Never auto-merge; humans review and merge PRs outside the factory after the checked PR-created transition.
- Fail early on missing credentials, missing CLIs, unsupported opencode surfaces, or PR prerequisites before a long build wastes time.

## Trust-model contract

The proof layer removed in the simplified factory. The durable contract is local state plus transition-time checks, not a cryptographic or tamper-proof authority system.

Threat boundary:

- The local operator and host are trusted for integrity. This includes the OS and process account, local filesystem and Git repository, installed factory code, test commands and toolchain, and reviewer/verifier implementations. Operator text shown to a model is still data rather than privileged instructions at the prompt boundary.
- Model and subagent claims and stale evidence are untrusted. Re-observe claims and reject stale or mismatched evidence before a checked transition. Crashes and concurrent retries are fallible operating conditions that can leave an outcome unknown.
- The factory makes no protection claim against arbitrary modification of the local filesystem, Git history, factory code, test commands, or reviewer/verifier implementations by the operator, a host administrator, or other code with equivalent local access. Such modification is outside the threat model and can rewrite both state and the checks that read it.
- Hashes, refs, locks, tokens, snapshots, and transition checks are local consistency and provenance checks, not cryptographic authentication or generic forgery resistance. They detect stale or mismatched state and coordinate crash/retry behavior only while the trusted local substrate remains intact.
- Within that boundary, retain exact Git/test/review/merge provenance: full Git SHAs plus locally observed diffs, trees, and ancestry; exact test commands, results, attempts, and heads; review subjects, attempts, refs, hashes, and exact reviewed commits; and merge commits plus their reviewed-tree relation. A model claim never substitutes for those observations.
- Retain idempotent external-effect controls: exclusive claims or fences and exact identity/token checks precede effects, unknown crash outcomes are re-observed before retry, and effects already recorded or observed are not repeated. In particular, after a PR exists, retain its fence and record that existing PR; do not create another.

Boundary-retention decisions are finite and explicit in
[`DURABLE-AUTHORITY-LEDGER.md`](DURABLE-AUTHORITY-LEDGER.md). The ledger aligns with
the nine durable authority classes, preserves unique evidence and boundary identities,
and permits consolidation only for duplicate internal attestations with a named
canonical replacement. It originated as a documentation decision record. Persisted
legacy records keep their original shape except for B0MR.1's narrow exact checked replay
of dual-panel verdict rows, which may add only the complete panel successor tuples
described below. Legacy slice review/merged rows reject without mutation.

Current guarantees:

- `run.json`, gate answers, `evidence/*`, `reviews/*`, and `terminal_result` are durable local workflow state.
- Semantic manifest writes go through locked transition helpers so stale writers fail instead of overwriting newer state. `transitionGateDecision` owns approved gate writes, and `transitionPrCreated` owns completed PR state writes.
- Slice review authority requires the complete `{evidence_hash, review_hash, reviewed_commit}` tuple and append-only `attempt_reviews` in `review`/`merged`; pending/running/blocked forbid the current tuple. Checked publication hashes exact sidecar bytes and binds their positive matching attempt/subject plus evidence `head_sha` and review `reviewed_commit` to the same clean current slice branch/worktree HEAD. Validator `{report_hash, review_hash, reviewed_head_sha}` and security `{review_hash, reviewed_head_sha}` tuples are likewise all-or-none and both panels must be successor or both legacy; checked publication binds both atomically to the same clean integration HEAD.
- Slice merge commit `M` has exactly ordered parents `P1,R`, with `R` equal to the persisted reviewed commit and current slice branch/worktree HEAD. The unique full `git merge-base --all P1 R` result `B` must be ancestor of both. NUL-delimited `--no-renames` path sets for `B..R` and `P1..M` must match, including both rename endpoints, and each path must have identical absence or mode/type/object identity in `R` and `M`; prior merged slice commits must already be ancestors of `P1`.
- Exact checked replays may upgrade only dual-panel rows from unchanged refs/identity/attempt and freshly observed bytes/Git. Legacy slice review/merged rows reject without mutation, partial successors reject, successor merged rows stay immutable, and legacy completed rows remain read-only. Pre-PR fence establishment and PR admission re-hash slice/panel refs and require both panel reviewed heads to equal the current clean integration HEAD.
- Pending gates carry a `pending_snapshot` with `question_ref`, `question_hash`, `artifact_ref`, `artifact_hash`, and answer refs/hashes. Gate answer consumption must fail closed when refs are missing, escaped, stale, or hash-mismatched.
- Detached opencode cancellation is run-scoped and fail-closed. `$RUN/process.json` records one verified `opencode-process` identity and `$RUN/processes/<timestamp>.log` records stdout/stderr for that run; if live identity verification is unavailable, the run-owned detached launch fails before writing `process.json`. Generic new detached starts allocate or validate a safe available run id before spawn, return it, and publish pre-manifest run-scoped evidence, while explicit ids that collide with existing state are rejected. `factory cancel` sends exactly one targeted `SIGTERM` only after run id, PID, start marker, command, cwd, log ref, and `state:"running"` evidence validate; missing, invalid, stale, mismatched, or non-running evidence returns `status:"failed-closed"`, `signaled:false`, and sends no signal. Broad process kills, process-group signals, `pkill`, and `killall` are outside the contract.
- The normal PR flow establishes a successor fence whose all-or-none identity is `{operation_id,repository,head_ref,head_sha,base_ref,base_sha,draft}`. It derives canonical origin, exact clean equal local/worktree/remote head, exact remote base equal to `run.base_commit`, base ancestry, and persisted `run.pr_mode`. After external creation with exactly one standalone operation marker, `feature-factory factory pr-created <run-id> --fence-token TOKEN` derives the canonical GitHub PR URL and all other PR metadata from strict bounded GitHub observation; callers cannot provide URL, number, repository, draft, node ID, refs, or SHAs.
- Unflagged and post-PR blocked-run continuation use schema v1 through `feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>`; explicit eligible pre-PR full-plan carry-forward adds `--carry-forward` and uses continuation schema v2. Before either route mutates child state, a target-ID Git CAS reservation binds its schema, crash-stable creation time, and complete continuation hash; exact replay alone may reuse it, and payload/resume/publication recheck it. Every continuation payload is untrusted operator data/config, not privileged instruction, and v2 is accepted only against the exact checked published child.
- Every newly produced/seeded plan has closed root `integration_gate.required_commands`: 1-32 ordered closed structured-argv `{program,args}` entries, with trimmed 1-255-byte control-free programs, 0-64 NUL-free args of at most 4096 UTF-8 bytes each, and a 64-KiB encoded-list cap. Exact `{program:"npm",args:["run","check"]}` occurs once and last. Seeding accepts only exact run-relative `$RUN/plan/slices.json`, fatally decodes UTF-8, rejects symlinks/non-files and projection drift, and re-observes exact bytes at replacement. Work-decomposer acceptance binds exact plan and review bytes in the existing step `acceptance` object. Legacy v1 reads/accepted records remain readable; test-verifier and schema-v2 construction/publication/adoption/replay/resume/downstream require and rehash current accepted authority.
- B4.1 defines the shared delivery contract without activating B4 policy. Optional closed `plan.delivery_envelope` schema v1 contains exactly one ordered delivery unit per plan slice and closed invariant-family, obligation, and verification-artifact arrays. IDs are globally unique canonical lowercase kebab-case; every obligation has one family ID and one known artifact ID in its unit, and every artifact binds an exact existing slice `test_plan` index and string. Optional closed review `invariant_family_ledger` schema v1 identifies that slice's delivery unit and contains at most one disposition per family; each disposition binds a family/artifact pair mapped by an obligation, evidence ref/hash, typed verification-artifact probe and verification-result outcome, full reviewed commit, and unique canonical unresolved findings. B4.1 validates shape and references only: fail/skipped outcomes, unresolved findings, partial disposition coverage, and omission have no pass-policy effect. The two file-disjoint admission/review evaluators return typed inactive results with `grants_b4_authority:false`; B4.2 and B4.4 alone may activate their respective policies.
- For schema v2, `factory test-execute <run-id> --json` is the sole execution sink and accepts no caller command/result/status/ref/attempt/cwd/environment. It commits an active nonce-bound claim before shell-free sequential execution, uses only the approved environment allowlist plus forced `GIT_TERMINAL_PROMPT=0`, enforces 300-second and separate 1-MiB stream limits with SIGKILL/10-second close, continues after decided failures, and stops on indeterminate process state. It then rechecks exact plan bytes/commands, merged ancestry, attempt, clean exact HEAD, and claim before create-only receipt publication at `evidence/test-verifier.attempt-N.json`; raw output is never durable or public.
- Completed pass/fail is exact no-write/no-process replay. Active and unknown claims cannot be cleared, replaced, terminalized, retried, or advanced by any CLI or exported transition. All `factory recover` reasons, including the former `test-execution-reconciliation` text, generic terminal, steering conflict, step mutation, and another `test-execute` reject unchanged. B1R has no autonomous reconciliation command or authority flag; only explicit trusted out-of-band operator/process reconciliation may resolve the underlying process uncertainty. JSON test-execution failures distinguish active ownership with `TEST_EXECUTION_ACTIVE` and unknown/indeterminate state with `TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED`, and state that no supported factory command resolves either claim. V2 acceptance and all downstream panel/gate/fence/PR consumers share one authority check requiring a completed passing receipt, `artifacts/test-report.md`, and independent APPROVE review at the same attempt and HEAD. V1 generic test-verifier evidence behavior remains compatible.
- Diagnostic `run.json.debug_snapshot` records redacted factory/opencode/plugin creation and resume snapshots for debugging only. Snapshot persistence must omit sensitive keys and redact token-shaped/high-entropy credential values such as `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, `xoxb_*`, bearer/JWT/AWS-shaped values, credential-bearing URLs, and similar secrets.
- Diagnostic `run.json.cost_attribution` records local current-run cost/usage attribution only. It is not billing authority, invoice state, quota enforcement, or cross-run chargeback data. The factory records provider-supplied usage/cost metadata only; it must not maintain pricing tables, call pricing APIs, estimate missing costs, or coerce missing values to zero.

Explicit limits:

- Local-only, not cryptographic or tamper-proof.
- A coherent rewrite of local files and Git history is outside the model.
- Arbitrary local filesystem or reviewer/verifier modification is outside the model; local checks do not defend against a hostile host or operator.

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
          "planning": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "builder": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "reviewer": { "model": "openai/gpt-5.6-sol", "variant": "high" }
        }
      }
    ]
  ]
}
```

Historical production profile (not recommended):

> **Historical model guidance — not recommended:** The GPT-5.4/GPT-5.5 table below is
> retained for planning history only. Use the current recommendation in
> [`README.md`](README.md) instead.

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

Repo-seeded skill repair is implemented in `seedRepoSkill(repo, opts = {})` and is deliberately limited to `SKILL.md` and `SCHEMA.md`. Missing, empty, invalid, or `{}` `.seed-hash` metadata is treated as absent metadata. A target file is managed and refreshable only when it is missing, matches the current packaged source, matches its recorded seed hash, or matches a known previously packaged seed hash. Differing unrecognized content is treated as an operator edit and preserved. Every seed pass rewrites `.seed-hash` with only the current packaged hashes for `SKILL.md` and `SCHEMA.md`, so stale recognized files can be repaired and unrelated files are neither modified nor recorded.

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
ok: provider openai authenticated for openai/gpt-5.6-sol
missing: provider anthropic credentials for anthropic/claude-sonnet-4-6
warn: gh CLI missing; PR creation will fail
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

Long-wait heartbeat guard:

- Mark in-flight state first when heartbeat requires it, so `run.json` already shows a `running` step, `running` slice, or `review` slice created by a factory CLI state writer.
- Start heartbeat immediately before long `Task`/subagent dispatch/wait; do not start it after dispatch begins.
- For Step 2, `spec-review` brackets both the `spec-writer` Task dispatch/wait and the following `work-reviewer` wait; `decomposition-review` brackets both the `work-decomposer` Task dispatch/wait and the following `work-reviewer` wait. Each long wait gets its own heartbeat start immediately before dispatch/wait and stop in the after-return/`finally` path before the next semantic `run.json` / factory CLI state write.
- Stop heartbeat in the after-return/`finally` path when the wait completes, fails, or is abandoned.
- Do not perform the next semantic `run.json` / factory CLI state write while the long-wait heartbeat remains active; stop heartbeat or verify inactive first.
- Protected gates `story`, `brief`, and `pre_pr` remain heartbeat-free. The phase is opaque/non-enforced by validation beyond being non-empty, and heartbeat remains liveness-only, not authority.

Use these phase labels by convention: `spec-review` for the spec-writer Task wait and spec review, `decomposition-review` for the work-decomposer Task wait and plan review, `builder-wave` for builder wave waits, `slice-review` for slice reviewer waits, `test-verifier` for test-verifier waits, `test-rerun` for long acceptance-suite reruns, `test-review` for test evidence review, `implementation-validator` and `security-reviewer` for the pre-PR panel, `remediation` for routed fix waits, `post-pr-observation` for long GitHub checks/review observation waits, `post-pr-remediation` for post-PR builder or test-verifier remediation waits, and `post-pr-revalidation` for post-PR panel and local revalidation waits.

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

Heartbeat diagnostics require heartbeat-bracketed in-flight work in `run.json`: a `running` step, `running` slice, or `review` slice. Idle/bootstrap runs, blocked steps, protected gates, and valid terminal states suppress inappropriate stale-heartbeat and missing-heartbeat-process alarms; operators should read gates, current work status, or read `terminal_result` instead of reviving zombie state.

Diagnostics must fail closed for invalid local state. `diagnostics.authoritative` is true only when `run.json` schema and required sidecars pass. Invalid runs must not be treated as healthy, must not be silently restarted, and must not infer health from heartbeat/PID/process data, status booleans, worktree strings, or mutable `run.json` claims.

Disrupted resume recovery is explicit and non-destructive. `feature-factory factory resume-check <run-id> --json` is the only recovery preflight used before a mutating `resume <run-id>` path, and `factory start --headless|--autonomous "resume <run-id>"` runs that preflight before skill seeding or `opencode run`. Missing, inaccessible, or invalid `.opencode/factory/<run-id>/run.json` must not silently re-scaffold a control plane, overwrite missing/inaccessible/invalid durable state, or pretend that a durable terminal write happened; it returns a synthetic non-durable blocked envelope with `ok:false`, `durable:false`, `updated:false`, `recovered:false`, and a clear `terminal_result.reason` explaining that no durable `terminal_result` can be written without forbidden re-scaffolding. Resume-check must not perform destructive cleanup, `git worktree prune`, `git worktree remove`, branch deletion, or run-directory removal; cleanup remains an explicit operator action through `feature-factory factory cleanup <run-id>`.

For a valid non-terminal manifest with a missing active worktree, restoration is allowed only when the branch exists, recorded `base_commit` and every merged slice `merge_commit` are ancestors of branch HEAD, the target path remains under `.opencode/worktrees`, no unsafe existing path would be overwritten, `git worktree add` succeeds, and final worktree identity/HEAD checks match branch HEAD. Contradictory git evidence is terminal `blocked` with a `terminal_result.reason` naming the conflicting branch/commit evidence. Unsafe or inaccessible local paths are terminal `needs-human` with a `terminal_result.reason` naming the path that requires operator reconciliation. Read-only `status`, `list`, `validate`, and `watch` diagnostics must not implicitly recover, repair, cleanup, prune, or remove anything.

Shipped command:

```sh
feature-factory factory recover <run-id>
```

Proposed, not yet implemented (`factory stale` and `watch --summary` do not exist in the
current CLI):

```sh
feature-factory factory stale [--after 30m]
feature-factory factory watch <run-id> --summary
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
      "story-reader": "openai/gpt-5.6-terra",
      "backend-builder": "openai/gpt-5.6-sol"
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

## 8. Cost Attribution Contract

Implementation status: baseline cost attribution exists as a local current-run diagnostic write surface. The durable field is `run.json.cost_attribution`, and the required write command is:

```sh
feature-factory factory cost-record <run-id> \
  --agent AGENT \
  [--step STEP] \
  [--slice-id ID] \
  [--provider PROVIDER] \
  [--model MODEL] \
  [--source SOURCE] \
  [--operation OP] \
  [--request-id ID] \
  [--input-tokens N] \
  [--output-tokens N] \
  [--total-tokens N] \
  [--cache-creation-input-tokens N] \
  [--cache-read-input-tokens N] \
  [--reasoning-tokens N] \
  [--cost-total N] \
  [--cost-input N] \
  [--cost-output N] \
  [--cost-cache-creation N] \
  [--cost-cache-read N] \
  [--currency CODE] \
  [--recorded-at ISO] \
  [--entry-id ID] \
  [--json]
```

Persistence and exposure:

- Append entries through `factory cost-record`; never edit `run.json.cost_attribution` directly.
- Persist entries and recomputed `totals`, `by_agent`, and `by_slice` under `run.json.cost_attribution` in `.opencode/factory/<run-id>/run.json`.
- Expose public cost summaries in `factory status <run-id> --json`, `factory list`, `factory watch`, and TUI data. These summaries are observability signals for the current local run, not financial authority.

Data policy:

- Accept only token and cost values supplied by the active provider/opencode response metadata.
- Do not use model pricing tables, pricing APIs, heuristic estimation, or currency conversion.
- Do not coerce absent provider usage/cost fields to `0`. Missing stays missing and is surfaced through `missing`.
- `available` requires provider, model, usage, `cost_total`, and `cost_currency`.
- `partial` means some provider-supplied usage/cost exists but availability requirements are incomplete.
- `unavailable` means no usage or cost data was exposed; it is not zero spend.
- Mixed currencies make the rollup `partial`, set `mixed_currency: true`, and omit aggregate `cost_total` rather than converting.

Orchestrator recording contract:

- After each `spec-writer`, `work-reviewer`, `work-decomposer`, builder, `test-verifier`, `implementation-validator`, `security-reviewer`, and remediation wait, record any available provider usage with `factory cost-record`.
- Work-reviewer attribution includes spec review, decomposition review, slice review, and test review waits.
- Builders include `--slice-id <slice-id>` so `by_slice` summaries work.
- If a wait was bracketed by heartbeat, stop heartbeat or verify inactive with `feature-factory factory heartbeat <run-id> --status --json` before `factory cost-record`.
- `factory cost-record` must happen before terminal writes, Gate 3 terminalization, or `feature-factory factory pr-created` so terminal consumers see the final current-run summary.

This section deliberately does not introduce billing connectors, pricing sources, or provider-specific normalization beyond preserving provider-supplied metadata.

### Read-only cost report (report-v1)

The supported report invocations are:

```sh
feature-factory factory cost-report <run-id>
feature-factory factory cost-report <run-id> --json
feature-factory factory cost-report <run-id> --telemetry [--json]
```

Without `--json`, the command emits a human-readable terminal report. With `--json`, it emits the stable report-v1 response. `--telemetry` is opt-in report-invocation correlation only and may be combined with either output mode.

The report is computed exclusively from a projected copy of `run.json.cost_attribution.entries` at read time. A missing/null attribution block, an empty object, or missing/null/empty `entries` means zero persisted entries. Validate only the attribution entries against the resolved run-directory basename, then delete every own usage/cost numeric property whose value is exactly `null` from the copy before aggregation; do not mutate the persisted entry. Recompute `totals`, `by_agent`, `by_step`, and `by_slice` from those entries and ignore persisted attribution `status`, `totals`, `by_agent`, and `by_slice` caches. Do not call cost normalization/recomputation on read. `by_step`, report totals, and the report itself are never persisted.

The stable JSON keys and count contract are:

```json
{
  "schema_version": 1,
  "run_id": "run-123",
  "status": "partial",
  "entry_count": 3,
  "request_count": 3,
  "agent_count": 2,
  "step_count": 2,
  "slice_count": 1,
  "unattributed_step_entry_count": 1,
  "totals": {},
  "by_agent": {},
  "by_step": {},
  "by_slice": {}
}
```

Every rollup requires `status`, `entry_count`, `request_count`, `mixed_currency`, and `missing`, then conditionally includes the aggregated numeric fields `input_tokens`, `output_tokens`, `total_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `reasoning_tokens`, `cost_total`, `cost_input`, `cost_output`, `cost_cache_creation`, and `cost_cache_read`, followed by `cost_currency` when valid. Top-level `status` equals `totals.status`; top-level entry/request counts equal totals; `request_count` is one per persisted entry and does not deduplicate `request_id`.

An empty rollup is `unavailable` with zero entries/requests and `missing: ["entries"]`. A nonempty rollup is `available` only when every entry is available and no missing currency or mixed-currency condition is discovered. Any available/partial contribution otherwise makes it `partial`; a validator-accepted data-less `partial` entry remains `partial` even with no usage or cost numeric fields and contributes no fabricated numeric field. All-unavailable entries remain `unavailable`, and available plus unavailable is `partial`. `unavailable` always means attribution is absent, not zero. Explicit numeric `null` in every usage/cost field is compatible persisted absence and is omitted, never added as zero; explicit numeric `0` remains present and aggregatable. Missing fields stay absent and are reflected through the sorted `missing` union.

Group membership for `agent`, `step`, and `slice_id` requires a string whose trimmed length is nonzero, but the exact untrimmed, unsanitized persisted string is the raw JSON map key. Values such as `"agent"`, `" agent "`, `"agent\nx"`, literal escape-looking strings, and `"agent x"` remain distinct; `__proto__` is an ordinary safe key. Missing, `null`, empty, or whitespace-only steps are omitted from `by_step` and counted exactly in `unattributed_step_entry_count`; no synthetic step group is created. Missing slice IDs remain omitted from `by_slice`.

Human labels use an injective terminal-safe encoding for every raw group key and `missing` value. They are double-quoted, preserve printable ASCII except escaped quote/backslash, and encode every other UTF-16 code unit as uppercase `\uXXXX`. The completed multiline report is not passed through a lossy sanitizer. JSON serialization preserves raw decoded keys while escaping literal controls/line separators safely, so display collisions never merge identities.

Mixed currencies set the rollup to `partial`, set `mixed_currency: true`, include `mixed_currency` in `missing`, and omit both `cost_total` and `cost_currency`. Existing compatibility behavior may still separately sum `cost_input`, `cost_output`, `cost_cache_creation`, and `cost_cache_read`. Those components are not a normalized monetary total, and consumers must not infer or reconstruct a combined amount from them. The report performs no pricing-table/API lookup, pricing, estimation, currency conversion, currency coercion, or missing-to-zero coercion.

The command resolves one contained bare run ID and reads only its `run.json`. It does not call full-run validation, inspect or require gates/steps/slices/verdicts/terminal state, require accepted attestations, acquire or wait for `run-json.lock`, require an active/inactive heartbeat, mutate any file, normalize provider metadata, generate IDs/timestamps, or persist derived state. It makes no network calls. A racing atomic writer may yield the old or new snapshot only. This is strictly local diagnostic output, not billing authority, an invoice, a quota or chargeback ledger, a finance control, or cross-run accounting.

Telemetry behavior is deliberately narrower than factory tracing. Without `--telemetry`, all ambient trace variables are ignored and output is byte-equivalent whether they exist or not. With `--telemetry`, valid matching inherited context may append only `telemetry.trace_id` and `telemetry.parent_span_id`; absent context adds no section, and invalid/conflicting explicitly enabled context fails locally. Never expose full `traceparent`, `tracestate`, flags, headers, or exporter configuration. The IDs correlate only this cost-report invocation with inherited runtime context: they do not prove any attribution entry, agent, step, slice, provider request, or aggregate originated from that trace or span. The command does not create spans, initialize SDKs/exporters, inspect OTLP endpoints, persist trace context, or make network calls.

Errors are local and write no partial stdout or state. The command requires exactly one bare safe run ID; missing runs, malformed `run.json`, invalid attribution/entries, more than 1000 entries, invalid non-null numeric/status/currency/missing fields, and mismatched entry run IDs fail before aggregation. Numeric `null` alone is projected to absence rather than rejected or coerced.

## 9. Scripted Environment And Credential Contract

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
missing: gh auth unavailable for PR creation
```

If credentials are missing, fail before starting a long build.

## 10. Headless And Autonomous Driver Modes

Add first-class CLI support for external drivers that want to advance the factory without an interactive terminal.

Implementation status: first pass implemented. `factory start` accepts `--repo`; `--run-id` passes a validated requested new-run id as `driver.run_id`; `--headless` / `--detached` injects driver instructions into the `/feature` invocation. The orchestrator prompt already requires stopping after pending gates in scripted mode. `--autonomous` now injects explicit autonomous instructions so the factory can approve story/brief from its own complete artifacts, decide pre-PR from its implementation/security panel, run bounded remediation, write `terminal_result`, and open a PR without an external gate relay using the configured PR mode.

Required behavior:

- `feature-factory factory start` accepts `--repo <path>` and runs against that repo root regardless of caller cwd.
- `feature-factory factory start --run-id <run-id>` validates a bare safe id, rejects resume prompts that also pass `--run-id`, rejects existing run directories before launch, and passes the value as `driver.run_id` for new-run bootstrap only.
- Add a detached/headless mode, e.g. `--headless` or `--detached`, that runs until the next gate and exits after writing the gate question file.
- Add an autonomous mode, e.g. `--autonomous`, that runs until terminal status and writes `run.json.terminal_result`.
- On reaching a gate, the factory writes `gates/<gate>.question.md`, marks the gate pending in `run.json`, and exits cleanly with a recognizable status/output.
- External drivers can loop:
  1. `feature-factory factory start --repo <repo> --run-id <run-id> --headless "<prompt>"`, or `feature-factory factory start --repo <repo> --headless "resume <run-id>"` for resume.
  2. Read `.opencode/factory/<run-id>/gates/<gate>.question.md`.
  3. Decide externally.
  4. Write `gates/<gate>.answer` via `feature-factory factory answer <run-id> <gate> "approve|changes: ...|stop"`.
  5. Resume with `feature-factory factory start --repo <repo> --headless "resume <run-id>"`.

This is the generic adapter contract. External drivers should not need to parse chat output, keep an interactive session open, or mutate anything except gate answers.

Autonomous adapter contract:

1. `feature-factory factory start --repo <repo> --run-id <run-id> --autonomous "<prompt>"`, or `feature-factory factory start --repo <repo> --autonomous "resume <run-id>"` for resume.
2. Wait for process exit.
3. Read `.opencode/factory/<run-id>/run.json` and consume `terminal_result`.
4. Mirror only stable terminal fields (`status`, `pr_url`, `reason`, summary/artifact refs) to the external tracker.

External autonomous drivers should not parse gate internals or write answer files.

PR completion contract:

1. Gate 3 must be approved through the same transition-gated path as interactive runs.
2. `factory pr-fence` derives `operation_id` as `ffpr-v1-` plus lowercase SHA-256 of canonical UTF-8 JSON `{"base_commit", "branch", "created_at", "repository", "run_id"}` in lexical key order. Read that identity from the durable fence and put exactly one standalone `<!-- opencode-feature-factory:pr-operation=<id> -->` marker in the PR body.
3. After external creation, call `feature-factory factory pr-created <run-id> --fence-token TOKEN --json`. The account-switched, shell-free query is `GET repos/{repository}/pulls?state=all&head={owner}:{head_ref}&base={base_ref}&per_page=100`, with strict normalization and at most 10 valid Link pages.
4. Unique exact open normally records the universal `{pr_url,pr_number,pr_node_id,repository,operation_id,head_ref,head_sha,base_ref,base_sha,draft}` tuple; unique exact merged completes without polling. Closed-unmerged terminalizes `needs-human`. Absent on record, ambiguity, malformed/foreign/repeated/incomplete pagination, adapter error, or other unknown retains the fence. Only complete checked absence authorizes exact-token clear.
5. Identity-less legacy fence mutation terminalizes `needs-human` with `legacy-pr-fence-operation-identity-missing` and retains the fence. Drivers must not mirror PR URLs from direct manifest edits.

### Remediation context reuse contract

Implementation status: safe context reuse is an orchestrator runtime behavior only. It must not change the durable state protocol, evidence contract, review contract, or schemas.

The orchestrator may reuse a Task `task_id` inside a bounded remediation loop only for the implementer that owns the fix. Reuse is permitted only when every safety dimension is identical to the original dispatch:

- Role is the same eligible slice builder: `backend-builder` or `frontend-builder`.
- Subject ownership is unchanged: the same slice.
- Worktree and branch are unchanged.
- The live orchestrator session is unchanged; `task_id` reuse is invalid after process restart, `factory resume`, detached relaunch, blocked-run continuation, or any handoff to a different orchestrator session.
- The same bounded remediation loop is still active and has not exceeded its retry budget.

If any dimension is unknown, ambiguous, stale, or mismatched, the orchestrator must omit `task_id` and launch a fresh Task. `test-verifier` and every non-builder role always start fresh. Reuse is an optimization for continuity of the slice-builder conversation, not authority to skip observation, evidence, tests, reviews, validation, security review, or remediation bounds.

Every checked ordinary slice-builder Task is synchronous. Starting a new attempt sets durable `dispatch_required`; the checked pre-hook then create-publishes an immutable per-run/slice/attempt claim and atomically binds its ref/hash into that slice. The plugin generates a random completion capability, stores only its hash in the claim, retains the capability outside the Task prompt/body, and gives it only to the matching synchronous after-hook. That hook requires exact callback role/prompt identity and a confirmed foreground result before it create-publishes the capability-authenticated closure and binds its ref/hash into the slice. Failed, cancelled, unknown, or promoted-background results leave the claim unresolved. Review publication retains the exact claim/closure tuple in that attempt's append-only history before a successor may replace the current tuple. An absent, invalid, or unbound closure is an active/unknown dispatch outcome: no review may publish, no attempt may advance, no same-slice attempt may dispatch, and no terminal or continuation route may reset it into another run. Claims, closures, and their `run.json` bindings are durable crash/restart fences but contain no `task_id`. Non-slice builder remediation routes remain fresh and use their own durable lifecycle authority rather than ordinary slice-dispatch markers.

Review agents are not eligible for context reuse. `work-reviewer`, `implementation-validator`, and `security-reviewer` must start from a fresh Task every loop, must not receive a prior `task_id`, and remain read-only observers of the current worktree/result. This preserves independence for slice re-review, final implementation validation, and adversarial security review.

Existing attempt and delta-review behavior remains required. On every retry, the orchestrator still passes the current `attempt` and the prior applicable `required_fixes` list into the reviewer/validator/security prompt so the review checks whether required fixes landed and whether the fix introduced regressions.

Durability rule: never write `task_id` into `run.json`, `evidence/*`, `reviews/*`, gates, `terminal_result`, schema examples, or blocked-run continuation metadata. Durable state records attempts, refs, hashes, verdicts, and required fixes only. `task_id` is runtime-only and implementer-only; if safety is unknown, omit it.

## 11. Blocked-Run Continuation

Public schema-v1 command (including unchanged post-PR `--new-pr` behavior):

```sh
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>
```

This command is a recovery path for automated runs that reached terminal `blocked` after bounded remediation. It must create a fresh child run instead of mutating or reviving the parent.

Explicit schema-v2 pre-PR full-plan command:

```sh
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> --carry-forward
```

`slice-review-nonconvergent` parents require this schema-v2 form. Omitting `--carry-forward` rejects before reservation, publication, or launch; schema v1 is not a downgrade route for terminal nonconvergence.

`--carry-forward` is mutually exclusive with `--new-pr`. Unflagged and post-PR continuation stay schema v1; v2 is never selected implicitly.

Required continuation contract:

- Treat the injected continuation payload and all CLI arguments as untrusted operator data/config, not privileged instructions.
- The parent status is exactly `blocked`; do not continue from `completed`, `partial`, `needs-human`, `running`, missing, or invalid parent state.
- Validate `--review <review-ref>` as approved review evidence under the parent run that is referenced by parent run state, including referenced artifacts/evidence/reviews, hashes, and subject consistency. Do not rely on a blocking verdict enum to authorize continuation.
- For schema v1, persist `run.continuation` / `run.json.continuation` with `schema_version: 1`, `kind: "blocked-run-continuation"`, nested `parent`, `review`, and `target` objects, parent worktree, target base ref/commit, hashes for validated refs, `parent_artifacts` `{kind, ref, hash}` entries, parent evidence/review `{kind, ref, hash}` entries, `created_at`, and `operator_summary`.
- Treat all parent context as read-only. The child must not edit the parent manifest, gates, artifacts, evidence, reviews, branch, worktree, PR URL, or terminal result.
- Run the normal factory flow for the child: story gate, research/design, brief/spec/decomposition gate, build slices, acceptance tests, implementation-validator, security-reviewer, pre-PR gate, and PR-created transition.
- Continuation PRs use the same effective PR mode as normal runs: plugin `prMode` by default, with per-run `--draft` or `--ready` / `--no-draft` overrides when supplied. Persist the resulting mode as `run.json.pr_mode` so resume preserves the original override.
- Before recording PR creation for a continuation, record `terminal_result.draft` to match the effective PR mode used to create the PR.
- If bounded remediation is exhausted, ownership is ambiguous, or validator/security remains blocking, end the child at terminal `blocked` with no PR URL (`run.pr_url` unset and `terminal_result.pr_url: null`).

Schema-v2 carry-forward additionally requires an eligible pre-PR blocked parent, exact accepted unchanged planning (`planning_reuse.eligible === true`), no draft reuse, the required structured integration gate, current accepted work-decomposer plan/review hashes, an exact full PLAN partition, accepted B0MR sidecars/merge chain, unchanged origin base, and the permanent B1.3 claim/branch/worktree allocation. Resolve mode, account, PR mode, complete post-PR policy, limits, and retries before allocation; conflicting flags reject before resources. Build and validate the complete child in staging outside run discovery, copy `plan/slices.json` and the decomposition review byte-for-byte with the accepted step binding, repeat every authority/configuration observation after target absence is observed and immediately before the atomic no-overwrite directory move, and publish before payload/skill/launch.

The v2 child keeps root schema 1 and continuation schema 2. It copies exact accepted planning/spec acceptance at attempt zero, the immutable accepted work-decomposer step with exact plan/review bytes solely as local decomposition authority, immutable accepted merged rows/sidecars, and authority-free pending rows in PLAN order. It inherits no gates, decomposition execution or retry state, tests, panels, PR, outcomes, costs, provenance, or process state. Fresh execution skips planning/bootstrap and starts normal dependency-ready remaining work. Fresh whole-plan test-verifier begins at attempt one only after every row merges, followed by fresh validator/security and whole-story pre-PR authority. Payload and resume admission require the exact checked published child and exact persisted driver projection; claim/worktree/candidate text alone is insufficient. Exact replay preserves legitimate progress, terminal replay does not launch, and accepted planning or slice rows never rerun or rewrite.

## 12. Fallback Models

Current config supports one profile per role/agent.

Future config idea:

```jsonc
{
  "profiles": {
    "planning": {
      "primary": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
      "fallbacks": [{ "model": "anthropic/claude-sonnet-5", "variant": "high" }]
    }
  }
}
```

Open question:

- Can opencode plugin hooks enforce fallback behavior, or should this stay documentation-only until opencode supports per-agent fallback chains?

Do not implement fake fallback behavior that silently changes models without observable state.

## 13. Better Install Flow

Improve `feature-factory install`:

- Support `--local` for development.
- Support npm package install shape.
- Preserve existing opencode config fields.
- Validate JSONC safely.
- Print exact restart instruction.
- Optionally prompt for profile category mappings.

Non-interactive mode:

```sh
feature-factory install --profile '{"model":"openai/gpt-5.6-sol","variant":"xhigh"}'
feature-factory install --profiles-file profiles.json
```

## 14. OpenTelemetry GenAI Instrumentation

Add opt-in OpenTelemetry tracing for feature-factory runs, shaped to work with the OpenTelemetry GenAI semantic conventions and Honeycomb Agent Timeline. The goal is to make one factory run debuggable as a conversation timeline across the orchestrator, subagents, tool calls, gates, slices, validation, PR creation, and terminal state.

Reference design target: <https://www.honeycomb.io/blog/instrumenting-ai-agents-agent-timeline-opentelemetry-guide>

Relevant upstream context:

- `anomalyco/opencode#5245` is an old, still-open, merge-conflicted attempt to add direct OpenTelemetry setup to opencode.
- The useful comments on that PR say current opencode can emit AI SDK spans when `experimental.openTelemetry` is enabled and an OpenTelemetry SDK/exporter is initialized.
- Those native AI SDK spans were reported as `ai.streamText`, `ai.toolCall`, and `ai.streamText.doStream`, and may include full prompt text.
- Current opencode has native OTLP setup under `packages/core/src/observability/otlp.ts`, gates AI SDK telemetry with `experimental.openTelemetry`, and reads standard `OTEL_EXPORTER_OTLP_*` env vars.
- The external `@devtheops/opencode-plugin-otel` plugin provides mature generic opencode telemetry, metrics, logs, trace export, and `traceparent` support, but it does not know feature-factory run/gate/slice context and uses OpenInference-style attributes rather than Honeycomb Agent Timeline's `gen_ai.*` contract.

Implementation status for this milestone: telemetry readiness and trace propagation are implemented. `feature-factory doctor --telemetry` reports native opencode OTel readiness, sanitized OTLP env readiness, companion plugin presence, `@opentelemetry/api` instrumentation loadability, feature-factory enablement/no-default-telemetry state, and content-capture warnings. `factory start`, `factory resume`, and `factory continue` accept `--parent-span-id`, `--traceparent`, and `--tracestate`, validate W3C trace context, preserve existing `OTEL_EXPORTER_OTLP_*` / `OTEL_RESOURCE_ATTRIBUTES` env, and map supplied context to runtime child-process env only.

Current feature-factory state: the factory has durable local artifacts (`run.json`, `evidence/*`, `reviews/*`, heartbeat, process logs), no default telemetry exporter, and no durable trace state. Debugging a failed run still primarily uses local files and logs until the follow-up span taxonomy/exporter work lands.

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
- No durable trace context in `run.json`, gates, evidence, reviews, schema examples, or terminal state.
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

Implemented readiness categories and contract:

- `telemetry opencode experimental.openTelemetry`: reports native opencode OTel configuration and whether native AI SDK spans are expected when an SDK/exporter is initialized.
- `telemetry native AI SDK spans`: warns when native spans are not expected and warns about prompt/tool payload capture risk when native OTel is enabled.
- `telemetry OTLP endpoint`: checks `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` first, then `OTEL_EXPORTER_OTLP_ENDPOINT`; endpoint summaries are sanitized and credential-bearing URLs are redacted.
- `telemetry OTLP headers`: checks `OTEL_EXPORTER_OTLP_TRACES_HEADERS` and `OTEL_EXPORTER_OTLP_HEADERS`; only header names and `{present:true,value:"[redacted]"}` are reported, never Honeycomb/API key values.
- `telemetry resource service`: checks `OTEL_SERVICE_NAME` or `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.
- `telemetry companion plugin`: detects configured companion telemetry plugins such as `@devtheops/opencode-plugin-otel`; absence is a warning because native opencode OTel can still be used.
- `telemetry package instrumentation`: proves `@opentelemetry/api` is loadable and exports `trace`, `context`, and `SpanStatusCode` without requiring a SDK/exporter.
- `telemetry feature-factory options`: reports whether telemetry is enabled through `plugin.telemetry.enabled`, `FEATURE_FACTORY_OTEL_ENABLED`, or remains `default-off`.
- `telemetry content capture risk`: reports capture flags (`captureMessages`, `captureToolArguments`, `captureToolResults`, `captureReviews`, `captureEvidence`), redaction activity, and native AI SDK prompt/content-capture warnings.

Trace-context launch flags are non-authoritative runtime config for process correlation, not instructions and not durable state:

- `--traceparent` must match W3C format `00-<32hex trace id>-<16hex span id>-<2hex flags>` and reject all-zero trace/span ids.
- `--tracestate` is allowed but rejects control characters and newlines.
- `--parent-span-id` must be a non-zero 16-hex span id.
- If both `--parent-span-id` and `--traceparent` are supplied, the parent span id must match the span id inside `traceparent`.
- Runtime env mapping preserves operator-provided OTel env and adds context only when supplied: `TRACEPARENT`, `TRACESTATE`, `FEATURE_FACTORY_TRACEPARENT`, `FEATURE_FACTORY_TRACESTATE`, and `FEATURE_FACTORY_PARENT_SPAN_ID`.
- These values must not be persisted in `run.json`, evidence, reviews, gates, `terminal_result`, process evidence, or schema examples, and they must not approve gates, reviews, merges, PRs, or terminal results.

### Implementation Plan

1. Implemented: `src/telemetry.js` has a no-op-by-default `@opentelemetry/api` wrapper layer, redaction helpers, content-capture risk checks, trace-context validation, runtime env mapping, `withSpan()`, `recordError()`, and `runAttributes()`.
2. Implemented: `feature-factory doctor --telemetry` detects native opencode OTel config, sanitized OTLP env vars, companion telemetry plugins, package instrumentation loadability, no-default telemetry state, and risky native/feature-factory prompt or content capture.
3. Implemented: `factory start`, `factory resume`, and `factory continue` accept `--parent-span-id`, `--traceparent`, and `--tracestate`; they preserve operator-provided OTel env and map validated W3C trace context into spawned `opencode run` runtime env. `feature_factory.execution_id` remains a follow-up if/when root spans need it.
4. Implemented: package smoke covers published install/import behavior with no OTel env configured; docs contract tests cover the telemetry readiness and trace-context contract.
5. Follow-up: instrument feature-factory plugin hooks in `src/plugin.js`: `command.execute.before`, `chat.message`, `chat.params`, `tool.execute.before`, `tool.execute.after`, and `event` where useful. Prefer adding run/gate/slice attributes and bridge spans over duplicating generic model/tool payload spans.
6. Follow-up: instrument durable state transition helpers in `src/run-state.js` so spans/events are emitted when opencode-run node scripts update gates, steps, slices, PR-created/opened state, validation, or terminal results.
7. Follow-up: instrument CLI/control-plane boundaries in `src/factory.js`: start, detached start, validate, cleanup, gate answer, heartbeat start/stop/tick. If no SDK is initialized in the CLI process, these spans may be no-op; trace/context propagation into opencode is already present.
8. Follow-up: add in-memory span-exporter tests covering enabled spans, tool span lifecycle, run-id correlation, and error status once real feature-factory spans exist. Disabled mode, redaction, loadability, trace-context validation, and package smoke behavior are already covered.
9. Follow-up: validate a real Honeycomb trace using native opencode OTel or a companion plugin with a small factory run.
10. Follow-up: only after phase evidence, decide whether feature-factory needs its own SDK/exporter dependency for CLI root spans.

### Known Limitations And Open Questions

- Native opencode OTel may provide AI SDK spans without Agent Timeline `gen_ai.*` attributes. We may need bridge spans or an upstream opencode contribution to enrich native spans.
- Native AI SDK spans may include full prompts/tool payloads outside feature-factory redaction. This requires upstream controls or collector redaction before production use.
- Full feature-factory span taxonomy, bridge spans, transition spans, root CLI spans, exporter ownership, and Honeycomb Agent Timeline validation are follow-up work after the readiness/propagation milestone.
- Plugin-only tool spans may miss failed tool executions if opencode does not call `tool.execute.after` on failure. If this matters, add or consume an opencode hook that fires in `finally` with error metadata.
- `chat.params` exposes request metadata but not guaranteed final token usage or response model. Full `gen_ai.usage.*`, `gen_ai.response.model`, and finish reason support may require native opencode telemetry, opencode events, or richer hooks.
- Subagent handoffs are visible through task/tool flows only if opencode surfaces enough tool metadata to identify the target agent reliably.
- Detached runs need careful context propagation because parent and child processes are separate. The parent should inject trace context into the child environment; the child/plugin should extract it.
- Telemetry cardinality must be controlled. Use run ids and artifact refs intentionally, but do not attach large or unbounded values.
- `@devtheops/opencode-plugin-otel` is useful as a companion/reference, but it is MPL-2.0 licensed. Do not copy its code into this MIT package without explicit license review.

### Acceptance Criteria

Implemented milestone acceptance:

- Telemetry is off by default and adds no exporter/network side effects unless explicitly enabled and an SDK/exporter is initialized by the operator/native opencode/companion plugin.
- `doctor --telemetry` reports native opencode OTel readiness, sanitized OTLP env readiness, companion plugin presence, package instrumentation loadability, feature-factory enablement/default-off state, and content-capture risk.
- Trace-context flags `--parent-span-id`, `--traceparent`, and `--tracestate` are accepted on launch/resume/continue paths, validated, mapped to runtime env, treated as non-authoritative config, and not persisted in `run.json`.
- Secret-shaped values are redacted from telemetry diagnostics and OTLP env summaries, including token-shaped values that do not contain literal `secret`, `token`, or `password` words.
- The docs warn that native opencode/AI SDK spans may capture prompts unless upstream or collector redaction is configured.
- Tests prove loadability, disabled/no-op behavior, redaction, trace-context validation/env propagation, package smoke behavior, and docs contracts.

Follow-up acceptance for the full span taxonomy/exporter milestone:

- With telemetry enabled and native opencode OTel configured, `factory start --detached` and normal foreground starts produce native opencode AI SDK spans plus feature-factory correlation spans in the same trace when possible.
- Spans include the three Agent Timeline attributes where applicable: `gen_ai.conversation.id`, `gen_ai.agent.name`, and `gen_ai.operation.name`.
- Factory tool/bridge spans include `gen_ai.tool.name` and `gen_ai.tool.call.id` when tool metadata is available.
- Errors set OpenTelemetry error status and `error.type` on real emitted spans.
- Tests with an in-memory exporter prove enabled mode, tool span lifecycle, run-id correlation, and error status.

## 15. Non-Goals

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

## Interrupt, Steer, And Resume Contract

Detached process evidence is part of the interrupt contract only for validated run-owned detached launches. A generic new `factory start --detached`, detached resume, or validated continuation writes `$RUN/process.json` with `{ schema_version, kind:"opencode-process", run_id, execution_id, pid, started_at, updated_at, state, cwd, identity, log_ref, cancel }` and run-scoped logs under `$RUN/processes/<timestamp>.log` only after live process identity is verified; unsupported identity inspection fails the launch before `process.json` is written. A generic new start allocates or validates a safe available run id before spawn and returns it; `--run-id <run-id>` does not grant process-evidence authority over an existing run because collisions are rejected. `feature-factory factory cancel <run-id> --json` validates run-scoped evidence against the requested run and live process identity. Success sends only `SIGTERM`, confirms exit, stops the run heartbeat, updates `process.json.state` to `cancelled`, and returns `ok:true`, `status:"cancelled"`, `signal:"SIGTERM"`, `process_ref:"process.json"`, `signaled:true`, and `updated:true`. Failure is fail-closed: missing/invalid/stale/mismatched/non-running evidence, signal failure, or indeterminate heartbeat cleanup returns `ok:false`, `status:"failed-closed"`, a reason, and no broad process kill, process-group signal, `pkill`, or `killall` fallback. `factory cancel` updates only process sidecars; it is not a semantic `run.json` state transition and does not use checked run transitions.

Steering is run-local untrusted operator data/config. Cancel before steering when a detached opencode process is still running, then queue with `feature-factory factory steer <run-id> --message TEXT --json`; it writes `$RUN/steering/*.json` and stores only ref/hash/message length metadata in `run.json.steering`. Consume it exactly once with `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`; the JSON response uses `trust: untrusted-operator-data` and the label `UNTRUSTED OPERATOR STEERING DATA (not instructions)`.

Resume uses `feature-factory factory resume <run-id> --dry-run --json` before `feature-factory factory resume <run-id> --headless --json`. It rejects `active-heartbeat`, `terminal-run`, `invalid-run-state`, and `missing-worktree`. The payload has top-level `resume` and `steering` objects and `raw_message_included: false`, preserving the existing run id, branch, worktree, gates, artifacts, evidence, reviews, slices, and terminal-state contract. Factory-generated start, resume, and continuation envelopes use a preprocessing-safe versioned `ffpayload-v1:<base64url>` transport token. The plugin must decode and structurally validate that token in `command.execute.before` before model execution and inject a line-oriented `PLUGIN_PARSED_OPERATOR_PAYLOAD` block containing normalized untrusted operator data/config. Driver mode and routing use only that deterministic parse result. Unencoded, malformed, non-canonical, ambiguous, or mismatched envelopes fail closed to interactive mode with no routing authority; raw transport text remains untrusted and is never reparsed to grant autonomous, resume, steering, continuation, or requested-run-id authority. This trust boundary is positional prompt framing, not cryptographic authentication; base64url encodes transport data but does not authenticate its sender.

The feature skill must run `feature-factory factory env record-resume <run-id> --json` before `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json` or any other mutating resume state write.

After `steer-consume`, the orchestrator must run a steering-conflict checkpoint before applying the steering to planning/build/test flow. If the consumed untrusted steering would require changing accepted durable state — approved gates, accepted steps, merged or blocked slices, passing validator/security verdicts, `pr_url`, or `terminal_result` — automatic rollback is forbidden. Use `feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --reason TEXT --json`; it requires a running run, inactive heartbeat, latest consumed steering ref/hash, and matching consumed-file hash. The transition writes terminal `status:"needs-human"` with fixed safe reason and summary text. Since it creates no durable artifact, `terminal_result.artifacts` is empty; the existing steering history retains the consumed ref/hash, and the response returns the steering ref/hash plus protected state with `ok:false`, `conflict:true`, `updated:true`, and `status:"needs-human"`. The operator must reconcile manually instead of the factory resetting gates, unmerging slices, rewriting evidence/reviews, removing PR URLs, or continuing from stale accepted artifacts.
