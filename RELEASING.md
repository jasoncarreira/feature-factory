# Releasing

> **Status:** This is the current repository-only release guide. The GitHub publish workflow is the source of automation behavior.

## Publish trigger and sequence

Publishing starts only when a tag matching `v*` is pushed. The tag must exactly equal `v<version>`, where `<version>` is the `version` in `package.json` (for package version `0.2.0`, the matching tag is `v0.2.0`). A non-matching `v*` tag starts the workflow but fails the exact tag/version guard before checks or publication.

The publish job then performs this sequence:

1. Checks out the pushed tag.
2. Selects Node.js 24 and configures the npm registry.
3. Runs `npm ci`.
4. Verifies that `GITHUB_REF_NAME` exactly equals `v${package.json.version}`.
5. Runs `npm run check`.
6. Runs `npm publish`.

The job uses the GitHub Actions `npm` environment and grants `id-token: write` for npm trusted publishing. It also has read-only repository-content permission.

## Maintainer responsibilities

Before pushing the tag, a maintainer must update and commit `package.json` and `package-lock.json` as needed, maintain this changelog, and create and push the matching tag. Confirm that the intended commit is the one referenced by the tag.

The workflow does **not**:

- publish from a branch or support manual dispatch;
- choose or bump the package version;
- update the changelog;
- create or push commits or tags; or
- create a GitHub Release.
