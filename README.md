# opencode-feature-factory

Hybrid opencode plugin plus CLI for a durable, scriptable feature workflow.

It ships:

- `/feature` command registration for opencode.
- A TUI sidebar panel that monitors active local factory runs.
- Feature-factory skill docs and control-plane schema.
- Specialized subagents for story, research, spec, decomposition, build, tests, review, and validation.
- A `feature-factory` CLI with install/doctor commands and local factory state helpers.

## Trust Model

The proof layer removed in the simplified factory. The durable contract is local state plus transition-time checks, not a cryptographic or tamper-proof authority system.

Active guarantees:

- `run.json`, gate answers, `evidence/*`, `reviews/*`, and `terminal_result` are durable local workflow state.
- Semantic manifest writes go through locked transition helpers so stale writers fail instead of overwriting newer state. `transitionGateDecision` owns approved gate writes, and `transitionPrCreated` owns completed PR state writes.
- Pending gates include `pending_snapshot` entries for `question_ref`, `question_hash`, `artifact_ref`, `artifact_hash`, and answer material. Gate answer consumption fails closed if current refs are missing, escaped, stale, or hash-mismatched.
- Detached opencode processes are cancellable only when they have run-scoped evidence from a known explicit run id: `$RUN/process.json` points at one verified process identity and `$RUN/processes/<timestamp>.log` records stdout/stderr. Run-owned detached launches fail before writing `process.json` if live process identity cannot be verified. `factory cancel` sends a single targeted `SIGTERM` only when that evidence validates; missing, invalid, stale, mismatched, or non-running evidence returns a fail-closed response and sends no signal. There is no broad process kill, process-group kill, `pkill`, or `killall` fallback.
- PR URLs are written only through `feature-factory factory pr-created ...`, which checks `pre_pr` approval, validator `GO` or `GO-WITH-NITS` with a report file, security `PASS` with a review file, completed slice state, matching PR number, and a canonical GitHub PR URL before updating `run.pr_url` and `terminal_result.pr_url`.
- Blocked-run continuation payloads are operator data/config, not privileged instructions. `factory continue` validates a parent whose status is exactly `blocked`, validates recognized subject-consistent approved review evidence, records read-only parent context under `run.json.continuation`, and still requires the normal gates, observed evidence, validator, security review, and configured PR checks.
- `run.json.debug_snapshot` is diagnostic-only creation/resume metadata. It helps debug the factory/opencode/plugin substrate, but it is not authority for gates, reviews, merges, or PR URLs. Persisted snapshots omit sensitive keys and redact token-shaped or high-entropy credential values, including GitHub PAT shapes (`ghp_*`, `github_pat_*`, `gho_*`), OpenAI keys (`sk-proj_*`, `sk-*`), Slack tokens (`xoxb_*`), bearer/JWT/AWS-shaped values, credential-bearing URLs, and similar high-entropy secrets.
- `run.json.cost_attribution` is diagnostic-only local current-run usage/cost attribution. It is not billing authority, invoice data, quota enforcement, or cross-run chargeback state. It records provider-supplied usage and cost metadata only; the factory does not maintain pricing tables, call pricing APIs, estimate missing costs, or coerce missing usage/cost to zero.
- Trace-context launch metadata from `--parent-span-id`, `--traceparent`, and `--tracestate` is non-authoritative runtime configuration for process correlation only. It is not user instructions, not gate/review/PR authority, and not persisted in `run.json` or other durable factory state.

Limits:

- Local-only, not cryptographic or tamper-proof.
- A coherent rewrite of local files and Git history is outside the model.

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
feature-factory doctor --telemetry
npm run doctor:local
```

`feature-factory doctor --local` and `npm run doctor:local` run the local doctor path; the npm script is a convenience wrapper around `feature-factory doctor --local` for this checkout. `feature-factory doctor --telemetry` runs the telemetry-readiness checks described in the Doctor section without requiring a factory run.

## Use In opencode

```text
/feature APP-123 add the missing approval workflow
```

### Workflow Depth

The primary `feature-factory` agent is the only agent allowed to dispatch tasks. Specialized subagents cannot recursively delegate, which keeps the orchestration tree one level deep.

Ordinary interactive maintenance requests may use the `light` bounded-maintenance path when scope, outcome, and tests are explicit and the change has no product ambiguity, class-wide requirement, cross-stack coordination, public API/schema contract, persistence/migration, generated/subtree ownership, or auth/security/trust-boundary impact. Light work uses one direct scoped discovery pass, direct implementation, focused plus full checks, and a human-reviewed PR; it does not create factory state or dispatch planning agents.

Explicit `/feature`, scripted/autonomous runs, tickets/product ideas, resumes, continuations, and broader work use the durable `standard` or `strict` workflow. Strict is selected for class-wide, security-boundary, migration, generated-code, and cross-system changes. Unknown legacy `review_tier` labels fall back to standard behavior.

`feature-factory install` warns when global files under `~/.config/opencode/agent/` or `agents/` duplicate plugin-owned agent names. Remove stale copies or replace them with delegators; otherwise an old global prompt may shadow the package prompt until opencode restarts.

## Configure Plugin Options

By default, successful factory runs create ready-for-review PRs. Set plugin `prMode` to `"draft"` if this repo should keep successful PRs as drafts, or `"ready"` to make the default explicit. Per-run CLI flags such as `factory start --draft` or `factory start --ready` / `--no-draft` can override the plugin default for that run.

```jsonc
{
  "plugin": [
    ["opencode-feature-factory", { "prMode": "ready" }]
  ]
}
```

By default, agents use opencode's normal model resolution. You can override model and variant together through plugin `profiles`.

One profile for all feature-factory agents:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profile": {
          "model": "openai/gpt-5.6-sol",
          "variant": "xhigh"
        }
      }
    ]
  ]
}
```

