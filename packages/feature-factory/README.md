# feature-factory

A durable, observed control plane for running a feature from idea to draft PR through a chain of
focused agents, with human approval gates. Host-agnostic, zero dependencies.

```sh
npm install feature-factory
```

Ships three things:

| | |
| --- | --- |
| `bin/factory.js` | the `factory` CLI — fourteen commands, each state change one checked transition |
| `WORKFLOW.md` | the canonical, host-agnostic workflow contract |
| `agents/` | eleven specialist definitions dispatched by a host adapter |

This package owns `WORKFLOW.md`; it does not ship a platform `SKILL.md`. Each adapter owns its own
host binding and copies this workflow beside that skill at build/pack time. Install
`opencode-feature-factory` or `prime-agent-feature-factory` for a supported host, or build an adapter
that loads the complete workflow and drives all durable state changes through the CLI.

## Repository command configuration

A repository operator may provide optional `$O/.factory.json`, where `O` is the physically
resolved Git top level:

```json
{
  "resolve": "<non-empty shell command>",
  "verify": "<non-empty shell command>",
  "publish": "<non-empty shell command>",
  "pr_draft": true,
  "verify_timeout_ms": 900000,
  "bootstrap": "<non-empty shell command>",
  "bootstrap_timeout_ms": 900000
}
```

The root has three required properties and four optional properties: `pr_draft`, `verify_timeout_ms`,
`bootstrap`, and `bootstrap_timeout_ms`. `resolve`, `verify`, `publish`, and a present `bootstrap` are non-empty command
strings. There is no `publishing_identity` key, and a file carrying one is malformed because the
optional set is closed. A present `pr_draft` must be a JSON boolean and omission means `true`. Both timeouts are
positive safe integers. `bootstrap_timeout_ms` requires `bootstrap`.
Each omitted timeout independently defaults to `900000`; neither shares the other's budget. The file is
operator-owned, committed, and protected as a privileged path: a run cannot create, write, merge,
archive, package, or repair it.

The publishing identity is not a config key. `factory init` resolves it from `--publishing-identity
<account>` or the inherited `FACTORY_PUBLISHING_IDENTITY`, refuses when neither supplies at least one
character, and records the resolved value immutably in `run.json`, where `status --json` reports it as
`publishing_identity`. The account a run publishes as is a property of the environment it runs in, not of
the repository, and a tracked file cannot hold two values for one repository published from both a
maintainer's checkout and an automated host. Absence refuses rather than skipping the guard, so a forgotten
value stops the run instead of publishing under whatever credential the host happens to carry. Never derive
it from `gh`, the token, stored authentication, or Git configuration: an expectation read from the
credential being checked would always match.

Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `pr_draft`; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries.

The named forms are `.factory.json entry 'pr_draft' must be a boolean`, `.factory.json entry 'bootstrap' must be a non-empty string`, `.factory.json entry 'bootstrap_timeout_ms' requires a declared bootstrap command`, `.factory.json entry 'bootstrap_timeout_ms' must be a positive integer`, and `.factory.json entry 'verify_timeout_ms' must be a positive integer`.

A present invalid, unreadable, incomplete, wrong-type, whitespace-only, or unknown-property config refuses closed.

Fresh init captures the effective `pr_draft` value only after the cloned repository config validates,
and stores that boolean immutably in `run.json`; init JSON and plain output do not change. Legacy
manifests without the key remain keyless and behave as `true`. Status alone adds effective
`pr_draft: boolean` in JSON and `pr_draft: true|false` in plain output. Step 6 reads that status value:
`true` (including legacy omission) creates a draft PR, while explicit `false` creates a ready-for-review
PR without `--draft`. Publication does not reread the live config.

`resolve`, `bootstrap`, and `verify` are consumed now. `resolve` runs as one ordinary shell step with the configured string submitted
unchanged, repository-root cwd, inherited environment plus the exact admitted request in
`FACTORY_INPUT`, and no positional argument or structured stdin. Empty stdout means the input was not
recognized. Non-empty stdout is the direct,
unchanged `ISSUE_PAYLOAD`: one JSON object containing a valid canonical top-level string `run_id`, a
non-empty string `title`, and a string `body` — all three validated before the run id is bound or anything
is dispatched — where `run_id`
selects the run and reaches `story-reader` without extraction, wrapping, reserialization, or
normalization. The value matches `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`; digit-only values are positive
decimal without leading zeroes.

A resolver does not have to look anything up. When the caller already holds the work item — a controller
dispatching an item it rendered itself, or a tracker whose content is already in the launch environment —
the resolver is a transport rather than a lookup, and the whole of it is one `printf`:

```sh
[ -n "$MY_WORK_ITEM_JSON" ] && { printf %s "$MY_WORK_ITEM_JSON"; exit 0; }
# otherwise fall through to whatever lookup this repository declares
```

