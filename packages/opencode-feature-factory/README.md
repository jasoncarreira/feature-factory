# opencode-feature-factory

The [opencode](https://opencode.ai) integration for
[`feature-factory`](https://www.npmjs.com/package/feature-factory): a sidebar that renders run state,
and a server plugin. It reads run state and cannot write it.

## Install

Install where the host's modules resolve, then name it in `~/.config/opencode/tui.json`:

```sh
npm install opencode-feature-factory
```

```jsonc
{
  "plugin": ["opencode-feature-factory"]
}
```

The host reads the sidebar entry from `exports["./tui"]`. The package root is the server plugin and
has no `tui` hook, so it is never mistaken for the sidebar.

Requires `solid-js` and `@opentui/solid`, declared as peer dependencies — the sidebar must use the
copies your host installed rather than its own, or its reactive graph runs in isolation and never
repaints.

## Configuring the agents

Each agent declares a **role** — `planning`, `story`, `research`, `design`, `builder`, `test`,
`reviewer` — and an `effort`. No model ships as a default: with nothing configured, agents use the
host's normal model resolution and keep their declared effort as `variant`.

A model resolves through four levels, most specific first:

```
profiles[<agent>]  →  profiles[<role>]  →  profiles.default  →  profile
```

So one entry can cover everything:

```jsonc
["opencode-feature-factory", { "profile": { "model": "openai/gpt-5.6-sol", "variant": "high" } }]
```

or by role, with per-agent exceptions where a role is not uniform:

```jsonc
["opencode-feature-factory", {
  "profiles": {
    "planning": { "model": "openai/gpt-5.6-sol",   "variant": "xhigh" },
    "builder":  { "model": "openai/gpt-5.6-sol",   "variant": "high"  },
    "research": { "model": "openai/gpt-5.6-terra", "variant": "high"  },
    "story-reader": { "model": "openai/gpt-5.6-luna", "variant": "medium" }
  }
}]
```

### Per-repository overrides

A repository's own `opencode.json` outranks all of it, because the host merges that before this
plugin runs:

```jsonc
{ "agent": { "work-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" } } }
```

For a targeted repository model or effort (`variant`) override, configure `agent.<name>.model` and/or
`agent.<name>.variant` in that repository's `opencode.json`.

OpenCode merges this file into `cfg` before the plugin runs; the plugin does not read `opencode.json`
itself.

**Warning:** Project-level plugin `profiles` replace the plugin's configured `profiles`; they are not
partially merged. Supplying only part of `profiles` drops omitted entries and can silently make
unmentioned agents fall back to OpenCode defaults. Use the targeted `agent` override above instead.

What configuration cannot change: **who may edit, and who may delegate.** Those come from each agent's
declared tools, because a reviewer that can modify the code it judges breaks the separation the chain
depends on, and a delegating subagent makes the orchestration tree unbounded. Change the agent
definition if you need different tools.

## What it does

Answers "what is this repository's run doing" — which run is live, which gate is waiting, how many
slices have merged, and what happens next.

Discovery is filesystem-only: it walks up from the current directory for `.factory`, and
follows a linked worktree's `.git` pointer back to the main repository, so the sidebar still shows
the run when a slice worktree is the working directory.

## The boundary

This package never writes run state, and that is structural rather than conventional. Its test suite
asserts that no write or process-spawning primitive appears anywhere in it, that it imports only the
factory's read-only surface, and that the dependency runs one way. If it needs a state change, it
must shell out to the CLI, which means first amending that test to allow the spawn — the escape
hatch exists but cannot be taken quietly. Today it needs none, because the orchestrator
drives every transition itself.

## License

MIT