Role-based profiles (a coarser alternative to the recommended exact-agent mapping below):

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "story": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "research": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "design": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "planning": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "builder": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "test": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "reviewer": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "security": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" }
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
          "default": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "spec-writer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "implementation-validator": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "security-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" }
        }
      }
    ]
  ]
}
```

Supported roles: `story`, `research`, `design`, `planning`, `builder`, `test`, `reviewer`, `security`. The dedicated primary orchestrator agent, `feature-factory`, is mapped to `planning`. `security-reviewer` uses `profiles.security` when present and falls back to `profiles.reviewer` for compatibility.

Factory agents are configured with scoped non-interactive permissions (`bash`, `edit` where appropriate, `webfetch`, task delegation, and read/search tools) so `factory start --headless` cannot deadlock on opencode permission prompts. `external_directory` is explicitly denied. This permission scope applies to the factory command and factory agents, not to your global opencode sessions.

Before each `factory start`, the CLI seeds the feature skill into the target repo at `.opencode/skills/feature/SKILL.md` and `.opencode/skills/feature/SCHEMA.md`, and adds `.opencode/skills/feature/` to the repo-local `.git/info/exclude` when available. The schema is the authoritative control-plane reference for `run.json`, `factory.lock`, `heartbeat.json`, `plan/slices.json`, `evidence/*`, `reviews/*`, and `run-json.lock/`; keeping it repo-local lets agents read it without relaxing `external_directory: deny`.

Seed repair is intentionally narrow. The CLI manages only `SKILL.md` and `SCHEMA.md` in `.opencode/skills/feature/`. If `.seed-hash` is missing, empty, invalid, or `{}`, those two files are treated as absent metadata: files matching the current packaged source, their recorded seed hash, or a known previously packaged seed hash are refreshed to the current package content, while unrecognized differing content is preserved as an operator edit. Each seed pass rewrites `.seed-hash` with only the current packaged hashes for `SKILL.md` and `SCHEMA.md`; unrelated files in the skill directory are not changed or recorded.

Profile precedence is exact agent, then role, then `profiles.default`, then top-level `profile`, then opencode default. A profile may contain `model`, `variant`, or both.

### Reviewer Read-Only Guard

Reviewer-designated agents are `work-reviewer`, `implementation-validator`, and `security-reviewer`. They run with `edit: deny`, but that is not a runtime sandbox: they may still mutate through allowed `bash` or other tool paths.

Current enforcement is post-run git dirty-state detection only. After one of those agents returns, the orchestrator checks the reviewed worktree with `git -C <reviewed_worktree> status --porcelain=v1 --untracked-files=all` before accepting the result. If that status is dirty or unverifiable, the review is blocked and the reviewer output is discarded.

Limitations: this catches only git-visible changes in the reviewed worktree after the reviewer returns. It does not catch ignored files, committed or reverted changes, non-git-visible effects, or effects outside the reviewed worktree, and it does not provide OS/process sandboxing or prevention.

### Recommended Model Profile

For serious feature-factory runs, use the strongest model/effort where architectural mistakes are most expensive: planning, decomposition, review, and final validation. Builders should still run strong, but story normalization and acceptance-test writing can usually run lower.

Recommended exact-agent mapping. These model IDs are registered by the OpenAI provider; if your provider exposes different IDs, keep the same agent/variant shape and adjust only the model strings.

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "feature-factory": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "backend-builder": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "codebase-researcher": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "design-interpreter": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "frontend-builder": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "implementation-validator": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "security-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "spec-writer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "story-reader": { "model": "openai/gpt-5.6-luna", "variant": "medium" },
          "story-writer": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "test-verifier": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "work-decomposer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "work-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "high" }
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

Every `/feature` invocation starts with an intent gate. It classifies the request as `new-feature`, `resume`, `gate-answer`, `status`, `scripted-start`, `autonomous-start`, `pr-continuation`, or `blocked-run-continuation` before mutating state. This prevents accidental restarts and lets external drivers answer gates with the same protocol as interactive users.

Start a run through opencode:

```sh
feature-factory factory start "APP-123 add the missing approval workflow"
```

Run against a specific repo and exit at the next gate for an external driver:

```sh
feature-factory factory start --repo /path/to/repo --headless "APP-123 add the missing approval workflow"
```

Run autonomously through the factory's own reviewed gates and open a PR when safe, using the configured PR mode:

```sh
feature-factory factory start --repo /path/to/repo --autonomous "APP-123 add the missing approval workflow"
```

Check or recover a disrupted resume before launching opencode:

```sh
feature-factory factory resume-check <run-id> --json
```

`factory resume-check` is the explicit recovery control plane for `resume <run-id>`. Missing, inaccessible, or invalid `.opencode/factory/<run-id>/run.json` never causes a fresh empty control plane to be re-scaffolded; the command returns a synthetic non-durable blocked envelope with `ok:false`, `durable:false`, `updated:false`, `recovered:false`, and a clear `terminal_result.reason` stating that no durable `terminal_result` can be written without forbidden re-scaffolding. Resume-check also never performs destructive cleanup, `git worktree prune`, `git worktree remove`, branch deletion, or run-directory removal; cleanup remains an explicit operator action through `factory cleanup` and should be previewed with `--dry-run` when appropriate. For valid non-terminal manifests with a missing active worktree, recovery is allowed only when the branch exists, recorded `base_commit` and merged slice `merge_commit` values are ancestors of branch HEAD, the target stays under `.opencode/worktrees`, no existing path would be overwritten, `git worktree add` succeeds, and the final worktree identity/HEAD matches the branch. Contradictory git evidence persists terminal `blocked` with a `terminal_result.reason` naming the conflicting branch/commit evidence; unsafe or inaccessible local paths persist terminal `needs-human` with a `terminal_result.reason` naming the path that requires operator reconciliation. `factory start --headless|--autonomous "resume <run-id>"` runs this preflight before seeding repo skills or spawning opencode and prints the envelope instead of continuing when `ok:false`. Read-only `status`, `list`, `validate`, and `watch` surfaces do not implicitly recover, repair, cleanup, prune, or remove anything.

Continue from a terminal blocked run with a new run id:

```sh
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>
```

`factory continue` is for automated blocked-run remediation. The supplied review ref and any injected continuation payload are untrusted operator data/config, not privileged instructions. The parent run must exist with status exactly `blocked`; the review ref must resolve to recognized, subject-consistent approved review evidence inside the parent run; and the child records the relationship under `run.json.continuation` with `schema_version`, `kind`, `created_at`, `operator_summary`, nested `parent` / `review` / `target` objects, parent worktree, target base ref/commit, refs paired with hashes, `parent_artifacts` `{kind, ref, hash}` entries, and parent evidence/review `{kind, ref, hash}` entries. The parent manifest, artifacts, reviews, evidence, branch, worktree, PR URL, and terminal result are read-only context and are not changed by the child.

Continuation does not bypass the factory. The child proceeds through the normal story and brief gates, research/spec/decomposition, slice build and acceptance tests, implementation-validator, security-reviewer, pre-PR gate, and checked PR creation. Review validation checks approved evidence and referenced refs/hashes; it does not rely on a special blocking verdict enum. Continuation uses the same effective PR mode as normal runs: plugin `prMode` by default, with per-run `--draft` or `--ready` / `--no-draft` overrides where supplied. The start-time effective mode is persisted as `run.json.pr_mode` so resume payloads do not fall back to a later plugin default. If bounded remediation is exhausted or the child remains blocked, terminal status is `blocked` with no PR URL (`terminal_result.pr_url: null`).

Run in the background for external watchers or CI-style adapters:

```sh
feature-factory factory start --repo /path/to/repo --headless --detached "APP-123 add the missing approval workflow"
```

Detached mode returns a PID. Generic detached starts write stdout/stderr to package-level process logs and do not create `$RUN/process.json`; adding `--run-id <run-id>` to `factory start --detached ...` is only operator input to that generic launch and does not grant process-evidence authority over an existing run. Run-scoped cancellation evidence is written only for validated run-owned detached launches, such as `factory resume <run-id> --detached` (and validated continuation launches), where stdout/stderr goes to `.opencode/factory/<run-id>/processes/<timestamp>.log` and `.opencode/factory/<run-id>/process.json` records the verified cancellable process identity. If the platform inspector cannot verify the just-launched process identity, the detached launch fails closed and writes no `process.json`.

Cancel a detached run before queueing interrupt steering:

```sh
feature-factory factory cancel <run-id> --json
```

`factory cancel` is evidence-bound and fail-closed. On valid running `process.json` identity it sends exactly one `SIGTERM` to the recorded PID, marks `process.json.state` as `cancelled`, and returns `ok:true`, `status:"cancelled"`, `signal:"SIGTERM"`, `process_ref:"process.json"`, `signaled:true`, and `updated:true`. If `process.json` is missing, invalid, stale, mismatched, already non-running, or the signal fails, it returns `ok:false`, `status:"failed-closed"`, `signaled:false`, `updated:false`, a `reason`, and no broad process kill, process-group signal, `pkill`, or `killall` fallback is attempted.

`factory cancel` updates only the process sidecar (`$RUN/process.json`). It is not a semantic `run.json` state transition and does not approve gates, change slices, write verdicts, or terminalize the run.

Autonomous mode is explicit opt-in. It still writes gate question files, observed evidence, reviews, and `run.json`; it records story/brief approvals only when the artifacts are complete and unambiguous, decides pre-PR from the implementation-validator/security-reviewer panel, runs bounded remediation on NO-GO, and never auto-merges. Humans review and merge PRs outside the factory.

### Remediation context reuse

During a bounded remediation loop, the orchestrator may reuse an opencode Task `task_id` only as a runtime-only, implementer-only optimization. Reuse is safe only when all of these remain unchanged from the original Task dispatch:

- Same implementer role: `backend-builder`, `frontend-builder`, or `test-verifier`.
- Same owned remediation subject: the same slice id for a builder, or the same acceptance-test/integration test owner for `test-verifier`.
- Same slice/test worktree and same branch.
- Same live orchestrator session; `task_id` values are not portable across process restarts, `factory resume`, detached relaunches, or continuation child runs.
- Same bounded remediation loop, including the same attempt sequence and remediation owner.

Eligible implementers are only `backend-builder`, `frontend-builder`, and `test-verifier`, and only when that agent owns the remediation being routed. If any safety fact is unknown, omit `task_id` and start a fresh Task.

Reviewers and final panel agents must start fresh every loop. Do not pass a `task_id` to `work-reviewer`, `implementation-validator`, or `security-reviewer`; they remain read-only observers for each review/validation/security pass. Existing re-review behavior still applies: every retry passes the current `attempt` and the prior review or panel `required_fixes` list so reviewers perform the required delta review instead of reopening unchanged scope.

`task_id` is never durable factory state. Do not persist it in `run.json`, evidence records, review files, schema examples, gates, process logs intended as workflow evidence, or external tracker payloads. Persist the attempt number, evidence refs, review refs, and required fixes; keep `task_id` only in orchestrator memory for the live dispatch that may be resumed.

Monitor local state:

```sh
feature-factory factory list
feature-factory factory status <run-id> --json
feature-factory factory watch <run-id>
feature-factory factory watch --all
feature-factory factory validate <run-id>
feature-factory factory env
feature-factory factory env record-created <run-id> --json
feature-factory factory env record-resume <run-id> --json
feature-factory factory cancel <run-id> --json
feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --reason TEXT --json
feature-factory factory cost-record <run-id> --agent AGENT --step STEP --provider PROVIDER --model MODEL --input-tokens N --output-tokens N --total-tokens N --cost-total N --currency CODE --json
feature-factory factory cost-report <run-id> [--json] [--telemetry]
feature-factory factory pr-created <run-id> --pr-url URL --pr-number N --repository OWNER/REPO --json
```

`factory status`, `factory answer`, and `factory validate` apply code-level schema validation to `run.json`; `factory validate` also validates `plan/slices.json` when present. Invalid runs appear as `invalid` in `factory list` instead of crashing the whole list.

### Cost attribution diagnostics

The factory records optional usage and cost attribution under `.opencode/factory/<run-id>/run.json` at `run.json.cost_attribution`, with `totals`, `by_agent`, and `by_slice` rollups. This block is a local current-run diagnostic surface for operators. It is not billing authority: do not use it as an invoice source, quota ledger, cross-run financial record, or chargeback contract.

Write cost attribution only through the CLI so the run-json lock, validation, and rollups stay consistent:

```sh
feature-factory factory cost-record <run-id> \
  --agent implementation-validator \
  --step implementation-validator \
  --provider openai \
  --model openai/gpt-5.6-sol \
  --input-tokens 12000 \
  --output-tokens 900 \
  --total-tokens 12900 \
  --cost-total 1.23 \
  --currency USD \
  --json
```

Semantics:

- Persist provider-supplied usage/cost metadata only. The factory must not use pricing tables, pricing APIs, local price estimates, currency conversion, or missing-to-zero coercion.
- `available` means provider, model, usage, `cost_total`, and `cost_currency` are present.
- `partial` means some usage/cost data is present but provider/model/usage/cost_total/cost_currency is incomplete; missing fields stay missing and are listed in `missing`.
- `unavailable` means the provider exposed no usage or cost data. It does not mean zero cost.
- `factory status <run-id> --json`, `factory list`, `factory watch`, and the TUI expose a cost summary (`status`, entry/agent/slice counts, token fields when supplied, `cost_total`/`cost_currency` when supplied, mixed-currency and missing-field indicators).

Read the complete current-run attribution as a report without changing factory state:

```sh
feature-factory factory cost-report <run-id>
feature-factory factory cost-report <run-id> --json
feature-factory factory cost-report <run-id> --telemetry [--json]
```

The default mode is a human-readable terminal report. `--json` emits the stable report-v1 response (`schema_version: 1`) for scripts. Both modes contain run totals and `by_agent`, `by_step`, and `by_slice` rollups, plus top-level `entry_count`, `request_count`, `agent_count`, `step_count`, `slice_count`, and `unattributed_step_entry_count`. Request count is one per persisted entry; it does not deduplicate `request_id`. Entries whose `step` is missing, `null`, empty, or whitespace-only are excluded from `by_step`, counted by `unattributed_step_entry_count`, and never placed in a synthetic group.

Every report view is recomputed at read time exclusively from `run.json.cost_attribution.entries`. Persisted attribution `status`, `totals`, `by_agent`, and `by_slice` caches are ignored, and `by_step` and report totals are never persisted. Exact, untrimmed, unsanitized nonblank agent, step, and slice strings remain distinct raw JSON map keys, including `__proto__`. Human output uses quoted, injective terminal-safe labels: printable ASCII remains readable with quote/backslash escaping, and every other UTF-16 code unit is encoded as uppercase `\uXXXX`. Display encoding never changes or merges the raw JSON identities.

Report rollups preserve the attribution contract. Empty data is `unavailable`, never zero; a validator-accepted `partial` entry with no usage or cost numeric fields remains `partial` and contributes no fabricated number. An explicit `null` in any usage or cost numeric field is treated as absence and omitted, not coerced to zero; an explicit numeric `0` remains present. `available`, `partial`, `unavailable`, `missing`, entry counts, and request counts use the existing rollup semantics.

Mixed currencies make the affected rollup `partial`, set `mixed_currency: true`, add `mixed_currency` to `missing`, and suppress both `cost_total` and `cost_currency`. Component fields such as `cost_input`, `cost_output`, `cost_cache_creation`, and `cost_cache_read` may remain separately summed for compatibility, but they are not normalized monetary totals. Consumers must not reconstruct a combined total from those components.

`factory cost-report` is a strictly local, read-only diagnostic, not billing authority. It does not mutate `run.json` or any factory file, persist derived output, acquire or wait for `run-json.lock`, require heartbeat state or accepted attestations, inspect pricing tables/APIs, price or estimate costs, convert currencies, coerce missing values, normalize provider metadata, or make network calls. It is not an invoice, quota, chargeback, finance-control, or cross-run accounting surface.

`--telemetry` opts in only for that report invocation. When valid inherited trace context exists, the response may append `telemetry.trace_id` and `telemetry.parent_span_id`; without the flag, ambient context is ignored and output is unchanged. This metadata correlates the report invocation only. It is not proof that any attribution entry, agent, step, slice, provider request, or aggregate came from that trace/span. It does not create a span, enable an exporter, persist context, or cause network traffic.

Orchestrators should record available provider usage with `factory cost-record` after the long waits for `spec-writer`, `work-reviewer`, `work-decomposer`, builders, `test-verifier`, `implementation-validator`, `security-reviewer`, and remediation. Because these waits usually run under heartbeat, stop heartbeat or verify it inactive first, then record cost attribution before terminal writes or `factory pr-created`.

Clean up terminal runs after their PRs are merged or their artifacts are no longer needed:

```sh
feature-factory factory cleanup <run-id> --dry-run
feature-factory factory cleanup <run-id>
```

Cleanup removes `.opencode/factory/<run-id>`, recorded worktrees under `.opencode/worktrees/`, and recorded local branches. It only runs for terminal statuses (`completed`, `blocked`, `partial`, or `needs-human`) unless `--force` is supplied. Cleanup refuses to remove run directories outside `.opencode/factory`. Unmerged branches are preserved unless `--force` is supplied. Use `--dry-run` first when you want to preview what would be removed.

When opencode is running in the TUI on a session route, the sidebar also shows a `Feature Factory` panel for runs found under `.opencode/factory/*/run.json` in the current session directory or any nested repo below it. It lists active runs across those repos, including status, mode, pending gate, slice progress, validation/security verdicts, PR URL, terminal reason, and branch. Completed runs are hidden except for the most recent completed run. Directly under the panel header, the muted refresh diagnostic label `sidebar vN · plugin changes need TUI restart` shows the current sidebar data version; run discovery still uses the existing 30s root-cache TTL. An already-open opencode TUI process can keep rendering stale Feature Factory sidebar data after the plugin bundle changes, so restart or reload the TUI to pick up plugin changes.

For autonomous runs, external adapters should read `run.json.terminal_result` or `factory status <run-id> --json` after the run exits. Terminal statuses are `completed`, `blocked`, `partial`, and `needs-human`; successful PR creation records `pr_url` only through the `pr-created` transition.

### Environment snapshots and PR recording

The factory records diagnostic environment snapshots explicitly:

```sh
feature-factory factory env record-created <run-id> --json
feature-factory factory env record-resume <run-id> --json
```

These commands update `run.json.debug_snapshot.created_with`, `last_resumed_with`, and `resume_count` using redacted diagnostic-only snapshots. They must not persist raw token-shaped or high-entropy credentials such as `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, or `xoxb_*`.