Use `printf %s` and not `echo`, which appends a newline and in some shells interprets backslash escapes,
corrupting a `body` that contains them. Gating the branch on a variable lets one config serve both callers:
the caller that supplies the item sets it, and a caller that supplies only a reference takes the declared
lookup unchanged, so adding the branch changes no existing behavior. Because the resolver chooses `run_id`,
a caller supplying its own item also chooses the sandbox name, feature-branch suffix, and manifest candidate
— so giving it a namespace of its own, such as `chainlink-1327`, makes collision with the tracker's own
numbering unrepresentable rather than something a lookup has to detect.

A resolver that recognizes a reference it cannot serve must exit non-zero rather than exit zero with empty
stdout. Exit status is observable, so those two results are distinguishable — which is precisely why the
choice matters. The ambiguity arises only when an in-scope but unserviceable reference is *reported* as exit
zero with empty stdout, because that is already the contract's signal for *this is not my reference*: the run
then continues to ticket, design, and free-text derivation from the request, and for a bare id that names no
workflow, outcome, or acceptance criteria, so it reaches Gate 1 with nothing to approve and parks there. A
non-zero exit instead refuses immediately, names the reference, and creates no session or run. Only the
resolver author knows which of the two cases it is in, so the contract cannot make the choice for it.

A `needs-human` terminalization is followed by a control-plane snapshot: the driver copies the run
directory to `$O/.factory/.parked/<R>` immediately after recording the park. A parked run waits for
outside intervention, and its control plane otherwise exists only inside the sandbox, so anything that
removed the sandbox destroyed the manifest and every accepted gate with it. `.parked` cannot be a run
id, so a snapshot never occupies the completed archive at `$O/.factory/<R>` and never blocks
re-initialising the same run id. It is published by a staged, verified swap, so a failed later park cannot degrade the last good
snapshot. A failed snapshot is reported and never prevents the park. `blocked`
and `partial` are not snapshotted, and a snapshot is evidence for recovery rather than a resumable run.

Qualified status reports `park_snapshot` for a parked run: the published path, or `null` when no snapshot
exists. That is how an outside observer verifies the snapshot happened rather than assuming it.
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

### Sandbox bootstrap

Only the CLI executes configured `bootstrap`: once during fresh init after clone, containment, and PR-base observation but before manifest publication, and again on every explicit resume while the run remains parked. The exact configured string runs unchanged with `shell: true`, inherited environment and stdin, cwd exactly the selected sandbox, and child stdout and stderr both routed to CLI stderr. Init JSON stdout therefore remains exactly one response object. Bootstrap has its own configured timeout or independent `900000` millisecond default, with no retry and no use of the verify budget.

After every attempt, the CLI checks tracked worktree and index paths only and ignores untracked dependency output. Unobservable tracked state refuses before dirty tracked paths; dirty paths refuse before unavailable or nonzero exit, and diagnostics name exact repository-relative paths. A clean numeric zero stores paired `bootstrap_command` and `bootstrap_exit` manifest evidence. The command is exact; the exit is a non-negative integer or `null`. Ordinary transitions preserve the pair, and status output does not expose it.

A failed, timed-out, dirty, or unobservable fresh init emits no JSON stdout, retains the deterministic sandbox, and leaves `run.json` absent. Configured resume first binds exact raw manifest bytes, validated parked state, a forward timestamp, and the exact fresh owner. Clean zero records evidence and unparks while preserving progress and the historical terminal result. Ordinary failure with intact bindings records integer or `null` evidence, advances the timestamp, remains `needs-human`, preserves progress and the historical result, and refuses so a later explicit resume reruns bootstrap. Byte mutation or owner loss preserves current state and ownership, records no evidence, and does not unpark. Factory claim, force-steal, heartbeat refresh, and release serialize with resume publication through `run-json.lock`.

When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change.

Bootstrap never runs during resolver intake, merge verification or replay, direct repository verification, slice observation, Gate 3, effective push, configured publication, push, or PR creation. Existing resolver, verify, configured-publish, effective-push, push, PR, and Gate 3 behavior is unchanged.

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

If `.factory.json` is absent, intake declares no resolver and init and resume perform no bootstrap. After
a recorded merge the factory silently returns its previous response with no repository command,
evidence write, or new output. A post-record
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
an optional `factory amend-paths <run-id> <slice-id> --add <path> [--add <path> ...] --reason <text>
--session <id> --repo <sandbox>` only when the verified cause is missing ownership on an unmerged slice;
then run `factory resume <run-id> --session <id> --repo <sandbox>` and verify running status, unchanged historical result, real
next action, and the same owner; replay only existing post-lock reconciliation for an already-recorded
merge; then continue solely from the newly qualified `status.next`.

Status remains readable while parked, and lock claim, justified steal, heartbeat, and owning release
remain available for ordered qualification. Every other effectful command refuses until explicit
resume. Without configured bootstrap, resume changes only `status` and `updated_at`. With configured
bootstrap, it also records the paired command and result under the bound transition described above.
Both paths preserve the original terminal reason and all progress. A resumed recorded merge still traverses the existing clean-head, retry-safety, evidence, and
repository-verification path. An unresolved repair-journal record is separate and remains
publication-blocking. If the cause was not fixed, the run may park again with the same reason.

