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

A repository operator may provide optional `$O/.factory.json`, where `O` is the physically
resolved Git top level:

```json
{
  "resolve": "<non-empty shell command>",
  "verify": "<non-empty shell command>",
  "publish": "<non-empty shell command>",
  "publishing_identity": "<non-empty account name>",
  "verify_timeout_ms": 900000
}
```

The root has four required properties and only one optional property, `verify_timeout_ms`. `resolve`,
`verify`, and `publish` are non-empty command strings. `publishing_identity` is a static non-empty account
name, not a command, token, credential, or command result. When present, `verify_timeout_ms` must be a
positive safe integer; omission silently defaults it to `900000`. Every required entry and the optional
timeout are validated before use; a present invalid, unreadable, incomplete, wrong-type, whitespace-only,
or unknown-property config refuses closed. An invalid timeout is reported as `.factory.json entry
'verify_timeout_ms' must be a positive integer`. The file is operator-owned, committed, and protected as
a privileged path: a run cannot create, write, merge, archive, package, or repair it.

`resolve` and `verify` are consumed now. `resolve` runs as one ordinary shell step with the configured string submitted
unchanged, repository-root cwd, inherited environment plus the exact admitted request in
`FACTORY_INPUT`, and no positional argument or structured stdin. Empty stdout means the input was not
recognized. Non-empty stdout is the direct,
unchanged `ISSUE_PAYLOAD`: one JSON object containing a valid canonical top-level string `run_id`, a
non-empty string `title`, and a string `body` — all three validated before the run id is bound or anything
is dispatched — where `run_id`
selects the run and reaches `story-reader` without extraction, wrapping, reserialization, or
normalization. The value matches `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`; digit-only values are positive
decimal without leading zeroes.

Malformed config, malformed payload, a non-zero exit, or unavailable exit status refuses before any
run effect and never falls back. Resolver diagnostics name `resolve`, the status classification, and the admitted reference bounded to 200
characters; neither
the configured or expanded command line, shell diagnostics, nor credentials are printed, logged, or
persisted. Credential values stay in inherited environment variables and never in the config. The
resolver contract adds no bridge, parser service, command runner, capture or stderr policy, output
channel or size policy, buffering, truncation, redaction, timeout, retry, cache, payload transport, or
session behavior.

After a slice merge is successfully and atomically recorded, `verify` starts in the exact recorded
integration worktree. The configured string is submitted unchanged as one ordinary shell command with
that worktree as cwd and the process environment and stdio inherited. Stdout and stderr remain visible,
informational, and unparsed; they are not captured or persisted. The numeric child exit status is
authoritative: zero succeeds and non-zero fails repository verification. No numeric status is canonical
unavailable evidence. Each repository shell attempt receives the full configured timeout, and one merge
or replay invocation executes at most twice: only a first unavailable result may retry, after a fresh
proof that the integration worktree, immutable merge SHA at `HEAD`, and clean tree are unchanged. The
timeout and retry do not apply to resolver, slice, or Gate 3 commands. The result uses the existing
canonical `evidence/test-verifier.json` schema, bound to the current merged head and the run's immutable
root base.

If `.factory.json` is absent, intake still declares no resolver and recognizes or fetches no reference;
after a recorded merge, absence silently preserves the previous merge response and progression, with no
repository command, evidence write, or new output. A post-record verification failure does not roll back
or rewrite the merged row or its slice evidence and review. It stops before the next wave. Production
defects, repair-journal exhaustion, dirty or moved replay safety failures, invalid config, unobservable
state, and malformed, stale, foreign, wrong-command, missing-field, or internally inconsistent evidence
route to durable `needs-human`. Clean, unchanged second-unavailable repository verification does not: it
uses the nonterminal exhausted/release contract below. A confirmed test-only finding may use only the
bounded test-file repair path, a separate commit, and a fresh repository verification.

Canonical evidence has four closed classifications. `green` has exact run, `test-verifier` subject,
current merged head, and unchanged `verify` command binding, observed integer exit zero, and
`review_ready: true`. `failed` has that exact binding with observed nonzero integer exit, or observed zero
that is not review-ready. `unavailable` has that exact binding and canonical `observed: false`,
`exit: null`, and `skipped_reason: null`. Everything missing, unreadable, malformed, foreign, stale-head,
wrong-command, missing-field, or internally inconsistent is `unknown`. Only `unavailable` may execute
again. A later driver invocation may replay the exact same-SHA merge command only with no active repair,
a freshly verified exact integration worktree on the recorded feature branch, the immutable merge SHA
still at `HEAD`, and a freshly observed clean tree. Green and failed results are reused, while unknown
evidence remains non-executing and routes to `needs-human`. The merged slice is never reopened,
re-seeded, re-observed, remerged, or re-dispatched.

