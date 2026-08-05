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