After Gate 3 and successful PR creation, the normal flow is to record the PR through the checked transition instead of editing the manifest directly:

```sh
feature-factory factory pr-created <run-id> \
  --pr-url URL \
  --pr-number N \
  --repository OWNER/REPO \
  --json
```

Verify the created PR first with `gh pr view <url>`. The command checks the approved `pre_pr` gate, validator `GO` or `GO-WITH-NITS` with a report file, security `PASS` with a review file, completed slice state, matching PR number, and a canonical GitHub PR URL. Only then does it write `run.pr_url`, `status: completed`, and `terminal_result.pr_url`.

`factory pr-created` records ready-for-review PRs by default. Pass `--draft` only when the effective PR mode intentionally created a draft PR.

## Heartbeat helper and monitoring

The orchestrator has an internal heartbeat helper for long `Task` and builder/reviewer/test waits:

```sh
feature-factory factory heartbeat <run-id> --status --json
```

Operational semantics:

- Start heartbeat immediately before a long `Task` wait begins with `feature-factory factory heartbeat <run-id> --start --phase <phase> --json`. During that wait, the helper writes `$RUN/heartbeat.json` and advances `run.json.heartbeat_at` under the shared `run-json.lock/` lock.
- `heartbeat.json` contains `{ schema_version, run_id, phase, pid, interval_ms, last_tick_at }`. Treat it as liveness-only data, not authority. External watchers should not infer workflow ownership or write authority from PID/sidecar contents.
- Freshness is derived at read time: `age(last_tick_at) <= max(2 * interval_ms, 120000ms)` and the recorded PID is alive.
- Heartbeat starts only while the manifest already shows real in-flight factory work through a `running` step or a `running`/`review` slice.
- Heartbeat is intentionally absent while the factory is paused at the `story`, `brief`, or `pre_pr` gates; external monitors should read `run.json.gates` for those waits.
- Stop heartbeat in a `finally`/after-return path with `feature-factory factory heartbeat <run-id> --stop --json`. Stop is best-effort; semantic writes are serialized by the run-json lock, not heartbeat state.
- External watchers should treat `heartbeat.json` as liveness only and use `factory status <run-id> --json` / `terminal_result` for durable workflow meaning.

