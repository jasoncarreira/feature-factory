# Changelog

Repository-only change record. Both packages are pre-1.0 and version independently.

## Unreleased — the rebuild

The implementation was replaced rather than refactored. The previous tree was 43,013 lines of
production source with 2,322 tests; the two packages together are ~2,900 lines with 99 tests, and
the deleted code remains in git history.

- **`feature-factory` 0.1.0** (new, replaces `opencode-feature-factory` 0.2.1's CLI): twelve
  commands, each state change one checked transition. Ships the `/feature` skill and eleven agent
  definitions. Zero dependencies.
- **`opencode-feature-factory` 0.3.0** (now integration only): server plugin and sidebar. Reads run
  state and cannot write it, asserted structurally rather than by convention.
- **Dropped as non-goals, not deferrals:** post-PR remediation, continuation and checkpoint runs,
  integration amendments, the steering machine, cost attribution, delivery envelopes, dispatch
  claim/closure, nonces and hash chains, the reviewer panel, the security-reviewer stage. The
  ceiling test fails if any reappears, including as prose in an agent prompt.
- **Breaking:** the repository root no longer publishes. Install `feature-factory` for the CLI and
  skill, `opencode-feature-factory` for the opencode integration. Release tags now name their
  package.

## 0.2.1 and earlier

The predecessor's history. See git history before the rebuild for detail; those entries describe
subsystems that no longer exist.
