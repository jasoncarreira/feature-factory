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