The optional amendment runs while the status remains `needs-human`, after fresh exact owner
verification and before resume. It appends repository-relative, nonprivileged paths in request order and
records their verbatim reason, session, and timestamp in `path_amendments`; the original path prefix and
`test_plan` stay immutable. It never resolves or requires path existence, and another slice may already
own the same path. Duplicate, target-already-owned, malformed, privileged, replayed, or merged-slice
requests refuse atomically. Resume never amends or reseeds. A merge continues to refuse every unamended
or privileged changed path.

`resolve` and `verify` are consumed now, and the run's recorded `publishing_identity` is compared at the publication guards. Configured `publish` remains unconsumed and is not invoked.
Effective push-target capture and comparison are active through the package-owned `factory effective-push` command; they are not deferred to configured `publish`.
The recorded `publishing_identity` is read from `status` exactly as reported, without trimming,
normalization, case-folding, or reserialization. `init` refuses when neither the flag nor the environment
supplies at least one character, so a created run always carries one; only a manifest written before 0.8.0
can report `null`. `publishing_identity` is a recorded run field reported by `status`, resolved by `init` from a flag or the environment. The independent `factory effective-push` command adds no state or flag.

With a recorded identity, every mode checks it at exactly three boundaries: immediately
after verified post-lock ownership, or immediately after an explicit resume is verified running with
the same fresh owner and before reconciliation or other work; immediately before `git push`, after
effective push-target equality; and immediately before `gh pr create`, after the push is known
successful. No operation intervenes across a guard boundary. Only a manifest written before 0.8.0, which can
report `null`, skips all three guards; an absent config does not affect them.

Before each guard, inherited `GH_TOKEN` must exist and contain at least one character. Missing or empty
means identity is unobservable without invoking `gh`, the network, stored authentication, credential
queries, or any fallback. A prepared environment submits exactly this read-only network probe as one
ordinary host shell step with cwd exactly `RUN_REPO`, inherited environment, and no stdin:

```sh
gh api --method GET /user --jq .login
```

The direct stdout bytes, stderr bytes, and numeric status are parsed strictly. Only numeric zero, empty
stderr, and exactly one ASCII GitHub login plus one LF are observable; the required LF alone is removed,
then the raw login is compared exactly and case-sensitively with the raw declaration. `gh auth status`
does not prove the publishing identity.

A mismatch names the safely rendered declared and observed values and says to authenticate as the
declared account; an unobservable result names the safely rendered declaration and says to launch with
inherited `GH_TOKEN` for it. Values use deterministic ASCII-only JSON-string rendering, including
lowercase `\uXXXX` escapes outside printable ASCII. The complete rendered reason is transported as one
shell-safe argv token and the sole `--reason` value. The token, raw stdout or stderr, diagnostics, status,
targets, helper output, and environment are never exposed, and the factory never manages credentials or
transport.

Either refusal quiesces outstanding work, parks through existing `needs-human`, verifies the exact
persisted reason and owner, releases that owner, verifies the lock absent, and retains the sandbox. After
the environment is fixed, a later driver binds the retained sandbox and repeats every selection,
manifest, containment, config, effective-push, provenance, branch, worktree, cleanliness or recovery,
and exact-ref precheck; makes and verifies a fresh claim with its own `FACTORY_SESSION_ID`; runs exactly
`factory resume "$R" --session "$FACTORY_SESSION_ID" --repo "$RUN_REPO"`; verifies running status, the
unchanged historical result, real next action, and same owner; performs existing post-resume
reconciliation; and continues only from the newly qualified `status.next`. It never reuses the released
session.

Publishing-identity verification is enforcement because it prevents false-green or wrong-account
publication. Credential provisioning and helper setup are instruction only. Existing push,
`gh pr create`, `factory pr`, Gate 3, merge, and approval semantics remain unchanged. The live config
is not part of this package and no generated config or resolver asset is shipped. See the repository's
[operator guide](https://github.com/jasoncarreira/feature-factory/blob/main/OPERATING.md) for the
shared inherited-token helper recipe; it does not acquire, store, install, or repair credentials.

## Effective push target

```text
factory effective-push <bootstrap|check> <operator-repository> <sandbox-repository>
```

The command accepts exactly those three positional arguments and no options. `bootstrap` captures the
operator's effective push target, configures the sandbox push URL from it, then freshly captures both
repositories and compares them exactly. `check` freshly captures both targets and compares without
configuration. Both modes use shell-free Git subprocesses, write no output on success, and retain the
sandbox on a fixed redacted failure. Captured targets and child diagnostics are never returned, logged,
persisted in factory state, printed, or attached as an error cause. The command is independent of
`publishing_identity`, adds no run state or flag, and configured `publish` remains unconsumed.

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

See the [repository](https://github.com/jasoncarreira/feature-factory) for the full command
reference and design notes.

## License

MIT
