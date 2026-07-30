# Build plan — the small factory

Written 2026-07-30. Supersedes `ISSUE-69-ADDITIVE-MIGRATION.md` as the proposed
direction. Companions: `VISO-BASELINE-COMPARISON.md` (what viso already does),
`SCOPE-DECISION.md` (what we drop and why).

## Target

**The viso `/feature` skill, plus reliable `run.json` transition tooling, plus
autonomous runs.** Nothing else.

The code exists for one reason: **agents cannot reliably hand-write
schema-perfect `run.json`**, so transitions are applied by a tool instead of by
prose. That is the whole justification. Verification exists only where the
absence of a human watching can otherwise produce a *false green*.

## Non-goals (the ceiling)

These are refusals, not deferrals. A reviewer cannot expand this list; only Jason
can.

- No post-PR remediation state machine. We stop at a draft PR.
- No cross-run continuation, checkpoints, or lineage.
- No integration amendments. A cross-slice defect escalates to a human.
- No steering machine. Autonomy is fire-and-check-later, not steer-mid-run.
- No cost attribution.
- No delivery-envelope / invariant-family layer.
- No dispatch claim/closure lattice, nonces, completion tokens, or hash chains.
- No verification of factory-authored records against other factory modules.
- No dual schema support. One shape, current, always.
- **No security-reviewer stage, and no reviewer panel.** viso has no
  `security-reviewer`; the predecessor added it, along with a two-reviewer verdict
  lattice, a strictest-of-N combination rule, and panel head-binding as its own
  mechanism. All of that is out.
- **Nothing viso's factory does is removed.** The chain is
  story -> spec -> decomposition -> (slice impl -> slice review -> merge) x n ->
  test-verifier -> implementation-validator -> PR, with the three gates.
  `implementation-validator` is the final reviewer and it **stays**: it is viso's
  holistic pass across the integrated slices, and dropping it would put the build
  below the baseline the target is defined by.
  - This line flipped three times before settling, every flip caused by inferring
    intent instead of reading it. "Skip the security reviews and final reviewer" was
    a description of how Jason ran the *predecessor* during dogfooding, not a spec
    for this build. Do not re-derive it.
- No provenance or audit records that nothing routes on.

## What we port (and nothing else)

| Asset | Why | Size |
| --- | --- | --- |
| `src/hardening/atomic-write.js` — `writeProtectedJsonAtomic` | crash-safe write, reused *unchanged* by the 0c spike | small |
| `withRunJsonLock` | single-writer lock, reused unchanged by the spike | small |
| `program/phase-0/spike/schema-neutral-write-core.js` | already written, already family-neutral, CAS proven | **130 lines** |
| The 13-attack catalogue from `FALSIFICATION-PROTOCOL.md` | ~10 survive scope; these become acceptance tests | ~1 page |
| Rejection *rules* inside surviving validators | the content of what gets refused, not its structure | judgement, per family |

**Not ported:** the 13 boundary test *bodies* — they inject at current-code seams
(`observeMergedTree`, `readExecutionReceipt`) that will not exist. The attacks
port; the test code does not.

## Prose vs code

Prose (in the skill, executed by the orchestrating model — viso does all of this
today and none of it can manufacture a false green):

wave scheduling and topological sort · worktree create/symlink/remove · PR body,
labels, reviewers, milestone · Jira sync · retry routing and root-cause
classification · gate presentation · escalation judgement · resume decisions ·
cleanup.

Code (two jobs only):

1. **Transition tooling** — apply a state change atomically, under the lock, with
   CAS and current-schema validation, so a malformed or lost-update record cannot
   land.
2. **Observation helpers** — re-derive the diff, re-run the named tests, compare
   reviewed tree to merged tree, bind a review to its commit.

## `run.json` — start from viso, justify each addition

viso's 15 fields, unchanged: `version`, `run_id`, `jira_key`, `branch`,
`worktree`, `created_at`, `updated_at`, `status`, `max_parallel_slices`,
`max_retries`, `gates`, `steps`, `slices`, `validator`, `pr_url`.

Additions, each with its reason:

| Field | Justification |
| --- | --- |
| `mode` (`interactive` / `headless` / `autonomous`) | required by autonomy; changes gate handling |
| `terminal_result` `{status, reason}` | "check later" needs a machine-readable why, not a chat message |
| `base_commit` | merge proof needs the base the reviewed tree was derived from |

