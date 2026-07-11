# Run latency & spec-churn findings

Diagnosis of why the current/blocked feature-factory runs (the ones building the dogfood
takeaways: `centralized-hardening-*`, `git-fixture-*`, `steering-*`) take hours and why the
spec-writer keeps getting rejected. All figures from run.json step/slice timestamps,
`reviews/*.json`, and the per-run process logs.

## Why the spec-writers are having a hard time

The class-wide-inventory discipline (PR #42 + the `codebase-researcher`/`spec-writer`/
`work-reviewer` prompt changes) is now live and is being applied to the most class-wide work
possible ("centralize the hardening primitives and apply at every sink", "migrate all
fixtures"). The spec must now close the entire world up front — a finite source→sink
inventory, per-call-site policy, every lock/heartbeat state-transition table, compatibility
prototypes, and a test per row.

Two things make it churn instead of converge:

- **The spec reviewer drip-feeds enumeration demands.** Round 1 rejects on
  output-inventory + env-snapshot + identity-API + lock-state-table + heartbeat-parsing;
  round 2 rejects on *mostly new* items (opaque constructors, `process.json` normalization,
  `heartbeatOnce` transitions, `doctor.js` sanitizer). It is the same "one more sink each
  round" pattern the retrospective found in *build* remediation, now visible in the *spec*
  phase. This is an **enforcement/observability gap, not a missing rule**: PR #42 already
  added the first-attempt consolidation rule to `assets/agent/work-reviewer.md` and Step 2
  of `SKILL.md`, and it applies to spec reviews. The observed rounds show the reviewer did
  not consolidate as instructed — it enumerated roughly one category per round instead of
  every discoverable dimension at `attempt: 1`. The open question is *why* later reviews
  produced new same-class demands: was the full research inventory available to round 1, and
  did the reviewer actually inspect it? The lever is to strengthen the rule to require every
  *dimension* of under-specification up front and to make first-pass completeness observable
  (PR #45), not to add a rule that already exists.
- **Each spec rewrite is expensive** (~50–110 min per draft; one ran 1h50m) while the review
  itself is cheap (~6–15 min). The cost is the writer regenerating a giant brief every round.
  Note: `resolved_models` is null in the run snapshots, but that is a **telemetry gap, not
  proof the writer ran on a weak model or default reasoning effort**. The active operator
  config maps `spec-writer` to GPT-5.6 Sol `xhigh` and `work-reviewer` to `high`; the
  `factory env` snapshot collected model resolution without the operator's `opencode.jsonc`
  profiles, so it recorded null. Treat null as unknown resolution — a diagnostic blind spot —
  unless runtime evidence demonstrates an actual profile fallback. PR #46 narrows the snapshot
  to explicitly non-authoritative visible plugin-profile provenance.

Observational before/after association (not a controlled A/B — these are different runs and
workloads with no controlled assignment and obvious confounders, so read it as a signal, not
proof): the pre-class-wide run `steering-drain-boundaries` (sampled 2026-07-06) took 1 spec
attempt, ~20 min; the post-#42 runs sampled 2026-07-07/08 took 2–3 attempts and 1–2.5h, and at
the time of that analysis the two `-completion` continuations were stuck in the spec loop.
Those specific run-status observations are historical — later runs and the fixes in PRs
#44/#45/#46 have since changed the picture.

## Why the runs take so long (by wall-clock share)

1. **Spec churn** — `centralized-hardening-primitives` spent **56%** of 4h21m in spec; both
   running `-completion` continuations are **100%** in spec and still going.
2. **Pre-PR panel + bounded remediation** — `steering-race` **~47%** (~2h), `steering-drain`
   **~74% of active time** (~2h) in test-verifier → validator → security → 3× remediation,
   single passes near 60 min; both burned `max_retries=3` and still terminated `blocked`.
3. **Large serialized slice DAGs that block mid-chain** — `primitives` cut a **13-slice** DAG
   with a 5-deep dependency chain; when slice 5 (`output-policy`) exhausted 3 attempts, **7
   downstream slices stayed pending** with the hours already spent.

Amplifiers:

- **Continuation runs redo the whole spec from scratch.** The `-completion` runs re-run
  story→research→spec even though the parent already had an *accepted* brief — the entirety
  of their current (stuck) time. **This is the biggest immediate waste.**
- **Every attempt re-runs the full serialized test suite** (`node --test --test-concurrency=1
  test/*.test.js` + `npm run smoke:pack`) 9–16× per run, on integrated diffs up to `41 files
  changed, 5212 insertions`.

Not causes this time: no git-signing failures, no lock contention (healthy 30s heartbeat).
`steering-drain`'s raw 17h is mostly its overnight orphan idle, not compute.

Honest caveat: the specific slices that blocked (secret-scrubbing wildcard-identity bypass,
structural-boundary child-process variants, lock-owner liveness revalidation) are genuinely
hard, correctness-critical concurrency/security contracts that exhausted `max_retries` on
their merits — bounded escalation working as designed. The levers below make the factory
*cheaper and faster to get there*; they will not make those specific slices auto-complete.

## Levers (highest impact first)

1. **Continuation reuses the parent's *durably accepted* brief instead of regenerating it.**
   `factory continue` seeds the parent's planning artifacts (`story.md`, `research-map.md`,
   `design-brief.md`, `technical-brief.md`) into the child `$RUN/artifacts/` **only when the
   parent has an accepted, approved `spec-writer` step** (`continuation.planning_reuse.eligible`)
   — hash-verified and transactional (fail-closed; no partial child dir) — and carries the
   approving spec review into `$RUN/reviews/spec-writer.json` so the adopted acceptance
   resolves in child state. The SKILL/command instruct the orchestrator to reuse them, record
   the adopted acceptance against that child-local review, decompose only the blocking
   review's `required_fixes`, and skip story/research/spec regeneration unless those fixes
   require spec/plan changes. When the parent brief was not accepted, nothing is seeded and it
   is amendment input only. **← addressed in this PR.**
2. **Strengthen and enforce the consolidate-don't-drip-feed rule in the *spec* review.** The
   rule already exists (PR #42) and applies to specs; the churn is under-enforcement, not
   absence. Broaden it to require every *dimension* of under-specification at `attempt: 1`
   (not just each same-class instance), add a finite acceptance bar so reviewers stop
   extending the loop for achievable-but-absent depth, and bound deferrals/residuals so an
   in-scope sink cannot be waived. **← PR #45.**
3. **Make visible plugin-profile telemetry honest.**
   A null `resolved_models` entry is not evidence of a weak or absent runtime model: the
   snapshot can observe feature-factory plugin profiles in supported files, but not OpenCode's
   full merged agent configuration, inheritance, or managed/inline sources. Record that
   observation scope and preserve unknown/error provenance. Keep provider/model-specific
   variants explicit rather than inventing unsupported reasoning-effort names. **← PR #46.**
4. **Cap decomposition depth** — a 13-slice DAG with a 5-deep chain strands 7 slices on one
   block; prefer shallower/wider waves so one hard slice does not freeze the rest.
   *(follow-up)*
5. **Scope the test runs** — run only the slice's named tests during slice review; reserve
   the full serialized suite + `smoke:pack` for the pre-PR panel. *(follow-up)*
