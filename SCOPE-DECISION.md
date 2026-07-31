# What we need, what we drop, and whether to start over

Prepared 2026-07-29 after reviewing Phase 0c. Companion to
`VISO-BASELINE-COMPARISON.md`. Target: **viso `/feature` + atomic-ish `run.json`
transitions + autonomous builds.** Everything above that must be justified.

## Phase 0c verdict: Gate 2 passes, verified by reading

- `schema-neutral-write-core.js` is **130 lines** and contains **zero** family
  names (`grep -ic 'checkpoint|receipt|terminal|steering|post.?pr|slice'` → 0).
- No schema knowledge: `validateEnvelope` is injected. No family branches, no
  family flags. Per-family behaviour only via a contract's four methods
  (`project`, `validateProjection`, `validateTransition`, `reobserve`).
- Participants are a **frozen, code-owned** descriptor — the rev4 constraint held.
- Reuses `withRunJsonLock` and `writeProtectedJsonAtomic` **unchanged**.
- Compare-and-swap is real: re-reads state and `isDeepStrictEqual` against the
  initial before rename, throwing `run state changed before protected replacement`.
- Terminalization is covered (`TERMINALIZE` descriptor) — the widest multi-family
  write, which was the required scope. 10/10 spike tests pass.

Gate 2's stated failure conditions are all absent. **Both gates now pass.**

## The number the spike gives us

| | lines |
| --- | --- |
| Schema-neutral write core | **130** |
| Family contracts for 3 subjects (checkpoint, receipt, terminalize) | ~190 (~63/family) |
| Current `src/run-state.js` | **9,818** |

Extrapolating at a generous 150 lines/family: `130 + 10 × 150 ≈ 1,600` lines for
the entire write plane, against 9,818 today. At the spike's observed 63/family it
is ~780. **This is measured from working code, not estimated** — and it is the
strongest argument in the whole program for the additive direction.

## The reframing that decides everything else

**viso has no implementation.** It is 353 lines of prose; the orchestrator is
Claude following instructions. There is no `validate.js`, no `run-state.js`. Our
43,013 lines exist to **enforce** what viso **instructs**.

So "what do we need" is really: **what must be enforced because nobody is
watching?**

The sharp criterion — and it is much tighter than 42 gates or even 13 boundaries:

> **Enforce what can produce a false green. Instruct the rest.**

A wrong wave schedule produces a stuck or slow run — observable, recoverable,
harmless. A claimed test pass that never ran produces a shipped PR that looks
verified and isn't. Only the second class needs code.

## Must be code (~10 enforcement points)

Each of these can manufacture a false green or a duplicated external effect:

| Enforcement | Failure it prevents |
| --- | --- |
| Checked test/artifact execution receipts | agent claims a pass that never ran |
| Merge proof (reviewed tree = merged tree) | merging something nobody reviewed |
| Review bound to the exact commit reviewed | approval applied to different code |
| Panel head-binding | verdict bound to a stale head |
| Content-hash at agent→factory handoff | artifact swapped after review |
| Exact ownership disclosure + privileged-path policy | unreviewed control-plane or foreign-path change |
| Git-observed facts (ancestry, HEAD, tree) | reasoning from claims instead of the repo |
| Pre-effect external re-observation | acting on stale external state |
| Crash-recovery idempotent replay | duplicated push/PR/merge after a crash |
| PR exactly-once reconciliation | second PR after an ambiguous create |
| CAS + validate-per-write | lost update, half-written manifest |

That is the honest keep-set for the stated target. Note **human-merges-the-PR
needs no enforcement** — it is satisfied by not merging.

## Can be prose (delete the code, keep the instruction)

viso does all of this in prose today and it works. None of it can produce a false
green:

- Wave scheduling / topological sort of `depends_on`
- Worktree lifecycle — create, symlink tooling, remove
- PR composition — labels, reviewers, milestone, body template
- Jira sync
- Retry routing and design-level root-cause classification
- Gate presentation and artifact rendering
- Escalation judgement
- Resume decisions ("first incomplete step")
- Cleanup sweeps

