# Baseline comparison — viso `/feature` skill vs. opencode-feature-factory

Prepared 2026-07-29 for the morning discussion. Target Jason stated: **the viso
feature skill, plus atomic-ish `run.json` state transitions, plus the ability to
run builds autonomously.** Everything above that needs justification.

## Scale

| | viso `/feature` | opencode-feature-factory |
| --- | --- | --- |
| Orchestrator spec | `SKILL.md` 206 lines | `SKILL.md` + skill tree, plus **43,013 lines** of `src/` |
| State schema | `SCHEMA.md` 147 lines | `src/validate.js` **5,294 lines** |
| Transition logic | prose in SKILL.md | `src/run-state.js` **9,818 lines** |
| Tests | none in the skill | **68,911 lines**, 2,322 tests, 510 mutation rows |

## What viso already has — and it is more than the framing suggests

These are **not** increments we added; they are in the 353-line baseline:

- **Observe, don't trust.** *"A subagent's report is a claim. Before you accept a build/test step you re-derive the diff and re-run its named tests yourself."* A claim disagreeing with observation is a review finding.
- **Atomic `run.json` write.** *"Write it atomically (temp file + rename) and after every state change."*
- **Single-writer lock with heartbeat TTL**, plus resume / steal / abort on a live lock and stale-lock stealing at ~30 min.
- **Durable resume** from the manifest — per-gate, per-step, per-slice restart rules, and *"never re-do side effects (Jira create, push, PR) that the manifest shows already done."*
- **Bounded retries** — `max_retries: 3`, then `blocked` / `partial` / `needs-human`.
- **Derived `review_ready`** predicate — status completed **and** non-empty `files_changed` **and** tests observed-passing **and** `diff_observed`.
- **Serial merge under parallel build** — *"builds are concurrent, merges are single-writer."*
- **File-disjoint same-wave slices** and hotspot serialization, enforced at decompose review.
- **Draft PR only, human merges.** Never merge to `development`.
- **Orchestrator-only external effects.** Subagents are read-only toward Jira/GitHub.

So the delta is **not** observe-don't-trust, atomicity, locking, resume, retry bounds, or human-merges-the-PR. All present.

## `run.json` field comparison

**viso (15 top-level fields):** `version`, `run_id`, `jira_key`, `branch`, `worktree`, `created_at`, `updated_at`, `status`, `max_parallel_slices`, `max_retries`, `gates`, `steps`, `slices`, `validator`, `pr_url`

**Ours adds ~22 top-level fields:** `mode`, `heartbeat_at`, `base_commit`, `base_ref`, `pr_mode`, `github_account`, `review_tier`, `program`, `terminal_result`, `security_review`, `cost_attribution`, `debug_snapshot`, `delivery_envelope`, `integration_gate`, `integration_amendment`, `checkpoint_source`, `checkpoint_progress`, `continuation`, `post_pr`, `steering`, `special_builder_dispatch`, `schema_version`

## The justification frame

viso's guardrail is explicit: **"Stop at every human gate. Never run gate-to-PR unattended."** Autonomy deletes that human. Gate 3 in viso presents the validator verdict, the AC table, the *full diff* against `origin/development`, and migration/risk callouts, and requires `review_ready` observed evidence before a human approves.

**So the honest test for each addition is: "in autonomous mode, which Gate-3 human judgement does this mechanize?"** Three outcomes:

1. **Mechanizes the absent human** → justified by autonomy.
2. **Enables a capability viso lacks** (resumable multi-run programs, remediation after PR) → justified by scope, but the scope itself is optional.
3. **Verifies the factory against its own code** → the P2 "drop" class. Not justified.

Applying it to the 13 keep-set boundaries:

