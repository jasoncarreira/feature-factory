# feature-factory

A durable, observed control plane for running a feature from idea to draft PR through a chain of
focused agents, with human approval gates. Host-agnostic, zero dependencies.

```sh
npm install feature-factory
```

Ships three things:

| | |
| --- | --- |
| `bin/factory.js` | the `factory` CLI — thirteen commands, each state change one checked transition |
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

## Resuming a parked run

A top-level `needs-human` status is a parked stop, not a final result. `completed`, `partial`, and
`blocked` remain final. Fix the external cause, then preserve this order: bind the intended retained
sandbox and validate its manifest and containment; run the post-selection exact-ref-absent guard;
complete effective-push proof; accept branch provenance, worktree binding, seed ancestry, cleanliness,
recovery, and every operator-ref recheck; rerun the final exact-ref guard immediately before claim;
claim or justifiably steal and verify fresh ownership plus the unchanged parked result; run
`factory resume <run-id> --session <id> --repo <sandbox>` and verify running status, unchanged historical result, real
next action, and the same owner; replay only existing post-lock reconciliation for an already-recorded
merge; then continue solely from the newly qualified `status.next`.

Status remains readable while parked, and lock claim, justified steal, heartbeat, and owning release
remain available for ordered qualification. Every other effectful command refuses until explicit
resume. Resume changes only `status` and `updated_at`; it preserves the original terminal reason and all
progress. A resumed recorded merge still traverses the existing clean-head, retry-safety, evidence, and
repository-verification path. An unresolved repair-journal record is separate and remains
publication-blocking. If the cause was not fixed, the run may park again with the same reason.

`.factory.json.publish` remains uninvoked. Static `publishing_identity` has no runtime input and returns
the non-empty account-name value itself; a missing, non-string, or empty identity makes the config
malformed. It is not yet consumed, and identity enforcement is deferred to #216. The live config is not
part of this package and no generated config or resolver asset is shipped.

## Effective push-target proof

Fresh `factory init` pre-reserves the deterministic sandbox, makes its one local clone, and proves
physical containment before the package captures the operator's effective push target. It configures
the fresh clone through a private mode-0600 Git include fragment, recaptures both current values, and
requires exact `Buffer.equals` equality before PR-base lookup, feature-branch creation, lock creation,
manifest publication, or output. Target bytes are never decoded or normalized.

Only cwd-independent transports are accepted: absolute `http://`, `https://`, `ssh://`, or `git://`
network URIs with nonempty authority, and non-drive SCP-style targets with nonempty suffixes. Relative
or unqualified paths, absolute local paths, tilde paths, Windows drive paths, `file://`, remote-helper
`transport::address`, and unsupported or malformed schemes refuse. Lookup stdout must be a Buffer ending
in exactly one LF, optionally preceded by one CR. Only that terminator is removed; empty values and any
remaining NUL, CR, LF, DEL, or other ASCII control byte refuse. Accepted current values are compared
byte-for-byte without normalizing credentials, case, slash, percent-encoding, escaping, Unicode, or URL
syntax.

Existing sandbox commands compare only and never rewrite Git configuration. Qualified `lock` claim or
steal, `resume`, and `gate pre_pr approved` validate the selected manifest and then recapture both
current values in code. Gate 3 compares before transition construction or a transition temporary file.
Status, heartbeat, lock release, `pr`, and unrelated transitions do not compare. A legacy direct run
outside `.factory-sandboxes` has no distinct sandbox destination and remains compare-free.

If an active selected root becomes missing, unreadable, a symlink, or a non-directory after manifest
validation but before physical canonicalization, the operation makes no retention claim and refuses:

```text
factory sandbox: selected repository unavailable at <P>; selected run unchanged
```

Once canonicalization succeeds, relationship or Git-top-level failures under `.factory-sandboxes` use
the operator refusal and never fall back to legacy behavior. Target operations use exactly these three
messages:

```text
factory sandbox: operator effective push target unavailable; sandbox retained at <S>
factory sandbox: sandbox effective push target unavailable at <S>
factory sandbox: sandbox effective push target does not match operator target; sandbox retained at <S>
```

No message contains a target, subprocess output, argv, child environment, low-level stack, or cause. A
fresh refusal retains the deterministic clone before `run.json`, leaving a non-resumable inspection
state that status cannot select and repeated init cannot reuse. The driver does not retry, clean, repair,
delete, or choose another destination; after inspection, the operator may manually remove it. An active
refusal leaves the manifest, configuration, and lock unchanged, remains resumable after repair, and
still permits status, heartbeat, and lock release as applicable.

The target boundary strips debug and trace variables from Git children, sets `LC_ALL=C` and
`GIT_TERMINAL_PROMPT=0`, and preserves credential providers. The shipped publication wrapper applies
the same ordered denylist to push and `gh`:

```text
DEBUG GH_DEBUG CURL_VERBOSE GIT_TRACE GIT_TRACE_PACKET GIT_TRACE_PACK_ACCESS
GIT_TRACE_PERFORMANCE GIT_TRACE_SETUP GIT_TRACE_SHALLOW GIT_TRACE_FSMONITOR
GIT_TRACE_CURL GIT_TRACE_CURL_NO_DATA GIT_CURL_VERBOSE GIT_TRACE2 GIT_TRACE2_EVENT
GIT_TRACE2_PERF GIT_TRACE2_BRIEF GIT_TRACE2_CONFIG_PARAMS GIT_TRACE2_ENV_VARS
GIT_TRACE2_PARENT_SID GIT_TRACE_REDACT GIT_REDIRECT_STDOUT GIT_REDIRECT_STDERR
GCM_TRACE GCM_TRACE2 GCM_DEBUG GIT_CONFIG_PARAMETERS
```

Host debug logging may remain enabled for run health, but those variables never reach target or
publication children. Shell tracing is disabled while publication values and child output are in scope.
Push uses configured `origin`, a fully qualified refspec, mandatory `--no-verify`, and suppressed stdout
and stderr; it never uses a URL, hook, `tee`, output or trace file, debug echo, expanded dump, or raw child
error. `gh pr create` runs from the operator checkout through the same wrapper, suppresses stderr, and
keeps captured stdout private.

Only one nonempty absolute HTTPS URL with empty username and password, no query or fragment, and
serialization equal to origin plus pathname is accepted. That validated userinfo-free URL may be passed
to `factory pr` and persisted as `pr_url`. Failures expose only:

```text
factory publication: git push failed; selected repository retained at <RUN_REPO>
factory publication: draft PR creation failed or returned unsafe output; selected repository retained at <RUN_REPO>
```

Git transport-helper process-table state on the trusted local host is the explicit ephemeral exclusion;
traces, child output, raw errors, state, and logs remain suppressed. The package makes no push or forge call,
`.factory.json.publish` remains uninvoked, and publishing-identity enforcement remains deferred to #216.
The proof adds no command, CLI flag, feature flag, output field, package export, dependency, or
`run.json` key. The live config is not part of this package and no generated config or resolver asset is
shipped. See the repository's
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