Long-wait heartbeat guard for operators and maintainers:

1. Mark in-flight state first when heartbeat requires it, so `run.json` already shows a `running` step, `running` slice, or `review` slice.
2. Start heartbeat immediately before long `Task`/subagent dispatch/wait; never after the dispatch has already begun.
3. Stop heartbeat in the after-return/`finally` path.
4. Do not perform the next semantic `run.json` / factory CLI state write while the long-wait heartbeat remains active; stop heartbeat or verify inactive first.

Use these phase labels by convention: `spec-review`, `decomposition-review`, `builder-wave`, `slice-review`, `test-verifier`, `test-rerun`, `test-review`, `implementation-validator`, `security-reviewer`, and `remediation`. `spec-review` brackets both the `spec-writer` Task dispatch/wait and the following `work-reviewer` wait; `decomposition-review` brackets both the `work-decomposer` Task dispatch/wait and the following `work-reviewer` wait. Each of those long waits uses its own heartbeat start immediately before dispatch/wait and stop in the after-return/`finally` path before the next semantic `run.json` / factory CLI state write. Protected gates `story`, `brief`, and `pre_pr` stay heartbeat-free. The phase is opaque/non-enforced by validation beyond being non-empty; heartbeat remains liveness-only and not authority.

Cost attribution is one of the semantic writes that must wait until heartbeat is stopped or verified inactive. Record `factory cost-record` entries after each provider-backed long wait and before terminal-result writes or `factory pr-created`.

