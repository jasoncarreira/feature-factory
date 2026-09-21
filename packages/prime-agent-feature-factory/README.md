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

Unattended, a run needs two things beyond the invocation, both documented with their reasoning in the
repository's [operator guide](https://github.com/jasoncarreira/feature-factory/blob/main/OPERATING.md):
redirect stdin from `/dev/null`, because an inherited pipe that never reaches EOF blocks the CLI before it
emits a byte and looks exactly like a broken tool; and raise the `--autonomous` limits, because the defaults of
12 turns, 3 continuations, 80,000 tokens and 30 minutes stop a real run mid-flight in a way that looks like a
stall. `-p` alone prints one response and exits, which initializes a run and then abandons it.

The integration currently drives foreground runs only. It rejects `--background` before creating or
changing a run. The extension exposes the current Prime session and installed agent directory through
`feature_factory_context`; the skill uses Prime RLM children for specialist work and requires their reports through agent messaging.

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

Configure them as extension options:

```jsonc
{ "profiles": {
    "planning": { "model": "openai/gpt-5.6-sol", "thinking": "xhigh" },
    "builder":  { "model": "openai/gpt-5.6-sol" },
    "story-reader": { "model": "openai/gpt-5.6-luna", "thinking": "minimal" }
} }
```

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
