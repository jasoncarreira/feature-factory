Status — implemented v2 reviewed carry-forward, 2026-07-17. Option A(a) / D is selected only by explicit pre-PR `factory continue ... --carry-forward`. Unflagged and post-PR continuation remain schema v1.

# Continuation Scope and Reviewed Carry-Forward

## Decision

A blocked feature has one continuation, not one continuation per remaining concern. The child owns the parent's complete remaining plan, starts from the parent's validated integration HEAD, and re-adopts exactly every parent slice that is already reviewed and merged. Remaining slices run as normal dependency waves inside that one child. The whole-story pre-PR gate remains unchanged.

This approves Option A(a) (branch from the validated integration HEAD and durably re-adopt accepted slices) and Option D (do not fragment one blocked run into sibling continuations). Scope-aware partial PR gates, cross-continuation joins, replaying already accepted slices, and independent sibling continuations are rejected.

## Current v1 boundary

The shipped v1 continuation remains current, narrow, and readable. It decomposes only `continuation.review.required_fixes`, inherits accepted planning only through the existing checked adoption path, and otherwise runs the current gates. Existing v1 post-PR continuation behavior is unchanged. V2 requires the explicit selector; a v2 payload is admissible only when it exactly matches a checked, published child.

## Implemented v2 carry-forward schema

V2 adds one closed `continuation.carry_forward` object:

```json
{
  "scope": "full-remaining-plan",
  "plan_ref": "plan/slices.json",
  "plan_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "start_commit": "1111111111111111111111111111111111111111",
  "accepted_slices": [
    {
      "id": "B0MR",
      "attempts": 1,
      "evidence_ref": "evidence/B0MR.json",
      "evidence_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "review_ref": "reviews/B0MR.json",
      "review_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "reviewed_commit": "4444444444444444444444444444444444444444",
      "merge_commit": "5555555555555555555555555555555555555555"
    }
  ],
  "remaining_slice_ids": ["B1.1", "B1.2", "B1.3", "B1.4"]
}
```

The `carry_forward` object is closed to exactly `scope`, `plan_ref`, `plan_hash`, `start_commit`, `accepted_slices`, and `remaining_slice_ids`; `scope` is exactly `full-remaining-plan`. Every `accepted_slices` entry is closed to exactly `id`, `declared_paths`, `effective_paths`, `attempts`, `attempt_reviews`, `evidence_ref`, `evidence_hash`, `review_ref`, `review_hash`, `reviewed_commit`, and `merge_commit`. The ownership arrays and `attempt_reviews` are exact immutable parent values through the current accepted attempt. `remaining_slice_ids` contains slice IDs only. Unknown, missing, duplicate, null, abbreviated, or synthetic fields fail closed.

`plan_ref` is the parent-relative `plan/slices.json`, and `plan_hash` binds its exact regular-file bytes. `accepted_slices` contains every parent slice whose status is exactly `merged`, in PLAN order. `remaining_slice_ids` contains every nonmerged slice ID, in PLAN order. IDs are unique within each array, the arrays are disjoint, and their set union is exactly the bound plan's complete `slices[].id` set, with no omission or extra ID. They are ordered filtered subsequences, not a prefix/suffix split: for plan order `[A, B, C]`, merged `A` and `C` produces `accepted_slices: [A, C]` and `remaining_slice_ids: [B]`, which is valid. Remaining rows inherit identity and plan dependencies only: they inherit no status, attempts, evidence, review, reviewed commit, merge commit, test result, panel verdict, or other authority from the parent.

Schema-v2 eligibility also requires root `plan.integration_gate.required_commands`. It is the closed ordered structured-argv contract: 1-32 exact `{program,args}` entries, no shell text, bounded UTF-8 program/args/list sizes, and exact `{program:"npm",args:["run","check"]}` once and last. The parent work-decomposer accepted step must bind exact `plan/slices.json` and its review through the existing closed `acceptance` ref/hash shape. Construction, staged publication, adoption, local authority checks, replay, resume, test dispatch, and downstream transitions rehash the accepted files and reject missing/malformed/drifted authority. Publication copies plan and review bytes unchanged; after observing target absence it repeats parent binding and staged-byte checks immediately before the no-replace move. Compatibility reads keep legacy v1 plans/accepted steps valid, but they cannot become v2 carry-forward authority.

After every child row is merged, only `factory test-execute <run-id> --json` may execute that command authority. The locked active claim binds nonce, run/attempt, exact plan hash, clean child HEAD, and fixed receipt ref before process creation. The shell-free executor uses exact child cwd, reduced environment, sequential bounded commands, captured-prefix hashes instead of raw output, and fail-closed unknown states for process, authority, or receipt-publication uncertainty. Finalization rechecks every merged commit remains ancestral to exact clean HEAD before create-only receipt publication. A completed pass remains running for independent test-report review; a decided failure rejects the same attempt. Active/unknown state has no supported retry, clear, replacement, terminal, steering-conflict, step-advance, or recovery path. Caller/model reason text grants no authority. B1R requires trusted out-of-band operator/process reconciliation and intentionally exposes no autonomous command or authority flag.

