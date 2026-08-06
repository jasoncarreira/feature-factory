# Operating the factory unattended

Written from one long session of autonomous runs: seventeen issues shipped, and roughly a dozen runs
lost. Every lost run traced to the *issue text*, not the machinery. This document is mostly about that,
and about which monitoring signals lie to you.

## 1. The binding constraint is the issue, not the factory

A run reads its issue **once, at Gate 1**. From then on the story artifact binds. Editing the issue
mid-run reaches nobody — that was tried twice and both times the run shipped the superseded design.

So everything a run needs must be in the issue *before launch*:

- **Measure host mechanisms before writing the issue.** An issue asserting unverified behaviour costs a
  full cycle. Attempts were lost to an API quoted from type declarations that did not exist, a cleanup
  step that could not be implemented under the issue's own rules, a fallback for a case another change
  had already made impossible, and a permission map that silently removed the capability it claimed to
  grant.
- **Count the unresolved decisions.** Budget roughly one review round each. An issue whose own story
  listed ten open decisions burned three `spec-writer` attempts and could not converge; retrying does
  not fix that, splitting does.
- **State scope locks as prohibitions a reviewer can check by absence.** "No quarantine,
  ownership-evidence, or recursive-removal machinery" works. "Be careful with cleanup" does not.
- **Say which facts are given.** Mark measured host behaviour as an accepted external premise, or a
  reviewer will reasonably demand in-repository proof of something no repository test can establish —
  and the run will go looking for it outside the tree, which hangs (§5).
- **Corrections belong in the body, never a comment.** `gh issue view` returns the body.

## 2. Launching

### Repository command configuration

The repository operator may create an optional `$O/.factory.json`, where `O` is the physically
resolved Git top level of the invocation checkout:

```json
{
  "resolve": "<non-empty shell command>",
  "verify": "<non-empty shell command>",
  "publish": "<non-empty shell command>",
  "publishing_identity": "<non-empty account name>",
  "verify_timeout_ms": 900000
}
```

The root object has four required properties and only the optional `verify_timeout_ms`. The first three
required properties are non-empty command strings; `publishing_identity` is a static non-empty account
name, not a command, token, credential, or command result. The timeout, when present, must be a positive
safe integer; omission silently defaults repository verification to `900000` milliseconds. Missing
required or unknown properties, invalid or unreadable JSON, wrong types, empty or whitespace-only
required values, and invalid timeout values make a present file malformed. All required entries and the
optional timeout are validated before an entry is used. A command may name credentials supplied through
its inherited environment, but credential values must not appear in the file.

`resolve` and `verify` are consumed today. After mode admission, `resolve` runs as one ordinary shell step with its
configured string submitted unchanged, exact cwd `O`, the inherited environment plus `FACTORY_INPUT`,
and no positional argument or structured stdin. `FACTORY_INPUT` is the exact admitted request remainder,
including its original whitespace and bytes. Exit zero with no stdout means the input was not recognized;
the factory continues ticket, design, or free-text classification. There is no built-in recognizer to
fall back to.
Exit zero with stdout uses those exact bytes directly as `ISSUE_PAYLOAD`. The payload must be one JSON
object with a valid canonical top-level string `run_id`, a non-empty string `title`, and a string `body`;
the factory validates all three, before binding the run id or dispatching anything, without
extracting, wrapping, reserializing, or changing the payload, then supplies the same stdout unchanged to
`story-reader`. The value must match `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`; a digit-only value must be
positive decimal without leading zeroes.

A present malformed file or malformed non-empty resolver payload refuses, respectively:

```text
invalid factory config: .factory.json; no session or run created.
invalid factory config: .factory.json entry 'verify_timeout_ms' must be a positive integer; no session or run created.
factory config entry 'resolve' returned malformed payload for reference <reference>; no session or run created.
```

A configured resolver failure refuses, naming the reference — `FACTORY_INPUT` as admitted, truncated to
200 characters — because an operator resolving several references cannot otherwise tell which one failed:

```text
factory config entry 'resolve' failed for reference <reference> with exit status <status>; no session or run created.
factory config entry 'resolve' failed for reference <reference>; exit status unavailable; no session or run created.
```

