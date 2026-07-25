# Issue #69 Program Review — Post-Completion Brittleness Assessment

Status: review of the completed issue-69 implementation program (B0–B6 per
`ISSUE-69-IMPLEMENTATION-DAG.md`), conducted 2026-07-23 against `origin/main` at
`335434c` (merge of PR #99). Method: four parallel deep reviews (factory core;
run-state/validate transition layer; CLI/evidence/telemetry; durable mutation
catalog), with every top-severity claim independently re-verified against the
source before inclusion. Line numbers refer to `335434c`.

## Policy decisions (binding for all dispositions below)

Set by the operator on 2026-07-23; amended the same day with six accepted
caveats from opencode's counter-review (integrated inline below). These govern
how findings are dispositioned and how opencode should implement against this
review.

**P1 — No legacy: assume the current file format everywhere.** "No legacy"
means no support for old file formats or superseded routes. Validators and
transitions read exactly one (current) shape per record. No dual-shape
readers, no "readable but ineligible" states, no migration fences, no sweep
tooling. A persisted record in an old shape is simply rejected fail-closed;
the affected run is abandoned and the feature re-seeded. This supersedes the
DAG's B5 allowance that "persisted legacy records remain governed by their
original schema and route until terminal" and resolves B5.4's "narrow or
remove" as **remove**.

