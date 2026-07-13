# Changelog

> **Status:** This is the current repository-only verified change record.

## 0.2.1

- Fixes repository cleanup to authorize immutable snapshots of the current canonical base head and revalidate remote authority at every mutation boundary.
- Restores validated descriptive run names in CLI and TUI output while continuing to redact credentials, opaque tokens, invalid identifiers, and identity mismatches.

## 0.2.0

- Provides the `/feature` server-plugin workflow with one primary `feature-factory` agent, 12 specialized subagents, and the packaged feature skill.
- Exposes package root and `/server` from `src/plugin.js`, `/tui` from generated `dist/tui.js`, `/cli` from `src/cli.js`, and the `feature-factory` bin.
- Includes install, doctor, and factory CLI surfaces plus the separately importable TUI registration object.
