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
run effect and never falls back:

```text
invalid factory config: .factory/config.json; no session or run created.
factory config entry 'resolve' returned malformed payload; no session or run created.
factory config entry 'resolve' failed with exit status <status>; no session or run created.
factory config entry 'resolve' failed; exit status unavailable; no session or run created.
```

Diagnostics name only `resolve` and the status classification; neither the configured or expanded
command line, shell diagnostics, nor credentials are printed, logged, or persisted. Credential values
stay in inherited environment variables and never in the config. The contract adds no bridge, parser
service, command runner, capture or stderr policy, output channel or size policy, buffering, truncation,
redaction, timeout, retry, cache, payload transport, or session behavior.

`verify` and `publish` are declarations for future ordinary shell steps in repository-root cwd. Their
exit status will be authoritative and stdout informational and unparsed. Zero means success; non-zero
means repository verification failed for `verify` and reported publication failure for `publish`.
Neither is invoked today. Existing verification and publication remain unchanged, with push-target
publication deferred to #224. Static `publishing_identity` has no runtime input and returns the
non-empty account-name value itself; a missing, non-string, or empty identity makes the config malformed.
It is not yet consumed, and identity enforcement is deferred to #216. The live config is not part of
this package and no generated config or resolver asset is shipped. See the repository's
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