## V2 eligibility and integration proof

V2 carry-forward is eligible only for a valid parent whose status is exactly `blocked` before PR creation. The parent has no PR URL or PR-created tuple and no active post-PR observation, remediation, revalidation, push, or continuation state. It must also have `planning_reuse.eligible === true` from durably accepted unchanged planning and no `draft_spec_reuse`. A parent with a PR, active post-PR state, a non-`blocked` status, no nonmerged slice, draft/unaccepted planning, or ambiguous state is ineligible for v2. Current v1 post-PR continuation remains unchanged and is not routed through v2 carry-forward.

Each accepted row must match the same-ID parent slice with positive `attempts`, status exactly `merged`, the complete B0MR successor tuple, and unchanged exact evidence/review bytes. Actual integration merge order may differ from PLAN and dependency-execution order. The Git first-parent range from `target.base_commit` exclusive through `start_commit` inclusive must contain exactly once the set of `accepted_slices[].merge_commit` values and no extra commit; its chain length equals `accepted_slices.length`. Every first-parent commit is associated by its `merge_commit` value with exactly one accepted entry and is revalidated with that entry's B0MR proof: exactly two ordered parents `P1, reviewed_commit`, a unique full `git merge-base --all`, equal NUL-delimited rename-disabled changed-path sets, and per-path absence or mode/type/object identity. `start_commit` is the parent branch HEAD and the last actual merge in that first-parent range, or equals `target.base_commit` when `accepted_slices` is empty. This does not require `accepted_slices` order to equal first-parent chain order: for PLAN-ordered `accepted_slices: [A, C]`, an actual first-parent chain `[C, A]` is valid when both mapped merges pass B0MR. Missing, duplicate, squash, linear, manual, or unrecorded commits fail closed.

Parent panel bindings are optional evidence only. If either parent panel binding is present, both validator and security bindings must be complete B0MR successor tuples, their exact sidecars must still hash correctly, and both `reviewed_head_sha` values must equal `start_commit`. Parent panels are never inherited as child verdict authority: the child always runs and publishes a fresh validator/security panel at its final child HEAD.

## V2 origin-base outcomes

After an authoritative fetch/observation of the configured target base, evaluate exactly these outcomes in order:

1. **unchanged** — the observed origin base tip equals the parent's recorded target base commit; carry-forward may continue.
2. **contains start** — the tip differs and contains `start_commit`; stop with `rebaseline-required` because current origin already contains the integrated parent work.
3. **moved** — the tip differs and does not contain `start_commit`; stop with `stale-parent-base-moved` rather than building on stale ancestry.
4. **unavailable** — the origin/base cannot be fetched or observed unambiguously; fail closed as `origin-base-unavailable`.

The candidate build, resource publication, and semantic adoption/activation stages each re-read and recheck parent identity, parent status, pre-PR eligibility, exact plan bytes/hash/classification, accepted sidecar bytes and B0MR merge set/actual first-parent chain, `start_commit`, optional panel completeness, and the ordered origin-base outcome. A prior observation or caller-supplied boolean is never mutation authority.

## V2 claim and branch transaction

The claim-ref suffix is derived from this closed parent-identity object and no other fields:

```json
{
  "schema_version": 2,
  "kind": "blocked-run-continuation-parent",
  "parent_run_id": "parent-run",
  "parent_run_ref": ".opencode/factory/parent-run/run.json",
  "parent_run_hash": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  "parent_branch_ref": "refs/heads/parent-run",
  "target_base_ref": "refs/remotes/origin/main",
  "target_base_commit": "7777777777777777777777777777777777777777",
  "plan_ref": "plan/slices.json",
  "plan_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "start_commit": "1111111111111111111111111111111111111111"
}
```

The parent identity is closed to exactly `schema_version`, `kind`, `parent_run_id`, `parent_run_ref`, `parent_run_hash`, `parent_branch_ref`, `target_base_ref`, `target_base_commit`, `plan_ref`, `plan_hash`, and `start_commit`. Canonicalization is recursively lexicographic by object key at every depth, emits canonical UTF-8 JSON with no insignificant whitespace and no trailing newline, and preserves array order. The suffix is the 64-character lowercase hexadecimal SHA-256 of those exact canonical bytes. The claim ref is literally `refs/opencode/continuations/<64hex>`; no other prefix, abbreviation, or `sha256:` text is accepted in the ref name.

The claim blob is decoded as JSON and closed to exactly `schema_version`, `kind`, `parent_identity`, `child_run_id`, `child_branch_ref`, and `start_commit`:

```json
{
  "schema_version": 2,
  "kind": "blocked-run-continuation-claim",
  "parent_identity": { "...": "the exact closed parent identity above" },
  "child_run_id": "parent-run-continuation",
  "child_branch_ref": "refs/heads/parent-run-continuation",
  "start_commit": "1111111111111111111111111111111111111111"
}
```