That is **18 fields**, against ~37 today. Everything else lives where viso puts
it: `heartbeat_at` in `factory.lock`, `base_ref`/`diff_observed`/`tests` in
`evidence/<subject>.json`, review findings in `reviews/<subject>.json`.

## CLI surface — the transition tooling

Every command is one checked transition: lock → read → validate → apply →
validate → CAS → atomic rename. Nothing else writes `run.json`.

```
factory init <run-id> --branch B --worktree W [--jira KEY] [--mode M]
factory status [<run-id>] [--json]              # read-only; also "first incomplete step"
factory lock <run-id> <claim|steal|release>
factory heartbeat <run-id>

factory gate <run-id> <story|brief|pre_pr> <approved|changes|stop> [--artifact REF]
factory step <run-id> <agent> <running|accepted|rejected|blocked>
             [--attempts N] [--review-ref REF] [--evidence-ref REF]

factory slices-seed <run-id> --from plan/slices.json
factory slice <run-id> <slice-id> <running|review|merged|blocked>
              [--attempts N] [--evidence-ref REF] [--review-ref REF] [--merge-commit SHA]

factory observe <run-id> <subject> --worktree WT --base REF [--test-cmd CMD]
                                                 # re-derives diff, runs tests, writes evidence
factory validator <run-id> <GO|GO-WITH-NITS|NO-GO> --report REF
factory pr <run-id> --url URL
factory terminal <run-id> <blocked|partial|needs-human> --reason TEXT
```

**13 commands**, against ~40 subcommands today. `factory observe` is the only one
that does more than transition state — it is the observe-don't-trust mechanism,
and it must run the tests *itself*.

## Packaging — two packages, one direction of dependency

**Contract:** the factory is a standalone package with a CLI, usable with no
opencode present. The opencode integration — plugin, TUI, telemetry — is a
separate package that depends on it.

```
feature-factory              (standalone; no opencode dependency)
  bin/factory                CLI — the only writer of run.json
  core/                      130-line write core + 5 family contracts
  observe/                   diff re-derivation, test execution, tree comparison
  state/                     schema + READ-ONLY reader, exported for consumers
  skill/                     the /feature orchestrator prose + agent definitions

feature-factory-opencode     (depends on feature-factory; never writes state)
  plugin                     session/task observation, checked context injection
  tui/                       read-only run rendering
  telemetry/                 spans
  install/                   copies skill/agents into .opencode, version checks
```

**Rule: only the CLI writes `run.json`.** The plugin package has no lock, no
atomic writer, no transition function. It reads through the exported reader and,
if it ever needs a state change, shells out to the CLI like any other caller.

### Is it easily separable? Yes — measured, not assumed

- **The plugin already performs zero writes.** `src/plugin.js` (1,350 lines) has no
  `writeFileSync`, no `withRunJsonLock`, no `writeProtectedJsonAtomic`, no `rename`.
  It imports exactly `readdirSync, readFileSync` from `node:fs`.
- **The TUI is zero-write.** `tui-data.js` (901) and `tui-rendering.js` (200): no
  write calls of any kind.
- **The one coupling is already slated for deletion.** The plugin's only route to
  mutation is the imported `completeSliceBuilderTaskDispatch` /
  `completeSpecialBuilderTaskDispatch` /
  `completeIntegrationAmendmentReviewTaskDispatch` family — i.e. the dispatch
  claim/closure/completion-token machinery, which is already a **non-goal** above.
  Remove it and the write coupling is gone entirely, not merely narrowed.

So the boundary the packaging needs is the boundary the scope cut already makes.

### The one genuinely shared surface

Both packages must agree on the `run.json` shape. Do not duplicate that knowledge:
the factory package exports the schema and a **read-only** reader, and the
opencode package consumes it. That single export is the entire API between them —
if the plugin ever needs something else, that is a signal the boundary is wrong.

### Consequences worth accepting up front

- **The skill lives in the factory package**, since it is the orchestrator
  contract, not an opencode artifact. The opencode package's `install` step copies
  it into `.opencode/`. That keeps `/feature` portable to a different host later.
- **Telemetry goes to the opencode package.** Nothing in the core routes on spans,
  so the standalone factory should not carry an OTel surface at all.
- **`feature-command-payload` (541 lines) is plugin-side** — it decodes the
  `/feature` invocation, which is an opencode command concern.
