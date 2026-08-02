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

## feature-factory 0.2.2 / opencode-feature-factory 0.4.2

- **`slices-seed` tells the two plan failures apart.** A file whose top level is not an object
  carrying a `slices` array is refused with a message naming the required `{ "slices": [...] }`
  shape; an object whose array is empty keeps the existing content message. One check previously
  covered both, so a bare array full of slices reported that it had none and sent the author
  looking for missing content rather than a missing wrapper. The skill now states the envelope
  where it describes the artifact, `work-reviewer` is directed to check it at the decompose step,
  and two claim-table rows drive both refusals through the real CLI and assert the run manifest is
  byte-identical afterwards. (#175)
- **The scope-lock guardrail is stated by shape rather than by this repository's example.** Its
  illustrations were four of `ceiling.test.js`'s own assertions restated generically; they are now
  limits that recur elsewhere — coverage floors, bundle and performance budgets, maximum file
  length, dependency allowlists, public-API and snapshot tests — and a lock no longer has to be a
  test, since a lint rule or CI threshold constrains scope the same way.
- **`opencode-feature-factory` 0.4.2** carries no source change; it moves only to keep its
  `feature-factory` pin exact, which the boundary test asserts.

## 0.2.1 and earlier

The predecessor's history. See git history before the rebuild for detail; those entries describe
subsystems that no longer exist.
