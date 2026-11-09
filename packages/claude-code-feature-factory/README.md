# claude-code-feature-factory

Claude Code plugin for [`feature-factory`](https://www.npmjs.com/package/feature-factory). It ships the
`feature` skill, the eleven specialist subagents and the factory CLI itself, and preserves the factory's
canonical workflow and CLI-owned durable state.

Requires Claude Code with plugin support, Node.js 22 or newer, and git.

## Install

From the marketplace in this repository:

```text
/plugin marketplace add jasoncarreira/feature-factory
/plugin install feature-factory@feature-factory
```

The marketplace entry fetches this package from npm at the version it names. Or install the package and
load it yourself:

```sh
npm install -g claude-code-feature-factory
claude --plugin-dir "$(npm root -g)/claude-code-feature-factory"
```

The plugin carries its own copy of the factory CLI under `vendor/feature-factory`, byte for byte what
`feature-factory` publishes at the same version, so it needs no other install and the two cannot drift
apart. Claude Code installs a plugin's npm dependencies only from a lockfile shipped beside its manifest,
which npm never publishes, so a dependency would have left a marketplace install without its CLI.

## Use

Interactively:

```text
/feature-factory:feature [--autonomous | --headless] <ticket key | feature idea>
```

Unattended, use the launcher:

```sh
node "$(npm root -g)/claude-code-feature-factory/launcher/launch.js" --cwd <repo> -- --autonomous <issue-number>
```

It starts `claude -p` detached in its own process group, so the run outlives the launcher and its shell,
with the stream-JSON transcript going to a log file, and prints one line:

```json
{"sessionId":"…","pid":12345,"log":"/tmp/feature-factory-….jsonl","cwd":"…","stop":"kill -TERM -- -12345"}
```

`--model` sets the driver's model and `--log` the transcript path. The run needs the `GH_TOKEN` and
`FACTORY_PUBLISHING_IDENTITY` its verify and publish commands use in the launcher's environment.

The launcher isolates the run from your own Claude Code configuration, and each flag closes a trap found
by trying it:

- `--setting-sources project`: without it a `-p` run inherits your user permission settings, so a tool
  nobody allowed for the run can run anyway.
- `--strict-mcp-config`: without it your MCP connectors and their instructions reach every subagent. The
  servers `.factory.json` names in `mcp_servers` are passed back from the repository's `.mcp.json` with
  `--mcp-config` and allowed, and the launcher prints them as `mcp_servers`. An entry that matches no
  `.mcp.json` server, or a missing or unreadable `.mcp.json`, is printed as `mcp_warnings` and on stderr:
  the run still starts, but its dispatch prompts would name a server it does not have.
- `--permission-prompts none`: anything not allowed is denied at once rather than waiting for an answer
  nobody will give. A run never hangs on a prompt; a denial shows in the transcript.
- `--permission-mode acceptEdits` with `Agent`, `Bash`, `Edit`, `Glob`, `Grep`, `Read`, `TodoWrite` and
  `Write` allowed. Bash is unrestricted because a run's verify, test and publish commands are the
  repository's own.

## How it binds

- **Session identity:** the skill reads `${CLAUDE_SESSION_ID}`, which Claude Code substitutes when the
  skill loads. It survives compaction and `claude --resume`, so `SESSION_ID` is
  `claude-code:<session id>`.
- **Specialists:** each is a plugin subagent, `feature-factory:<name>`, dispatched with the Agent tool in
  the foreground, so the driver holds every result before it reconciles. A parallel wave is several Agent
  calls in one message.
- **Specialists inherit tools minus a denylist; read-only is instructed.** `npm run vendor` rewrites each
  shared agent file's `tools:` allowlist as `disallowedTools:`, because an allowlist also hides every MCP
  server. A specialist inherits the session's tools, the project's MCP servers included, and is denied the
  Agent tool, every Claude Code session tool its role was not given, and Edit, Write or Bash where the shared
  file withholds them. So the reviewer and validator have no Edit or Write tool, but keep Bash for tests and
  their report artifacts: that they edit no code is the workflow's instruction rather than a sandbox. The
  Agent denial is what keeps delegation one level deep: Claude Code otherwise lets a subagent spawn its own.
  Wildcards are not honoured in the list, so a Claude Code release that adds a session tool reaches the
  specialists until `scripts/agent-tools.js` names it.
- **Model and effort** come from each subagent's frontmatter. `model: sonnet` and `model: opus` are family
  names that Claude Code resolves to that family's current model, so a new model reaches every run with no
  release. `ANTHROPIC_DEFAULT_OPUS_MODEL` and its `SONNET` and `HAIKU` counterparts pin a version.

## Development

From this package directory:

```sh
npm test            # refreshes skills/feature/WORKFLOW.md, agents/ and vendor/ first
claude --plugin-dir .
```

`agents/` and `vendor/` are generated from `packages/feature-factory` by `scripts/vendor.js` on `pretest`
and `prepack`, and are not committed.

## License

MIT