- **`global-definitions` / version checking is plugin-side** — it asserts the
  installed opencode definitions match, which is meaningless standalone.
- **The standalone package must be testable with no opencode installed.** Make that
  a CI job, not an aspiration; it is the check that keeps the boundary honest.

### Where it is built (decided 2026-07-30)

**This repository, restructured as a monorepo. The old `src/` tree stays as a
read-only reference until the step-7 delete PR.**

```
packages/feature-factory/            standalone; bin/factory; no opencode dependency
packages/opencode-feature-factory/   plugin + TUI + telemetry + install
src/                                 old tree — reference only, deleted in step 7
```

Naming falls out of what is already published. `opencode-feature-factory@0.2.1`
has `main` pointing at the *plugin* (`src/opencode-plugin.js`), a `bin` for the
CLI, and a `./tui` export — the exact conflation being split. So:

- **`opencode-feature-factory` keeps its name and release channel**; it accurately
  describes the plugin package. `0.3.0` becomes a thin plugin depending on the core.
- **The core takes a host-agnostic name**, since calling a portable package
  `opencode-*` would be wrong.

Reasons to stay rather than start a new repo:

1. The new family contracts are ported from the **content** of the old validators'
   rejection rules. Deleting on day one removes the reference being ported from.
2. The three ported assets are already here.
3. The reasoning record is here — `DOGFOOD-LEARNINGS.md`, the `ISSUE-69-*` docs,
   these three plans, and the issue history. `git log` is also where the provenance
   of each individual guard lives.
4. CI, branch protection, and the review bot are already configured.

Two frictions accepted deliberately, with mitigations:

- **43k lines of dead code in the same tree** will surface in every grep — the same
  "wired in so it looks live" hazard the no-baggage rule exists for. Correctness is
  handled by the ceiling test forbidding imports from `src/`; ergonomics by keeping
  all new work under `packages/`.
- **CI would run 2,322 obsolete tests per push.** Scope the build branch to
  `packages/**` and leave the old suite on `main` until the delete PR.

### Ceiling additions for packaging

Extend the day-one ceiling test:

- The opencode package contains **no** write primitive — assert absence of
  `withRunJsonLock`, `writeProtectedJsonAtomic`, `rename`, `writeFile*` in its tree.
- The factory package imports **nothing** from the opencode package (dependency
  direction is one-way and asserted).
- The factory package's exported API to consumers is the schema plus the read-only
  reader, asserted as an exact export list.

## Families

Five contracts against the 130-line core, ~65 lines each at the spike's observed
rate:

1. **envelope** — identity, status, timestamps, limits, terminal_result
2. **gates** — the three human gates
3. **steps** — agent step rows
4. **slices** — slice rows, attempts, merge_commit
5. **evidence-and-verdict** — observed evidence refs and the validator verdict

Each owns its projection, its transition validation, and its re-observation hook.
The core stays ignorant of all five.

Estimated total: **130 + ~325 ≈ 460 lines** for the write plane, plus the CLI
surface and observation helpers. Whole system plausibly **1,500–2,500 lines**
against 43,013.

**Revised to 2,650** after opencode's fifth review round, at 2,579 actual. The
estimate was met until three findings needed closing: publication readiness
centralized and invoked at Gate 3's approval rather than only in `factory pr`
(where it runs after the push and the PR already happened), `test_plan` ratified
on the slice row in place of `observe --skip-tests-reason`, and the gates
contract's missing reobserve hook. Removals were made first — `lock inspect`,
`lock --force`, `observeTree`, and three duplicated integration-head
observations — so the raise covers only what is new. The reasoning is recorded in
`test/ceiling.test.js` beside the assertion, which is the file a future raise has
to edit.

**Revised again to 2,700** at 2,660, for two more publication-authorization findings: a
re-opened earlier gate did not withdraw publication authority because only `pre_pr` was
consulted, and the validator's verdict and judged head were CLI arguments rather than read
from the record it produced — so a report about one commit could be recorded as a verdict
on another. Two raises in one session is a ratchet; the next request should be answered by
deleting something.

## Acceptance — the attack catalogue

The build is done when each attack is injected and rejected. Ported from the
falsification protocol, scoped down:

