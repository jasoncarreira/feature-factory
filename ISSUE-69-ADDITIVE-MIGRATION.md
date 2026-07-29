# Issue #69 Program — Additive Migration Alternative

Status: **Phase 0 ready to adopt.** The full additive migration is *not* adopted;
it requires both evidence gates below to pass first. Written 2026-07-29 by Claude
for comparison against `ISSUE-69-IMPLEMENTATION-DAG.md`.

Revision history: **rev1** initial proposal. **rev2** incorporated opencode's
first review (keep-set was incomplete; gate finding needed a closed inventory;
falsification needed stable seams; Phase 1 was speculative; cross-family
transactions undesigned; checkpoint is the better pilot). **rev3** adopts
opencode's second review: the 0a enumeration criterion, a corrected Gate 2
rejection criterion, proof-mass discipline in Phase 0, and freeze-#111-now —
which reverses my own recommendation. Adds the **no-baggage rule** per Jason.
**rev4** corrects the no-baggage rule's overclaimed enforcement — name
scanning cannot detect a renamed or reimplemented equivalent, so enforcement is now
import-boundary + capability + inventory-trace — and sets the Phase 0 timeboxes, a
Gate 1 test budget, and the static-descriptor constraint on declared families.
**rev5** (this) makes the Gate 1 budget a counterweight rather than an absolute, per
P3, and fixes two editorial errors from rev4.

## The question this answers

Jason asked whether it would be faster to spec the parts we want to keep and
rebuild from those, rather than keep extracting the parts we do not want. My first
answer was no, on the grounds that the test suite encodes invariants a spec
cannot. **That was wrong on its central claim** — the program already plans to
delete a large share of that suite (#114 drops mutation-catalog cases proving the
factory rejects hand-corrupted factory-authored records; 611 pinned prose strings
collapse to rejector identity). Weighting the mass without checking how much of it
the review itself judges disposable was the error.

The corrected answer is not "rebuild" either. The program is refactoring
**subtractively**, and the same end state is reachable **additively** at lower
risk per step.

## Evidence base

Measured on `origin/main` at `690b193` unless cited from `ISSUE-69-PROGRAM-REVIEW.md`.

| Measurement | Value |
| --- | --- |
| `src/` | 43,013 lines |
| `test/` | 68,911 lines (1.6× source), 98 files, 2,314 tests |
| `src/run-state.js` | 9,818 lines (2.6k at program start; ~1,125 throw sites, 88 exports) |
| `src/validate.js` | 5,282 lines (1.9k at program start; 55 exports) |
| `src/factory.js` | 7,780 lines (~5k at program start; 442 top-level functions) |
| `src/` growth over the program | ~19.5k → 43k |
| Critical-path gates | ~32, of which **~6 protect product-code correctness**; ~26 observed firing fail-closed on correct work |
| Mutation catalog | 510 rows |

Per-step transformation costs the subtractive path pays: one schema change costs
~40–60 hand-edited literal sites across 5+ files; the hash-binding ritual is
inlined ~80× in `run-state.js`; the write pipeline dispatches on ~15 flags;
unknown CLI flags are silently ignored on ~36 of ~40 subcommands.

Proven-good counter-example (review Part 4): `src/delivery-envelope/` is 7 files,
~1,245 lines, "cohesive, closed-schema, dependency-injected", where "a new
invariant *family* is plan data, zero code". The heartbeat consolidation "proves
the extraction pattern works here; it has simply only been applied once."

## The keep-set

The review states the correctness core in **two** places; the keep-set is their
union. rev1 used only the second and was incomplete.

### A. P0 stays-hard core (review line 64)

*"What stays hard, so deletion never overreaches (the correctness core, **none of
which has ever false-fired**): the merge proof (reviewed tree equals merged tree),
checked test/artifact execution receipts, panel head-binding, exact ownership
disclosure, the privileged-path policy, PR exactly-once reconciliation, and
human-merges-the-PR."*

