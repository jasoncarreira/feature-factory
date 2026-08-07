# prime-agent-feature-factory

Prime Agent integration for [`feature-factory`](https://www.npmjs.com/package/feature-factory).
It adds a `/feature` command and a Prime-specific adapter skill while preserving the factory package's
canonical workflow and CLI-owned durable state.

## Install

```sh
prime-agent package install npm:prime-agent-feature-factory
```

The package manifest exposes its extension and skill through `pi.extensions` and `pi.skills`. Prime
Agent installs the runtime `feature-factory` dependency with it. Node.js 22 or newer is required.

## Use

```text
/feature [--autonomous | --headless] <ticket key | feature idea>
```

The integration currently drives foreground runs only. It rejects `--background` before creating or
changing a run. The extension exposes the current Prime session and installed agent directory through
`feature_factory_context`; the skill uses Prime RLM children for specialist work and requires their reports through agent messaging.

`skills/feature/WORKFLOW.md` is a package-local copy of the factory's canonical workflow. `pretest` and
`prepack` refresh it with the repository sync script so the adapter never relies on a skill loader to
inline another package's resource. The CLI remains the only writer of `run.json`.

## Development

From this package directory:

```sh
npm test
npm pack --dry-run
```

## License

MIT
