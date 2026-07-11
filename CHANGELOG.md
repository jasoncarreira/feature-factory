# Changelog

> **Status:** This is the current repository-only verified change record.

## 0.2.0

- Provides the `/feature` server-plugin workflow with one primary `feature-factory` agent, 12 specialized subagents, and the packaged feature skill.
- Exposes package root and `/server` from `src/plugin.js`, `/tui` from generated `dist/tui.js`, `/cli` from `src/cli.js`, and the `feature-factory` bin.
- Includes install, doctor, and factory CLI surfaces plus the separately importable TUI registration object.
