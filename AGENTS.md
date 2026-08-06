# Working in this repository

Every rule here cost a run. None of them is a style preference, and each names what it prevents so you
can tell when it does not apply.

## Read only inside this tree

The CLI under change is `packages/feature-factory/bin/factory.js` **in this working tree** — never the
copy installed under `~/.config/opencode`, and never a `factory` executable on `PATH`. The installed copy
is a snapshot of some earlier merge; reading it tells you what shipped last week, not what you are
changing.

A read outside the tree is auto-rejected, and a run that treats the refusal as fatal ends its turn
without terminalizing — leaving `status: running` with nothing alive. That is how the first attempt at
one issue died, on `~/.asdf/installs/nodejs/24.11.1/bin/factory`. An unscoped search is worse: one rooted
at `$HOME` wedged a run for 65 minutes on a blocked write while every health signal read normal.

**If something you need genuinely is not in the tree, say so and stop.** Do not search for it. A
dependency you cannot find in-tree is usually a dependency that has not been declared yet.

## Tests drive this repository's entry point

Resolve `bin/factory.js` relative to the test file, as `test/end-to-end.test.js` does. Never invoke an
installed `factory`, and never assert against the installed skill or agent files. The suite proves what
this tree does.

## A prose assertion must match a fragment that sits on one line

Assertions that pin skill or agent text search raw markdown, and a fragment spanning a line wrap can
never match — the assertion fails for a reason that has nothing to do with the rule it guards. Pick a
distinctive fragment short enough to live on one line, or match with `\s+` where the wrap is.

## An assertion should fail for the reason its comment gives

Run the negative control before you believe it: delete the rule the assertion pins, watch the test fail,
restore it, watch it pass. A test that passes because the tokens happen to appear elsewhere is worse than
no test, because it reads as coverage.

This is the same discipline the suite applies to itself — see the comments in `test/end-to-end.test.js`
about helpers that were correct while their wiring was dead.

## The ledger records where you landed, not a target

`test/ceiling.test.js` asserts an exact production total and a tripwire above it. The exact total is a
record of the last run's landing, so updating it to your own is expected and is not a ceiling change.
**Never pad or trim production code to satisfy it** — manufacturing scope to make an assertion pass is
worse than the drift the assertion catches.

The test budget in the same file counts `it(` and `test(` **call sites**, not executed assertions. Adding
a row of data to an existing site is invisible to it and is the growth this codebase wants; adding a new
`it()` is what it constrains. Bind new prose to a site that already exists.

## Never narrow a ratified test command

`factory observe` refuses a `--test-cmd` that is not an exact match for one of the slice's ratified
`test_plan` entries, so this is enforced rather than advisory. The reason is worth knowing anyway:
dropping a failing path from the command makes the observation green while proving less than the plan
ratified, and every downstream check — the evidence record, the review binding, the merge — reads the
command you supplied rather than the one the plan named.

If a ratified command covers a test your slice may not touch, the slice blocks. That is the honest
outcome.

## Prefer instruction to enforcement, and say which you added

The governing rule for this codebase: **enforce what can produce a false green, instruct the rest.** A
guard that stops a run from claiming success it did not earn is worth production lines. A guard against
an inconvenience is not — it costs a limit nobody voted for and blocks work it was never aimed at.

When you add a check, say in its comment which of the two it is.