*Accepted caveat — P1 trades resumability, and the cost is managed by
process, not code.* What an old-shape run loses is **resumability of its
durable state**, not its work: commits, branches, PRs, and evidence files all
survive and are salvaged into a fresh run. The operational rule that makes
this cost near-zero is **version-skew discipline**: a schema-changing PR
merges only when no run is active, or after the active run is finished or
deliberately abandoned (e.g., issue #100 must be finished or abandoned before
PR #102's required marker lands). Runs are short-lived; this is a scheduling
constraint. **Guardrail:** caveat or no caveat, P1 is never operationalized
as compat windows, version detection, dual-read gates, or migration helpers —
that is the ratchet returning through the back door.

**P2 — Integrity calibration: verify at trust boundaries, trust ourselves
internally.** This ratifies what the program's own threat contract already
said. B0.1's intent was to *"remove claims of resistance to an arbitrary
local filesystem/verifier attacker"*, with acceptance that documents
*"consistently trust the local operator/host, distrust model claims and
stale/crash-raced evidence"* and describe internal records as
*"consistency/provenance controls"*. B0.4 was chartered to remove
*"duplicate internal attestation"*. The implementation nevertheless kept a
strong-adversary posture toward its own writers. Under P2 there are exactly
two trust boundaries:

1. **LLM agent output** — anything a builder/reviewer produced (worktree
   contents, artifacts, evidence, reviews, verdicts, claims of success).
2. **The external world** — GitHub, CI, remote state.

Facts crossing those boundaries are observed and bound (hash, commit, receipt).
Factory-authored records consumed by factory code are *internal*: validated
against the current schema once per write under the lock, and otherwise
trusted. Proof ceremony between factory modules is deleted per B0.4's own
charter. Whoever can hand-edit `run.json` on this host can also edit
`factory.js`; defending one against the other is theater.

*Accepted caveat — P2 does not erase crash and TOCTOU protections.* Git,
processes, agent-produced files, and GitHub can all change between an
observation and an external effect. Three cases, decided separately:

1. **Re-observing external mutable state** (git refs, worktree bytes, GitHub
   state, process results) **immediately before an external effect** (merge,
   process spawn, publication, PR mutation) — **keep**. This is trust
   boundary 2 doing its job.
2. **Crash-recovery idempotent replay** — **keep**. That is correctness, not
   attestation.
3. **Re-verifying factory-authored state under a lock already held** (the
   doubled guard passes, the hook→options re-derivation) — **delete**. The
   lock serializes writers; nothing changed between the two passes.

**Guardrail:** this caveat is citable only for cases 1 and 2. It never
defends case 3.

*Accepted caveat — "validate once per write" has a precise scope.* It means
one canonical schema validation per locked write of **factory-authored**
state — not one observation forever. External facts are still checked at
their consumption boundary, per case 1 above.

**P3 — Width calibration: specs and plans are budgeted by mass, not record
count.** Set by the operator on 2026-07-25, after two width-blocked dogfood
runs (`issue-103-retry` → carry-forward `issue-103-retry-2`): one slice burned
six attempts across two runs (fix trajectory 8→4→2, then 2→2→3 in the child)
because the brief for a "small operational fix" grew source-to-sink matrices;
the B4.2 width gate (`familyCount > 1 && obligations >= 6`) could never fire —
the envelope packed ~6 concerns into **1 family × 1 paragraph-length
obligation** — while the countable signal (8 acceptance rows / 16 declared
paths, vs a healthy sibling's 3 / 6) went unread; and carry-forward re-runs
the byte-identical plan by design, so the child hit the identical wall. This
is the five-whys obligation-mass bedrock cause resurfacing through a
Goodhart-defeated metric. Three legs (implementation: #112):

1. **Spec-review simplification block** in the work-reviewer's spec-subject
   checks (mirrored by a spec-writer self-check): proportionality to source
   scope, altitude (observable behavior only; no prose cross-products),
   traceability-or-cut, simplest-mechanism, and **aggregation-as-defect** (a
   family/obligation whose description enumerates multiple concerns is REJECT
   with a named split). Precedence rule: *simplification governs the scope
   and altitude of the spec; completeness governs coverage within the chosen
   scope; scope findings resolve first — completeness never justifies scope
   the source does not require.* Over-scope is BLOCKING on specs;
   simplification findings stay MINOR/notes on code reviews.
2. **Countable acceptance probes and an anti-Goodhart width budget.** Each
   slice acceptance criterion is a spec line item naming an executable probe
   (command + expected observable) — spec text, not pre-written test code.
   Admission gains per-slice budgets on acceptance-row and declared-path
   counts alongside the family×obligation rule, so mass cannot hide inside
   single records' prose.
3. **Scope-shaped terminal routing** (guidance + terminal hint only; no new
   record family, per P2): a nonconvergent terminal with zero merged slices,
   or a flat/rising fix trajectory, recommends **re-seed with a mandated
   split** rather than carry-forward, which cannot help by construction.

**Guardrail:** P3 is a counterweight to the first-attempt completeness rule,
not a second absolute. Without the precedence rule, reviewers whipsaw
spec-writers between "enumerate everything" and "cut everything"; with it,
every conflict is decidable. P1, P2, and P3 are one decision applied three
times: cost must be proportionate to what it buys, and metrics must measure
mass, not record count.

## Executive verdict

The program landed what the DAG promised. Every mechanism exists — reviewed
carry-forward, checked command contract and execution receipts, bounded
attempts with terminal nonconvergence, ownership-aware lanes, delivery-envelope
admission, checkpoint routing, generic integration amendment, correlated
telemetry — and the fail-closed discipline is applied consistently. The
checkpoint and delivery-envelope modules are genuinely healthy.

Two structural problems remain, and they compound:

1. **Copy-instead-of-extract.** Each brief copied the shared substrate
   (vocabularies, guards, serializers, claim machines, message strings) instead
   of extracting it; the same invariant typically lives in 2–12 hand-maintained
   copies whose agreement is enforced only by tests — or by nothing.
2. **Miscalibrated proof mass.** Most of the proof budget is spent on
   factory→factory attestation that P2 (and B0.1 before it) declares out of
   scope, while the maintenance cost of that attestation (exact-byte formats,
   exact-message catalogs, doubled guards, re-validation storms) is what makes
   the system expensive to change.

Scale for calibration: `src/` grew ~19.5k → 37.2k lines over the program
(`run-state.js` 2.6k→9.4k with 88 exports and ~1,125 throw sites;
`validate.js` 1.9k→4.9k; `factory.js` ~5k→7.8k with 442 top-level functions).
86 test files / 2,372 tests; 5.2k lines of load-bearing docs pinned by 187
docs-contract tests; a 4,588-line mutation-catalog helper. Applying P1+P2 is
deletion-dominant work; a control plane near half the current size is a
plausible outcome. That figure is **motivation, not an acceptance
criterion** (accepted caveat): every deletion follows an item's P1/P2
classification, never a line-count target, and no explicit behavior is
removed to hit a number.

## How the proof mass grew (context for P2)

The ratchet had three mechanisms, worth recording so it does not recur:

1. **Review dynamics.** Every brief was adversarially reviewed, and a
   reviewer's cheapest legitimate-sounding finding is always "this record
   could drift/be forged — bind it." Accepting costs one more hash; declining
   requires re-litigating the threat model in every round. PR #79 alone ran
   eight rounds and twenty-five findings, nearly all of the form "add more
   binding." The apparatus grew by ratchet, not by design.
2. **The catalog institutionalized the ratchet.** B0.3 requires every new
   durable record to register adversarial mutations ("cannot claim integrity
   coverage until registered"), so each brief added exact-byte and
   exact-message obligations, and removing a binding now reads as "removing
   coverage."
3. **Checks looked free.** Fail-closed culture treats every additional check
   as costless safety. The real costs landed elsewhere: maintenance
   amplification (Part 2), LLM producers failing closed on bookkeeping and
   burning attempts (3.4), and runtime waste (3.2).

The enforcement machinery (reviewer expectations, catalog registration rules)
must be recalibrated to P2 alongside the code, or the ratchet resumes.

### P2 keep / simplify / drop

| Tier | What | Examples |
| --- | --- | --- |
| **Keep** (trust boundaries) | Factory-executed tests and receipts (B1R); git-observed facts (ancestry, HEAD, tree equality at merge); content-hash at the agent→factory artifact handoff; review bound to the exact commit reviewed; PR/CI facts re-observed from GitHub; re-observation of external mutable state immediately before an external effect (P2 case 1); crash-recovery idempotent replay (P2 case 2) | These catch the failures dogfooding actually observed: confabulated test claims, wrong-commit reviews, stale/crash-raced evidence, state drift between observation and merge/spawn/publication |
| **Simplify** (internal consistency) | Validate the current schema once per write under the lock; one canonical-JSON authority; derive counts/indexes instead of echoing them; error codes where code dispatches, prose free to change | Kills re-validation storms (3.2), `remediation_context` attempt-burning (3.4), message-as-API (2.4) |
| **Drop** (duplicate internal attestation) | Byte-equality re-serialization proofs between factory modules on factory-authored records; nonce claim ceremonies for single-host operations already serialized by the run-json lock; doubled in-lock guard passes; catalog exact-message pinning (bind rejector identity — check name + path — not 611 strings of prose); catalog cases proving the factory rejects hand-corrupted factory-authored records | This is the factory distrusting its own code, which the test suite covers |

---

## Part 1 — Top severity (verified directly)

### 1.1 B5.4 legacy narrowing is inverted fail-closed

`src/run-state.js:8755-8768`: legacy `merged_slice_repair` admission decides
"is this incident generic-amendment-eligible?" by calling
`observeIntegrationAmendmentAdmission` inside `try { … } catch { continue; }`.
**Any** throw from the multi-clause generic admission means "not eligible →
legacy allowed," so tightening any generic admission check silently re-opens
the legacy route — the inverse of the single-active-authority rule the DAG
describes. Because generic admission hard-rejects continuation/checkpoint runs
(`integration-amendment-continuation-unsupported`, thrown at
`src/run-state.js:1978`, `src/run-state.js:8023`, duplicated at
`src/factory.js:2793`), continuation runs are permanently routed to legacy.
Both repair state machines remain fully live: `mergedSliceRepairFence` is
consulted at 7 transition sites (run-state.js 493, 860, 1039, 2490, 2715,
2805, 3399) beside a parallel amendment fence set, and the "generic and legacy
repair authority may never coexist" guard string is copy-pasted at 3 sites
(3673, 7930, 8024).

**Disposition under P1:** do not fix the probe — delete the route. See Part 5
(L1–L4) and the L3 decision.

### 1.2 Per-repo lock guards host-global `gh auth switch`

`src/post-pr-ci.js:536-549` (`runGitHubOperation`): every GitHub operation
runs `gh auth switch -h github.com -u <account>` — which mutates `~/.config/gh`
for the whole host — serialized only by
`<repo>/.opencode/factory/github-operation.lock`
(`withGitHubOperationLock`, `src/post-pr-ci.js:630-640`). Two concurrent runs
in different repos, or an operator using `gh` interactively (a daily reality on
this host), interleave freely: run A switches, run B switches, A's `gh pr view`
executes under B's account. Wrong-account observations classify as
`not-found`/`permission` (non-transient) → runs terminally block, or worse,
observe an authenticated-but-wrong answer.

**Fix:** stop mutating global state entirely — run each `gh` invocation with an
isolated `GH_CONFIG_DIR` (per-account config prepared once), which removes both
the race and the need for the lock's cross-process semantics. Note this is a
*real* trust-boundary control (external world) and stays under P2.

### 1.3 Two incompatible `canonicalJsonBytes` under one name

`src/factory.js:4860` (compact, no trailing newline) vs
`src/checkpoint-publication.js:563` (pretty 2-space + trailing `\n`) — same
name, different bytes. `src/factory.js:493` carries a third helper,
`canonicalCheckpointPublicationBytes`, whose only job is to byte-match the
other module's format: factory writes the claim blob
(`git hash-object -w --stdin`, `src/factory.js:370`) and
`src/checkpoint-publication.js:177` re-serializes with its own implementation
and requires byte equality ("claim blob is not canonical immutable bytes").
Full inventory of canonical-JSON definitions: factory.js ×2, run-state.js:2212,
checkpoint-publication.js:563, checkpoint-completion.js:554, refs.js:140,
worktrees.js:248, cleanup-sweep-report.js:79,
delivery-envelope/checkpoint-routing.js:479 — **eight definitions, two byte
formats**.

**Disposition under P2:** the cross-module byte-equality proof is
factory→factory attestation — drop the re-serialization equality check
entirely; the claim is factory-authored and lock-serialized. Keep exactly one
exported canonical-JSON helper (for deterministic hashing where a hash is
still warranted) and migrate all nine sites.

---

## Part 2 — Systemic duplication (high; drift is the failure mode)

### 2.1 Closed vocabularies re-declared as literals in 8–12 files

- Verdict vocabulary: `src/validate.js:52-54`, `src/run-state.js:5084`,
  `src/cli.js:1099`, `src/factory.js:2434,7167,7184,7201`,
  `src/post-pr-ci.js:27`, `src/plugin.js:765`, `src/telemetry.js:61`,
  `src/tui-data.js:454` — ~10 files.
- Attempt cap: `src/validate.js:132` exports `SLICE_MAX_ATTEMPTS = 3`, yet
  `src/run-state.js:5570,6735,7523` and `src/cli.js:310` hard-code `3`, and
  `src/telemetry.js:407-410` hard-codes the 1..3 bound. Even run-state — which
  already imports 20+ symbols from validate — re-declares
  `TERMINAL_RUN_STATUSES` (`validate.js:17` vs `run-state.js:26`).
- The 15-phase post-PR vocabulary exists in **18+ literal copies** counting the
  catalog's frozen rejector strings (see 3.1).

Failure mode is *silent*: `telemetry.js` B6 allowlists (which duplicate the
13-agent roster twice within the same file, `src/telemetry.js:52` and `:64`)
drop any off-list value with no error — a new agent, route, verdict, or an
attempt-budget change vanishes from Honeycomb; the TUI mislabels; the CLI
rejects states the library supports.

**Fix:** one shared constants module; every consumer imports it.

### 2.2 B2 attempt/review invariants enforced twice in different idioms

At least six rules are written once in validate.js (record shape) and again as
hand-rolled run-state transition guards, without either calling the other:
append-only strictly-increasing attempts (`validate.js:4059` vs
`run-state.js:7563`); the cap (`validate.js:3974,4036` via constant vs
`run-state.js:7523` literal); history-entry/top-level binding equality
(`validate.js:4071-4079` vs `run-state.js:5528-5560` rebuilding an `expected`
object field-by-field); `blocked_reason` (`validate.js:4006` vs
`run-state.js:7549`); attempts positivity (`validate.js:4004-4005` vs
`run-state.js:7515-7519`); dispatch-quartet all-or-none
(`validate.js:4049-4050` vs `run-state.js:7373-7375`). Drift produces records
`validateRun` accepts but no transition can regenerate.

**Fix under P2:** one owner per invariant. Record-shape rules live in the
validator only; transition guards enforce only genuinely transition-relative
rules (old-vs-new comparisons) and call the validator for shape.

### 2.3 Three cloned claim/receipt/unknown state machines

`src/factory.js:2869-3041` (amendment execution, ~173 lines) structurally
clones `src/run-state.js:1372-1463` (B1R checked test execution) and
`src/run-state.js:1465+` (verification-artifact execution). Each
re-implements: active/completed/unknown claim states, nonce binding,
create-only receipt write with beforeCommit re-observation, exact-claim
assertion, and the same reason-string taxonomy. The subtlest recovery branch
("claim closure published but completion acknowledgement indeterminate",
`src/factory.js:2997-3002`) exists in only one copy.

**Fix under P2:** these guard a real boundary (process execution results), so
the receipt concept stays — but as **one** engine, and simplified: the
run-json lock already serializes local writers, so the nonce ceremony and
re-observation choreography reduce to claim → execute → receipt with a single
crash-recovery rule.

### 2.4 Error-message text is load-bearing API

- Two **already-drifted** copies of the launch-failure classifier:
  `src/factory.js:1836` (`/readiness|timed out/iu`) vs `src/factory.js:2002`
  (`/readiness|timed out|disconnect|before readiness/iu`) — the same pattern
  whose heartbeat instance was previously fixed via exported
  `assertHeartbeatStartable` (`src/factory.js:3142`).
- Cross-module message matching: `src/factory.js:2788` regexes a validate.js
  template (`validate.js:2067`); `src/factory.js:6625` regexes run-state's
  lock-timeout message (`run-state.js:9175`); `src/run-state.js:3307-3318`
  routes probe errors on message *content*, sending anything matching
  `/checkpoint/iu` to `plan.delivery_envelope.checkpoint_plan`.
- Exact-equality on strings: `src/process-evidence.js:930,942,958`.
- Scale of pinning: the mutation catalog holds **611 exact rejector literals**
  (202 unique strings, strict-equality matched); one shared validate.js string
  fans out to 19 test literals; ~129 additional regex message assertions across
  the three core test suites. Error *codes* exist but are used at roughly 5 of
  ~1,125 throw sites.

**Fix under P2:** error codes on every message any code dispatches on (~20
sites); tests and the catalog bind code + path, never prose. Prose becomes
freely editable.

### 2.5 Post-PR attribution unified in name only (B3.3)

`createOwnershipIndex` (`src/post-pr-ci.js:428`) did unify path matching, but:
(a) the classify→fetch-changed-files→reclassify sequence is copy-pasted at
`src/factory.js:2229-2240` and `:7258-7266` with *different* error handling;
(b) `regenerateFailureEvidence` (`src/factory.js:7275-7286`) hand-synthesizes
an ownership envelope that must byte-match `routeSlice()`/`integration()`
output (`post-pr-ci.js:749-750`) or fingerprint replay fails closed;
(c) `classifyPanelOwner` (`src/factory.js:7111-7125`) hardcodes `test/` and
`.github/workflows/` prefixes, duplicating `TEST_PREFIXES`
(`post-pr-ci.js:19`) and skipping `isUnsafeRuntimePath`.

**Fix:** one attribution function, one prefix list; the fingerprint byte-match
on a factory-authored envelope is internal attestation — drop it (P2).

---

## Part 3 — Cost centers (medium; maintenance amplification)

### 3.1 Mutation catalog has no update story — and P2 narrows its scope

A single schema change costs ~40–60 hand-edited literal sites across 5+ files
(measured on the actual B2 commit `383a7ec`: 24 files; helper +204/−47
including 30 digest-line edits). The manifest hash functions are
module-private (helper:4093,4180,4206) and the test *asserts on the helper's
own source text* that manifests are never derived from RECORDS
(test:1480-1503) — recomputing digests requires throwaway scratch crypto.
Digest-mismatch errors print neither expected nor actual. There is no script,
doc, or comment describing the update ritual. The drift it guards against has
already happened to its own spec: `ISSUE-69-IMPLEMENTATION-DAG.md:401-402`
says "exactly 109 rows, 108 production-covered"; reality is 196/195
(test:936-937).

**Disposition under P2:** narrow the catalog to records that cross a trust
boundary (agent-authored reviews, evidence, artifacts, external observations).
Catalog cases proving the factory rejects hand-corrupted *factory-authored*
records are out-of-scope attestation — delete them with their manifests.
Accepted caveat on the retained scope: agent-authored **review** records keep
full mutation coverage — schema, binding identity (subject, attempt,
`reviewed_commit`, evidence/review hashes), and **the fields the factory
routes on** (verdict, convergence, classification, `scope_effect`). "Fields
the factory routes on" is the boundary; vaguer notions of "consequential
fields" are not, or the catalog regrows without limit. For what remains: a
`catalog:review` script that prints old/new oracle snapshots plus recomputed
digests, expected/actual in mismatch errors, and code+path (not
message-prose) rejector binding per 2.4.

### 3.2 The central write pipeline is a flag interpreter

`transitionRunJsonLocked` (`src/run-state.js:3485-3556`) dispatches on ~15
hook keys, then at `:3547-3553` *translates hooks back into a second
`options.*` namespace* so `writeProtectedRunJson` (`:3797-3830`) can re-derive
the same authority. Flag semantics are non-obvious (`terminal: true` both
permits terminalization and flips amendment blocked-terminal behavior). Every
new record family adds a lane in both namespaces. Related waste: four guards
run twice on the identical object (`:3510-3514` then `:3517-3520`,
byte-identical, uncommented), and `validateRun(JSON.parse(readFileSync(...)))`
appears at 19 sites — the worst, `observeAttemptReviewDispatch` (`:7376`),
re-reads and re-validates the whole run *per history entry*, so one slice
transition at attempt 3 pays ~12 full `validateRun` passes.

**Fix under P2:** validate once per write under the lock; delete the doubled
guard pass and the mirrored options namespace (the lock already serializes;
in-lock re-derivation is internal attestation).

### 3.3 Mirror-maintenance pairs

- `buildContinuationCandidate` (`src/factory.js:4162-4290`, 130 lines)
  field-mirrored by `assertContinuationBindingsCurrent` (`:4292-4392`,
  100 lines); the `CARRY_FORWARD_ALLOCATION_REPLAY` Symbol threads through 9
  sites toggling three availability predicates.
- Two hand-built initial-run literals: `initialCarryForwardRun`
  (`src/factory.js:4635-4711`) vs `buildChildRun`
  (`src/checkpoint-publication.js:270-348`) — already drifted stylistically.
- Checkpoint observer wiring copy-pasted at 6 sites; two ~25-line
  near-duplicate PR-operation observers; the lineage-chain algorithm
  implemented twice with *different* edge behavior.
- The hash-binding ritual inlined ~80× in run-state.js with per-site
  variation. Under P2 most of these sites disappear (internal records lose
  their hashes); the survivors (agent-artifact handoff) use one
  `readBoundFile` helper.
- Content-address template inlined as string literals at 7 sites across 3
  modules.

### 3.4 `remediation_context` over-constrains the LLM producer

`src/validate.js:207-280`: the fix count is encoded three mutually
cross-checked times, each fix echoes its own array index, and nonconvergence
is encoded twice — all fully derivable. The producer is the work-reviewer
agent; prompt drift that miscounts *with zero semantic disagreement about the
fixes* fails closed and **burns an attempt**; on attempt 3 the run
terminalizes as nonconvergent for bookkeeping reasons. The 8 classifications
collapse to a boolean downstream (`:278`).

**Fix under P2:** derive, don't echo. Keep the DAG-mandated count binding at
most; drop index echoes and the dual nonconvergence encoding. This is the one
finding that costs real blocked runs today.

### 3.5 CLI parsing and wiring

One global ~70-flag namespace (`src/cli.js:30-31`), a 68-line if-chain in
`options()` (`:649-717`), `positionals()` consuming values against the
*global* VALUE_FLAGS (`:765-777`), an exact-index grammar for `amendment`
(`:376-403`). Unknown flags silently ignored on ~36 of ~40 subcommands.
Measured wiring cost of one new subcommand (B1R's `test-execute`): ~12–15
files, 5 of them prose pinned only by docs-contract regexes.

### 3.6 TUI shadow state machine

`src/tui-data.js:447-459` infers workflow phase from pre-B1R workflow shape
and is already stale (a run waiting on `factory test-execute` is mislabeled).
Three byte-identical recursive projection walkers in one file
(`:502,510,519`).

### 3.7 process-evidence duplicated readers

`readProcessEvidence` (`:308-327`) vs `readProcessEvidenceForCleanup`
(`:353-374`) are near-identical hardened readers differing subtly — a security
fix applied to one does not reach the other. Merge into one reader. (The
legacy shim half of this file is L10.)

---

## Part 4 — What is genuinely healthy

- `src/checkpoint-publication.js` / `src/checkpoint-completion.js` and the
  `src/delivery-envelope/` directory: cohesive, closed-schema,
  dependency-injected. B4.2/B4.4 really did activate by touching only their
  own slot files; a new invariant *family* is plan data, zero code.
- The heartbeat consolidation (`assertHeartbeatStartable`,
  `src/factory.js:3142`, consumed by `src/cli.js:1187`) proves the extraction
  pattern works here; it has simply only been applied once.
- The boundary controls that P2 keeps are real and observed-necessary:
  factory-executed receipts, git-observed merge facts, hash-bound
  agent artifacts, commit-bound reviews.
- Fail-closed discipline is uniform. Nothing reviewed trusts an agent claim
  where the DAG required observation.

## Part 5 — Legacy retirement inventory (per P1)

Complete inventory of legacy retained at `335434c`. Under P1, every
disposition is **delete the old shape/route outright**: no dual-read, no
migration tooling, no sweep. Where a persisted old-shape record exists, the
validator rejects it and the run is abandoned/re-seeded.

| # | Legacy item | Evidence | Disposition |
| --- | --- | --- | --- |
| L1 | `merged_slice_repair` state machine (statuses, fences, transitions, quiescence guards) | `run-state.js` ~19 refs incl. 7 fence sites; `validate.js` 15 refs; coexistence guard ×3 | **Delete.** Generic integration amendment is the sole repair authority. Delete transitions, fences, validators, catalog records, and `test/merged-slice-repair.test.js` (port any adversarial case not already covered by `integration-amendment.test.js` — B5.4's parity suite should make this mostly deletion). |
| L2 | Legacy-eligibility exception probe | `run-state.js:8755-8768` | **Delete with L1.** Generic admission either admits or rejects with a reason; no fallback route. |
| L3 | Generic-admission carve-outs that existed to route continuation/checkpoint runs to legacy (`integration-amendment-continuation-unsupported`) | `run-state.js:1978`, `run-state.js:8023`, `factory.js:2793` | **Decide explicitly** (open decision, recommendation below): with legacy gone, either (a) extend generic amendment to inherited-authority runs — the "separately approved sidecar-copy and first-parent proof design" the B5.1 doc names — or (b) declare repair-in-place unsupported on continuation/checkpoint runs and non-pristine consumers: the run terminalizes and the fix arrives via a fresh carry-forward continuation. **Recommendation: (b)** — carry-forward is already the uniform escape hatch everywhere else (B2 nonconvergence routes there), and it is the smaller proof surface. Trade-off acknowledged: a one-line defect on a continuation run costs a continuation cycle instead of an in-place amendment. |
| L4 | `factory repair` CLI command | `cli.js:96` | **Delete with L1**; `factory amendment` is the only repair surface. |
| L5 | v1 continuation route and v1-shaped continuation construction | inline v1 route in `continueFactoryImplementation` (`factory.js:1580-1597`); `legacyContinuation` builder (`factory.js:4978-4993`) | **Delete.** v2 carry-forward is the only continuation. Delete the v1 construction path, v1 validator branches, and v1 route/schema plumbing (`routeSchemaError` dual-schema machinery collapses). |
| L6 | v1 plans without `integration_gate.required_commands` ("readable but ineligible") | B1C acceptance; dual-shape validator branches | **Delete readability.** Plans without the v2 integration gate are rejected outright; re-seed the plan. Delete dual-shape branches and the catalog's legacy-plan rows. |
| L7 | Legacy PR fence without operation identity → needs-human reconciliation path | `run-state.js:1173-1181`; `factory.js:1070-1077` (`transitionLegacyPrFenceNeedsHuman`) | **Delete.** An identity-less fence is an invalid record under the current schema; validation rejects it and the run is re-seeded. No reconciliation path. |
| L8 | Legacy panel rows without complete binding (read-only legacy completed runs; legacy panel *upgrade* path) | `run-state.js:3406-3413`, `:4550` | **Delete both branches.** Current schema requires complete bindings; old-shape completed runs are archival files the factory no longer reads as authority. No upgrade path. |
| L9 | Legacy dispatch-reconciliation closure kind (`checked-slice-builder-dispatch-reconciliation` widened key set) | `run-state.js:7239-7251` | **Delete.** One closure shape. |
| L10 | process-evidence legacy test seams: 4 alias option names for liveness injection, 2 for inspectors, 2 each for clock/sleep; `legacyVerificationContext` fabricating `platform:"linux"` + synthetic `/proc/<pid>/stat` | `process-evidence.js:622-748, 819-839, 746-748`; 3 more mentions in `hardening/process-verification.js` | **Delete.** One injection seam per concern; port tests to the real inspector interface. *(Accepted caveat: this is a test seam, not persisted compatibility — the justification is reduced maintenance surface, not P1.)* |
| L11 | Duplicated hardened evidence readers | `process-evidence.js:308-327` vs `:353-374` | **Merge into one reader.** *(Same relabel as L10: maintenance-surface cleanup, not P1.)* |
| L12 | Program docs encoding superseded facts | `ISSUE-69-IMPLEMENTATION-DAG.md:401-402` (109/108 vs actual 196/195); DAG untracked | **Commit the DAG with a superseded banner** pointing at this review. An authority program whose governing spec is unversioned and rotting is itself a legacy liability. |

## Part 6 — Execution sequence (tracked in GitHub issues)

The work breakdown lives in the tracker; this section records only the
sequence and rationale. The issues are the consumable units for factory runs;
this document is the policy authority they cite. (The DAG's lesson applies:
this doc does not duplicate per-issue detail, so it cannot rot against it.)

| Step | Issue | Scope | Depends on |
| --- | --- | --- | --- |
| 0 | #109 | `GH_CONFIG_DIR`-isolated gh operations (1.2) — the one operationally dangerous race; independent, ship first | — |
| 1 | #110 | Legacy retirement (Part 5, L1–L12); L3 decided in-PR (recommendation: option b, repair-by-continuation); removes the inverted probe (1.1) by deletion | #109 (soft; keeps hotspot PRs serial) |
| 2a | #111 | P2 attestation-deletion sweep (keep/simplify/drop table: 1.3, 3.2, 2.3-simplify, 2.5, 3.4) plus reviewer/catalog-registration recalibration | #110 |
| 2b | #112 | P3 width recalibration (simplification block, countable acceptance probes, width budget, scope-terminal routing) | adjacent to #111 (shared prompt files); width budget may land earlier |
| 3 | #117 | Validator family split: `src/validate/` per-record-family modules behind a re-export index — behavior-identical extraction that removes the persistence lane choke point (evidence: the issue-103 fail-closed stop; the DAG's shared-file serialization table) | #111 |
| 4 | #113 | Substrate extraction (constants, canonical JSON, claim/receipt engine, attribution, error codes; one owner per invariant), consolidating guards directly into validator family modules | #111, #117 (or land atomically with #117) |
| 5 | #114 | Catalog narrowing + tooling (3.1, code+path binding, `catalog:review`) | #113 |
| 6 | #118 | Run-state family split: core write pipeline + per-family transition modules behind a re-export index | #110, #111, #113, #117 |
| 7 | #104 | Post-refactor durable wait state + truncated-output recovery, built on the new substrate (wait-state records land in their own family module) | #113, #114, #118 |
| — | #103 | Pre-refactor operational hardening — independent; re-seed with the mandated split after its two width-blocked runs (the P3 evidence) | — |

Sequencing rationale: steps 1 and 2 are deletion-dominant and interact — in
that order, the behavior-identical validator split (3) operates on the smallest
surviving surface. Substrate extraction (4) then establishes one owner per
invariant directly in the validator family modules, avoiding a monolithic
consolidation followed by a second move. Steps 2a/2b are one recalibration
batch: P2 fixes the proof-mass ratchet, P3 the spec-mass ratchet, and both edit
the same reviewer prompts. Opportunistic cleanups (CLI flag scoping 3.5, TUI
projection dedup 3.6, mirror pairs 3.3) ride along when their files are next open — no
dedicated issue, by design.

## Verification notes

Independently re-verified against `335434c` before inclusion: the
`gh auth switch` lock scope (1.2); both `canonicalJsonBytes` bodies, the
bridge helper, and the 8-definition inventory (1.3); the L2 exception probe
and retirement message (1.1); telemetry allowlists including the duplicated
13-agent roster and hardcoded 1..3 attempt bound (2.1); the DAG 109/196 rot,
the 611 rejector-literal count, and the 19-copy message fan-out (3.1, 2.4);
the B0.1 threat-contract text and B0.4 charter quoted in P2; the
`CONTINUATION-SCOPE-DESIGN.md:485-490` rationale quoted in L3. Remaining
line-level citations are from the four deep reviews and were spot-checked but
not exhaustively re-derived. Policy decisions P1/P2 were set by the operator
on 2026-07-23 in review conversation; P2 quotes B0.1/B0.4 to show it ratifies
the program's own documented threat model rather than introducing a new one.

Amendment provenance: the six italicized "accepted caveat" clauses (P1
skew-rule and resumability framing; P2 three-case re-observation boundary;
validate-once scope; size-figure demotion; L10/L11 relabel; catalog
routing-fields scope) originate from opencode's counter-review of this
document and were accepted by the operator on 2026-07-23. They constrain the
deletion work; none of them authorizes compat machinery or preserves same-lock
re-verification.

P3 provenance: added 2026-07-25 from the `issue-103-retry`/`issue-103-retry-2`
dogfood evidence (verified directly: the 1-family × 1-obligation envelope
prose, the 8/16-vs-3/6 acceptance-row/path counts in `plan/slices.json`, the
`familyCount > 1` precondition in
`src/delivery-envelope/admission-policy.js`, and both runs' attempt review
trajectories). The acceptance-probes-as-spec-line-items decision (not
pre-written test code) was set by the operator in the same review
conversation.