1. Merge proof — reviewed tree equals merged tree
2. Checked test/artifact execution receipts
3. Panel head-binding
4. Exact ownership disclosure
5. Privileged-path policy
6. PR exactly-once reconciliation
7. Human-merges-the-PR

"None of which has ever false-fired" is **positive** evidence for retention and is
categorically stronger than the 6-of-32 finding, which is only evidence about what
to cut. Retained by default; burden of proof on anyone proposing to touch it.

### B. P2 keep table — trust boundaries

8. Git-observed facts — ancestry, HEAD, tree equality at merge
9. Content-hash at the agent→factory artifact handoff
10. Review bound to the exact commit reviewed
11. PR/CI facts re-observed from GitHub
12. Re-observation of external mutable state immediately before an external effect (P2 case 1)
13. Crash-recovery idempotent replay (P2 case 2)

### C. Overlaps are named, not folded

Several B items are the boundary-shaped statement of an A mechanism — panel
head-binding (3) and review-bound-to-commit (10); merge proof (1) and git-observed
tree equality (8); receipts (2) and B1R. The inventory names all 13 explicitly.
Ambiguity about which mechanism a test protects is what recreates the per-PR
review ratchet this program exists to escape.

Failure classes these catch: **confabulated test claims, wrong-commit reviews,
stale/crash-raced evidence, state drift between observation and
merge/spawn/publication.** Treat as open — 15 dogfood runs may not have exercised
every class.

Outside the keep-set: *simplify* (validate once per write under the lock; one
canonical-JSON authority; derive counts instead of echoing; error codes where code
dispatches) or *drop* (byte-equality re-serialization proofs between factory
modules; nonce ceremonies for single-host operations already serialized by the
run-json lock; doubled in-lock guard passes; catalog exact-message pinning).

## The no-baggage rule *(rev3, per Jason)*

Two failure modes would let the additive path reproduce what the program set out
to remove. Both are forbidden, and both are **mechanically enforced**, not left to
review vigilance:

- **Carrying baggage because it is wired in.** No mechanism moves into a family
  module merely because current code calls it. Every mechanism a migration carries
  forward must cite its Phase 0a disposition as *Retain* or *Consolidate*.
- **Re-implementing something slated for removal.** Nothing dispositioned *Delete*
  may appear in the new core or any family module, in any form, including a
  renamed or restructured equivalent.

Enforcement *(rev4 — corrected)*. rev3 claimed a test could assert that no
*Delete*-dispositioned decision function "or its recorded successor names" is
reachable from the new modules. **That overclaimed.** Name scanning cannot detect a
renamed or restructured equivalent — which is the form this failure actually takes
— and JavaScript reachability analysis is not reliably complete through dynamic
imports, computed member access, or string-keyed dispatch. Three layers instead,
none of which depends on recognising a name:

1. **Import-boundary test** — a migrated family module may not import legacy
   family owners. Structural and decidable.
2. **Capability test** — behaviour dispositioned *Delete* no longer affects a
   migrated transition. This is the layer that catches reimplementation, because it
   asserts the **effect is absent** rather than searching for the code that would
   produce it. A reimplementation under any name fails this test.
3. **Inventory trace** — every *Consolidate* row names the retained successor gate
   and that successor's boundary test ID, so consolidation cannot quietly mean
   "kept as-is somewhere else".

Name scanning may remain as a **diagnostic** aid; it is not the authoritative
mechanism. The 0a inventory is still a machine-readable data file — that is what
makes layers 2 and 3 checkable, and it is #114's input.

A *Defer* row **blocks migration of the family that owns it** until dispositioned;
deferral is not a licence to carry the mechanism along quietly.

Secondary benefit: the same data file is #114's input, so catalog narrowing stops
being an argument and becomes a query.

## Two evidence gates

The additive path requires **both**. Neither is decided by argument.