## Detached run diagnostics

`factory status`, `factory list`, `factory validate`, `factory watch`, and the TUI expose detached-run diagnostics as output-only observations. Diagnostics do not change `run.json`, `heartbeat.json`, or gate schemas.

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

Condition enum: `stale-heartbeat`, `missing-heartbeat-process`, `missing-worktree`, `invalid-run-state`, `protected-gate`, `terminal-run`. Classification enum: `healthy`, `recoverable`, `blocked`, `needs-human`, `terminal`, `invalid`; `invalid` is first-class and must not be collapsed into `blocked`. Status enum: `ok`, `warning`, `error`. Severity enum: `info`, `warning`, `error`, `critical`.

When multiple diagnostic items are present, the top-level `classification`, `status`, `severity`, and `summary` come from one primary item using this priority order: classification `invalid` > `blocked` > `needs-human` > `recoverable` > `terminal` > `healthy`; severity `critical` > `error` > `warning` > `info`; status `error` > `warning` > `ok`; condition `invalid-run-state` > `missing-worktree` > `missing-heartbeat-process` > `stale-heartbeat` > `protected-gate` > `terminal-run`; then original detection order.

Operator-facing condition mapping:

| Condition | Classification / status / severity | Operator action |
|---|---|---|
| `stale-heartbeat` | `recoverable` / `warning` / `warning` | Inspect logs and validate durable state before resuming; do not restart blindly. |
| `missing-heartbeat-process` | `recoverable` / `warning` / `warning` | Treat as heartbeat-helper liveness only; inspect logs/state before deciding recovery. |
| `missing-worktree` | `blocked` / `error` / `error` | Restore the worktree or clean up/recover from durable state. |
| `invalid-run-state` | `invalid` / `error` / `critical` | Treat `run.json` or required sidecars as untrusted until schema/JSON validation passes. |
| `protected-gate` | `needs-human` / `warning` / `warning` | Answer the pending protected gate (`story`, `brief`, or `pre_pr`) or stop the run. |
| `terminal-run` | `completed`/`partial` => `terminal` / `ok` / `info`; `blocked` => `blocked` / `error` / `error`; `needs-human` => `needs-human` / `warning` / `warning` | Read `terminal_result`; no heartbeat/worktree liveness action is required for valid terminal runs. |