An absent config file means no resolver is declared, and nothing is recognized or fetched: the skill
carries no tracker grammar and no fetch command. Reference intake exists only where a repository declares
it. **This repository declares its own**, in a committed `.factory.json`, so `205`, `#205`, and
`https://github.com/jasoncarreira/opencode-feature-factory/issues/205` still select run `205` — through
that declaration rather than through anything built in. A repository without one can still start a run
from free text; it just cannot start one from a reference.

Resolver diagnostics never print, quote, log, or persist a configured command, its expanded command
line, shell diagnostics, or credentials. The resolver contract adds no config bridge or parser service,
command runner, payload transport, capture or stderr policy, output channel or size policy, buffering,
truncation, redaction, timeout, retry, cache, or session behavior.

The entries have these execution contracts:

| entry | input and return contract | failure meaning | status |
| --- | --- | --- | --- |
| `verify` | The unchanged string runs as an ordinary shell command in the exact recorded integration-worktree cwd with inherited environment and stdio; no structured stdin or factory payload. Each attempt gets the full configured timeout. Stdout and stderr are visible, informational, and unparsed rather than captured or persisted. | Numeric child exit status is authoritative. Zero succeeds; non-zero means repository verification failed; no numeric status is unavailable. | Invoked after each newly recorded merge with at most two executions per merge or replay invocation. Direct committed test-only repair observation remains one execution. |
| `publish` | Future ordinary shell step in repository-root cwd with inherited environment; no structured stdin or factory payload. Exit status is authoritative and stdout is informational and unparsed. | Zero reports success; non-zero reports failure. | Not invoked; existing push and PR behavior remains unchanged. Push-target publication is deferred to #224. |
| `publishing_identity` | No runtime input; the static non-empty account-name string is the return value. | A missing, non-string, or empty identity makes the config malformed. | Not consumed for identity enforcement; deferred to #216. |

The merge record commits before `verify` begins. A successful observation is written through the existing
canonical `evidence/test-verifier.json` schema against the current merged head and the immutable base of
the first root slice. A non-zero or unavailable result, a malformed present config, or a non-ready
observation leaves the merged slice, its merge commit, its evidence, and its review unchanged and stops
the driver before it consults or activates the next wave. It never reopens, re-seeds, or re-dispatches
the merged slice.

Production defects are not repaired on the integration branch and terminalize `needs-human`.
Repair-journal exhaustion, dirty or moved replay safety failures, invalid config, unobservable state, and
malformed, stale, foreign, wrong-command, missing-field, or internally inconsistent evidence do the same.
Clean, unchanged second-unavailable repository verification is explicitly excluded: it follows the
nonterminal exhausted/release contract below. A confirmed test-only finding may change test files only,
never production or privileged paths; it uses a separate commit, preserves the tested property or
records its loss, is bounded by `max_retries`, and is disclosed in the PR body. Only changed bytes from
such a committed repair authorize another repository verification.

Canonical evidence has exactly four classifications. `green` has exact run, `test-verifier` subject,
current merged head, and unchanged `verify` command binding, observed integer exit zero, and
`review_ready: true`. `failed` has that exact binding with observed nonzero integer exit, or observed zero
that is not review-ready. `unavailable` has that exact binding and canonical `observed: false`,
`exit: null`, and `skipped_reason: null`. Missing, unreadable, malformed, foreign, stale-head,
wrong-command, missing-field, or internally inconsistent evidence is `unknown`. Only `unavailable` may
execute again; failed and unknown evidence never does.

On a first unavailable merge result, replay requires no active repair and the CLI freshly proves the
exact integration worktree on the recorded feature branch, unchanged recorded merge SHA at `HEAD`, and a
clean tree before one retry. Dirty, moved, unobservable, malformed, stale, foreign, wrong-command, or
inconsistent state never executes. Each attempt receives the full timeout; there is no aggregate timer,
third attempt, output capture, fallback, partial suite, or persistent counter. The timeout and retry are
verify-only: resolver, slice observation, and Gate 3 remain unchanged. The same configured timeout
applies to the one direct repository observation after a committed test-only repair without changing
repair-journal retry policy.