- **Gate 1 — boundary falsification.** The Phase 0 suite is green on current
  `main` and every keep-set mechanism provably fails through its own deliberate
  fault seam. *(rev5 — budget made a counterweight, not an absolute.)* rev3 left the
  threshold subjective ("most of the existing 2,314 assertions"); rev4 overcorrected
  by making 26 tests an automatic failure, which contradicts P3's rule that budgets
  are counterweights rather than absolutes — a retained boundary such as PR
  exactly-once reconciliation may legitimately need more than two distinct crash
  cases. The initial budget is **one primary falsification per mechanism plus at
  most one additional justified case**, so **13–26 focused tests**. **Exceeding 26
  requires an explicit checkpoint** identifying the additional failure classes and
  why existing falsifications cannot cover them. **Gate 1 fails when mechanisms
  cannot be isolated from internal ceremony — not merely because the test count
  exceeds the initial budget.**
- **Gate 2 — common write contract.** Checkpoint and test-execution receipts both
  fit a small shared write contract, cross-family transactions included.
  *(rev3 — corrected.)* rev2 said this fails "if the contract has to special-case
  either family", which was too strict: families necessarily have different
  validators and transition behaviour, and a typed `family.validateTransition(...)`
  call is the **intended** design, not a special case. **Gate 2 fails if the core
  branches on family identity, contains family-specific schema knowledge, or grows
  family-specific boolean flags.**

## Phase 0 — Boundary inventory and test port (blocking precondition)

Time-boxed and staged, so the downstream pause is bounded. Durations set *(rev4)*:

| Stage | Work | Box |
| --- | --- | --- |
| **0a** | closed gate inventory and falsification protocol | **2 working days** |
| **0b** | boundary tests and the **Gate 1** decision | **3 working days** |
| **0c** | throwaway two-family spike and the **Gate 2** decision | **2 working days** |

**Any extension requires an explicit checkpoint** — a stated reason, a revised box,
and a decision to continue. Phase 0 must not expand silently; the #111 freeze is
accepted *because* the box is real.

### 0a. Closed gate inventory

