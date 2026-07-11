# Contributing

> **Status:** This is the current repository-only contributor guide. It is not included in the published npm package.

## Node.js and setup

The package supports Node.js `>=20`. Repository tooling pins Node.js `24.11.1` in `.tool-versions`, so use that version for local development when possible. CI verifies Node.js 22 and 24; Node.js 20 is supported but is not part of the CI matrix.

Install the exact locked dependencies before running checks:

```sh
npm ci
```

## Deterministic checks

Run the focused checks in this order while developing:

```sh
npm run test:unit
npm run smoke:pack
```

Before submitting a change, run the aggregate gate:

```sh
npm run check
```

`npm run check` runs `npm run test:unit` first and `npm run smoke:pack` second. The repository does not currently define a lint or typecheck script.

The package smoke test packs the project, which invokes `prepack` and generates `dist/tui.js` from `src/tui.jsx`. `dist/tui.js` is generated output: do not edit it, stage it, or commit it. It is ignored by Git and may be removed after local checks.

## Machine-dependent diagnostics

`npm run doctor:local` checks the local checkout and depends on the developer's machine and opencode installation. Provider smoke is also machine-dependent: `node src/cli.js doctor --provider-smoke` makes real `opencode run` calls using configured models and credentials, and may consume quota or incur cost. These diagnostics are useful for local investigation but are not deterministic unit, package-smoke, CI, or release gates.
