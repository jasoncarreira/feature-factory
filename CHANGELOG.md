# Changelog

Repository-only change record. All three packages are pre-1.0 and, from 0.7.0, release in lockstep: one
version across the workspace, with each adapter pinning the exact factory version it ships beside.

## 0.8.3

0.8.2 required a parked control-plane snapshot and it did not happen on the first real park. This makes the
requirement reachable and its absence visible.

- **The parked stop is now one numbered, ordered sequence** — enter the park, publish the snapshot, report —
  and the eleven one-line rules that say a run parks enter *that*, rather than each restating steps. 0.8.2
  appended the snapshot to the shared park semantics as a sentence; a driver walking a step list never
  reached it. mimir chainlink 1521 parked on a slice ownership omission while verifiably running 0.8.2 — the
  version pin fails closed — and no snapshot was written. The contract also now says what a partial park
  leaves behind: an unreported park with no recovery evidence.
- **`status` reports `park_snapshot` for a parked run**: the published path, or `null`. It answers whether a
  complete publication exists for the *current* control plane. Completeness is inventory equality over the
  whole plane — relative path, type, size for regular files, target for symlinks, sorted — which is the
  property the publication contract already defines. Currency is the manifest compared by bytes, because an
  earlier park's `updated_at` is the same length as this one's and size alone would call a stale snapshot
  current. Sizes rather than hashes for everything else: `status` is polled continuously and the plane
  carries a 143 KB workflow copy, and the failure mode is a driver that did not finish rather than a forged
  snapshot. Every path component is `lstat`ed and never followed, since `lstat` on the final entry still
  follows intermediate symlinks. Computed at read time, so there is no stored key to keep truthful. The copy
  itself remains a driver step, because this CLI is forbidden copy and delete primitives.
  Two earlier versions were false greens of their own, both caught in review. "Does the pathname exist"
  reported a snapshot from an earlier park as this park's evidence. Matching only `run.json` proved one file
  was copied after the current terminalization, not that publication finished — a driver that created the
  directory and copied that file first, or an interrupted copy, still read as published.
  `null` therefore covers a snapshot left by an earlier park, an incomplete or altered tree, a file or
  symlink at the canonical path, and a symlinked parent component. Publishing again is what makes it
  correspond.
- **Observability rather than enforcement.** It cannot make the snapshot happen; it makes a missing one a
  fact a controller can act on. That is the property that made the 0.8.0 publishing-identity work land, and
  prose alone has now failed twice in this same place — 0.7.5's environment override was the first, this the
  second. Both failures were silent, which is the part worth fixing.

Production source moves 4584 → 4599, and the tripwire 4600 → 4650 using the authorization given during the
0.8.2 discussion for this feature area, which went unused then because that implementation turned out to be
prose.

## 0.8.2

One change: a parked run's control plane is no longer destroyed with its sandbox.

- **A `needs-human` terminalization is now followed by a control-plane snapshot** to
  `$O/.factory/.parked/$R`, performed by the driver immediately after the park is recorded. The completed
  handoff is the only thing that archives a control plane and it is entered only for `completed`, so
  `needs-human` — the state that by definition waits for outside intervention — was the one state with no
  durable copy. mimir chainlink 1521 lost an accepted 44.8 KB brief, a ratified ten-slice plan and four
  review verdicts when a controller misread a correct lock refusal as a failure and swept a parked sandbox.
  What survived was salvaged from opencode's session database rather than from the factory, which is the
  wrong way round.
- **It is required by the shared park definition, not by a late subsection.** The requirement sits between
  entering the parked stop and reporting it, in `## Operating modes` where every mode's park semantics are
  defined, and a park is not reported until the snapshot is published or its failure recorded. A first
  attempt placed the mechanics inside `## Step 7`, whose entry conditions are post-draft-PR and whose first
  transition is `completed` — so no park path reached it. Prose nobody reaches is worse than none, because
  it reads as coverage. Caught in review.
- **Publication has exactly one commit point**, and every failure rule is stated relative to it: preflight,
  stage to `.staging-$R`, verify source and destination inventories exactly as the completed archive
  requires, then commit by renaming the verified tree onto the canonical path. Before that rename no
  publication has occurred and a failure restores the untouched previous snapshot; after it the published
  snapshot is authoritative and never rolled back, so a failure to remove `.prior-$R` is a reported cleanup
  warning and a later park clears that residual at preflight.
  Two review rounds shaped this. The first attempt said the snapshot "replaces its own prior snapshot",
  permitting delete-then-copy, so a failed second park would erase the last known-good evidence. The staged
  version then still contradicted itself: once staging is renamed onto the canonical path the old snapshot
  *is* `.prior-$R`, so "leave the previous snapshot exactly as it was" and "remove this procedure's prior
  path" were mutually impossible, and a partial removal could not be undone. Naming the rename as the commit
  point is what closes it. Neither `.staging-$R` nor `.prior-$R` can be a run id, so neither is ever a
  manifest candidate.
