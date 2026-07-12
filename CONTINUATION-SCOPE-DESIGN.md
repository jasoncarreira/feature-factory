Status — design question, 2026-07-12: an open decision, not the current contract. `README.md` is current authority. This documents a structural tension observed in dogfood runs and frames the choice; it does not change behavior.

# Continuation Scope vs. Whole-Story Gates

## The question

When a blocked run's remaining work is resumed as **several narrowly-scoped continuations**, each continuation's branch carries only a subset of the story's slices — but the pre-PR panel judges **whole-story** completeness against that branch. A narrowly-scoped continuation is therefore structurally unable to reach GO no matter how good its own work is. Do we fix the continuation model (one continuation owns the whole remaining plan) or make the pre-PR gate scope-aware?

## Evidence

Parent run `cleanup-conservative-sweep` blocked with four of seven slices merged. Its remaining work was resumed as **three separate continuations** off the same parent:

- `cleanup-command-output-continuation` → **completed**
- `cleanup-eligibility-continuation` → **blocked**
- `cleanup-conservative-sweep-continuation` → **needs-human** (unrelated: steering conflict)

`cleanup-eligibility-continuation` did its job correctly — the four selected eligibility fixes are closed and its own test-verifier and security reviews passed. It blocked only at the holistic pre-PR panel, whose `implementation-validator` returned NO-GO:

> "The four selected eligibility fixes are closed, but the integrated branch does not deliver the accepted repository-wide cleanup feature: production orchestration, exact CLI grammar, digest execution, rendering, and required execution/docs coverage remain absent."

Those absent surfaces are owned by *sibling* continuations, not by this one. The validator is correct — the branch it sees is not a shippable feature — and the continuation is also correct — it completed its declared scope. Both are right; the run still dead-ends.

## Why it happens (the structural tension)

Two mechanisms that are individually sound collide:

1. **Narrow remediation** (PR #44). `factory continue` reuses the parent's durably-accepted plan and scopes decomposition to `continuation.review.required_fixes` — deliberately *not* re-decomposing the whole brief, so a targeted fix converges within the bounded remediation budget. Good for fixing one blocking review.

2. **Whole-story pre-PR gate.** The `implementation-validator` is holistic by design: it judges every acceptance criterion → code → test across the *integrated* branch. A PR should not ship a partially-implemented feature.

The gap: a continuation scoped to a subset of the plan is **complete for its scope but incomplete for the gate**. When a blocked run is fragmented into N per-slice/per-concern continuations, each one's branch lacks its siblings' slices, so each is destined to fail the whole-story panel. Only a continuation that carries the entire remaining plan can legitimately pass it.

This also interacts with the decomposition-depth cap: splitting to avoid a god-slice (or to keep remediation bounded) pushes work toward multiple continuations, which then hit the whole-story gate. Depth cap ↔ slice size ↔ continuation scope are a three-way tension.

## Options

**A. Continuation carries the full remaining plan (recommended).** A blocked run is continued as *one* run that reuses the accepted plan plus all already-merged slices and resumes at the first incomplete slice — remaining slices run as normal dependency waves within that single continuation. The whole-story gate then applies legitimately, once, at the end.
- Pro: keeps the pre-PR gate as the correctness anchor; no new state; matches the original single-run resume model; parallelism across remaining slices is preserved (as waves).
- Con: a continuation is as large as the remaining work; loses the "one narrow fix per continuation" framing for multi-slice remainders (but narrow remediation still applies *within* a slice).

**B. Scope-aware pre-PR gate.** A continuation declares itself scope-partial; the panel evaluates only in-scope acceptance criteria, and PR creation is gated on a separate "all sibling continuations merged" join condition.
- Pro: keeps per-concern continuations.
- Con: adds a durable partial-completion state and a cross-continuation join — more machinery, and it risks shipping a whole-story-incomplete PR unless the join is rigorously enforced. This is the heaviest option.

**C. Strictly sequential (chained) continuations.** Continuations are serialized, each starting from the prior's reviewed handoff branch, so the last one carries the fully integrated tree and faces the whole-story gate legitimately. (The TODO's serialized-epic guidance already prescribes this for some epics.)
- Pro: reuses the existing branch model; no new state.
- Con: no parallel remediation across slices; a mid-chain block strands the rest.

**D. Don't fragment at all.** The observed failure is that one blocked feature was split into three named sibling continuations. Treat that as the anti-pattern: a blocked run has one continuation.
- This is essentially Option A stated as a rule rather than a mechanism change.

## Recommendation

**The fragmentation is the anti-pattern, not the gate.** The pre-PR panel's whole-story judgment is a feature — it is what prevents shipping a half-built feature — and should not be weakened to per-slice (Option B's failure mode). Prefer **Option A / D**: a blocked run is continued as a single run that re-adopts the accepted plan and all merged slices and resumes at the first incomplete point; if parallel remediation is wanted, that is waves within the one continuation, not separate runs.

## Decision needed

For `factory continue`, choose one:

1. **(Recommended)** Require a continuation to carry the full remaining plan — and add guidance/guardrails so a blocked run is not fragmented into per-slice sibling continuations. Keep the whole-story pre-PR gate unchanged.
2. Grow a scope-partial continuation state plus a cross-continuation PR-join condition (Option B) — only if per-concern parallel continuations are a hard requirement.

## Non-goals

- Do not build a cross-run merge-train / join orchestrator (heavy; Swarm-style infrastructure this project has deliberately avoided).
- Do not weaken the pre-PR panel to evaluate less than whole-story coverage as the default path.
