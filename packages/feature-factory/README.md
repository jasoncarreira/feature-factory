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
| `skill/SKILL.md` | the `/feature` orchestrator prose |
| `agents/` | eleven agent definitions the skill dispatches |

Point your agent host at `skill/SKILL.md` and `agents/`, then drive runs with the CLI.

## Why the code exists at all

Almost all of this system is prose. Code exists only where prose cannot enforce something:

- **Agents cannot reliably hand-write a schema-perfect `run.json`**, so every state change goes
  through `lock → read → validate → apply → validate → compare-and-swap → rename`, and nothing else
  writes the manifest.
- **Verification exists only where its absence produces a false green.** With a human at the gate,
  someone sees the diff. In an autonomous run nobody does, so a review must name the commit it
  judged, a merge must prove it contributed exactly what was reviewed, and a test result must have
  been observed rather than reported.

Run state lives at `<repo>/.claude/factory/<run-id>/run.json`, which must be gitignored: a tracked
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
