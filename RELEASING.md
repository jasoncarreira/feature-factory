# Releasing

Repository-only guide. The GitHub publish workflow is the source of automation behaviour.

## Three packages, one version

The workspace root is private and publishes nothing. `packages/feature-factory`,
`packages/opencode-feature-factory`, and `packages/prime-agent-feature-factory` publish separately, but from
0.7.0 they carry **the same version** and move together. Each still needs its own tag, because a tag selects
which package the workflow publishes:

```
feature-factory-v0.7.0
opencode-feature-factory-v0.7.0
prime-agent-feature-factory-v0.7.0
```

A bare `v1.2.3` tag no longer starts the workflow. It used to read the root manifest's version,
which no longer exists.

**Tag the factory first and let it publish before tagging either adapter.** Both adapters pin
`feature-factory` at an exact version, so an adapter that reaches the registry first is unresolvable until the
factory follows. `test/pack.test.js` enforces the version agreement in CI; the ordering is on whoever releases.

## Sequence

Pushing a matching tag runs `.github/workflows/publish.yml`, which:

1. Checks out the tag, selects Node.js 24, `npm ci`.
2. Resolves the package from the tag prefix — longest first, because
   both adapter tag prefixes also end with `feature-factory-v…`, and testing the shorter name first
   would publish the wrong package under the right tag.
3. Verifies the resolved package's manifest name and that its version exactly equals the tag's.
4. Runs `npm test`, then `npm test --workspace feature-factory` on its own.
5. `npm publish --workspace <resolved package>`.

## Publishing credentials

The workflow carries `permissions: id-token: write`, `environment: npm`, and no token: it publishes through
**npm trusted publishing (OIDC)**. That requires a trusted publisher configured for each package on npmjs.com,
naming this repository, this workflow file, and the `npm` environment.

**A package that does not exist on npm yet cannot have one configured**, so its first version has to be
published with a credential. `npm` reports the missing authorization as a 404 on the PUT rather than a 401,
because that endpoint must not reveal which names exist:

```
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/<package>
```

Read that as *not authorized*, never as a name collision — check availability with `npm view <package>`
separately. As of 0.7.0 this had blocked every workflow publish the repository has attempted.

## Before tagging

- Bump the version in **all three** `package.json` files and commit them, along with `package-lock.json`.
- Bump the `feature-factory` pin in both adapter packages' `dependencies` to the same version. Pack and boundary
  tests assert those pins equal the factory's version exactly, so a mismatch fails before publish rather than
  shipping an integration built against another version.
- Update `CHANGELOG.md`.
- Confirm the tag points at the commit you mean.
- Confirm the package exists on npm, or expect to publish that first version by hand.

The workflow does not bump versions, write the changelog, or create tags.

A tag whose publish failed stays valid: fix the cause and re-run that workflow run rather than
deleting and re-pushing the tag, which changes nothing the workflow reads.
