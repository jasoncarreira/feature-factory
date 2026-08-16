# Changelog

Repository-only change record. All three packages are pre-1.0 and, from 0.7.0, release in lockstep: one
version across the workspace, with each adapter pinning the exact factory version it ships beside.

## Unreleased — three-package architecture

- **One version across the workspace, from 0.7.0.** `feature-factory`, `opencode-feature-factory` and
  `prime-agent-feature-factory` previously drifted at 0.3.6, 0.5.6 and 0.1.0, which made "which versions
  work together" a question nothing answered. They now move together, and both adapters pin the exact
  factory version they ship beside. `test/pack.test.js` fails when only some manifests were edited,
  because a half-applied bump publishes an adapter that cannot resolve its dependency.

- **`feature-factory` owns the host-agnostic contract.** It now ships the `factory` CLI, specialist
  definitions, and canonical `WORKFLOW.md`, but no platform `SKILL.md`.
- **Each adapter owns its host binding.** `opencode-feature-factory` and
  `prime-agent-feature-factory` each ship their own `skills/feature/SKILL.md` plus an exact build-time
  copy of the factory workflow beside it.
- **Prime Agent is now a distinct adapter.** Install it with
  `prime-agent package install npm:prime-agent-feature-factory`. It currently supports foreground
  runs only and refuses `--background` before creating or changing a run.

### Earlier rebuild baseline

The implementation had previously been replaced rather than refactored. The predecessor tree was
43,013 lines of production source with 2,322 tests; the deleted code remains in git history.

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
  canonical workflow, or install the adapter for the target host. Release tags now name their
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