After two clean, unchanged unavailable executions, the current merge/replay CLI invocation and enclosing
driver invocation terminate, but the irreversible `factory terminal` transition does not run. Durable
state remains `running` with `terminal_result: null`. The driver stops dispatch and `status.next`, awaits
all specialist tasks, stops and awaits all heartbeats, releases exactly its owning session, then requires
qualified status to prove that durable state and that the session no longer owns the lock. In the normal
uncontended path the lock must be absent before it reports `repository-verify-exhausted`.

If release or qualified ownership verification fails, the driver reports `retained-lock-error` with the
actual status, terminal result, lock, and error, retains the repository, stops all orchestration, and
makes no resumability claim. A later invocation repeats normal run selection, manifest, provenance,
branch, worktree, effective-push, and operator-ref checks; claims with its actual host-exported session
ID; verifies that exact ownership; and only then replays the same-SHA merge before following
`status.next`. The session ID may equal the prior value because verified absence and a new verified claim,
not string inequality, establish freshness. Green and failed same-SHA evidence remains non-executing;
unknown or unsafe state retains `needs-human` routing. Gate 3 remains separately fresh.

An absent `.factory.json` remains silent compatibility behavior. At intake it declares no resolver. After
a recorded merge it runs no repository verification, writes no canonical evidence, emits no additional
output, and returns the same merge result as before this consumer existed. A malformed present file still
fails closed.

Post-merge verification does not replace Gate 3. Gate 3 always runs a fresh, independent integrated
`test-verifier` observation at the current head through the existing command path, overwriting canonical
evidence without sharing or optimizing from the post-merge result even when the head is unchanged.

The live file is operator-owned: committed, so every clone and sandbox carries it, and protected by the
privileged-path policy rather than by being unversioned. It was `.factory/config.json` until that path
proved unusable — `.factory/` is gitignored, so the declaration could not be committed and never reached
a sandbox clone. A feature run
does not create, write, merge, archive, or package it.

### Launch command

```sh
export GH_TOKEN=$(gh auth token -u <account>)
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper \
  GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'

opencode run --log-level DEBUG --print-logs --dir <repo> \
  --command feature " --autonomous <issue-number>"
```

Three details, each of which cost something:

- **The leading space** before `--autonomous`. The launcher's argument parser consumes the flag
  otherwise, and `--` makes the host crash. The skill's mode admission tolerates the space.
- **The credential pin.** The machine-active `gh` account flips as a side effect of unrelated work. Two
  runs built correct code, passed every gate, and terminalized without a PR on HTTP 403. The pin makes
  publication independent of machine state.
- **`--log-level DEBUG --print-logs`.** The only instrument that distinguishes a stalled run from a slow
  one. Attach it always.
- **Keep the host awake.** A batch queued overnight ran one issue and then sat idle until the machine woke
  nine hours later. Hold sleep off around the queue, or expect to lose the night — nothing in the factory
  reports this, because from its side no time passed at all.
- **Detach each run from whatever supervises it.** `nohup` ignores SIGHUP but does not leave the process
  group, so killing a supervisor kills the runs it started. One run died that way with a twenty-line log
  reading `init` … `cleanup`, which looks like a crash on startup and is not. Give each run its own
  session, or start it as an independently tracked job.

## 3. Signals that lie

| signal | verdict |
| --- | --- |
| manifest `updated_at` | **misleading** — moves only at transitions, so a long build looks dead |
| lock heartbeat freshness | **misleading** — reads fresh for its whole TTL after a stall |
| debug-log idle time | fine up to ~20 minutes; output is block-buffered to the file |
| `grep "asking id="` | **ambiguous** — also matches an issue body quoting a log excerpt |
| `grep "message=asking id=per_"` | reliable: a real permission request |
| `pgrep -f "opencode run"` | **matches your own monitor script** |
| `pgrep -f "bin/opencode run"` | real processes only |
| non-terminal manifest + no process | a genuine orphan; needs a lock release |
| matching package versions | **proves nothing** — see §7 |
| `duplicate skill name" name=feature` | the run may be following a different skill entirely — see §7 |

That last row is the one to internalise. It is a `WARN` among hundreds of `WARN`s, it scrolls past during
startup, and it is the only notice you get that the run is not executing the skill you installed.

The reliable health check is: a live process, a debug log that has moved within ~20 minutes, and zero
real permission requests.