| Keep-set boundary | In viso? | Justification |
| --- | --- | --- |
| Merge proof (reviewed tree = merged tree) | No — records `merge_commit` only | (1) the human saw the diff at Gate 3; nobody does now |
| Checked test/artifact execution receipts | **Partly** — orchestrator re-runs tests, records `exit`/`observed` | (1) hardening of an existing viso mechanism |
| Panel head-binding | No — `validator` has no head | (1) verdict must bind to what was validated |
| Exact ownership disclosure | Partly — slices declare `paths` | (1) autonomous merge needs enforcement, not declaration |
| Privileged-path policy | No | (1) no human to notice a control-plane edit |
| PR exactly-once reconciliation | No — `pr_url` only | (2) autonomy can crash mid-`gh pr create` |
| Human-merges-the-PR | **Yes** — draft PR only | baseline, not an addition |
| Git-observed facts | **Yes** — `diff_observed`, `base_ref`, `commit` | baseline, hardened |
| Content-hash at agent→factory handoff | No — no hashes anywhere | (1) substitutes for a human reading the artifact |
| Review bound to exact commit | Partly — `attempt`, no `reviewed_head_sha` | (1) autonomous retry can move HEAD under a review |
| PR/CI facts re-observed from GitHub | No | (2) post-PR remediation is beyond viso's scope |
| Pre-effect external re-observation | No | (1) crash-safety without a human to notice |
| Crash-recovery idempotent replay | **Partly** — resume rules + "never re-do side effects" | baseline, formalized |

**Rough read: 3 of 13 are viso baseline, ~7 mechanize the missing Gate-3 human, ~3 exist only for post-PR/continuation scope.**

## Where the burden of justification actually falls

Not on the 13 boundaries — on the machinery around them:

| Above baseline | Justified by | Status |
| --- | --- | --- |
| `post_pr` (phase/attempt/remediation) | scope: fixing a PR after creation | **optional scope.** viso stops at draft PR. If we stop there too, this whole subsystem goes. |
| `continuation` + `checkpoint_source`/`checkpoint_progress` | scope: multi-run carry-forward | **optional scope.** viso has no cross-run lineage. |
| `integration_amendment` | scope: cross-slice defect after integration | **optional scope.** viso escalates to the human instead. |
| `steering` (queued/consumed/acknowledged, generation, state_hash, boundaries, action claims) | autonomy: injecting direction into an unattended run | **thin.** #111 already deletes the generation/boundary/action machine. viso's equivalent is "the human is right there." |
| `special_builder_dispatch`, dispatch claims/closures, 4-hash echoes | internal single-flight | **class (3).** Single-host, already serialized by the run lock. #111 collapses this to one lease. |
| `delivery_envelope` / invariant families | verification structure | needs its own justification; it *is* the one architecture Part 4 calls healthy. |
| `cost_attribution` | diagnostics | **not justified by the target.** Pure observability; nothing routes on it. (I built the last increment of this today.) |
| `debug_snapshot`, `github_account`, `review_tier`, `program`, `mode`, `pr_mode` | operational | mostly (1)/(2), individually cheap. |
| `schema_version` | evolution | P1 says one shape; a version field with one legal value earns little. |

## Questions for the morning

1. **Do we keep post-PR remediation, continuation/checkpoints, and integration amendments at all?** Those three subsystems are the largest "above baseline" blocks and none is required by "viso + atomic transitions + autonomy." Dropping them is a far bigger reduction than anything in the current #111 → #117 → #113 program.
2. **What replaces the Gate-3 human, minimally?** If the answer is "the merge proof, commit-bound review, and observed receipts," that is 3–4 boundaries, not 13.
3. **Is `steering` needed if autonomy means fire-and-check-later** rather than fire-and-steer-mid-run?
4. **Does "atomic-ish" mean viso's temp+rename, or our lock + compare-and-swap + validate-per-write?** viso already has temp+rename. The increment is CAS and fail-closed validation — cheap, and probably the one unambiguously justified addition.
5. **Does the 13-boundary keep-set survive this test**, or is the real keep-set closer to 6–8? The Phase 0a inventory dispositioned gates against the *current* architecture; this reframes the question against the viso baseline instead.

## Note on Phase 0c

Reviewed only at the summary level: Gate 2 reported passing, real lock and atomic writer reused unchanged, schema-neutral core with no family IDs/schemas/branches/flags, family-owned contracts, 10/10 spike tests, no production files changed. I have **not** inspected the spike, and it is uncommitted. If the answers above shrink the target materially, Gate 2's result still holds — a schema-neutral core is required under any of these scopes — but the *number of families* it must serve could drop sharply, which makes the result easier rather than harder.