## Can be dropped as scope (the big lever)

None of these is required by "viso + atomic transitions + autonomy":

| Subsystem | Why it can go | viso's answer |
| --- | --- | --- |
| **`post_pr`** — phase/attempt/remediation state machine | we stop at a draft PR | stops at draft PR |
| **`continuation`** + `checkpoint_source`/`checkpoint_progress` | no cross-run lineage in the target | no such concept |
| **`integration_amendment`** | cross-slice defect after integration | escalate to the human |
| **`steering`** machine (generation, state_hash, boundaries, action claims) | autonomy = fire-and-check-later, not steer-mid-run | the human is present |
| **`cost_attribution`** | routes nothing; pure diagnostics | absent |
| **dispatch claim/closure lattice**, 4-hash echoes, 3 closure kinds | single-host, already serialized by the run lock | absent |
| **`delivery_envelope`** / invariant families | verification structure above the target | absent — `work-reviewer` prose |
| **`schema_version`** beyond a constant | P1 says one shape | `"version": 1` |

**Five of Phase 2's ten families disappear** if these go: post-PR,
continuation, checkpoint, integration-amendment, steering. Remaining: core run
envelope, slices/attempt-reviews, steps/gates, panels/verdicts, test-execution
receipts. **Five families to migrate, five to delete.**

## Start over?

**No — but the destination moves much closer to viso than Phase 2 assumes, and
the reason to keep the additive route is narrow and specific.**

Three assets are worth preserving, and only three:

1. **`withRunJsonLock` and `writeProtectedJsonAtomic`.** The spike reused both
   *unchanged* — that is empirical proof they are correct and sufficient. Rebuilding
   a lock and an atomic writer is exactly the kind of work that looks trivial and
   produces subtle crash bugs for months.
2. **The 13 boundary falsifications**, now written, seam-injected, and bound to
   candidate `30a2ab6`. I independently confirmed two of them bite by neutralizing
   the underlying guards. That evidence does not survive a rewrite.
3. **The five surviving families' hard-won validators** — the specific rejection
   rules behind receipts, ownership, and merge proof. Not their structure; their
   content.

Everything else — the flag-interpreting write pipeline, the ~1,125 throw sites,
the 442-function `factory.js`, the dispatch lattice — is not an asset.

**Honest caveat:** if the scope answers above are yes, we delete roughly 60–70% of
the system, and at that point "additive migration of 5 families" and "start over
keeping 3 assets" converge to nearly the same work. The distinction stops being
architectural and becomes bookkeeping. I would still call it additive, because
that framing keeps the factory self-hosting throughout and keeps the boundary
tests green at every step — but nobody should pretend it is a small refactor.

## Recommendation

1. **Decide the five scope questions first** (post-PR, continuation/checkpoint,
   amendments, steering, cost). They are worth more than every remaining
   engineering step combined, and they are decisions, not work.
2. **Re-derive the keep-set against the target**, not the current architecture.
   Phase 0a dispositioned 42 gates against what exists; the false-green criterion
   above yields ~10 enforcement points. If that holds, some of the 13 primaries
   become unnecessary and Gate 1's evidence set shrinks rather than grows.
3. **Then migrate the five surviving families** onto the 130-line core, deleting
   each old path in the same PR, and delete the five dropped subsystems outright.
4. **Keep `#111` frozen.** Most of its remaining cut lines are inside subsystems
   that step 3 deletes wholesale — sweeping them first would be wasted work.

## What I have not verified

- `family-contracts.js` (288 lines) read only structurally — contract shapes and
  descriptor names, not each `validateTransition` body.
- `gate-1-evidence.json` has `result` and `falsifications` keys; I did not audit
  whether all 13 rows carry both default and injected results.
- The five scope subsystems' true LOC. The inventory is file-level, so I cannot
  give a defensible deletion figure — only the family count (5 of 10).
