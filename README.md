# opencode-feature-factory

Hybrid opencode plugin plus CLI for a durable, scriptable feature workflow.

It ships:

- `/feature` command registration for opencode.
- A TUI sidebar panel that monitors active local factory runs.
- Feature-factory skill docs and control-plane schema.
- Specialized subagents for story, research, spec, decomposition, build, tests, review, and validation.
- A `feature-factory` CLI with install/doctor commands and local factory state helpers.

## Install Locally

From this package directory:

```sh
npm link
feature-factory install --local
feature-factory doctor --local
```

Then restart opencode. Config is loaded at startup.

Local installs configure the package root, not `src/plugin.js`, so opencode can discover both the server plugin and the TUI sidebar export.

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

Before each `factory start`, the CLI seeds the feature skill into the target repo at `.opencode/skills/feature/SKILL.md` and `.opencode/skills/feature/SCHEMA.md`, and adds `.opencode/skills/feature/` to the repo-local `.git/info/exclude` when available. The schema is the authoritative control-plane reference for `run.json`, `heartbeat.json`, `plan/slices.json`, `evidence/*`, `reviews/*`, and `run-json.lock/`; keeping it repo-local lets agents read it without relaxing `external_directory: deny`.

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
```

`factory status`, `factory answer`, and `factory validate` apply code-level schema validation to `run.json`; `factory validate` also validates `plan/slices.json` when present. Invalid runs appear as `invalid` in `factory list` instead of crashing the whole list.

Clean up terminal runs after their PRs are merged or their artifacts are no longer needed:

```sh
feature-factory factory cleanup <run-id> --dry-run
feature-factory factory cleanup <run-id>
```

Cleanup removes `.opencode/factory/<run-id>`, recorded worktrees under `.opencode/worktrees/`, and recorded local branches. It only runs for terminal statuses (`completed`, `blocked`, `partial`, or `needs-human`) unless `--force` is supplied. Cleanup refuses to remove run directories outside `.opencode/factory`. For non-`completed` terminal runs, unmerged branches are preserved unless `--force` is supplied. Use `--dry-run` first when you want to preview what would be removed.

When opencode is running in the TUI on a session route, the sidebar also shows a `Feature Factory` panel for runs found under `.opencode/factory/*/run.json` in the current session directory or any nested repo below it. It lists active runs across those repos, including status, mode, pending gate, slice progress, validation/security verdicts, PR URL, terminal reason, and branch. Completed runs are hidden except for the most recent completed run.

For autonomous runs, external adapters should read `run.json.terminal_result` or `factory status <run-id> --json` after the run exits. Terminal statuses are `completed`, `blocked`, `partial`, and `needs-human`; successful PR creation records `pr_url`.

## Heartbeat helper and monitoring

The orchestrator has an internal heartbeat helper for long builder/reviewer/test waits:

```sh
feature-factory factory heartbeat <run-id> --status --json
```

Operational semantics:

- During a long wait, the helper writes `$RUN/heartbeat.json` and advances `run.json.heartbeat_at` under the shared `run-json.lock/` lock.
- Heartbeat is intentionally absent while the factory is paused at the `story`, `brief`, or `pre_pr` gates; external monitors should read `run.json.gates` for those waits.
- Before any foreground semantic manifest write, especially terminal `completed|blocked|partial|needs-human` plus `terminal_result`, the helper must stop and confirm the stopped lease.
- External watchers should treat `heartbeat.json` as liveness only and use `factory status <run-id> --json` / `terminal_result` for durable workflow meaning.

Answer gates by writing the same files an interactive user would approve through chat:

```sh
feature-factory factory answer <run-id> story approve
feature-factory factory answer <run-id> brief "changes: split frontend and backend slices"
feature-factory factory answer <run-id> pre_pr stop
```

The factory writes:

- `.opencode/factory/<run-id>/run.json`
- `.opencode/factory/<run-id>/gates/<gate>.question.md`
- artifacts, plan, evidence, and review files

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
