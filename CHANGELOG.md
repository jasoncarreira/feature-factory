# Changelog

Repository-only change record. All three packages are pre-1.0 and, from 0.7.0, release in lockstep: one
version across the workspace, with each adapter pinning the exact factory version it ships beside.

## 0.10.7

A patch release that runs the repository verify on every slice before it can merge, and bounds review of
specification subjects.

- `factory observe` for a slice now also runs the configured `.factory.json` `verify` on the slice's commit,
  after the ratified test command, and records `repository_verify` in the evidence (#372). A result that is
  not green makes the slice not `review_ready`, so a lint, format or suite failure is an ordinary rejection
  and retry instead of first appearing after merge, where production repair is forbidden. It runs whenever
  `verify` is configured, including slices with an empty `test_plan`. The command sees
  `FACTORY_VERIFY_SCOPE=slice` (and `integration` after a merge), and its output goes to stderr so
  `observe --json` stays one JSON object. A malformed config now refuses at slice observation. Post-merge
  verify is unchanged. baleyg run 37 parked 1 of 13 slices in on one Clippy `collapsible_if`.
- A mid-run post-merge production defect no longer promises an in-band resume; the reason names preserving
  the branch and starting a fresh run.
- `work-reviewer` bounds specification subjects by their acceptance criteria: missing depth is never
  blocking, added obligation beyond the criteria always is (#371). `spec-writer` gains the matching rule.

All three package manifests and both exact adapter pins move together to 0.10.7.

## 0.10.6

A patch release that binds the issue key a run records.

- The init command has carried `[--issue "$KEY"]` since the Prime adapter landed (#245), but nothing
  bound `KEY`, so a driver following the text omitted the flag and every resolver-named run recorded
  `issue_key: null` (baleyg run 25). Publication reads `issue_key` for the `<key> : ` title prefix and
  the `Closes #<key>` reference, so those PRs lost both. The workflow and the OpenCode skill now bind it:
  a resolver payload gives `KEY = R`, a ticket key gives that key, and a free-text slug gives none.
  Instruction only; no production code changes.

All three package manifests and both exact adapter pins move together to 0.10.6.

## 0.10.5

A patch release that moves the publishing-identity guard into the CLI and lets a project commit its
attempt budget.

- `factory identity <run-id> --json` runs the publishing-identity probe (`gh api --method GET /user
  --jq .login`) itself, with separate stdout and stderr pipes, and returns the already-rendered park
  reason (#365). The workflow's three guard sites call it. The rules are unchanged: no `gh` call without
  a nonempty `GH_TOKEN`, numeric zero, zero-byte stderr, one login plus one LF, exact comparison. Prime's
  `bash` returns stdout and stderr combined, so a compliant Prime driver previously could never observe
  the identity and had to park.
- `.factory.json` accepts an optional positive-integer `max_retries` as the project's default attempt
  budget (#367). `init` uses an explicit `--max-retries` first, then the committed value, then 3. An
  invalid present value is refused.

All three package manifests and both exact adapter pins move together to 0.10.5.

## 0.10.4

A patch release that lets an operator set the run-wide retry limit in one grant (#363).

- `factory grant-retry <run> <slice> --scope all --max-retries N` sets `max_retries` to `N` directly
  instead of raising it by one. `N` must exceed the current limit, and the flag is refused with
  `--scope slice`. Omitted, `all` still raises by one.
- Everything else is unchanged: the named slice must be blocked at its effective limit with its REJECT
  and evidence, only that slice reopens (at N+1), and the snapshot refresh and separate `resume` are
  still required. Later rejections below the new limit retry without another grant.
- Schema replay reconstructs the initial limit from each grant's recorded raise, so manifests with a
  multi-step raise validate on read, restore and status.

All three package manifests and both exact adapter pins move together to 0.10.4.

## 0.10.3

A patch release so evidence whose builder claim disagrees with the observation can be read back (#361).

- `review_ready` was derived twice. The writer forced it `false` on a claim mismatch; `readEvidence`
  recomputed it without that term and refused the stored `false` as self-contradicting. Every consumer
  reads through `readEvidence`, so `slice blocked`, `grant-retry` and merge all refused, and a slice
  with a mismatched claim could never leave `review` (baleyg run 9). The mismatch term now lives in
  `deriveReviewReady`, so writer and reader agree; a mismatched record still cannot be review-ready.
- Builders are told `files_changed` spans everything since the slice's `base_ref`, not the last
  attempt. The observer diffs the whole slice because that is what merges.

All three package manifests and both exact adapter pins move together to 0.10.3.

## 0.10.2

A patch release that makes retry-grant snapshot revocation recoverable across manifest write failure and
process death (#359).

- `grant-retry` now publishes a durable transaction fence before replacing `run.json`. The qualified
  pre-grant snapshot stays canonical until the manifest commits, while the fence prevents stale restore,
  resume, status, or parked mutations from treating it as current recovery authority.
- The transaction reconciles exact before/after manifest hashes and the bound snapshot inventory. A failed
  manifest rename keeps the old snapshot usable; a committed grant revokes it before removing the fence.
  Ambiguous or altered transaction artifacts are preserved and refused rather than guessed or deleted.
- `factory snapshot` recovers both fenced grants and legacy interrupted `.prior-$R` grants under the run
  lock. Fault injection covers manifest rename failure, directory-durability ordering, delayed restore, and process death at the commit seam.

All three package manifests and both exact adapter pins move together to 0.10.2. No release tag is included.

## 0.10.1

A patch release that makes the slice retry budget real instead of caller-optional, gives a supervisor a
way to publish park evidence, and adds an audited operator extension for an exhausted slice (#352, #353, #357).

- A complete slice merit rejection now advances exactly `review@N -> running@(N+1)` before builder
  redispatch. Infrastructure recovery and resume remain on N, approval proceeds only to merge, and a
  rejection at `max_retries` blocks without inventing another attempt. Every slice `blocked` transition
  starts from that fully bound max-attempt review; a ratified-plan conflict parks top-level `needs-human`.
- The CLI enforces the transition against the matching live `REJECT` review, clears stale attempt-bound
  evidence and review refs, refuses wrong-attempt observation before evidence publication, and rejects
  every row above the configured bound.
- A retry preserves the slice's exact immutable `base_ref`. Integration HEAD may move when a same-wave
  sibling merges; that does not rewrite the historical branch point or narrow the owned and reviewed diff.
  Restore also preserves terminal blocked slices instead of reopening them at their exhausted attempt.
- **`factory snapshot <run-id> --repo <operator>` publishes a parked control-plane snapshot.** `factory
  terminal` requires no lock so a supervisor can park a run it is not driving, and `restore` consumes a
  snapshot to rebuild a lost sandbox — but producing one was specified only as driver prose, so an
  out-of-band park was incomplete by construction: step 1 of the three-step park and nothing else, which
  the contract names as the state the sequence exists to prevent. mimir's budget park is that case,
  cancelling the driver and then terminalizing, so its parked runs report `park_snapshot: null` and stay
  recoverable only while their sandbox survives.
- **Publication is verified before it commits, and refuses what `restore` cannot read.** The command
  stages, compares source and destination inventories excluding only the plane-root `factory.lock` and transition lock, then
  commits by rename with rollback. It refuses a run that is not parked, so a live plane cannot be recorded
  as a moment no resume can return to, and it requires `run.json` to be a regular non-symlink file
  resolving to itself — the same rule the restore side applies, so producer and consumer agree on what a
  valid snapshot is rather than each deciding separately. The prose specification is unchanged and remains
  the definition; a driver may run the command instead of copying by hand, and a supervisor must.
- `factory grant-retry` can add exactly one attempt to a parked exhausted slice or raise the run-wide
  default for pending work while reopening only its named slice. It requires the exact owner, complete
  snapshot, clean live branch, bound REJECT and evidence, and immutable attempt archives; the run stays parked.
- Retry grants append immutable provenance, refuse a run-wide raise around another blocked slice or exhausted
  repair journal, and move the pre-grant snapshot away. Publish the changed plane before separate resume;
  restored blocked slices whose physical references were cleared remain ineligible.

All three packages and both exact adapter pins move together to 0.10.1.

## 0.10.0

A minor release: parked control-plane snapshots can now reconstruct a lost sandbox without claiming that
unpublished branch-local work survived.

- **`factory restore` consumes the previously write-only snapshot.** Run it from the canonical operator
  repository with a full remote-tracking feature ref. It reserves the exact derived sandbox, clones the
  repository, restores the recorded feature branch, and publishes `run.json` only after the copy and every
  final binding check succeed.
- **Preserved work is proved, not trusted.** Merged slices retain their status only when their base,
  evidence, review, merge proof, and ancestry all resolve against the restored feature head. Stale
  HEAD-bound validator state is invalidated. Gate 3 and test-verifier state are always invalidated, and canonical verifier records are omitted, because
  publication evidence names the prior physical generation. Restored slice authority is rebound to the
  Brief-approved plan digest and recorded path amendments. Other nonmerged slices reset to
  `pending`, preserving the ratified plan and attempt counts while reporting the loss.
- **A restore is a new physical generation of the same logical run.** It stays parked and lockless, never
  runs repository-configured bootstrap or resumes automatically, omits the snapshot's root `factory.lock`, and
  leaves the source snapshot unchanged. `status.restore` records the source inventory digest, exact feature commit, reset
  slices, and invalidations. `status.park_snapshot` becomes `null` because the transformed generation is
  intentionally not byte-identical to its source.
- **The recovery path fails closed.** Canonical source and destination directories, tracked ignore policy,
  exact effective-push-endpoint remote-ref identity, source/ref stability, contained-symlink preservation,
  escaping-link refusal, inventory equality, Git containment, and create-only manifest publication through
  a held, unreadable target inode are checked around every effect that could otherwise produce a
  partially restored live run.
- **Configured publication is optional and real.** Step 6 selects the exact nonblank inherited override,
  selects the default for a set blank or whitespace override, otherwise selects configured `publish` when
  present, and selects the default when neither source exists. Only the selected nondefault command replaces
  PR creation, after the factory-owned exact push and post-push identity guard. It receives explicit base,
  head, mode, title, and body inputs.
  Indeterminate results park with exact reason `selected publishing command outcome indeterminate; re-observe whether the pull request exists before retry`, without a default fallback or duplicate-PR claim.
- **Post-merge production defects have an explicit operator exit (#342).** The operating guide preserves the
  merged run, names the external-fix and resume sequence, and does not misroute production repair into the
  test-only repair journal.
- **Prime specialist dispatch is live again (#345).** Prime profiles select optional model and thinking values,
  spawn through the supported `rlm.spawn` interface, recover direct children by host identity, and keep
  runtime factory state as the only package dependency.
- **A single-slice run skips only the duplicate validator verdict (#346).** Its integrated diff still receives the
  fresh test-verifier reading that catches cross-cutting production defects before publication.
- **Specialist transport failures preserve the work-attempt budget (#349, #350).** A closed host-origin classifier permits
  one safe same-attempt recovery, never duplicates possibly-started work, and parks repeated or ambiguous
  outcomes through bounded redacted reasons, snapshot publication, and verified unlock.

The production ledger lands at 5192 lines against the issue-authorized 5200 tripwire. Tests extend existing
call sites: one restores a proved merge and its negative control; another restores a lost active slice,
proves root-lock exclusion and source immutability, and then completes the ordinary claim/resume handoff.

## 0.9.2

A patch: shipped prompt and contract text only. No command, field or contract shape changed, but
`FACTORY_VERSION` is matched exactly, so a consumer picks this up deliberately.

Every change here comes from one run. mimir's `chainlink-1762` spent three runs and twenty-one build
attempts on a typed-ledger and accounting subsystem; the feature actually requested — detect a stuck
run, prompt a turn, remediate or escalate — was three of its eleven acceptance criteria and was never
once the thing that blocked. The factory behaved correctly throughout: the reviewer was right five
times running, the builder reported `blocked` honestly every round, and the decomposer's single-slice
justification was sound. Nothing produced a false green. What was missing was any instruction that
would have stopped it earlier.

- **Escalation no longer requires an unresolved design choice.** The driver was told to escalate when
  repeated findings trace to the same open design question — but every review of that slice ended
  `feasibility: "No unresolved design-level blocker."`, which was true and which disarmed the only
  exit. The rule now also asks, when repeated reviews leave substantial acceptance gaps, whether the
  next attempt has a **bounded, achievable remediation target**, and routes a dead end through the
  existing parked-stop procedure for replanning rather than spending the rest of the budget. Work is
  preserved and approved acceptance criteria are not quietly changed.
- **An unchanged finding count is explicitly not a stall.** The contract says so in as many words,
  because it is the tempting wrong rule: across attempts 3–6 that slice held at eight blocking
  findings while the reviewer credited real progress inside every category and narrowed each one to
  its exact remaining defects. A finding code names a category, not a unit of work, and a count-based
  trigger would fire on a run that is genuinely advancing.
- **`story-writer` keeps criteria tied to what was asked.** Additional capabilities and broad
  architectural requirements must be labelled as proposed scope additions with a reason, for decision
  at the story gate, rather than becoming requirements silently. Separately: when addressing known
  defects, name the failure scenarios to prevent instead of generalizing them into a subsystem-wide
  guarantee, and if a broader guarantee really is needed, state its scope and proof obligations before
  approval. That second rule is aimed at the most expensive line in that story — "avoid the reference
  implementation's three failures" — which reads as a cheap safety condition and converts into proving
  an absence across a whole subsystem.
- **`work-reviewer` rejects unapproved scope expansion**, in the doc-step review where its sibling
  spec and plan verdicts already live. It must not reopen explicitly approved scope merely because a
  smaller feature was possible, impose a criterion-count limit, or reject necessary reliability
  behavior — the failure mode of a scope rule is a reviewer that relitigates approved work forever.

All four are instruction, not enforcement: a stall wastes attempts, it does not let a run claim
success it did not earn.

The placement of the reviewer verdict is pinned by a test rather than left to an eye, and that test's
own boundary is now guarded: it bounds the doc-step section between two subject bullets, and an absent
end marker makes `indexOf` return `-1` while `slice(start, -1)` reads to end-of-file — which would
have relaxed the check to "appears anywhere after Doc steps" and kept passing on a botched move.
Control: renaming the Build slices bullet fails on the new bound assertion by its own message, and
restoring returns it to green.

Ledger unchanged at 4860; no production line changed.

## 0.9.1

A patch: shipped prompt text only. No command, field or contract shape changed, but `FACTORY_VERSION` is
matched exactly, so a consumer picks this up deliberately rather than silently.

- **A class-wide behavioral test matrix starts with one proven negative control.** mimir's
  `chainlink-1762` exhausted five build attempts on one defect that reappeared under a different name each
  round: the tests established that 117 call sites were *enumerated* — AST references, test names — where
  the acceptance criterion required each one to *behave*. The reviewer was right five times, and nothing in
  the contract told the builder what would settle it. Builders now mutate production behavior within their
  owned paths without changing the tests or preventing execution, confirm the mapped test passes before,
  **fails on the expected behavioral assertion** with the mutation, and passes after restoration, then
  restore before committing. A syntax, import, discovery or unrelated failure does not count — that
  qualifier is the mechanism, since an inventory test really can fail under a mutation that renames the
  symbol it searches for, and a control accepting any failure certifies the defect it exists to expose.
  The report names the row, symbol, mutation, exact command, observed assertion failure and restoration;
  an unperformed control is marked **not run** with its reason rather than inferred.
- **The reviewer reads that report as diagnostic information, not evidence.** Naming a symbol, a test and
  an assertion makes a claim checkable, not verified, and one control validates the approach rather than
  the other 116 members. It cuts both ways and the prompt says both: a missing attestation alone is not a
  blocker, inadequate behavioral coverage is, and an attestation alone is not grounds to approve. Shared
  parameterized tests are explicitly valid — 117 rows needing behavioral proof is not 117 test cases.
- **Instruction, not enforcement.** A CLI cannot confirm a mutation was performed and restored without
  performing it again, so a schema field here would record an unverified claim while looking like a gate.
  The prompt says so inline, so the next reader does not add the field.

Ledger unchanged at 4860; no production line changed.

## 0.9.0

A minor bump, not a patch, because `FACTORY_VERSION` is matched exactly: a consumer pinned to a version is
asserting that it agrees with this contract, and three things here change what that agreement means.

- **`factory decide <run-id> --text TEXT --session ID` answers a parked run.** There was no channel.
  `resume` carries no message and every command that could carry one is refused while parked, so the
  contract's own advice — record the decision in the issue — named the one place a retained run never
  re-reads. mimir's `chainlink-1762` parked after six and a half hours asking whether a ceiling was
  authoritative, and the only supported reply was to destroy the sandbox and relaunch, discarding planning
  the run had already done. The cumulative text is published as
  `artifacts/operator-decisions-<sha256hex>.md` — content-addressed, so the name and the manifest's
  `operator_decision.digest` identify the same bytes — and `operator_decision.artifact` is the
  authoritative pointer to read; `status` reports the record. Answers accumulate rather than replace, and
  deciding leaves the run parked: answering the question is not deciding to continue.
  Recording is enforced; **reading it is instruction**, because no CLI can make an agent read a file. The
  digest identifies the recorded bytes; it does not prove a driver applied them.
- **The 4500 production-line ceiling is gone.** That number was this repository's own ledger value, copied
  into two body templates shipped to every consumer, and it reached a run as though it were the target
  project's policy. The contract now states that it sets **no limit on how much code a change may add**,
  and the old pins are replaced by assertions that the ceiling is absent so it cannot return. A project
  that wants one states it in its own spec.
- **Explicit resume refreshes the staged contract before unparking**, so a run parked across an upgrade
  cannot keep driving from the copy it was staged with. Bindings are re-checked after that copy. A resume
  refused *after* the refresh leaves the previous park snapshot stale; the contract says so and routes the
  driver to republish it, rather than excluding `WORKFLOW.md` from snapshot verification — the staged
  contract is exactly what a recovery needs, so excluding it would make the snapshot claim more than it
  verifies.
- **A conventions sweep of the shipped prompts.** An `APP-` issue-key format, a blanket
  no-stray-comments rule stated as universal rather than as the target repository's documented policy,
  and related wording across the builders, decomposer, reviewer and validator. Same defect as the 4500:
  one project's house rules shipped as everyone's contract.

Production moves 4774 → 4860; the tripwire 4775 → 4900 on explicit operator instruction after the measured
cost was shown.

## 0.8.9

`work-reviewer` could never approve a planning step. One unqualified sentence made it unsatisfiable.

- **The rule and the code disagreed.** `deriveReviewReady` returns false for any zero-diff observation —
  correctly, since "no files changed, tests pass" is the shape of a false green for an implementation
  slice. But `work-reviewer.md` carried an unqualified *"Observed `review_ready` is false … REJECT"*,
  while a planning subject (`spec-writer`, `work-decomposer`) produces an artifact under
  `.factory/$R/artifacts/` and no worktree commit. A zero diff is its **correct** shape, so the step could
  not pass at any attempt count.
- **The prompt already knew better in two other places** — it scopes observed evidence to "build/test
  subjects" at one point and tells the reviewer to judge `spec-writer`/`work-decomposer` from the artifact
  and cited files at another. Only the reject bullet dropped the qualifier. The reject rule now names the
  subjects that have evidence, and the section states outright that a planning subject is never rejected
  for missing, empty or not-`review_ready` evidence.
- **`deriveReviewReady` is unchanged, deliberately.** Relaxing it so an empty diff could be review-ready
  would destroy the guard that stops a builder who did nothing from reading as reviewable — the exact
  false green this codebase spends production lines to prevent.
- **The guard executes its premise.** Rather than pinning one string against another, the test runs
  `deriveReviewReady` with an empty `files_changed`, proving the rule is unsatisfiable, and only then
  requires the prompt to scope it and state the planning case. Controls: restoring the unqualified bullet
  fails, and keeping the scope while deleting the exemption fails a different assertion.

Observed on mimir's `chainlink-1762`, which parked with `spec-writer:blocked(2)` and attributed the
contradiction to its own adapter policy. It was ours. `work-reviewer.md` had never been covered by the
drift guards added in 0.8.4 through 0.8.8, all of which pin `WORKFLOW.md`.

- **The Prime extension no longer depends on the host's resolver root.** Observed: Prime Agent failed to
  load the extension with `Cannot find module 'feature-factory'` on an install where the dependency was
  present, and where the same specifier resolved from that file's own path under Node by both `import`
  and `require`. Bare resolution is still tried first, since it is correct when Node imports the file;
  when it throws, a walk up from this file's own location finds the dependency beside the package, and a
  build carrying that fallback was confirmed to start where the same install previously failed.
  The suspected mechanism — Prime creating jiti with its **own** module URL as the resolution root, so a
  bare specifier is looked up from Prime's directory — is the best explanation for those observations
  rather than an established cause: three reproductions of that loader shape resolved successfully here.
  The fallback stands either way. Which resolver is doing the asking is the host's business; where a
  package manager put a declared dependency is not.
- **And when it genuinely is missing, the error says what to do.** Previously it propagated the resolver's
  bare
  `Cannot find module 'feature-factory'`, which the host prints under "Failed to load extension" and which
  names no remedy. It now identifies the file resolution was attempted from, gives the reinstall command,
  and points at the other possibility — a host loading the extension from somewhere other than its
  installed path, since resolution is relative to that file. The original resolver error is preserved as
  `cause`. Reported from a global install where the dependency was in fact present and the same specifier
  resolved correctly when asked directly from that path, which is exactly the case the old message could
  not distinguish from a missing package.

### Ten contract contradictions, found by audit rather than by a run

An outside scan for this defect class turned up ten more. All ten were verified against the code before
being fixed; all ten were real. Two came from the release series that was fixing this class.

1. **Approved test waivers became reviewer blockers.** `WORKFLOW.md` exempts a slice with an empty
   ratified `test_plan` and `deriveReviewReady` honours it, while the reviewer blocked on "an AC unmet or
   untested" with no qualifier — so a ratified docs-only slice was rejected forever.
2. **Required regeneration read as prohibited editing.** The reviewer banned "edits to vendored or
   generated trees" absolutely; `frontend-builder` correctly requires the source-owning slice to
   regenerate. Only hand-editing is prohibited.
3. **`test-verifier`'s claim described a different diff from its observation.** Its prompt said the
   orchestrator passes its claim to `observe --claim`; the integration observation covers the whole
   integrated diff and passes no claim, so following the prompt manufactured a `claim_mismatch`.
4. **The fresh-init sequence was imposed on existing runs.** The OpenCode skill required `init` before any
   state read; the workflow requires selecting an existing manifest and never initializing it again. This
   was the 0.8.5 ordering, correct to state and wrong to state unconditionally.
5. **"Park on any stop" erased intentional nonterminal exits.** Added to both adapters in 0.8.5. An
   interactive `stop` is an unlocked nonterminal stop the contract says not to terminalize, and clean
   verification exhaustion forbids terminalizing too.
6. **Verification exhaustion assumed the run had never parked.** It required `terminal_result: null`,
   which no resumed run can satisfy, since resume preserves the historical result by design.
7. **Configuration validation restated an obsolete schema** — "four required properties plus optional
   `verify_timeout_ms`" against an actual three required and four optional. It now points at the
   authoritative statement instead of restating a shape that goes stale.
8. **Headless parking waited for an impossible status.** `terminal:needs-human` cannot occur: `next` names
   terminal only for `completed`, `partial` and `blocked`, so a parked run still reports a resume action.
9. **The reviewer granted an integration waiver that does not exist** — WRITTEN-NOT-RUN for
   `test-verifier`, where the workflow says there is no waiver.
10. **The root README dropped two qualifiers** — an unconditional `gh pr create --draft`, and a validator
    verdict required without the single-slice exemption.

**The guard now covers where restatements live.** 0.8.6 derived a rule — prose naming a branch outcome
must name the selector that chooses it — and scoped it to `WORKFLOW.md`. That scope is why #10 survived it.
The rule now runs over every shipped prose document, including fenced examples, which is the shape #10
actually took; each adapter runs the same check over its own skill using its own bundled workflow, so no
package reaches into another. It also moved from line to paragraph granularity, because a correctly
qualified sentence routinely wraps the selector onto the line above.

### A second audit pass: four regressions in the first, and five pre-existing defects

The first pass was re-reviewed. It found four problems **in those fixes** and five pre-existing defects
reproduced through the CLI. All are fixed here.

**In the first pass's fixes.** The empty-`test_plan` waiver was written as an exception to a conjunction,
so it waived "acceptance is implemented" as well as test coverage, and a closing sentence excused a missing
observed *diff*. It now waives test execution only. The OpenCode resume exception permitted candidate
reads the canonical opening still forbade, and pointed at candidate paths defined only in the file not yet
readable — the opening now allows that bounded lookup and the skill states the paths inline. Exhaustion's
corrected check kept three stale `terminal_result: null` restatements, including the required report, so
the check passed while the report lied. And the reviewer still rejected any producer/observation file-list
disagreement, which for `test-verifier` is the integrated diff and legitimately contains builder files.

**Pre-existing, and reproduced through the CLI.** A reviewed step consumed nothing: `accepted` was
recorded against a missing review file, a REJECT with blocking fixes, and an approval naming a nonexistent
commit. A `pre_pr` approval named no commit, so a single-slice run — which skips the validator that
carries that binding — could approve at A, commit B, re-observe tests at B and publish under the older
approval; the gate already observed the head to prove readiness and now records it. An accepted step could
not record a rejection, so a Gate 2 revision could record success but never its REJECT. A NO-GO finding in
production source had no legal path and is now an explicit park rather than an instruction the contract
cannot carry out. Autonomous Gate 3 required the validator that single-slice runs must skip. And a
background driver was told to read durable state only through `status`, while the workflow requires direct
manifest reads for fields `status` does not expose.

**The guard, again.** Its inventory listed two of eleven specialist prompts, the adapter checks stripped
fences, and a `DRAFT PR` chain diagram survived in two files. Inventory is now every document this package
owns, fences included, and each adapter checks its own examples too. Its limits are now stated in the test
rather than implied: it matches tokens in a block and cannot tell whether a qualifier *governs* an
outcome, so `"Read PR_DRAFT for logging. Always publish a draft PR."` passes and
`"Never assume the result is a draft PR."` fails. It catches the shape every defect in this series took —
an outcome stated with no selector near it — and nothing subtler.

### A third pass: three false greens in the second pass's production code

The re-review reproduced all three through the CLI, and none needed a contrived input.

- **A review was matched by subject and verdict but not by attempt.** Accept attempt 1, record
  `running --attempts 2`, then accept again **omitting `--review-ref`** — the reference fallback
  re-consumed attempt 1's approval. Omitting a flag was enough.
- **`test-verifier` inherited the planning-subject exemption.** A planning subject has no commit for its
  review to name, which is why that check omits the head binding a slice merge requires. The verifier
  judges the integrated branch and does have one, so a review naming a nonexistent commit was accepted.
- **Reopening an accepted step was allowed on any raised attempt**, which reopened planning work after the
  slices derived from it were seeded, and reopened steps on completed, blocked and partial runs. A
  revision is narrower than a raised attempt.

Also fixed: the pre-init instructions now state the `$R` and `$FEATURE_BRANCH` derivations inline rather
than pointing at a file that cannot be read yet; the existing-run lookup spells out
`<sandbox_path>/.factory/$R/WORKFLOW.md`, since `status` reports no run directory; the guard's document
inventory omitted the canonical workflow's own fences, which is how a `DRAFT PR` diagram survived in the
document the rule is derived from; and the reviewer prompt now states the repair-evidence substitution,
so the supported recovery path is not rejected for lacking ordinary evidence.

The gate-head binding was checked against the repair path and showed no regression, including the case
where repair evidence substitutes for ordinary verifier evidence.

The five refusals are pinned as regressions rather than as a fixture adjusted until it passes — the
fixture passing is what hid all five.

### A fourth pass

- **Publication ignored the step rows.** Accept the verifier at attempt 1, approve Gate 3, then record a
  genuine REJECT at attempt 2 — and the run still published under the older approval. Permitting verifier
  revisions is what made that reachable, so allowing the revision had to bring the approval rule with it:
  the verifier's row must be settled as accepted.
- **Revision scoping ran only on a status change**, so `accepted@1 → accepted@2` skipped every
  restriction, terminal runs included. That is precisely what a driver recording only the successful final
  result produces. Any departure from the settled row is a revision now; exact same-attempt re-acceptance,
  which is what a resumed driver re-records, stays free.
- **The inlined run-id derivation was a summary, and summaries of it pick different runs.**
  `implement ABC-123 login` became `implement-abc-123-login` rather than `abc-123`, `café` became `caf`
  rather than `cafe`, and the branch fallback and both multiple-key refusals were missing — before `init`,
  which is early enough to create the wrong run. It is now copied verbatim and bound by byte equality,
  like the init invocation beside it.
- **The regression named for the fallback did not exercise the fallback.** It supplied `--review-ref`
  explicitly against a run with no recorded step. It now pins the real sequence — accept attempt 1, reopen
  at attempt 2, accept with no reference flag — and a companion case proves the fallback still works when
  the stored approval *is* for the current attempt.

Production moves 4682 → 4774, within the 4775 tripwire, across two explicit operator instructions.

## 0.8.8

`status --json` projects step and slice rows as structured records. **Breaking for anyone parsing the
previous strings.**

- **`attempts` had to be regexed out of a rendering.** The projection emitted
  `${agent}:${status}(${attempts})` — `spec-writer:rejected(1)` — inside an otherwise machine-readable
  payload. `attempts` is the single field a controller reads to decide whether an attempt was consumed,
  and reaching it meant parsing a display string. Rows are now
  `{agent, status, attempts}` and `{id, status, attempts}`. The content is unchanged; only the shape is.
- **It was a public shape with no coverage.** No assertion in the suite referenced the string form, which
  is how a display artifact survived inside a machine contract. The end-to-end path now pins both the
  exact `be-thing` slice row and the structural property of every row, so a return to strings fails.
- **Why breaking is acceptable here.** An exact-match `FACTORY_VERSION` pin already forces a consumer to
  move deliberately on any version change, so there is no silent-upgrade path. The raw `run.json` manifest
  always carried objects, and the TUI and `observe/runs.js` read that rather than the projection, so they
  are unaffected.

Context: mimir's escalation epic stalled because outcomes could only be classified by reading prose. Most
of that gap is not the factory's to close — "infrastructure failure versus genuine build outcome" is
knowable by the controller and frequently not by a run that was killed. This is the part that *was* ours:
structured attempt counts, which the factory already knows and was rendering instead of reporting.

- **`gates` carried only a status.** The record is `{status, at, artifact}` and the projection emitted the
  status alone, so `at` — most of what "is this run stuck" means — was thrown away at the boundary while
  sitting intact in `run.json`. Gate rows are now the whole record.
- **`validator` carried only a verdict**, dropping `report`, `reviewed_head` and `loops`. `loops` is what
  says whether validation is converging. It is now the whole record.
- **`next` packed two facts into one string.** `gate:story`, `observe-slice:protocol`,
  `stopped-at-gate:brief` — a kind and a subject a consumer had to split on a colon, in the field most
  worth branching on. `status --json` now also emits `next_action: {kind, subject}`. `nextActionRecord` is
  the single computation and `nextAction` is a one-line formatter over it, so the string is a projection
  of the record rather than a second implementation; a test asserts exactly that. `next` is retained
  because the driver contract, the sidebar and a lot of prose name `next: gate:story`.
- **A narrowing guard, read from the schema.** `GATE_KEYS` and `VALIDATOR_KEYS` come from
  `state/schema.js`, so a field added to either must be exposed or consciously excluded rather than
  silently forgotten — which is exactly how all three of the above happened. Steps and slices expose a
  deliberate subset, pinned explicitly. The guard's first draft was itself a no-op: its validator half sat
  behind a `!== null` at a point where no validator exists, so it read as coverage and proved nothing
  until a control caught it.

Production moves 4650 → 4682, and the tripwire 4650 → 4700 on explicit operator instruction given before
the work.

## 0.8.7

The park snapshot stopped reporting itself. Found on a live park, not in review.

- **`status` reported `park_snapshot: null` for a snapshot that was on disk, complete and byte-correct.**
  A real parked run published its control plane at 23:28:25 and `status` denied it eleven seconds later.
  The two planes were identical — 32 entries, same modes, same digests — except `factory.lock`, whose
  `heartbeat_at` had moved from `23:28:25.920Z` to `23:28:36.538Z`.
- **The lock is liveness, not run state**, and it is the one entry in the plane designed to change on a
  timer. Comparing it made every snapshot invalid within one heartbeat, so the field built to answer "did
  the driver publish it" answered "no" about a park sitting right there — the same
  signal-disagrees-with-its-own-description defect 0.8.3 existed to remove, reintroduced by the check
  built to remove it. It is excluded now, by exact root path, from the qualified-status comparison and
  from the contract's staging verification, which had the same race between reading source and copy.
- **Why the suite could not have caught it.** Every existing case publishes and reads back with nothing
  touching the plane in between. The regression now ticks a heartbeat between the two, and a second plants
  a nested `factory.lock` so the exclusion cannot widen from an exact root path to a name match — without
  that, a `rel.includes("lock")` implementation passes.

Production moves 4641 → 4650, which is **exactly the tripwire, with zero headroom**. Nothing was trimmed
to fit; the next change in this file needs an operator decision on the tripwire first.

## 0.8.6

`pr_draft` is a repository setting, not a property of autonomous mode — and a guard so the next one of
these fails a test instead of a run.

- **Nothing in the executable layer was wrong.** The publication block selects `gh pr create --draft` on
  `PR_DRAFT=true` and plain `gh pr create` otherwise, and the surrounding text already said draft
  publication for `true` and ready-for-review "only for `PR_DRAFT=false`". A `pr_draft: false` repository
  has always been supported.
- **Eight prose passages asserted a draft unconditionally**, one of them putting "draft" and "autonomous"
  in a single clause: "The draft PR is the last externally publishing side effect an autonomous run may
  perform." A driver read autonomous as draft-only, found its run recorded `pr_draft: false`, and parked
  on a contradiction between two instructions it is required to obey. Parking was correct. All eight are
  now mode-neutral, including the `## Step 6` heading and the two publication signatures, which are
  labelled with the `PR_DRAFT` value that selects them.
- **`draft-pr-recorded` is declared a fixed protocol token** meaning the run's pull request was created
  and recorded. It does not assert draft-ness; a `pr_draft: false` run terminalizes with the same reason.
  Kept verbatim rather than varied, because downstream consumers match it exactly.
- **The guard is derived from the code, not from a phrase list.** For every selector a fenced block
  branches on, prose naming one of its outcomes must also name the selector, so an outcome reads as
  chosen rather than fixed. A selector found with no declared outcome vocabulary fails rather than going
  unpoliced, and word senses are distinguished: "draft a ticket" is not a `PR_DRAFT` outcome.
  It is a regex over shell text, not a shell parser, and the first version **failed open** — the same
  defect it exists to catch. Rewriting the condition as `[[ … ]]` or `${PR_DRAFT}` made it discover
  nothing, and with nothing discovered every prose check was skipped and the whole guard passed while
  proving nothing. Caught in review. The extractor now reads those forms, and a list of known selectors
  must still be discovered, so a rewrite it cannot parse fails loudly and gets fixed in the extractor
  instead of silently tolerated. Eight table-driven controls pin the guard's own failure modes, including
  both rewrites and a selector that has vanished entirely.

This is the third consecutive release fixing the same shape — executable block correct, prose restating
its decision and drifting. 0.8.4 was the option prefix, 0.8.5 the init invocation. A manual sweep of this
file found four of the eight sites; the guard found the rest, including the section heading, which is the
argument for having built it.

No production lines; the ledger stays at 4641.

## 0.8.5

The init invocation has one source of truth, and it lives where a driver can reach it.

- **The host skill now carries the complete `factory init` command, verbatim.** A driver runs `init` at
  step 3; the canonical workflow is not readable until step 3 stages it. So the skill was the only
  document available at the moment of the call, and it described `init` only as three isolated flag
  fragments — `factory init --pr-base`, `factory init --max-retries`, `factory init --mode` — never
  pairing it with `--repo` or `--json` anywhere. A model assembled exactly those fragments and guessed the
  rest:

  ```
  init chainlink-1610 --mode autonomous --max-retries 5 --repo <checkout>
  ```

  No `--json`. Init succeeded and published `run.json`, but this workflow binds paths only from a JSON
  response and forbids repeating init, so the run correctly stopped — leaving a live sandbox at
  `status: running` with no driver, and a host exit code of 0.
- **The canonical block gained `--max-retries`.** The skills instruct drivers to forward it and the block
  omitted it, so every run with a retry budget had to improvise the one command that must not be
  improvised.
- **Two prose sentences contradicted the block and are gone.** `## Mode admission` said the fresh-run
  invocation "ends with `--repo \"$RUN_REPO\"`" — wrong twice, since init is the one command taking
  `--repo \"$O\"` (`RUN_REPO` is bound *from* its response) and the block ends with `--json`. Step 0 said
  "command first and repository flag last", which the block it introduced contradicts. Every other `"$R"`
  invocation does end with `--repo \"$RUN_REPO\"`, which is why the over-generalization read as correct;
  `state-relocation.test.js` had already allowlisted init as the exception, and an assertion there was
  pinning the wrong claim.
- **Enforcement: byte equality, not flag presence.** The canonical `INIT_RESPONSE=` line is extracted from
  `WORKFLOW.md` and both skills must contain it verbatim. Dropping `--json` from a copy, or adding a flag
  to the block and leaving a copy behind, fails the test. The skills must also state that `--json` is
  mandatory.

Verified end to end with the launcher argv that produced the failure, leading space included —
`opencode run --dir <checkout> --command feature " --autonomous --max-retries 5 chainlink-1610"` — which
now yields `init "chainlink-1610" --branch "feature/chainlink-1610" --issue "chainlink-1610" --mode
"autonomous" --max-retries "5" --repo "<checkout>" --json` and a run that binds its paths and proceeds.

- **`status` reports `max_retries`.** Init has recorded it since the flag existed and nothing read it
  back, so an operator forwarding `--max-retries` could not distinguish a budget that took effect from
  one that silently fell back to the default 3 — a run bounded at the wrong number looked exactly like a
  correct one. Emitted unguarded, because `max_retries` is a required schema-validated positive integer:
  a manifest without one is invalid and never reaches the emitter.
- **The Prime copy is Prime-specific.** The first version of this change pasted OpenCode's bootstrap
  rationale into the Prime skill — "the workflow is not readable until init stages it", "Step 3 runs
  `factory init`" — both false for Prime, which loads the canonical workflow before intake, admission and
  `feature_factory_context`, and whose step 3 applies host bindings. That is the contradictory-instruction
  defect this release exists to remove, reintroduced inside its own fix, and byte equality could not see
  it because the command was identical. Caught in review. Prime now states that the section adds no
  ordering and routes the call through the `feature_factory_context` CLI path, and a guard rejects the
  OpenCode-only claims and requires the workflow-load section to precede it.

Production moves 4636 → 4641 for the `max_retries` field; the tripwire stays 4650.

## 0.8.4

One change: the canonical workflow and the host skills no longer both parse the invocation.

- **The platform skill owns invocation-option admission; `WORKFLOW.md` concedes it.** Its `## Mode
  admission` section defined its own prefix — "the maximal consecutive sequence of tokens that are exactly
  `--autonomous` or `--headless`", with "the first other token ends the prefix" — and named the remainder as
  the input to run-id derivation. The host skills define a wider prefix that also admits `--base` and
  `--max-retries`. `--max-retries` was added to the skills in #281 and never reached the workflow;
  `--base` had the same gap. For `--autonomous --max-retries 5 chainlink-1610`, one document made
  `--max-retries 5` an option pair and the other made it part of the run id.
  The section now states that each host skill defines the complete option prefix, consumes it, and supplies
  the workflow two things — the admitted mode tokens and the byte-preserved admitted remainder — and that
  the workflow never decides where the prefix ends. Everything downstream is unchanged: the same mode
  conflict refusal, the same `--mode` mapping, the same missing-request refusal, the same immutability of a
  persisted mode. `OPERATING.md` already described admission this way; only the canonical workflow had not
  caught up.
- **What this cost, twice.** Read alone, the workflow's grammar derived the run id `max-retries-5-1606` and
  parked that run. Read together with the skill — which 0.8.1 made mandatory, in a defined order, under a
  rule to stop rather than improvise when the two disagree — a driver correctly refused to start
  `chainlink-1610` at all, after eight workflow steps. The second failure is much better than the first and
  is still a halt. Both are one defect: two documents governing the same bytes.
- **A guard, because this drifted invisibly.** 0.8.1's verbatim-restatement test binds a later region of
  `WORKFLOW.md` and never reached this section, so nothing compared the two grammars. The admission section
  must now contain the concession and must not define a prefix terminator. The negative control that matters
  is additive: a re-parsing sentence added while every pinned fragment stays intact is caught by the
  terminator guard alone, which is the shape this drift actually takes.

No production lines: the fix is contract text plus a test. The ledger stays at 4636.

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
  whole plane — `.` and every descendant, each recording relative path, type, mode, SHA-256 for a regular
  file, target for a symlink, sorted lexically by relative path — which is the property the publication
  contract already defines; an entry that is none of those three types is rejected rather than skipped. Currency is the manifest compared by bytes, because an earlier park's
  `updated_at` is the same length as this one's and size alone would call a stale snapshot current. Every
  path component is `lstat`ed and never followed, since `lstat` on the final entry still follows
  intermediate symlinks. Computed at read time, so there is no stored key to keep truthful. The copy itself
  remains a driver step, because this CLI is forbidden copy and delete primitives.
  Three earlier versions were false greens of their own, all caught in review. "Does the pathname exist"
  reported a snapshot from an earlier park as this park's evidence. Matching only `run.json` proved one file
  was copied after the current terminalization, not that publication finished — a driver that created the
  directory and copied that file first, or an interrupted copy, still read as published. Comparing file
  sizes rather than digests — on the theory that hashing was too costly for a continuously polled command —
  passed a same-length byte change and a mode-only change as faithful copies, so this same defect had
  reappeared inside its own fix. The cost estimate was right and the conclusion was wrong: hashing the plane
  costs about a millisecond. Walking into the root without recording it then passed a snapshot whose own
  directory mode differed from the plane's — narrower, again, than the contract it claimed to check.
  `null` therefore covers a snapshot left by an earlier park, an incomplete or altered tree, a file or
  symlink at the canonical path, and a symlinked parent component. Publishing again is what makes it
  correspond.
- **Observability rather than enforcement.** It cannot make the snapshot happen; it makes a missing one a
  fact a controller can act on. That is the property that made the 0.8.0 publishing-identity work land, and
  prose alone has now failed twice in this same place — 0.7.5's environment override was the first, this the
  second. Both failures were silent, which is the part worth fixing.

Production source moves 4584 → 4636 across four review rounds, and the tripwire 4600 → 4650 using the
authorization given during the 0.8.2 discussion for this feature area, which went unused then because that
implementation turned out to be prose.

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