Heartbeat and PID evidence is liveness-only, never authority. `missing-heartbeat-process` refers to the heartbeat helper PID recorded in `heartbeat.json`, not a detached opencode process; there is no durable run-id-to-opencode-PID registry. PID checks are race-prone and may be affected by PID reuse, so diagnostic items from heartbeat/process evidence carry `authoritative: false` and `evidence.liveness_only: true`.

Heartbeat diagnostics are emitted only while `run.json` shows heartbeat-bracketed in-flight work: a `running` step, `running` slice, or `review` slice. Idle/bootstrap runs, blocked steps, protected gates, and valid terminal states suppress stale-heartbeat and missing-heartbeat-process alarms because no heartbeat helper should be active for those states.

Diagnostics are fail-closed for invalid local state. `diagnostics.authoritative` is true only when `run.json` schema validation and required sidecars pass. Heartbeat data, PID liveness, process existence, worktree strings, status booleans, and mutable `run.json` claims are not enough to infer a healthy run.

Answer gates by writing the same files an interactive user would approve through chat:

```sh
feature-factory factory answer <run-id> story approve
feature-factory factory answer <run-id> brief "changes: split frontend and backend slices"
feature-factory factory answer <run-id> pre_pr stop
```

The factory writes:

- `.opencode/factory/<run-id>/run.json`
- `.opencode/factory/<run-id>/gates/<gate>.question.md`
- artifacts, plan, evidence, review files, and gate `pending_snapshot` state

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