Two clean, unchanged unavailable executions end only the current merge/replay CLI invocation and its
enclosing driver invocation; they do not invoke the irreversible `factory terminal` transition. The
driver awaits all specialist tasks, stops and awaits heartbeats, releases its owning session, and uses
qualified status to prove `status: "running"`, `terminal_result: null`, and no remaining ownership before
reporting `repository-verify-exhausted`. A failed release or unverified ownership reports
`retained-lock-error` without claiming resumability. A later invocation repeats every normal selection,
manifest, provenance, branch, worktree, push-target, and operator-ref guard, claims with its actual
host-exported session ID, verifies ownership, and only then reconciles the same SHA. The new session value
may equal the old one; verified release and a new verified claim establish freshness.

Gate 3 always performs its own fresh integrated `test-verifier` observation at the current head using
the existing command mode. It overwrites the canonical evidence independently and never shares,
substitutes, or optimizes from post-merge evidence, even when the head has not moved.

`.factory.json.publish` remains uninvoked. Static `publishing_identity` has no runtime input and returns
the non-empty account-name value itself; a missing, non-string, or empty identity makes the config
malformed. It is not yet consumed, and identity enforcement is deferred to #216. See
[OPERATING.md](OPERATING.md) for the exact refusal text, what an absent declaration means, and credential
guidance.

## The CLI

Thirteen commands. Every one that changes state is a single checked transition, and an unknown flag is
an error rather than a silently ignored typo.

```
factory init <run-id> [--branch B] [--worktree W] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]
factory status <run-id> [--json]
factory resume <run-id> --session ID [--now ISO]
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
`git clone --local -- O S` attempt, and completes the physical containment proof before its code-owned
effective-push proof. It captures the operator target, configures the fresh sandbox through a private
mode-0600 Git include fragment, recaptures both current targets, and requires exact `Buffer.equals`
equality before PR-base lookup, feature-branch creation, lock creation, `run.json`, or output. Target
bytes are never decoded or normalized. There is no fallback clone, staging location, or second attempt.

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

Target lookup accepts only cwd-independent transports: absolute `http://`, `https://`, `ssh://`, or
`git://` network URIs with nonempty authority, and non-drive SCP-style targets with nonempty suffixes.
It rejects relative or unqualified paths, absolute local paths, tilde paths, Windows drive paths,
`file://`, remote-helper `transport::address`, and unsupported or malformed schemes. Lookup output must
be a Buffer ending in exactly one LF, optionally preceded by one CR; only that terminator is removed,
and empty values or remaining NUL, CR, LF, DEL, or other ASCII control bytes are rejected. Accepted
current values are compared byte-for-byte without normalizing credentials, case, slash,
percent-encoding, escaping, Unicode, or URL syntax.

Fresh init owns capture, configuration, both current recaptures, and equality. Active sandbox `lock`
claim or steal, `resume`, and `gate pre_pr approved` validate the selected manifest and then perform a
compare-only proof; Gate 3 compares before transition construction or a transition temporary file.
Existing sandboxes are never reconfigured or migrated. Status, heartbeat, lock release, `pr`, and
unrelated transitions do not compare. A legacy direct run outside `.factory-sandboxes` has no distinct
sandbox destination and remains compare-free. Branch creation or recovery and provenance checks finish
before a lock is claimed or an agent is dispatched.

After manifest validation but before an active comparison, a selected-root race, missing or unreadable
path, symlink substitution, or non-directory substitution refuses with the lexical absolute path:

```text
factory sandbox: selected repository unavailable at <P>; selected run unchanged
```

Once the selected root is physically canonical, relationship or Git-top-level failures under
`.factory-sandboxes` use the operator-target refusal and never fall back to legacy behavior. Target
operations expose exactly three refusal messages:

```text
factory sandbox: operator effective push target unavailable; sandbox retained at <S>
factory sandbox: sandbox effective push target unavailable at <S>
factory sandbox: sandbox effective push target does not match operator target; sandbox retained at <S>
```

On every refusal, neither effective target is printed, persisted, or included in an error cause. The
messages contain no subprocess output, argv, child environment, or low-level stack.
A fresh refusal retains the deterministic clone before `run.json`; it is a non-resumable inspection
state, so status cannot select it and repeated init refuses the occupied destination. The driver never
retries, repairs, cleans, deletes, or chooses another destination; after inspection, the operator may
manually remove it. An active refusal leaves the existing manifest, configuration, and lock unchanged,
so the run remains resumable after the external cause is repaired and status, heartbeat, and lock
release remain available as applicable.

