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

The agents declare *tiers*, not model ids — `model: sonnet|opus` and `effort: low..xhigh` — because
which role deserves the deep model is a property of the chain, not of a vendor. No model default ships;
with none configured the host's default applies and `effort` still maps to `variant`.

Map the tiers once, in the plugin's options:

```jsonc
["opencode-feature-factory", {
  "models": { "sonnet": "openai/gpt-5.6-terra", "opus": "openai/gpt-5.6-sol" }
}]
```

Or override a single agent, either there under `profiles`, or **per project** in the repository's own
`opencode.json` — the host merges that before this plugin runs, so a project's choice wins:

```jsonc
{ "agent": { "work-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" } } }
```

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