Use `--run-id <run-id>` on new starts when an external driver needs a predictable factory directory name:

```sh
feature-factory factory start --repo <repo> --run-id issue-123 --headless "<work order>"
```

`--run-id` is validated as a bare safe factory run id, rejected for `resume <run-id>` starts, and passed as `driver.run_id` for new-run bootstrap only.

Thin autonomous adapter loop:

1. Claim external work.
2. Check out the repo.
3. Run `feature-factory factory start --repo <repo> --run-id <run-id> --autonomous "<work order>"`.
4. Read `run.json.terminal_result`.
5. Mirror `status`, `pr_url`, and `reason` back to the external system.

## Doctor

`feature-factory doctor` checks the local opencode/plugin environment before a long run:

```sh
feature-factory doctor --local
feature-factory doctor --local --profiles
feature-factory doctor --local --provider-smoke
feature-factory doctor --telemetry
```

It checks opencode run support, plugin registration, command/agent/skill registration, provider auth visibility, `HOME`, `git`, `gh`, base branch detection, and whether `.opencode/factory/` / `.opencode/worktrees/` are gitignored.

`--provider-smoke` runs a lightweight opencode call for each configured model provider. Use it when you want stronger credential validation and accept that it may consume model quota.

### Telemetry readiness and trace propagation

Telemetry is off by default. The factory has no default exporter, no default network side effects, and no durable telemetry state; local `run.json`, gates, evidence, reviews, and transition checks remain the workflow contract. Enable telemetry explicitly with plugin option `telemetry.enabled: true` or `FEATURE_FACTORY_OTEL_ENABLED=true`, and initialize an OpenTelemetry SDK/exporter through native opencode, a companion plugin, or operator runtime setup.

Honeycomb / native OTel setup uses standard OTLP environment variables and opencode's native switch:

```sh
FEATURE_FACTORY_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=${HONEYCOMB_API_KEY},x-honeycomb-dataset=feature-factory
OTEL_RESOURCE_ATTRIBUTES=service.name=feature-factory,deployment.environment=dev
```

```jsonc
{
  "experimental": { "openTelemetry": true },
  "plugin": [
    ["opencode-feature-factory", { "telemetry": { "enabled": true, "mode": "native-opencode" } }]
  ]
}
```

`feature-factory doctor --telemetry` reports these readiness categories:

