# prime-agent-feature-factory

Prime Agent integration for [`feature-factory`](https://www.npmjs.com/package/feature-factory).
It ships a Prime-specific `feature` skill, a context script and an unattended launcher, while preserving
the factory package's canonical workflow and CLI-owned durable state.

Requires **Prime Agent 0.10 or newer** (the Rust host) and Node.js 22 or newer. 0.12.0 is the first
version for that host: Prime 0.10 loads no JavaScript extensions, so the `/feature` command and the
`feature_factory_context` tool that earlier versions registered no longer exist.

## Install

```sh
prime-agent package install npm:prime-agent-feature-factory
```

The package manifest exposes the skill through `pi.skills`. Prime Agent runs a real `npm install` of the
package, so the runtime `feature-factory` dependency is installed beside it.

## Use

Interactively, in any Prime session:

```text
/skill:feature [--autonomous | --headless] <ticket key | feature idea>
```

Unattended, use the launcher, not `prime-agent -p`:

```sh
node "$(npm root -g)/prime-agent-feature-factory/bin/launch.js" --cwd <repo> -- --autonomous <issue-number> < /dev/null
```

`-p` cannot drive a run on Prime 0.10. It runs the session in-process. On 0.10.0 `rlm.spawn` has no child
runtime there and agent messaging does not exist. 0.10.1 runs subagents inline and has agent messaging, but
`agent_observe`, which the skill needs, exists only in a daemon worker. The skill refuses either way. The
launcher instead starts a Prime daemon on its own socket, creates a **resident** session there (one that
outlives the launcher), sets the autonomous budget (600 turns, 200 continuations, 6,000,000 tokens and six
hours by default; `--max-turns`, `--max-continuations`, `--max-tokens` and `--timeout-ms` override them),
prompts it with `/skill:feature <arguments>`, prints one JSON line and exits:

```json
{"socket":"/tmp/prime-agent-501/feature-….sock","activeSessionId":"e44fd57b15c3","stop":"PRIME_AGENT_DAEMON_SOCKET=… prime-agent stop e44fd57b15c3"}
```

**If the launch exits 1 after creating the session, it still prints that line,** with `"prompt"` added:
`"refused"` means the daemon declined the prompt and the session is idle, so stop it; `"unconfirmed"` means
the acknowledgement was lost and the run may be working. Check it with `prime-agent list --json` on that
socket before stopping it or launching again. The launcher never re-sends an unconfirmed prompt, because a
second one could start a second driver.

The `GH_TOKEN` and `FACTORY_PUBLISHING_IDENTITY` a run needs must be in the launcher's environment. The
launcher sends that environment with the create as `launchEnv`, and Prime 0.10.1 applies it to the session.
Prime 0.10.0 ignores it and gives a session the daemon's boot environment, which is why the daemon is the
launcher's own, started with that environment. `--socket` reuses a daemon you started yourself; on 0.10.0 it
must have booted with the run's environment. Prefer Prime 0.10.1, since 0.10.0's TUI blanks in iTerm2's
fullscreen view. `--skill <path>` adds a skill file
to the session; it does not turn discovery off, so where the adapter is also installed the session sees two
`feature` skills. Which one a self-hosted run then follows is not yet verified on Prime 0.10.

Stop a run with the printed `stop` command. Do not use `prime-agent shutdown`: on 0.10.0 it stops every
daemon under the same socket directory, interactive sessions included, and its narrower 0.10.1 scope was not
tested here. The run's daemon stays up, idle, after the run
terminalizes.

The integration drives foreground runs only, and rejects `--background` before creating or changing a run.
The skill reads its install context by running `bin/context.js`, which prints the installed agent directory,
the factory CLI and each specialist's spawn profile. It binds `SESSION_ID` from the session's own durable
`sessionId` in `agent_observe.list_agents()`, uses Prime RLM children for specialist work, and requires their
reports through agent messaging.

`skills/feature/WORKFLOW.md` is a package-local copy of the factory's canonical workflow. `pretest` and
`prepack` refresh it with the repository sync script so the adapter never relies on a skill loader to
inline another package's resource. The CLI remains the only writer of `run.json`.

## Specialist model and thinking level

Every agent file in `feature-factory` declares `model`, `role`, and `effort` in its frontmatter. This
adapter uses `role` and `effort`, and ignores the declared `model` for the same reason the OpenCode
adapter does: `sonnet` and `opus` are tiers, while Prime requires an exact `provider/id` selector and
fails a spawn given anything else.

`effort` becomes the child's `thinking` level directly — every declared value (`low`, `medium`, `high`,
`xhigh`) is one of Prime's `THINKING_LEVELS`, so nothing is mapped or approximated. A value outside that
set is dropped rather than passed, because an unknown level fails the spawn instead of being ignored, and
inheriting the parent's level is the safer miss.

A model resolves through the same four levels as the OpenCode plugin, most specific first, so an operator
configuring both hosts learns one vocabulary:

```
profiles[<agent>]  →  profiles[<role>]  →  profiles.default  →  profile
```

Configure them in `.prime/agent/feature-factory.json`, project-local first and then
`~/.prime/agent/feature-factory.json` for every project:

```jsonc
{ "profiles": {
    "planning": { "model": "openai/gpt-5.6-sol", "thinking": "xhigh" },
    "builder":  { "model": "openai/gpt-5.6-sol" },
    "story-reader": { "model": "openai/gpt-5.6-luna", "thinking": "minimal" }
} }
```

The project file wins outright over the home file; they are not merged, so a project that sets only
`builder` does not inherit the home file's other roles. A malformed or non-object file is skipped rather
than raised, because a typo in an optional profile must not stop every run before it starts.

That file is the configuration surface because the skill runs `bin/context.js` with no options, so
anything reachable only by calling its exports directly is not configuration.

Roles come from each agent's own frontmatter — `planning`, `story`, `research`, `design`, `builder`,
`test`, `reviewer` — so a new agent inherits its role without needing an entry.

**`model` has no default here, deliberately.** Prime's own `subagentDefaultModel` setting already means
"one model for every child", and it applies exactly when a spawn omits `model=`. Pinning a selector is
fail-closed at both layers: an unavailable, unauthenticated or expired selection fails the spawn rather
than falling back to another model. That is the behaviour you want — a run should not quietly proceed on
a model nobody chose — but it means a wrong selector stops the chain rather than degrading it. Configure
one only after `rlm.find_models()` confirms it from the credentials the run will use.

### What this adapter cannot enforce

On OpenCode, each agent's declared `tools` becomes a permission map, and that is what keeps a reviewer
from editing the code it judges. **Prime children inherit the parent's tools and skills**, and
`rlm.spawn` takes no tool or skill argument, so that separation is instruction here rather than
enforcement: the composed prompt states the allowed files and tools, and nothing stops a child ignoring
it. Recursion depth is enforced by the host — the default permits children but not grandchildren.

## Development

From this package directory:

```sh
npm test
npm pack --dry-run
```

## License

MIT
