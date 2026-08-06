# feature-factory

A durable, observed control plane for running a feature from idea to draft PR through a chain of
focused agents, with human approval gates. Host-agnostic, zero dependencies.

```sh
npm install feature-factory
```

Ships three things:

| | |
| --- | --- |
| `bin/factory.js` | the `factory` CLI — twelve commands, each state change one checked transition |
| `skills/feature/SKILL.md` | the `/feature` orchestrator prose |
| `agents/` | eleven agent definitions the skill dispatches |

Point your agent host at `skills/feature/SKILL.md` and `agents/`, then drive runs with the CLI.

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

The root has four required properties and only the optional `verify_timeout_ms`. `resolve`, `verify`, and
`publish` are non-empty command strings. `publishing_identity` is a static non-empty account name, not a
command, token, credential, or command result. If present, `verify_timeout_ms` must be a positive safe
integer; omission silently defaults to `900000`. Every required entry and the optional timeout are
validated before use; a present invalid, unreadable, incomplete, wrong-type, whitespace-only, or
unknown-property config refuses closed. An invalid timeout names `.factory.json entry
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
run effect and never falls back:

```text
invalid factory config: .factory.json; no session or run created.
factory config entry 'resolve' returned malformed payload for reference <reference>; no session or run created.
factory config entry 'resolve' failed for reference <reference> with exit status <status>; no session or run created.
factory config entry 'resolve' failed for reference <reference>; exit status unavailable; no session or run created.
```

Resolver diagnostics name `resolve`, the status classification, and the admitted reference bounded to 200
characters; neither the configured or expanded
command line, shell diagnostics, nor credentials are printed, logged, or persisted. Credential values
stay in inherited environment variables and never in the config. The resolver contract adds no bridge,
parser service, command runner, capture or stderr policy, output channel or size policy, buffering,
truncation, redaction, timeout, retry, cache, payload transport, or session behavior.

After a slice merge is successfully and atomically recorded, `verify` starts in the exact recorded
integration worktree. Its configured string is submitted unchanged as one ordinary shell command with
that worktree as cwd and inherited environment and stdio. Stdout and stderr are visible, informational,
and unparsed; they are not captured or persisted. Numeric child exit status is authoritative: zero
succeeds and non-zero fails repository verification; no numeric status is canonical unavailable
evidence. Each repository shell attempt gets the full configured timeout. A merge or replay invocation
executes at most twice, and retries only a first unavailable result after freshly proving the unchanged
worktree, merge SHA at `HEAD`, and clean tree. Resolver, slice, and Gate 3 commands receive neither this
timeout nor this retry. The observation uses the existing canonical `evidence/test-verifier.json` schema,
bound to the current merged head and the immutable root base.

If `.factory.json` is absent, intake declares no resolver and after a recorded merge the factory silently
returns its previous response with no repository command, evidence write, or new output. A post-record
failure leaves the merged row and its slice evidence and review unchanged and stops before the next wave.
Production defects, repair exhaustion, dirty or moved safety failures, invalid config, and malformed,
stale, foreign, wrong-command, missing-field, or inconsistent evidence terminalize `needs-human`; clean,
unchanged second-unavailable repository verification instead follows the nonterminal exhausted/release
contract below. Only a confirmed test-only finding can use the bounded test-file-only repair path, with a
separate commit and fresh repository verification.

Canonical evidence has exactly four classifications. `green` has exact run, `test-verifier` subject,
current merged head, and unchanged `verify` command binding, observed integer exit zero, and
`review_ready: true`. `failed` has that exact binding with an observed nonzero integer exit, or observed
zero that is not review-ready. `unavailable` has that exact binding and `observed: false`, `exit: null`,
and `skipped_reason: null`. Missing, unreadable, malformed, foreign, stale-head, wrong-command,
missing-field, or internally inconsistent evidence is `unknown`. Only `unavailable` is replay-eligible.
A later invocation may replay the exact same-SHA merge only with no active repair, a freshly verified
exact integration worktree on the recorded feature branch, the immutable merge SHA still at `HEAD`, and
a freshly observed clean tree. Green and failed evidence is reused; unknown evidence never executes. The
merged slice is never reopened, re-seeded, re-observed, remerged, or re-dispatched.

Two clean, unchanged unavailable executions terminate the current CLI and driver invocations, not the
durable run. The driver quiesces all tasks and heartbeats, releases exactly its owning session, and uses
qualified status to prove `running`, null terminal result, and no ownership before reporting
`repository-verify-exhausted`. Release or ownership-verification failure reports `retained-lock-error`
without a resumability claim. A later invocation repeats all normal guards, claims with its actual
host-exported session ID, verifies ownership, and only then reconciles the same SHA. That value may equal
the prior value; verified release followed by a new verified claim establishes freshness.

Gate 3 always runs a separate fresh integrated `test-verifier` observation at the current head. It
overwrites canonical evidence through the existing command mode and never shares, substitutes, or
optimizes from post-merge evidence, even when the head is unchanged.

`publish` remains a deferred future ordinary shell step; existing push and PR behavior is unchanged and
push-target publication is deferred to #224. Static `publishing_identity` has no runtime input and
returns the non-empty account-name value itself; a missing, non-string, or empty identity makes the
config malformed. It is not yet consumed, and identity enforcement is deferred to #216. The live config
is not part of this package and no generated config or resolver asset is shipped. See the repository's
[operator guide](https://github.com/jasoncarreira/opencode-feature-factory/blob/main/OPERATING.md) for
the complete operating contract.

## Why the code exists at all

Almost all of this system is prose. Code exists only where prose cannot enforce something:

- **Agents cannot reliably hand-write a schema-perfect `run.json`**, so every state change goes
  through `lock → read → validate → apply → validate → compare-and-swap → rename`, and nothing else
  writes the manifest.
- **Verification exists only where its absence produces a false green.** With a human at the gate,
  someone sees the diff. In an autonomous run nobody does, so a review must name the commit it
  judged, a merge must prove it contributed exactly what was reviewed, and a test result must have
  been observed rather than reported.

Run state lives at `<repo>/.factory/<run-id>/run.json`, which must be gitignored: a tracked
control plane puts manifest churn in every slice diff and trips the privileged-path refusal on every
merge.

## The read-only API

For tools that display run state. Everything here reads; nothing writes.

```js
import { readRun, readRunUnchecked, nextAction, validateRun, RUN_KEYS } from "feature-factory";
```

`readRun` validates and throws; `readRunUnchecked` reports a broken record instead of refusing to
load it, so a diagnostic can show an operator what is wrong. `nextAction` derives what happens next,
and is the same function `factory status` uses — so a display cannot disagree with the CLI.

The write path is deliberately not exported. Changing state means calling the CLI.

See the [repository](https://github.com/jasoncarreira/opencode-feature-factory) for the full command
reference and design notes.

## License

MIT