This target proof adds no command, CLI flag, feature flag, output field, package export, dependency, or
`run.json` key. Targets never enter factory state, evidence, logs, or error causes.

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

A current `needs-human` run is parked and explicitly resumable; only `completed`, `partial`, and
`blocked` are final. Fix the external cause and retain the original result. Resume in this order:

1. Bind the intended retained sandbox, validate the selected manifest, and prove physical containment.
2. Run the post-selection operator exact-ref-absent guard.
3. Accept the feature branch only after provenance, worktree binding, seed ancestry, cleanliness or recovery, and every existing operator-ref recheck passes in order.
4. Immediately before claiming, rerun the final operator exact-ref-absent guard.
5. Claim with the current host session or perform a justified steal; that qualified command performs the first code-owned comparison before lock creation.
6. Verify qualified status still shows fresh ownership, parked status, and the deeply unchanged result.
7. Run `factory resume <run-id> --session ID --repo S`; it performs the second code-owned comparison before lock inspection and transition. Then verify running status, unchanged historical result, the real next action, and the same fresh owner.
8. Run only existing post-lock reconciliation for any already-recorded merge, including its evidence and repository verification.
9. Continue solely from the newly qualified `status.next`, never from the pre-resume read or reason text.

While parked, status and lock qualification remain available, but every effectful gate, step, seed,
slice, observe, validator, terminal-rewrite, and PR command refuses before effects. Resume changes only
`status` and `updated_at`; no manifest key is added. A resumed recorded merge replays the existing
clean-head and retry-safety checks before progression, and unresolved repair-journal records remain
publication blockers. An unfixed cause may park the run again with the same reason.

Gate 3 approval is the final code-owned target comparison. Step 6 performs no target lookup or remote
mutation and allows no mutating or publishing effect between its final branch, ref, and provenance
checks and push. External publication disables shell tracing and runs both children through a sanitized
wrapper. The wrapper removes this ordered denylist while preserving credential providers such as
`GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, askpass variables, and existing
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*` helper configuration:

```text
DEBUG GH_DEBUG CURL_VERBOSE GIT_TRACE GIT_TRACE_PACKET GIT_TRACE_PACK_ACCESS
GIT_TRACE_PERFORMANCE GIT_TRACE_SETUP GIT_TRACE_SHALLOW GIT_TRACE_FSMONITOR
GIT_TRACE_CURL GIT_TRACE_CURL_NO_DATA GIT_CURL_VERBOSE GIT_TRACE2 GIT_TRACE2_EVENT
GIT_TRACE2_PERF GIT_TRACE2_BRIEF GIT_TRACE2_CONFIG_PARAMS GIT_TRACE2_ENV_VARS
GIT_TRACE2_PARENT_SID GIT_TRACE_REDACT GIT_REDIRECT_STDOUT GIT_REDIRECT_STDERR
GCM_TRACE GCM_TRACE2 GCM_DEBUG GIT_CONFIG_PARAMETERS
```

The wrapper also sets `LC_ALL=C` and `GIT_TERMINAL_PROMPT=0`. Push names configured `origin`, never a
URL, uses the fully qualified recorded refspec and mandatory `--no-verify`, and suppresses stdout and
stderr. No `tee`, output or trace file, debug echo, expanded dump, raw child error, or pre-push hook is
allowed. A Git transport-helper descendant may transiently receive the target in the trusted local
host's process table; that ephemeral process state is the explicit exclusion.

Host debug logging may remain enabled for run-health diagnosis, but `DEBUG`, `GH_DEBUG`, and the full
trace denylist never reach target or publication children, so target bytes and raw child output do not
enter those logs.

`gh pr create` runs from `O` through the same wrapper with stderr suppressed and stdout captured but
never displayed or logged. Its result must be exactly one nonempty absolute HTTPS URL with empty
username and password, no query or fragment, and serialization equal to origin plus pathname. Only that
validated userinfo-free URL is legitimate publication identity; it may be passed to `factory pr` and
persisted as `pr_url`. Publication failures expose only these fixed messages:

```text
factory publication: git push failed; selected repository retained at <RUN_REPO>
factory publication: draft PR creation failed or returned unsafe output; selected repository retained at <RUN_REPO>
```

The package performs no push or forge call, and `.factory.json.publish` remains uninvoked. Publishing
identity enforcement remains deferred to #216. The orchestrator's external call shape is:

```sh
factory status <run-id> --json
publication_child git -C "$RUN_REPO" push --no-verify origin \
  "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH" >/dev/null 2>&1
publication_child gh pr create --draft --base "<pr_base>" --head "<branch>" --title "<title>" --body-file "<body-file>"
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
