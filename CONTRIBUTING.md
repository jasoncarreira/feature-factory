# Contributing

Repository-only guide; not included in either published package.

## Setup

Node.js `>=22`. `.tool-versions` pins the version used locally; CI runs 22 and 24.

```sh
npm ci          # installs both workspaces
```

## Checks

```sh
npm test                    # both packages
npm run test:factory        # packages/feature-factory alone
npm run test:opencode       # packages/opencode-feature-factory alone
```

No lint or typecheck script. `feature-factory` is not bundled or transpiled at all.

`opencode-feature-factory` has one build step: the sidebar is authored as JSX and bundled to
`tui/dist` by `npm run build` (also run by `prepack`, and by `npm test` before the pack check). The
output is generated and gitignored — do not edit or commit it.

`solid-js` and `@opentui/solid` are **peer** dependencies and are externalized from that bundle. The
contract is module *identity*: the sidebar has to use the copies the host installed, or its reactive
graph runs in isolation and repaints nothing. Bundling them produces a sidebar that renders once and
then never updates, which looks identical to having no reactivity at all.

**Run `npm run test:factory` before submitting.** The factory package declares zero dependencies and
claims to work with no opencode present. That claim is only true if its suite passes on its own, and
CI runs it separately for the same reason.

## Two tests you will meet

**`packages/feature-factory/test/ceiling.test.js`** is the scope lock. It asserts the exact CLI
command set, the exact `run.json` key set, the family list, the absence of every dropped subsystem
under any spelling — including in agent prose — that the skill invokes only commands and flags the
CLI accepts, that every agent the skill dispatches ships, and a hard line budget on production
source.

If it fails, that is usually the correct answer rather than an obstacle. Widening it means editing
that file, so the decision appears in a diff instead of arriving as a reasonable-sounding addition.
Raising the line budget is a debt: pay it down with a deletion in the same change, or record in the
test why you could not.

**`packages/opencode-feature-factory/test/boundary.test.js`** proves the opencode package cannot
write run state. It scans for write and process-spawning primitives as plain substrings across whole
files, *comments included*. That bluntness is deliberate and it does bite — a comment explaining why
a spawn is absent trips it exactly as a spawn would. Reword rather than adding an exception.

## Changing behaviour

Two conventions this codebase holds to, both learned the hard way:

- **Falsify the guard.** After adding or changing a check, remove it and confirm a test fails.
  Assert the anchor is present before removing it, so a silent no-op edit cannot masquerade as a
  falsification. Several guards here were "verified" while being dead code that only read as
  enforcement.

  Two ways that goes wrong, both of which happened repeatedly: **judge the result by the pass/fail
  count, not by grepping for your assertion message** — a guard that fires with a different error
  (`ENOEXEC`, a thrown exception) looks like a dead guard to a grep. And **probe one thing at a
  time**: two mutations at once means the first failure masks the second, and you record a live guard
  as dead.
- **Prose is part of the contract.** `skills/feature/SKILL.md` and `agents/*.md` are executable instructions.
  The ceiling test checks their commands and flags against the CLI, and
  `test/prompt-claims.test.js` executes the claims they make about what the CLI permits. Add a row
  there when prose starts asserting what will or will not be allowed — three separate times a fix
  shipped carrying a false claim of exactly that kind.

- **Know what the tests cannot see.** The sidebar component needs a running OpenTUI renderer, so it
  cannot be instantiated here at all; its poll loop is extracted into plain JavaScript precisely so
  that the testable part is testable. Whether the sidebar actually paints is a question only a real
  host answers.