- **Three properties make it safe at a park rather than only at completion**, and all three are stated in
  the contract: `.parked` cannot be a run id, so a snapshot never occupies the completed archive at
  `$O/.factory/$R` and never becomes a manifest candidate blocking a relaunch; it never touches the sandbox,
  so removal stays the completed handoff's guarded step alone; and a snapshot failure is reported without
  preventing the park, because refusing to park would leave `status: running` with nothing alive.
- **A snapshot is evidence for recovery, not a resumable run.** Resume still operates on the sandbox
  manifest. `blocked` and `partial` are not snapshotted — neither is resumable, so the case there is
  diagnosis rather than recovery.

**Instruction rather than code, and not by preference.** This was first built as ~29 production lines in
`factory terminal` using `cpSync` and `rmSync`, and the suite rejected it: this CLI is forbidden copy and
delete primitives, and archiving is a driver step by design — the completed archive beside it is prose too.
An operator-authorized ceiling raise to 4650 was available and went unused. Production stays at **4584** and
the tripwire stays at **4600**.

## 0.8.1

One change, in the OpenCode adapter, and it unblocks configured resolvers there entirely.

- **The OpenCode `SKILL.md` now specifies the repository resolver intake, before any run-id allocation.**
  The resolver must run before `factory init`, but since 0.7.2 `init` is what *stages* the canonical
  workflow — so a driver that read the workflow first could never learn the rule in time. The skill also
  claimed "admission and the `init` invocation are specified here", which was untrue: admission includes the
  resolver, and the resolver lived only in the staged workflow. mimir chainlink 1521 is what that costs — the
  driver initialized from the literal reference `chainlink-1521`, read the staged workflow afterwards, and
  `story-reader` received a bare key instead of the rendered title and body the repository resolver had ready
  in `MIMIR_WORK_ITEM_JSON`.
- **The whole canonical pre-init region is restated, not a summary of it.** It begins where the canonical
  workflow derives the operator repository root `O` from `INVOCATION_CHECKOUT` and
  `git rev-parse --show-toplevel`, and requires an absolute nonempty `O` — without which there is no path to
  `$O/.factory.json` and no cwd for `resolve`. It then covers the config schema,
  the closed key set, required entries and their types, first-defect validation order, and the exact
  malformed-config refusals. The first attempt began at "With a valid present file", which is circular: the
  only definition of a valid `.factory.json` lived in the document the driver cannot read until `init` stages
  it, so a pre-init driver could not decide whether a resolver was declared at all. Caught in review.
- **The copy is bound to the canonical text as a region, not as selected sentences.** The region is located by
  its headings and compared whole on whitespace-normalized text, so the files may wrap differently and cannot
  disagree. A subset binding cannot fail for an omission, which is precisely the defect it should catch.
- **The adapter's opening is now an explicit four-step order**: admission, repository resolver intake,
  `factory init`, then read the staged workflow. It previously said to read the staged workflow "before any
  state read", which forbade the pre-init intake it also required — a contradiction a driver resolves by
  initializing first, which is the original defect. The intake's own reads and command executions are
  exempted in place, because they are what that step is.
- **Step 2 names its executable subset, and the region's post-init constraints are excluded from it.**
  Copying the region whole is what protects it from drift, but the region also carries the
  publishing-identity rules — which `factory init` itself resolves and records, and which the driver binds
  from `status --json`. Declaring the whole region "before every `factory` command including `init`" made
  those impossible. Step 2 is now exactly: derive and validate `O`, validate `.factory.json`, run `resolve`,
  validate the payload, bind `R`.
- **The test pins ordering, not presence.** A story containing the body would also be consistent with
  resolving *after* `init`, which is not the contract and is not what failed.

Verified in a live run before shipping: with the rule restated, the driver read `.factory.json`, executed the
resolver before `init`, and the run advanced with the real work item as its story.

**Prime is unaffected and needs nothing.** Its skill already reads the adjacent canonical `WORKFLOW.md` in
full before inspecting intake or running any `factory` command, because Prime agents may read outside the
workspace. The gap is specific to a host that denies `external_directory` and therefore depends on staging.

No production lines change; the factory CLI, its schema, and the canonical workflow are untouched.

## 0.8.0

**Breaking.** `publishing_identity` is removed from `.factory.json` and resolved by the CLI instead. A
config file still carrying the key is malformed, because the optional property set is closed — so this
version and the edit that removes the key must land together.

