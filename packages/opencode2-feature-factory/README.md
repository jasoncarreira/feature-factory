# opencode2-feature-factory

The [OpenCode 2.0](https://opencode.ai/v2/docs/build/plugins) integration for
[feature-factory](https://www.npmjs.com/package/feature-factory). For OpenCode 1.x, use
[`opencode-feature-factory`](https://www.npmjs.com/package/opencode-feature-factory): V1 plugins don't run in
2.0, and the two packages are separate.

It has two plugins:

- **The server plugin** registers the workflow with the host and writes nothing:
  - the `/feature` command;
  - the `feature` skill;
  - the `feature-factory` orchestrator, the `run-orchestrator` background driver, and the factory's eleven
    specialists;
  - a `feature_factory_context` tool that reports the calling session's id;
  - a `feature_background` tool that starts a run in its own background session and routes gate answers to
    it.
- **The CLI plugin** (`./tui`) adds a run list to the session sidebar, and a palette command per run that
  jumps to the session driving it. It reads run state from disk and never writes it.

Every run state change goes through the `factory` CLI that ships with the pinned `feature-factory`.

## Install

```sh
npm i -g opencode2-feature-factory
```

Then list it in your OpenCode configuration: the server plugin in `opencode.json(c)`, and the CLI plugin in
`cli.json`:

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["opencode2-feature-factory"] }
```

```jsonc
// ~/.config/opencode/cli.json
{ "plugins": ["opencode2-feature-factory"] }
```

A configured plugin *path* has to be a directory, and for a directory OpenCode loads `server.js` or
`index.js` from that directory rather than the package's `exports`. To load an unpublished checkout, point
the server entry at its `plugin/` directory.

## Use

```text
/feature [--background] [--autonomous | --headless] <ticket key | feature idea>
```

## Agents and permissions

The agents are registered in memory, as in the 1.x adapter. OpenCode 2.0's agent editor has no `add`, but
`update` on an id the host doesn't hold creates the agent. The plugin checks after setup that every agent
exists, and refuses to load if one doesn't, so a host that changes that behavior fails loudly instead of
running without specialists.

Each agent's `permissions` are derived from what it declares, and a project can't override them:

- A specialist can edit only if it declares `Edit` or `Write`, so `work-reviewer` and
  `implementation-validator` can't change the code they judge.
- No specialist can dispatch a subagent.
- No agent can read outside the workspace (`external_directory: deny`).
- The two drivers can dispatch exactly the eleven specialists. OpenCode 2.0 enforces that list, because a
  `subagent` rule's resource is the target agent's id.

The plugin's `profiles` and `profile` options set models, as in the 1.x adapter:

```jsonc
{
  "plugins": [{
    "package": "opencode2-feature-factory",
    "options": { "profiles": { "builder": { "model": "anthropic/claude-sonnet-5", "variant": "high" } } }
  }]
}
```

A project's own definition of an agent keeps its `model` and `system` prompt. The CLI binding is always
re-appended to the prompt.
