# Releasing

Repository-only guide. The GitHub publish workflow is the source of automation behaviour.

## Two packages, versioned independently

The workspace root is private and publishes nothing. `packages/feature-factory` and
`packages/opencode-feature-factory` publish separately and carry their own versions, so a release
tag has to name its package:

```
feature-factory-v0.1.0
opencode-feature-factory-v0.3.0
```

A bare `v1.2.3` tag no longer starts the workflow. It used to read the root manifest's version,
which no longer exists.

## Sequence

Pushing a matching tag runs `.github/workflows/publish.yml`, which:

1. Checks out the tag, selects Node.js 24, `npm ci`.
2. Resolves the package from the tag prefix — longest first, because
   `opencode-feature-factory-v…` also ends with `feature-factory-v…`, and testing the shorter name
   first would publish the wrong package under the right tag.
3. Verifies the resolved package's manifest name and that its version exactly equals the tag's.
4. Runs `npm test --workspaces`, then `npm test --workspace feature-factory` on its own.
5. `npm publish --workspace <resolved package>`.

## Before tagging

- Bump the version in that package's `package.json` and commit it, along with `package-lock.json`.
- If you bumped `feature-factory`, also bump the pin in `packages/opencode-feature-factory`'s
  `dependencies`. The boundary test asserts the pin equals the factory's version exactly, so a
  mismatch fails before publish rather than shipping an integration built against another version.
- Update `CHANGELOG.md`.
- Confirm the tag points at the commit you mean.

The workflow does not bump versions, write the changelog, or create tags.