## 4. Recovery

```sh
kill <pid>                                    # by PID; never pattern-kill
factory lock <run-id> release --session <session-from-the-lock-file>
rm -rf .factory-sandboxes/<run-id>            # only after confirming the work is merged or worthless
```

The manifest carries the run, so nothing is lost by relaunching. Confirm merge state with "is this PR
merged?" — **not** by comparing commits, because squash merges make the originals unrecognisable.

## 5. Failure modes to expect

**A subagent reading outside the repository hangs forever.** No error, no terminal state, no telemetry;
every signal reads "working". Every mechanism that could decide such a request has been measured
inert — the permission hook is never invoked, `external_directory` config is ignored in every form, and
the blanket auto-approve flag is too broad to use. Mitigate in the issue: read only inside the tree,
vendored dependencies are inside it, and a refused read is expected rather than fatal.

A **primary** session's request is auto-rejected instead of hanging, which is survivable — but a run
that treats the refusal as fatal will end its turn, which is the next item.

**A run can end its turn without terminalizing**, leaving `status: running`, a step marked in flight,
and nothing alive. Two clean reproductions. Recovery is §4.

**Publication can fail after all the work succeeds.** Gates approved, slices merged, then HTTP 403. The
run records the reason accurately rather than claiming success; the branch is pushable by hand.

## 6. Concurrency

Concurrent runs work. Each gets its own sandbox and lock, and slices within a run build in parallel when
they are file-disjoint.

A run's sandbox is a **snapshot of the base branch at clone time**, so a run cannot see a merge that
lands while it works. Do **not** merge the base branch inside a run to compensate: that can turn correct,
tested work into no PR, and it breaks the link between what was reviewed and what is published. Let CI
test the merge and reconcile on the pull request — that is what the pull-request workflow is for.

Expect to reconcile the second of two PRs that touch the same file. It cost about fifteen minutes once.

## 7. Installing

Version equality is **not** content equality. Installation from a local pack means a merge after a
version bump leaves the installed copy reporting the same version with different contents. Verify by
content:

```sh
grep -c '<symbol-the-new-code-introduces>' ~/.config/opencode/node_modules/<package>/<file>
```

**The file the agent reads may not be the file you installed.** Two copies of the same skill can be
registered at once, and the stale one can win. This cost two runs, and the first diagnosis was wrong in an
instructive way: the run refused a payload its skill explicitly permits, in the exact manner its skill
explicitly forbids. That reads unmistakably as a model ignoring its instructions. It was obeying a
*different* skill — a version published to the registry long ago, present because the host config named
the plugin twice, once by path and once as a bare package name that resolves to `@latest`.

Triage, when a run refuses on a rule you cannot find in your skill: **grep for the words it used.**

```sh
grep -c '<phrase from the refusal>' <installed skill> <every other registered copy>
```

Vocabulary present in one copy and absent from the other identifies which file was in force, in one
command. It beats any amount of reasoning about why the model misbehaved, because the premise of that
reasoning is false. Here the refusal cited a flag that had not existed for many versions, which is the
tell: **a rule referring to machinery you do not have is not your rule.**

Then look at what else that copy shipped. The stale one carried its own `assets/agent/*.md`, including a
reviewer that does not exist in the current lineage — so every stage would have run against agent
definitions from a dead lineage, not merely a stale skill. Prefer packages that ship no skill or agent
assets at all: nothing to shadow with is better than shadowing detected.

**Never reinstall while a run is live.** Swapping CLI flags under an orchestrator that is following the
previously installed skill breaks it mid-flight.

## 8. Reviewing what came back

The gates and the reviewer catch a great deal. Two classes they structurally cannot:

- **Ambient-environment dependencies.** A fixture that borrows something from the environment — a git
  committer identity, a global config — passes on every machine that has it and fails only where it
  matters. Reading the fixture will not reveal it; running without the ambient value will.
- **A permission that is not a capability.** A grant can resolve perfectly in the permission output
  while the tool it governs is withheld. Assert the capability alongside the permission, or the test
  passes while the feature is broken.

And one habit worth keeping: when a claim's *comment* asserts more than its *assertions* check, only
someone reading both will notice. Prefer assertions that fail for the reason the comment gives.