Enumeration criterion *(rev3 — opencode's, adopted)*. A **critical-path gate** is
any production decision reachable from a public CLI command, plugin hook,
supervisor route, or supported recovery API that can:

- Authorize or prevent an external effect
- Accept or reject agent/external authority
- Consume an attempt or retry
- Persist blocked, needs-human, or terminal state
- Authorize accepted, merged, PR-created, or completed state
- Change crash replay or resume disposition

**Closure is demonstrated by tracing from the finite entrypoint inventory to the
finite effect/state sinks** — not by asserting a count. Individual schema
predicates are grouped under their owning schema gate rather than counted
separately.

Each row names: **entrypoints · decision function · guarded sink · failure result
· trust boundary · disposition · boundary test ID.**

Exactly one disposition per row:

- **Retain** as a correctness boundary
- **Consolidate** into another retained boundary (naming which)
- **Delete** as internal ceremony
- **Defer** pending evidence (naming what evidence would settle it)

Every keep-set item in A and B must appear as *Retain*. A gate that cannot be
dispositioned is *Defer*, never silently dropped.

A boundary suite alone does **not** prove the other 26 gates' tests are
disposable. Those are separate claims, and 0a is what settles them.

### 0b. Boundary tests with stable fault seams

Proof-mass discipline *(rev3)* — this program exists partly because proof mass
grew unchecked, so Phase 0 must not recreate it across 13 overlapping mechanisms:

- **One registered test group per mechanism**, with explicit test IDs recorded in
  the 0a inventory. Related mechanisms **may share a test file and fixture**;
  duplicated harnesses are the thing being avoided.
- Every mechanism still needs **its own deliberate fault seam and its own recorded
  falsification result**. Sharing a fixture never means sharing a falsification.
- Seams are **dependency-injected test seams, never runtime flags capable of
  disabling a protection.** A production-reachable switch that turns off a
  correctness boundary is a defect, not a test affordance.
- Tests assert the mechanism, not its current call site or module layout.
- Revert-based falsification is not acceptable: it produces failures caused by
  compilation or unrelated behaviour. Both hazards showed up in this session's work
  — a pseudonymized run id that looked like a bug but was designed behaviour, and a
  `--test-name-pattern` that silently excluded the test being falsified.
- **Not** ported: gates dispositioned *Delete*, catalog cases proving rejection of
  hand-corrupted factory-authored records, exact-message pins.

### Phase 0 definition of done

Inventory closed by entrypoint→sink tracing with one disposition per row (0a);
suite green on current `main` with every mechanism falsified through its own seam
(0b) — that is **Gate 1**. Then the throwaway two-family spike (0c) decides
**Gate 2**.

Phase 0 is worth doing **even if the additive direction is rejected.** It de-risks
the subtractive path identically, makes #114 tractable, and stops every deletion
PR relitigating whether a guard matters.

## Phase 1 — Minimum write core, proven by one family

rev1 proposed building the core first; that is speculative infrastructure.
Instead: define the **minimum** core the pilot family actually needs — run-json
lock, protected replacement, scoped-authority write pipeline — and validate it by
migrating the pilot in the same increment. **The core grows only when a second
family demonstrates a shared need.** A facility with one consumer stays in that
consumer.

Non-goals: no flag interpreter, no per-site hash ritual, one canonical-JSON
authority, error codes on every message any code dispatches on.

### Cross-family transaction contract

Undesigned in rev1 and the most likely reason the additive path fails.
Terminalization alone touches the run envelope, steps, post-PR, steering,
receipts, and cleanup policy, so a schema-neutral core still coordinates
multi-family writes:

- **Core** validates the envelope and coordinates the lock and atomic replacement.
- **Each affected family** validates its own transition, via a typed call.
- **Each transition declares the families it mutates** — declared, not inferred.
  *(rev4)* These declarations are **static, code-owned descriptors**. They must not
  become durable `run.json` fields, agent-produced metadata, hashes, or catalog
  rows. A declaration that persists or is produced by an agent would be a new echo
  requiring its own verification — exactly the class of proof mass this program is
  deleting, reintroduced at the coordination layer.
- **External re-observation hooks stay explicit and typed** (P2 case 1 is a
  keep-set boundary and must not become implicit).
- **No generic boolean flag interpreter.** If coordination needs one, Gate 2 failed.

The 0c spike must exercise **terminalization** specifically, as the widest
multi-family write in the system.

## Phase 2 — Family migration

Families per #117: core run envelope; slices/attempt-reviews; steps/gates;
panels/verdicts; continuation; post-PR; integration-amendment; checkpoint;
steering; test-execution receipts.

Order *(rev2, from opencode's coupling measurement — it beat my cohesion
assumption)*:

1. **Checkpoint — architectural proof.** Already called out as healthy, so it
   tests the core's shape rather than the family's difficulty.
2. **Test-execution receipts — first major trust-boundary migration.** B1R is a
   keep-set mechanism, so it proves the core can carry a retained boundary.
3. **Post-PR** — after the core has survived both.
4. **Steps/gates**, **panels/verdicts**, **slices/attempt-reviews**.
5. **Continuation**, **integration-amendment** — most entangled, last.
6. **Steering** — migrate the reduced form directly rather than migrating then removing.

Per-family definition of done:

- Family module owns its schema, transitions, and key sets.
- **Every carried-forward mechanism cites a *Retain*/*Consolidate* disposition;
  no *Delete* row reappears in any form** (the no-baggage rule, enforced by test).
- **Old path deleted in the same PR**, not deprecated.
- Phase 0 suite green; full suite green.
- The family's `validate.js` / `run-state.js` regions are **gone, not moved**.
- No second family starts before the previous one's old path is deleted, so at
  most one family is ever dual-path.

## Phase 3 — Retire the monolith

When the last family lands, `validate.js` and `run-state.js` are thin re-export
indexes or gone. #117 and #118 are satisfied by construction rather than executed.

## Sequence

1. **Freeze unmerged #111 work now.** *(rev3 — reverses my rev2 recommendation.)*
   I advised landing in-flight work first, assuming it was near-complete deletion
   work; I had flagged not having read the branch and then relied on having read
   it. opencode's measurement: the execution-claims branch is **~890 insertions /
   368 deletions, net +522**, introduces dual schema-v1/v2 readers **contrary to
   binding P1**, exposed further cleanup and sidecar coupling, still has two
   failing cleanup tests, and is based behind main. That is net-additive work
   violating a binding policy, not deletion nearing completion. **Salvage its
   adversarial tests and discovered failure cases into Phase 0 and the later
   test-execution migration; do not land the implementation.** Merged #156, #157,
   and #158 remain useful under either direction.
2. Build **0a** against current `main`.
3. Reconcile the keep-set with the P0 stays-hard mechanisms; complete the inventory.
4. **0b** → Gate 1 decision.
5. **0c** throwaway two-family spike (checkpoint + test-execution, including
   terminalization) → Gate 2 decision.
6. Adopt the additive path only if **both** gates pass.
7. Migrate one family at a time, old-path deletion in the same PR.

**No additional #111 cuts run in parallel with Phase 0** *(rev3)*: changing gates
while inventorying them creates a moving baseline and weakens the evidence. The
downstream pause — #111 blocks #112 and #135, transitively #123 and #147 — is
accepted on condition that Phase 0 is genuinely time-boxed per stage.

## Effect on existing issues

| Issue | Under the additive plan |
| --- | --- |
| **#111** | Mostly **subsumed**; cut lines land inside each family's migration. Non-family-scoped items stay. Unmerged work frozen now. |
| **#117** (split `validate.js`) | **Satisfied by construction.** Dissolves the #111-before-#117 deadlock. |
| **#118** (split `run-state.js`) | **Satisfied by construction.** |
| **#113** (substrate extraction) | Becomes the minimum core, grown per demonstrated need. |
| **#114** (catalog narrowing) | **0a supplies its input** as queryable data. |
| **#104** | Unchanged; lands as a family module on the new core. |
| **#112** (prompts/docs) | Unchanged, but paused behind the #111 freeze. |
| **#123**, **#135**, **#147** | Unchanged in intent; each becomes a one-family-module change. |

## Risks and abort conditions

- **Gate 1 fails** — keep-set mechanisms cannot be isolated from internal
  ceremony, refuting 6-of-32. Surfaces in 0b, cheaply, by design. A test count above
  the 13–26 budget is a checkpoint trigger, not the failure itself.
- **Gate 2 fails** — the core has to branch on family identity, hold
  family-specific schema knowledge, or grow family-specific flags. Surfaces in the
  0c spike, which is explicitly throwaway.
- **Phase 0 overruns its boxes** (2/3/2 working days). Mitigated by requiring an
  explicit checkpoint to extend rather than allowing silent expansion — the risk is
  not the overrun itself but an unbounded freeze on #112/#135/#123/#147.
- **The capability test proves too little** if *Delete*-dispositioned behaviour is
  hard to observe as an effect. Where a disposition has no observable effect to
  assert absence of, it should be *Defer*, not *Delete*.
- **Families may be less separable than #117 assumes** in `run-state.js`. I did
  **not** read its 9,818 lines function by function; that verification belongs in 0c.
- **Two live paths** during migration, bounded to one family by the same-PR rule.

## What is not claimed

- Not that a from-scratch rebuild is a good idea. The factory self-hosts; big-bang
  integration would leave it dark.
- Not that this is faster in total effort. The claim is **lower risk per step,
  resumable after a stall, review cost paid on the shape we keep**.
- Not that the existing DAG is wrong about *what* to cut. It is comprehensive and
  this plan consumes it. The disagreement is only direction of travel.
- Not that the direction is decided. **Adopt Phase 0; provisionally favour
  additive; do not formally resequence until the boundary and separability
  evidence exists.**
