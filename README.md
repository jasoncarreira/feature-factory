# feature-factory

A durable, observed control plane for running a feature from idea to draft PR through a chain of
focused agents, with human approval gates.

Two packages:

| Package | What it is |
| --- | --- |
| [`packages/feature-factory`](packages/feature-factory) | The standalone factory: the `factory` CLI, the `/feature` skill, and the agent definitions. Zero dependencies, host-agnostic. |
| [`packages/opencode-feature-factory`](packages/opencode-feature-factory) | The opencode integration: server plugin and sidebar. Reads run state; never writes it. |

This repository is a workspace root and publishes nothing itself.

## Why it exists

The whole system is one skill's worth of prose plus the smallest amount of code that prose cannot
enforce. The dividing line is deliberate:

- **Agents cannot reliably hand-write a schema-perfect `run.json`.** So every state change goes
  through a checked transition — `lock → read → validate → apply → validate → compare-and-swap →
  rename` — and nothing else writes the manifest.
- **Verification exists only where its absence produces a false green.** In an interactive run a
  human sees the diff. In an autonomous run nobody does, so a review must name the commit it
  judged, a merge must prove it contributed exactly what was reviewed, and a test result must have
  been observed rather than reported.

Everything else is instructions. The rule is: *enforce what can produce a false green, instruct the
rest.*

## The chain

```
INTAKE ─▶ [GATE 1: Story] ─▶ RESEARCH + DESIGN ─▶ SPEC ─▶ DECOMPOSE ─▶ [GATE 2: Brief + Plan]
       ─▶ BUILD  (waves of parallel slices; per-slice OBSERVE ▶ REVIEW ▶ serial MERGE)
       ─▶ INTEGRATE: TEST + VALIDATE (on the merged feature branch)
       ─▶ [GATE 3: Pre-PR] ─▶ DRAFT PR
```

Builds run in parallel; merges are serial, which is what makes the parallelism safe. The
orchestrator owns the worktrees and every state change. Subagents do work and report claims, and a
claim is re-derived from the repository before it is believed.

## Install

The CLI, the skill and the agents:

```sh
npm install feature-factory
```

Then point your agent host at `node_modules/feature-factory/skills/feature/SKILL.md` and
`node_modules/feature-factory/agents/`.

For opencode, additionally install the integration where the host's modules resolve, and name it in
`~/.config/opencode/tui.json`:

```jsonc
{
  "plugin": ["opencode-feature-factory"]
}
```

The host reads the sidebar entry from `exports["./tui"]`; the package root is the server plugin and
has no sidebar hook, so it is never mistaken for one.

## The CLI

Twelve commands. Every one that changes state is a single checked transition, and an unknown flag is
an error rather than a silently ignored typo.

```
factory init <run-id> [--branch B] [--worktree W] [--pr-base TARGET] [--jira KEY] [--mode interactive|headless|autonomous]
factory status <run-id> [--json]
factory lock <run-id> <claim|steal|release> --session ID [--ttl-ms N]
factory heartbeat <run-id> --session ID
factory gate <run-id> <story|brief|pre_pr> <pending|approved|changes|stop> [--artifact REF]
factory step <run-id> <agent> <running|accepted|rejected|blocked> [--attempts N]
factory slices-seed <run-id> --from plan/slices.json
factory slice <run-id> <slice-id> <pending|running|review|merged|blocked> [...]
factory observe <run-id> <subject> --worktree W --base SHA [--test-cmd CMD] [--claim FILE]
factory validator <run-id> --report REF
factory pr <run-id> --url URL
factory terminal <run-id> <completed|blocked|partial|needs-human> --reason TEXT
```

Run state lives at `<repo>/.factory/<run-id>/run.json` and should be gitignored — if it is
tracked, every slice diff carries manifest churn and every merge trips the privileged-path refusal.

`branch` is the feature branch the run builds and pushes. `pr_base` is the intended moving branch
that the draft PR targets; it is not a slice `base_ref` SHA. By default, init records the symbolic
branch checked out in the configured worktree, resolved from `--repo`, even when the process is
running elsewhere. `--pr-base` is an explicit override and bypasses that observation. Without an
override, detached HEAD or an unobservable configured worktree fails closed. The recorded value is
immutable and appears in both plain and JSON status.

Initialization is create-only. If `run.json` already exists, use `factory status <run-id> --json` and
resume instead of running init again; existing current and legacy manifests are never overwritten or
backfilled. A scaffold-only `.factory/<run-id>/` directory without `run.json` is safe to retry. If init
reports that creation may already have succeeded, status resolves the unknown outcome before any
retry: resume valid state, retry only when no manifest exists, and stop on invalid state.

The orchestrator creates the external draft PR with the recorded values before recording its URL:

```sh
factory status <run-id> --json
gh pr create --draft --base "<pr_base>" --head "<branch>" --title "<title>" --body-file "<body-file>"
factory pr <run-id> --url <pr-url>
```

For a pre-change manifest whose `pr_base` is absent or null, a human/operator must choose or confirm
the exact target passed to `gh --base`. Do not infer or backfill it. The factory records delivery
intent but does not query the forge to verify the PR's actual base.

## What it refuses

Enforced, not suggested. Each is a mechanism with a test that fails when the mechanism is removed:

- A review must record the 40-character commit it judged, and is refused against any other head.
- A merge must be a two-parent merge that contributed exactly the reviewed paths, with content on
  those paths identical to the reviewed commit.
- A slice may only change paths it declared, and never a privileged control-plane path.
- Evidence must be observed on a clean worktree that did not move while the tests ran.
- Whether a slice may ship untested is ratified in its `test_plan` at seeding — there is no flag
  that waives tests at observation time.
- Publication requires all three gates currently approved, every slice merged, an approving
  validator verdict bound to the branch's current head, and an observed green test-verifier run.
- A run has exactly one PR, and recording the same one twice is idempotent.

## Non-goals

These are refusals, not deferrals, and `packages/feature-factory/test/ceiling.test.js` fails if any
reappears — including as prose in an agent prompt:

post-PR remediation · continuation and checkpoint runs · integration amendments · a steering
machine · cost attribution · delivery envelopes · dispatch claim/closure · nonces, completion
tokens and hash chains · a reviewer panel with a verdict lattice · a security-reviewer stage.

## Development

```sh
npm install          # workspaces
npm test             # both packages
npm run test:factory
npm run test:opencode
```

Run sandboxes are gitignored and therefore deleted by `git clean -xdf`.

`test/ceiling.test.js` is the scope lock. It asserts the exact command set, the exact `run.json` key
set, the family list, the absence of every dropped subsystem, that the skill invokes only commands
and flags the CLI accepts, that every agent the skill dispatches ships, and a hard line budget on
production source. Widening any of it means editing that file, which is the point — the decision
shows up in a diff instead of arriving as a reasonable-sounding addition.

The design is recorded in [BUILD-PLAN-SMALL.md](BUILD-PLAN-SMALL.md), the reasoning for the scope in
[SCOPE-DECISION.md](SCOPE-DECISION.md), and the baseline it was cut against in
[VISO-BASELINE-COMPARISON.md](VISO-BASELINE-COMPARISON.md).

## License

MIT