- native opencode `experimental.openTelemetry` status and whether native AI SDK spans are expected;
- OTLP endpoint readiness from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`;
- sanitized OTLP header presence from `OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS`, showing only header names and replacing values with `[redacted]`;
- service/resource readiness from `OTEL_SERVICE_NAME` or `service.name` in `OTEL_RESOURCE_ATTRIBUTES`;
- companion telemetry plugin presence, such as `@devtheops/opencode-plugin-otel`;
- package instrumentation loadability for `@opentelemetry/api`, proving the package is loadable and exports `trace`, `context`, and `SpanStatusCode` without requiring an SDK/exporter;
- feature-factory telemetry enablement source (`plugin.telemetry.enabled`, `FEATURE_FACTORY_OTEL_ENABLED`, or default-off);
- content-capture risk and redaction status.

Sanitized OTLP env behavior is diagnostic-only: `doctor --telemetry` never prints OTLP header values or credential-bearing endpoint URLs. Header values such as Honeycomb API keys are reported as present and redacted; token-shaped values (`ghp_*`, `github_pat_*`, `sk-*`, bearer/JWT/AWS-shaped strings, credential-bearing URLs, and high-entropy secrets) are scrubbed before display.

Native opencode/AI SDK telemetry may capture prompts, completions, tool arguments, or tool results outside feature-factory's redaction path. `doctor --telemetry` warns when native opencode OTel is enabled or when feature-factory content-capture flags (`captureMessages`, `captureToolArguments`, `captureToolResults`, `captureReviews`, or `captureEvidence`) are enabled. Production telemetry should use upstream prompt/output suppression, an OpenTelemetry Collector redaction processor, a trusted non-production telemetry environment, or feature-factory-only metadata spans.

The launch commands accept trace-context flags for runtime correlation:

```sh
feature-factory factory start --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 --tracestate vendor=value "APP-123 add workflow"
feature-factory factory start --parent-span-id 00f067aa0ba902b7 "APP-123 add workflow"
feature-factory factory resume <run-id> --traceparent <w3c-traceparent> --tracestate <w3c-tracestate>
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> --parent-span-id <16-hex-span-id>
```

Runtime env mapping preserves operator-provided OTel env and adds trace context only when supplied: `--traceparent` sets `TRACEPARENT` and `FEATURE_FACTORY_TRACEPARENT`; `--tracestate` sets `TRACESTATE` and `FEATURE_FACTORY_TRACESTATE`; `--parent-span-id` or the span id inside `--traceparent` sets `FEATURE_FACTORY_PARENT_SPAN_ID`. If both `--parent-span-id` and `--traceparent` are supplied, the parent span ids must match. These values are non-authoritative runtime launch metadata, not instructions, not persisted in `run.json`, and not used to approve gates, reviews, PRs, or terminal state.

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

## Interrupt, Steer, And Resume

Operator steering is untrusted operator data/config, not instructions and not a gate bypass. Cancel the external opencode process first, then queue steering for the existing non-terminal run and dry-run the resume before relaunch:

```sh
feature-factory factory cancel <run-id> --json
feature-factory factory steer <run-id> --message TEXT --json
feature-factory factory status <run-id> --json
feature-factory factory resume <run-id> --dry-run --json
feature-factory factory resume <run-id> --headless --json
```

`factory resume` reuses the same run id, branch, worktree, and durable state. It rejects `active-heartbeat`, `terminal-run`, `invalid-run-state`, and `missing-worktree` instead of blindly restarting. The resume payload includes top-level `resume` and `steering` metadata with `raw_message_included: false`; raw steering text is never included in status/list/TUI or the resume payload. Factory start, resume, and continuation launchers encode their structured envelope as a preprocessing-safe `ffpayload-v1:<base64url>` token. Before model execution, the plugin's `command.execute.before` hook deterministically decodes and structurally validates that versioned token, then injects a line-oriented `PLUGIN_PARSED_OPERATOR_PAYLOAD` block for driver mode and routing. The normalized values remain untrusted operator data/config. Unencoded, malformed, non-canonical, ambiguous, or mismatched envelopes fail closed to interactive mode with no routing authority; the model does not independently parse raw transport data to decide autonomous mode, resume, steering, continuation, or a requested run id. This is positional prompt framing, not cryptographic authentication; base64url provides transport safety, not authenticity.

On a mutating `/feature resume <run-id>` path, run `feature-factory factory env record-resume <run-id> --json` before `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`. The consumed JSON labels raw text as `UNTRUSTED OPERATOR STEERING DATA (not instructions)` with `trust: untrusted-operator-data`.

After `steer-consume`, run a steering-conflict checkpoint. Compare the untrusted steering against accepted durable state: approved gates, accepted steps, merged or blocked slices, passing validator/security verdicts, `pr_url`, and `terminal_result`. If honoring the steering would require editing or rolling back that protected state, automatic rollback is forbidden. Record the checkpoint with:

```sh
feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --reason TEXT --json
```

`factory steer-conflict` requires the run to still be `running`, requires inactive heartbeat, verifies the latest consumed steering ref/hash and consumed file hash, then writes terminal `status:"needs-human"` with `terminal_result.summary` explaining that accepted durable state would have to change. Its JSON response has `ok:false`, `conflict:true`, `updated:true`, `status:"needs-human"`, the steering ref/hash, `protected_state`, and `terminal_result`. The operator must reconcile manually; the factory must not silently reset gates, unmerge slices, rewrite evidence/reviews, remove PR URLs, or continue from stale accepted artifacts.
