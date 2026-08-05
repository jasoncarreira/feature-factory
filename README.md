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

## Repository command configuration

A repository operator may provide optional `$O/.factory/config.json`, where `O` is the physically
resolved Git top level:

```json
{
  "resolve": "<non-empty shell command>",
  "verify": "<non-empty shell command>",
  "publish": "<non-empty shell command>",
  "publishing_identity": "<non-empty account name>"
}
```

The root has exactly these four properties. `resolve`, `verify`, and `publish` are non-empty command
strings. `publishing_identity` is a static non-empty account name, not a command, token, credential, or
command result. All four entries are validated before use; a present invalid, unreadable, incomplete,
wrong-type, whitespace-only, or unknown-property config refuses closed. Only an absent file selects the
existing GitHub issue behavior. The factory never creates, writes, merges, archives, or packages this
operator-owned live file.

Only `resolve` is consumed now. It runs as one ordinary shell step with the configured string submitted
unchanged, repository-root cwd, inherited environment plus the exact admitted request in
`FACTORY_INPUT`, and no positional argument or structured stdin. Empty stdout means the input was not
recognized and does not invoke the GitHub compatibility resolver. Non-empty stdout is the direct,
unchanged `ISSUE_PAYLOAD`: one JSON object containing a valid canonical top-level string `run_id`, which
selects the run and reaches `story-reader` without extraction, wrapping, reserialization, or
normalization. The value matches `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`; digit-only values are positive
decimal without leading zeroes.

Malformed config, malformed payload, a non-zero exit, or unavailable exit status refuses before any
run effect and never falls back. Diagnostics name only `resolve` and the status classification; neither
the configured or expanded command line, shell diagnostics, nor credentials are printed, logged, or
persisted. Credential values stay in inherited environment variables and never in the config. The
contract adds no bridge, parser service, command runner, capture or stderr policy, output channel or
size policy, buffering, truncation, redaction, timeout, retry, cache, payload transport, or session
behavior.

`verify` and `publish` are declarations for future ordinary shell steps in repository-root cwd. Their
exit status will be authoritative and stdout informational and unparsed. Zero means success; non-zero
means repository verification failed for `verify` and reported publication failure for `publish`.
Neither is invoked today. Existing verification and publication remain unchanged, with push-target
publication deferred to #224. Static `publishing_identity` has no runtime input and returns the
non-empty account-name value itself; a missing, non-string, or empty identity makes the config malformed.
It is not yet consumed, and identity enforcement is deferred to #216. See
[OPERATING.md](OPERATING.md) for the exact refusal text, missing-file compatibility, and credential
guidance.

## The CLI

Twelve commands. Every one that changes state is a single checked transition, and an unknown flag is
an error rather than a silently ignored typo.

```
factory init <run-id> [--branch B] [--worktree W] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]
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

The usage lines above keep the compact advertised command shape. Every command also accepts
`--repo PATH` and `--json`; unknown flags are errors.

For a fresh run, call init with the canonical operator checkout `O` as `--repo O`. Init derives the
single destination `S = O/.factory-sandboxes/<run-id>`, pre-reserves an empty `S`, makes exactly one
`git clone --local -- O S` attempt, and completes the physical containment proof before publishing
`run.json`. There is no fallback clone, staging location, or second attempt.

On success, JSON output returns its canonical `sandbox_path` and absolute `run_dir`. Pass that returned
`sandbox_path` as `--repo S` to status and every later factory command; commands do not redirect an
operator checkout to its sandbox:

```sh
factory init "$R" --branch "$FEATURE_BRANCH" --repo "$O" --json
factory status "$R" --json --repo "$S"
```

A destination or manifest collision is retained for inspection. The deterministic path is never
reused, retried, or deleted during bootstrap or refusal. Resume a valid sandbox manifest with
`--repo S`; surface invalid state instead of replacing it. `O/.factory/<run-id>` is supported only as
a legacy direct-run location, resumed with `--repo O`, and is never migrated or backfilled by init.

After selecting a fresh or resumed sandbox, the orchestrator proves the effective push targets match
and establishes feature-branch provenance. Branch creation or recovery and provenance checks finish
before a lock is claimed or an agent is dispatched. A push-target mismatch reports only the mismatch
and `S`; neither effective target is printed, persisted, or included in an error cause, and the sandbox
is retained.

Run state under `S/.factory/<run-id>/run.json` should be gitignored — if it is tracked, every slice diff
carries manifest churn and every merge trips the privileged-path refusal.

`branch` is the feature branch the run builds and pushes. `pr_base` is the intended moving branch
that the draft PR targets; it is not a slice `base_ref` SHA. By default, init records the symbolic
branch checked out in the configured worktree, resolved from `--repo`, even when the process is
running elsewhere. `--pr-base` is an explicit override and bypasses that observation. Without an
override, detached HEAD or an unobservable configured worktree fails closed. The recorded value is
immutable and appears in both plain and JSON status.

Initialization and manifest publication are create-only. If `run.json` already exists, use qualified
status against the selected repository and resume instead of running init again. Existing sandbox and
legacy manifests are never overwritten or backfilled. A scaffold-only or partially created `S` without
`run.json` is a retained collision, not a retryable destination.

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

Run sandboxes are gitignored. Sandbox deletion is allowed only during the verified Step 7 completed
handoff, after the draft PR is recorded and local-ref fetch, control-plane archive, and archive
verification all succeed. Bootstrap failures, collisions, push mismatches, and non-completed outcomes
retain their sandbox for inspection.

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
