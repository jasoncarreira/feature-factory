# Changelog

Repository-only change record. All three packages are pre-1.0 and, from 0.7.0, release in lockstep: one
version across the workspace, with each adapter pinning the exact factory version it ships beside.

## 0.7.3

One change, and it stops a field from depending on how a driver spelled a flag.

- **`factory init` accepts `--issue-key` as an alias for `--issue`.** `issue_key` is the field name every
  reader of `run.json` and `status --json` sees, so it is the spelling a caller reaches for first. mimir 1606's
  driver ran `init "1606" --issue-key "1606"`, got `unknown option '--issue-key' for 'init'`, and recovered by
  dropping the flag rather than trying the other spelling. That run then read issue 1606 for real, built a
  correct story, merged four slices on first attempt and opened a correct PR — while recording
  `issue_key: null` throughout. Since an absent key is deliberately exempt from the title prefix, body prefix
  and `Closes #<key>` line, the linkage the key exists to produce was silently forfeited, and whether it
  appears at all came down to a spelling the caller could not see. Consumers should still treat `run_id` as
  identity and `issue_key` as optional enrichment.
- **Two spellings that disagree refuse** rather than one winning: the key is appended as `Closes #<key>`, so a
  silent preference would close a stranger's issue. That one line is enforcement and says so in place; the
  alias itself is neither a guard nor instruction, just an accepted input spelling.

Production source lands at 4550 lines, **exactly on the tripwire**. No authorization was required and none
remains: the next production line in `packages/feature-factory` needs an operator-authorized raise recorded in
the issue body before the run.

## 0.7.2

One change, and it removes the last reason a run needed `--auto`.

- **`factory init` stages the canonical workflow into the run directory** and returns its path as `workflow`.
  Every factory agent denies `external_directory` (0.7.1), and the canonical `WORKFLOW.md` ships inside the
  adapter package, which is never inside the workspace — so the read the skill *mandates* was the read the
  guard *refused*, and whether a run survived depended on whether the skill loader happened to inline the
  file. Two runs died with "the authoritative feature/WORKFLOW.md could not be read"; others survived only
  because their denial landed somewhere harmless.

  The narrow permission fix is not expressible: a `*` rule outranks a path rule, and omitting `*` leaves
  every other path at `ask`, which a headless run cannot answer and which `--auto` silently approves. So the
  deny stays absolute and the read moves inside the workspace. `.factory/` is gitignored by every consuming
  repository, so nothing dirties the tree.

  Staging runs **before** manifest publication, so a failure aborts init while a retry is still possible
  rather than leaving a published run that can never be re-initialized, and it goes through the protected
  no-follow atomic writer with the staged bytes verified against canonical.

  **Contract change:** the canonical workflow now states where the driver reads it from. A host whose agents
  may read outside the workspace may read the copy beside its skill; a host that denies such reads must use
  the staged copy, which is read after `init` rather than before it — admission and the `init` invocation are
  specified by the host `SKILL.md`. The bytes are identical either way. The OpenCode adapter uses the staged
  copy; Prime keeps its adjacent read. (#322)

## 0.7.1

Six merged changes, all of them earned by self-hosted runs against a real repository. Two are production
guards; the rest tighten contracts that a run had already misread.

- **`observe` refuses a `test_plan` entry it cannot execute, and `WORKFLOW.md` now says what shape works.**
  A ratified entry is executed as argv split on single spaces with **no shell**, so a shell operator, a
  quote that groups an argument across a space, a substitution, or a redirection is inert payload or a hard
  failure rather than syntax. A run ratified `uv run python -c "import subprocess; ..."` wrapping 33
  commands; `python -c` received `"import` as its whole program, and the slice could never be observed
  green. Entries are also **alternatives, not a sequence** — any one exiting zero satisfies observation — so
  a slice needing several commands in order names one script. (#319)

- **`argv[0]` is resolved when the plan is seeded**, before any slice has implemented anything, so a script
  the work itself creates cannot be `argv[0]`. Name an interpreter that already resolves and pass the script
  as an argument: `sh scripts/verify-all.sh`. A decomposer spent an attempt discovering this. (#320)

- **Every factory agent denies `external_directory`.** It ships as `{"*": "ask"}`, and a headless
  `opencode run` has nobody to answer an ask: one run stopped mid-step for an hour while `work-reviewer`
  waited on a path under `node_modules/feature-factory`. `--auto` cannot approve an explicit deny, and the
  deny survives a project-level override. **This is a behaviour change**: an agent that previously read
  outside the workspace after a prompt is now refused, which is the point — reading an installed copy of the
  package proves what shipped, not what the run is changing. (#318)

- **Archiving an archive has nothing to preserve, so no archive is written.** A live run reported an archive
  path back as `--review-ref`, the attempt suffix was appended twice, and
  `spec-writer.attempt-1.attempt-1.json` landed beside the real archive with identical bytes. (#316)

- **`OPERATING.md` documents both unattended-run permission guards** — pre-deny the prompt and pass
  `--auto` — and records that progress is judged by `run.json`'s `updated_at` rather than by CPU. (#317)

- **`OPERATING.md` says precisely which Prime sessions cannot be stopped, and how to start one that can.** A
  `-p` launched session outlives its launcher and only `shutdown --force` ends it; a session created through
  the daemon is listable and stoppable. (#314)

## 0.7.0 — three-package architecture

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