The claim blob uses the same canonicalization. It contains no self data: no `claim_ref`, claim digest/hash, blob OID, transaction ID, worktree path, mutable status, or timestamp. `child_branch_ref` is a full literal `refs/heads/...` ref, and the blob's `start_commit` must equal the parent identity's `start_commit`.

After the final publication recheck, one atomic `git update-ref --stdin` transaction uses create/no-replace semantics to create both `refs/opencode/continuations/<64hex>` pointing to the claim blob and `child_branch_ref` pointing to `start_commit`; both commands require the all-zero old OID. A precheck is not authority, neither ref may be force-updated, and no fallback sequence may create them independently.

Only an exact replay succeeds: both refs already exist, the claim ref resolves to a blob with byte-for-byte canonical claim content for the same parent and child, and the same `child_branch_ref` points exactly to `start_commit`. Any different child, blob, branch target, object type, or extra/missing field is a conflict. The child worktree is created only after a successful transaction or exact replay, with normal no-overwrite path and final branch/HEAD identity checks.

Claim lifecycle is monotonic. A crash before transaction commit leaves neither ref; a crash after commit leaves both refs and same-child recovery may exact-replay and create or recover the worktree. A half-state with only one ref is impossible from the transaction and is treated as external damage/conflict, never repaired by filling in the other half. A losing concurrent child or pre-existing child branch is a conflict. The claim ref is a permanent tombstone for the parent identity and is not deleted by child failure, terminalization, branch/worktree cleanup, or successful completion; it prevents a different later child. Same-child recovery is permitted only by the exact replay rule and never converts the tombstone into reusable capacity.

## Atomic semantic publication and activation

- **B1.1:** records the reviewed design without runtime behavior.
- **B1.2:** builds and rechecks the v2 candidate but creates no claim ref, branch, worktree, child run directory, or other resource.
- **B1.3:** implements the atomic claim-ref/child-branch transaction and post-transaction worktree creation/recovery. Those resources are allocation only: B1.3 publishes no child manifest, `carry_forward`, plan, adopted slice state, panel verdict, or executable semantic workflow authority.
- **B1.4 (implemented):** after another full recheck, atomically publishes the child plus the complete hash-bound plan, adopts every `accepted_slices` entry without rerunning it, initializes every `remaining_slice_ids` entry without inherited authority, leaves child validator/security panels fresh and unbound, and only then activates remaining work by normal dependency readiness.

A complete child directory is staged on the same filesystem outside factory run discovery. Before rename, no v2 payload, skill seed, or launch exists. The staged tree contains `run.json`, byte-identical `plan/slices.json`, accepted planning/spec review, and exact accepted slice evidence/review sidecars. It is validated before a commit-boundary recheck of parent, plan, sidecars, Git/origin, claim, branch, worktree/start HEAD, and invocation configuration, followed by one no-overwrite atomic directory rename. A crash before rename leaves no semantic child; a crash after rename leaves one complete valid child. Foreign, partial, symlinked, escaped, or conflicting targets are never filled, replaced, or rolled back.

The child root remains `schema_version: 1`; only `continuation.schema_version` is 2. Closed configuration is resolved before allocation and persists mode (`autonomous`, else headless for headless/detached, else interactive), account (explicit, canonical origin owner, or `null`), PR mode (explicit draft/ready else built-in ready), post-PR policy (current-invocation flags over built-in disabled defaults), limits and retries of 3, and no review tier. Conflicts reject before allocation. Replay recomputes these immutable values and rejects a mismatch without rewriting progress.

Initial child state contains exact accepted planning/spec acceptance at attempt zero, PLAN-ordered mixed merged/pending rows, fresh steering, empty gates, null validator/security, and no inherited test/panel/PR/outcome authority. Adopted rows and sidecars are immutable. Pending rows start at attempt zero and become runnable only when all dependencies are merged. Fresh execution skips bootstrap/story/research/spec/decomposition and enters normal remaining-slice execution; only after every full-plan row is merged may fresh test-verifier attempt one, validator, security, and whole-story pre-PR authority run.

Schema-v1 publication and schema-v2 allocation share one create-only target reservation at `refs/opencode/continuation-targets/<sha256-child-run-id>`. The canonical reservation binds route schema, crash-stable creation time, and the complete continuation hash, so concurrent cross-schema retries cannot both acquire authority and only exact replay can continue after a crash.

The transport remains `ffpayload-v1:`. Candidate, claim, branch, worktree, or caller payload alone is never authority. A reservation alone is likewise insufficient: parsing checks the exact reservation-bound continuation, and v2 additionally checks the exact published child and persisted driver projection. Resume/replay rechecks immutable adoption and parent/origin/reservation/claim/branch/worktree/plan authority. Replay preserves progressed remaining-slice, gate, panel, and post-PR state. Terminal replay returns current terminal state without launching, and the permanent allocation records survive cleanup and terminalization.

## Non-goals

- Do not weaken the whole-story pre-PR gate.
- Do not build a cross-run merge train or sibling-continuation join.
- Do not replay already reviewed accepted slices.
- Do not change or remove the current v1 narrow or post-PR continuation paths.
