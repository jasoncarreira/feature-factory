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

### Two independent axes

The failure is a combination of two axes that must not be conflated:

- **Work scope** — which slices a continuation is responsible for producing/decomposing. Today `factory continue` scopes this narrowly (`continuation.review.required_fixes`, `assets/command/feature.md`, `assets/skills/feature/SKILL.md`).
- **Integration ancestry** — what already-completed implementation is physically present in the branch the child is built from. Today `factory continue` derives the child `target.base_commit` from the *parent's recorded base commit* (falling back to the base ref) and reuses only accepted planning **provenance** (story/research/brief artifacts + spec-review), **not the parent's merged slice code** (`src/factory.js` continuation build). So a child does not automatically inherit its parent's merged implementation.

The observed dead-end needs *both*: **independent sibling continuations, each branched from a base that lacks the others' required implementation.** A narrow continuation whose base already contains the prerequisite work can pass the gate; a full-scope continuation can still fail if the completed parent slices are absent from its base. The precise failure topology — not an absolute rule — is: *sibling continuations from a shared base missing each other's implementation cannot individually satisfy the whole-story gate.*

This also interacts with the decomposition-depth cap: splitting to avoid a god-slice (or to keep remediation bounded) pushes work toward multiple continuations, which then hit the whole-story gate. Depth cap ↔ slice size ↔ continuation scope ↔ integration ancestry are the interacting axes.

## Options

**A. Continuation carries the full remaining plan *and* an explicit ancestry rule (recommended).** A blocked run is continued as *one* run that owns the whole remaining plan and resumes at the first incomplete slice, remaining slices running as normal dependency waves. But "full remaining plan" is only the *work-scope* half — it does not by itself make the final branch whole-story-complete, because today's continuation does not inherit the parent's merged implementation. Option A must therefore also pick an **integration-ancestry** rule for the already-completed slices:
- **(a) Branch the child from the parent's validated integration HEAD** and preserve merged-slice state. Cleanest whole-story ancestry; requires `factory continue` to base the child on the parent's integrated worktree HEAD (not its base commit) and to durably re-adopt those slices as accepted.
- **(b) Rebaseline on current `main`** and reconcile parent work as read-only evidence — appropriate once sibling PRs have landed on `main` (the existing README recovery/rebaseline contract). Risk: stale base if sibling work has *not* landed.
- **(c) Replay/rebuild completed slices** in the child. Safe ancestry but duplicates already-reviewed work and re-spends budget; generally the worst option.
- Pro: keeps the pre-PR gate as the correctness anchor; option (a) matches the original single-run resume model; parallelism across remaining slices is preserved as waves.
- Con: needs a real change to how `factory continue` establishes the child base (it currently does none of (a)/(c)); a continuation is as large as the remaining work.

**B. Scope-aware pre-PR gate.** A continuation declares itself scope-partial; the panel evaluates only in-scope acceptance criteria, and PR creation is gated on a separate "all sibling continuations merged" join condition.
- Pro: keeps per-concern continuations.
- Con: adds a durable partial-completion state and a cross-continuation join — more machinery, and it risks shipping a whole-story-incomplete PR unless the join is rigorously enforced. This is the heaviest option.

**C. Strictly sequential (chained) continuations.** Continuations are serialized, each starting from the prior's reviewed handoff branch, so the last one carries the fully integrated tree and faces the whole-story gate legitimately. Historical serialized-epic guidance prescribed this for some epics. Note this is primarily an **integration-ancestry** fix, not merely a parallelism tradeoff: chaining changes each child's base to include the prior's implementation, so it can succeed precisely where independent siblings from a shared base cannot — it resolves the same ancestry gap as Option A(a), by branch topology rather than by a `factory continue` change.
- Pro: reuses the existing branch model; no new state.
- Con: no parallel remediation across slices; a mid-chain block strands the rest.

**D. Don't fragment at all.** The observed failure is that one blocked feature was split into three named sibling continuations. Treat that as the anti-pattern: a blocked run has one continuation.
- This is essentially Option A stated as a rule rather than a mechanism change.

## Recommendation

**The fragmentation is the anti-pattern, not the gate.** The pre-PR panel's whole-story judgment is a feature — it is what prevents shipping a half-built feature — and should not be weakened to per-slice (Option B's failure mode). Prefer **Option A / D**: a blocked run is continued as a single run that owns the whole remaining plan and resumes at the first incomplete point; if parallel remediation is wanted, that is waves within the one continuation, not separate runs.

But work-scope alone is insufficient: Option A must also fix **integration ancestry**, because today's `factory continue` bases the child on the parent's recorded base commit and reuses only planning provenance — it does not carry the parent's merged slice code. The recommended ancestry rule is **A(a): branch the child from the parent's validated integration HEAD and durably re-adopt those slices**, falling back to **A(b): rebaseline on `main`** once sibling PRs have landed. Chaining (Option C) achieves the same ancestry outcome by branch topology and is a reasonable interim path for serialized epics. Whichever is chosen, the two axes must be decided together — a full-scope continuation on a base missing the completed slices still fails the gate.

## Decision needed

For `factory continue`, both axes must be decided together:

1. **(Recommended — work scope)** Require a continuation to carry the full remaining plan — and add guidance/guardrails so a blocked run is not fragmented into per-slice sibling continuations. Keep the whole-story pre-PR gate unchanged.
2. **(Recommended — integration ancestry)** Give the child a base that contains the parent's completed slices: base it on the parent's validated integration HEAD and durably re-adopt those slices (A(a)), or rebaseline on `main` once sibling PRs land (A(b)). Today it does neither, so this is a real `factory continue` change, not just guidance.
3. Alternatively, grow a scope-partial continuation state plus a cross-continuation PR-join condition (Option B) — only if per-concern parallel continuations are a hard requirement. This is the heaviest path and weakens the whole-story anchor.

## Non-goals

- Do not build a cross-run merge-train / join orchestrator (heavy; Swarm-style infrastructure this project has deliberately avoided).
- Do not weaken the pre-PR panel to evaluate less than whole-story coverage as the default path.
