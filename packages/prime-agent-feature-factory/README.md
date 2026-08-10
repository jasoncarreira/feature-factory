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

## Specialist model and thinking level

Every agent file in `feature-factory` declares `model`, `role`, and `effort` in its frontmatter, and the
OpenCode adapter treats the three differently: `role` selects a configured profile, `effort` becomes the
default `variant`, and the declared `model` is **ignored** — an OpenCode agent's model comes from profile
configuration, because `sonnet` is a tier rather than a model id. **This adapter consumes none of the
three.** On Prime, all eleven specialists run with the parent session's model and thinking level.

That follows from Prime's spawn contract rather than being an oversight. `rlm.run` accepts exactly two
options — `name` and `model` — and unknown keyword arguments fail the spawn instead of being ignored, so
an `effort` or `thinking` argument would stop the child starting rather than go unused. A child inherits
the parent model when `model` is omitted, and inherits the global `defaultThinkingLevel` either way.

`model` is deliberately not passed even though Prime supports it. Selection is fail-closed: an unavailable
model fails admission rather than falling back to another one. Under a subscription OAuth login
(PrimeIntellect-ai/prime-agent#740) `rlm.find_models()` returns nothing and an explicit `model=` fails
admission for every model except the parent's, so passing a selector there would stop specialists spawning
at all — worse than running them all on one tier. Pre-validating a selector does not avoid this either:
`find_models()` returns an alphabetical head slice that reads as the full reachable set (#799), so it
rejects models that are in fact reachable.

**The parent session is therefore the only lever.** `work-decomposer` and `work-reviewer` declare `opus`
and decide whether a plan is satisfiable and whether a build is accepted; on Prime they inherit whatever
the run was launched with. Choose the parent model and `defaultThinkingLevel` with that in mind.

Upstream requests that would change this: per-child thinking level (#703), a persistent
`subagents.defaultModel` policy (#921), and virtual model selectors (#1138). If they land, what this
adapter needs is mostly configuration rather than code.

## Development

From this package directory:

```sh
npm test
npm pack --dry-run
```

## License

MIT