| # | Attack | Required rejection |
| --- | --- | --- |
| 1 | Agent claims a test pass that never ran | `observe` re-runs it; claim/observation mismatch is a review finding |
| 2 | Merged tree differs from the reviewed tree | merge recording rejects |
| 3 | Approval presented against a different commit | consumption rejects |
| 4 | Validator verdict bound to a stale head | acceptance rejects |
| 5 | Observed path outside the slice's declared paths | merge rejects |
| 6 | Unauthorized control-plane path in a slice diff | dispatch or merge rejects |
| 7 | Stale head / false ancestry from git | transition rejects |
| 8 | External state changed between observation and effect | effect is not performed |
| 9 | Crash after push/PR, then replay | no duplicate effect; adopt or require reconciliation |
| 10 | Ambiguous PR create, then retry | no second PR |
| 11 | Concurrent writer changes `run.json` mid-transition | CAS rejects with bytes intact |
| 12 | Malformed record submitted by an agent | schema validation rejects before write |

**Dropped from the original 13:** GitHub PR/CI re-observation (post-PR is out of
scope). **Optional, decide explicitly:** agent-artifact content hashing — if the
orchestrator always re-derives, a hash between write and consume buys little; it
matters only across a crash/resume boundary.

Each attack gets one test with one injected substitute, and each must be shown to
fail when its guard is removed. **Budget: 12–15 tests.** Exceeding it needs a
stated reason.

## Autonomy — one open decision

"Run builds autonomously" needs a choice about the three human gates, and it
changes the design:

- **A — run to Gate 3, then stop.** Autonomous build and integrate; a human
  approves the PR. Smallest change: gates 1 and 2 auto-approve from the story/plan,
  gate 3 blocks. Keeps every viso guarantee.
- **B — fully unattended to draft PR**, with all three gates recorded as
  auto-approved and a post-hoc review by the human on the PR itself. Needs
  attacks 2–6 to be airtight, since nobody reads the diff before it exists.
- **C — unattended with a stop-on-doubt rule** — auto-approve unless the
  orchestrator's own confidence checks fail, then `needs-human`.

**Recommendation: A first, B behind a flag once the attack catalogue is green.**
A is a small delta from viso and immediately useful; B is where the false-green
risk concentrates.

## Build sequence

1. **Fresh directory in-repo** (`factory/` or a new package), the three ported
   assets moved in unchanged, the 130-line core as-is.
2. **Envelope + gates + steps** contracts and their CLI commands. Attack 11, 12
   green.
3. **Slices + `observe`**. Attacks 1, 5, 7 green.
4. **Merge recording + validator**. Attacks 2, 3, 4, 6 green.
5. **PR + terminal + resume**. Attacks 8, 9, 10 green.
6. **Port the viso SKILL.md** as the orchestrator prose, adapted for the CLI and
   for mode A autonomy.
7. **Delete the old tree** in one PR when every attack is green.
8. Mode B behind a flag.

Steps 2–5 are each a working system: the CLI transitions and the tests that
matter pass. There is no requirement that the *old* system keep working, which is
what makes this faster than the additive migration.

## Ceiling enforcement

The one piece of process machinery worth carrying forward is
`test/phase-0-gate-inventory.test.js` — a test that fails when scope grows. Build
the equivalent on day one:

- The CLI command list is asserted against a fixed set. A new command needs a test edit.
- The `run.json` top-level key set is asserted exactly. A new field needs a test edit.
- Forbidden-key assertion for the dropped subsystems (`post_pr`, `continuation`,
  `checkpoint_*`, `integration_amendment`, `steering`, `cost_attribution`,
  `delivery_envelope`) so they cannot reappear under any name.
- Test count budget asserted, so proof mass cannot creep.

This is what makes the non-goals real rather than aspirational, and it is what
the 0a expansion lacked until it was retrofitted.

## Risks

- **The 460-line write-plane estimate comes from a 3-family spike.** The five real
  families may be heavier, particularly slices. If contracts exceed ~150 lines
  each, something is being modelled that the target does not need.
- **Attack 9 (crash-recovery replay) is the hardest**, and the one most likely to
  pull complexity back in. It is also the one the current system spent the most
  code on. Cap it: adopt-or-reconcile, never invent a third path.
- **Autonomy mode B is the false-green frontier.** Do not ship it until 2–6 are
  green and falsified.
- **The review ratchet is a named cause of the current state**, not an accident.
  Every stage that can request changes will request them. Keep the chain short —
  `work-reviewer` on high-risk steps only, as viso has it — and make the ceiling
  test the arbiter rather than reviewer judgement.
