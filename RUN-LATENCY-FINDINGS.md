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
  round" pattern the retrospective found in *build* remediation — PR #42 relocated it into
  the *spec* phase. The consolidate-don't-drip-feed rule was added for build reviews but
  not spec reviews.
- **Each spec rewrite is expensive** (~50–110 min per draft; one ran 1h50m) while the review
  itself is cheap (~6–15 min). The cost is the writer regenerating a giant brief every round,
  and `resolved_models` is null — the hardest planning task runs on the default model with
  no elevated reasoning effort.

A/B proof it is new behavior: `steering-drain-boundaries` ran pre-class-wide (1 spec
attempt, ~20 min); the post-#42 runs take 2–3 attempts and 1–2.5h, and the two `-completion`
continuations are currently ~100% stuck in the spec loop.

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

1. **Continuation reuses the parent's accepted brief instead of regenerating it.**
   `factory continue` now seeds the parent's accepted planning artifacts (`story.md`,
   `research-map.md`, `design-brief.md`, `technical-brief.md`) into the child `$RUN/artifacts/`
   (hash-verified; outcome artifacts excluded), and the SKILL/command instruct the
   orchestrator to reuse them and skip story/research/spec regeneration unless the blocking
   review's `required_fixes` require spec/plan changes. **← addressed in this PR.**
2. **Apply the consolidate-don't-drip-feed rule to the *spec* review**, not just build
   reviews: the first spec review must enumerate all missing inventory in one pass, and a
   spec may be accepted with a reviewed inventory without pre-deciding every micro-contract
   (leave a bounded residual to build remediation). *(follow-up)*
3. **Configure a stronger model / higher effort for `spec-writer` and the reviewers**
   (`resolved_models` is null today). *(follow-up)*
4. **Cap decomposition depth** — a 13-slice DAG with a 5-deep chain strands 7 slices on one
   block; prefer shallower/wider waves so one hard slice does not freeze the rest.
   *(follow-up)*
5. **Scope the test runs** — run only the slice's named tests during slice review; reserve
   the full serialized suite + `smoke:pack` for the pre-PR panel. *(follow-up)*