- **`factory init` resolves the publishing identity from `--publishing-identity <account>` or the inherited
  `FACTORY_PUBLISHING_IDENTITY`,** records it immutably in `run.json`, and `status --json` reports it as
  `publishing_identity`. The flag wins over the environment. The account a run publishes as is a property of
  the environment it runs in, not of the repository, and a tracked file cannot hold two values for one
  repository published from both a maintainer's checkout and an automated host.
- **Absence refuses.** No flag and no environment value means no sandbox and no run. A forgotten value stops
  the run rather than letting it publish under whatever credential the host happens to carry. There is no
  checked-in fallback, by choice: a fallback only helps when the override works, and it can also mask a
  missing one.
- **It is now observable.** Because the value is recorded and reported, a supervising controller can verify
  what a run will publish as before trusting it, instead of discovering a mismatch at the first guard.
- The comparison against `gh api /user` remains driver-executed instruction, unchanged. It was resolution
  that was unreliable, not the comparison.

**Why this replaces 0.7.5.** That release expressed the same intent as contract text: an environment
override the driver was told to prefer. The driver never looked. `FACTORY_PUBLISHING_IDENTITY` reached the
child's shell — proven by a resolver short-circuiting on a sibling variable injected the same way — and the
run's stderr contained no reference to it. A new instruction in a 143 KB contract is a compliance ask, and
the surrounding mechanism working as instruction did not make an addition to it safe. Same intent, expressed
as code.

**Migration.** Remove `publishing_identity` from `.factory.json`, then supply the value per environment:
`export FACTORY_PUBLISHING_IDENTITY=<account>` for a hand-run checkout, and the same variable in the image or
dispatched environment for an automated host. Consumers pinning an exact factory version must move that pin
in the same change as the deployment that installs 0.8.0, since a version-mismatch probe that fails closed
will otherwise refuse every dispatch.

Production source moves 4557 → 4574, and the tripwire 4550 → 4600 by operator authorization recorded before
the work. `run.json` gains its twenty-third key.

## 0.7.5

Documentation only. No production lines, no CLI behaviour change beyond what the contract now permits.

- **`FACTORY_PUBLISHING_IDENTITY` overrides `.factory.json`'s `publishing_identity` per environment.** The
  whole publishing-identity mechanism is contract text the driver executes — there are no references to
  `publishing_identity` anywhere in `bin/`, `core/`, or `state/` — so permitting an environment override is a
  change to `WORKFLOW.md` and the operator docs, not to the CLI. A nonempty inherited value replaces the file
  value exactly as inherited; an absent or zero-length one leaves the file value in force.
- **Why it is an override and not a replacement.** One repository may be published from a maintainer's own
  checkout and from an automated host, needing different accounts, while `.factory.json` is tracked and holds
  one value. Removing the key is not an option: it is one of four required properties, so the file would be
  invalid and every run would refuse. Making it optional and omitting it would be worse — an absent
  declaration disables the guard, and a forgotten variable would then publish under whatever credential the
  environment happened to carry. Keeping the file value as the fallback is what turns a forgotten override
  into a park, with both values named, before publication.
- **The value must never be derived from the credential being checked.** Reading it from `gh`, the token,
  stored authentication, Git configuration, or any command result would make the comparison circular: it
  would always match, and the guard would silently stop guarding.

`OPERATING.md` gains a *Publishing one repository as two identities* recipe, and both adapter `WORKFLOW.md`
copies were regenerated by `sync:workflow` so all three remain byte-identical.

## 0.7.4

One change, and it closes a false green the contract only ever instructed against.

- **`factory terminal <run-id> completed` now requires a recorded `pr_url`.** `completed` is the only terminal
  status that asserts a run earned a result, but the ordering that gave it meaning — publish, then terminalize
  with reason `draft-pr-recorded` — lived in `WORKFLOW.md` alone. `terminal` checked three things: that the
  status was a known terminal value, that `--reason` was present, and that the run was not parked. It never
  consulted `slices`, `pr_url`, or evidence, and `assertPublicationReady` was wired only into the `pr` and
  `effective-push` paths. So a driver that skipped the work could record success, and the CLI reported it
  faithfully. mimir 1483 is what that looks like from outside: a ~70-second run with no commits, no pushed
  branch and no PR reported `completed`, and a controller binding on `status == "completed"` read a do-nothing
  run as a shipped epic. Use `blocked` when nothing merged, or `partial` when some slices did; both stay
  unguarded because they claim less.

Consumers should still not treat `status` as sole proof of work: verify the PR's repository, base and head sha
independently, and require at least one `:merged(` entry in `slices`. This guard removes a way to lie, not the
reason to check.

Production source moves 4550 → 4557, and the tripwire 4550 → 4560 by operator authorization recorded before the
work. The two other `completed` terminalizations in the cleanup path re-terminalize an already-published run, so
their `pr_url` is set and the guard does not reach them.

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
