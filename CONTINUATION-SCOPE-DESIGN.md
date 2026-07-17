Status — approved v2 design, 2026-07-17: Option A(a) / D is the decision. The v2 reviewed-carry-forward contract below is **planned and not implemented**. It does not change the current v1 `factory continue` contract or runtime behavior; `README.md` remains the authority for current behavior.

# Continuation Scope and Reviewed Carry-Forward

## Decision

A blocked feature has one continuation, not one continuation per remaining concern. The child owns the parent's complete remaining plan, starts from the parent's validated integration HEAD, and re-adopts only the parent's exact reviewed-and-merged prefix. Remaining slices run as normal dependency waves inside that one child. The whole-story pre-PR gate remains unchanged.

This approves Option A(a) (branch from the validated integration HEAD and durably re-adopt accepted slices) and Option D (do not fragment one blocked run into sibling continuations). Scope-aware partial PR gates, cross-continuation joins, replaying already accepted slices, and independent sibling continuations are rejected.

## Current v1 boundary

The shipped v1 continuation remains current, narrow, and readable. It decomposes only `continuation.review.required_fixes`, inherits accepted planning only through the existing checked adoption path, and otherwise runs the current gates. Existing v1 post-PR continuation behavior is unchanged. Nothing in this document makes v2 input valid, creates a v2 claim, publishes v2 authority, changes eligibility, or changes current production/catalog coverage.

## Planned v2 carry-forward schema

V2 adds one closed `continuation.carry_forward` object:

```json
{
  "scope": "full-remaining-plan",
  "plan_ref": "plan/slices.json",
  "plan_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "start_commit": "1111111111111111111111111111111111111111",
  "accepted": [
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
  "remaining": ["B1.1", "B1.2", "B1.3", "B1.4"]
}
```

The `carry_forward` object is closed to exactly `scope`, `plan_ref`, `plan_hash`, `start_commit`, `accepted`, and `remaining`; `scope` is exactly `full-remaining-plan`. Every `accepted` entry is closed to exactly `id`, `attempts`, `evidence_ref`, `evidence_hash`, `review_ref`, `review_hash`, `reviewed_commit`, and `merge_commit`. `remaining` contains slice IDs only. Unknown, missing, duplicate, null, abbreviated, or synthetic fields fail closed.

`plan_ref` is the parent-relative `plan/slices.json`, and `plan_hash` binds its exact regular-file bytes. The accepted IDs concatenated with `remaining` must exactly equal the bound plan's ordered `slices[].id` list, with no omission, duplication, reordering, or extra ID. `accepted` is therefore an exact prefix and `remaining` the non-empty suffix beginning at the first incomplete slice. Remaining rows inherit identity and plan dependencies only: they inherit no status, attempts, evidence, review, reviewed commit, merge commit, test result, panel verdict, or other authority from the parent.

## Planned v2 eligibility and integration proof

V2 carry-forward is eligible only for a valid parent whose status is exactly `blocked` before PR creation. The parent has no PR URL or PR-created tuple and no active post-PR observation, remediation, revalidation, push, or continuation state. A parent with a PR, active post-PR state, a non-`blocked` status, an empty `remaining` suffix, or ambiguous state is ineligible for v2. Current v1 post-PR continuation remains unchanged and is not routed through v2 carry-forward.

Each accepted row must match the same-ID parent slice with positive `attempts`, status exactly `merged`, the complete B0MR successor tuple, and unchanged exact evidence/review bytes. Its merge is revalidated with the B0MR proof: exactly two ordered parents `P1, reviewed_commit`, a unique full `git merge-base --all`, equal NUL-delimited rename-disabled changed-path sets, and per-path absence or mode/type/object identity. Starting at the recorded target base commit, the accepted `merge_commit` values must be the complete first-parent chain in plan order and end exactly at `start_commit`. `git rev-list --first-parent <target-base>..<start_commit>` may contain those accepted merge commits and no extra commit; skipped, reordered, squash, linear, manual, or unrecorded commits fail closed.

Parent panel bindings are optional evidence only. If either parent panel binding is present, both validator and security bindings must be complete B0MR successor tuples, their exact sidecars must still hash correctly, and both `reviewed_head_sha` values must equal `start_commit`. Parent panels are never inherited as child verdict authority: the child always runs and publishes a fresh validator/security panel at its final child HEAD.

## Planned v2 origin-base outcomes

After an authoritative fetch/observation of the configured target base, evaluate exactly these outcomes in order:

1. **unchanged** — the observed origin base tip equals the parent's recorded target base commit; carry-forward may continue.
2. **contains start** — the tip differs and contains `start_commit`; stop with `rebaseline-required` because current origin already contains the integrated parent work.
3. **moved** — the tip differs and does not contain `start_commit`; stop with `stale-parent-base-moved` rather than building on stale ancestry.
4. **unavailable** — the origin/base cannot be fetched or observed unambiguously; fail closed as `origin-base-unavailable`.

The candidate build, resource publication, and semantic adoption/activation stages each re-read and recheck parent identity, parent status, pre-PR eligibility, exact plan bytes/hash/partition, accepted sidecar bytes and B0MR merge chain, `start_commit`, optional panel completeness, and the ordered origin-base outcome. A prior observation or caller-supplied boolean is never mutation authority.

## Planned v2 claim and branch transaction

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

## Slice ownership and semantic-publication boundary

- **B1.1 (this slice):** documentation and documentation tests only, owned exactly by `CONTINUATION-SCOPE-DESIGN.md`, `README.md`, `assets/skills/feature/SCHEMA.md`, and `test/docs-contract.test.js`. It creates no runtime behavior, resource, current promise, schema acceptance, or catalog coverage.
- **B1.2:** builds and rechecks the v2 candidate but creates no claim ref, branch, worktree, child run directory, or other resource.
- **B1.3:** implements the atomic claim-ref/child-branch transaction and post-transaction worktree creation/recovery. Those resources are allocation only: B1.3 publishes no child manifest, `carry_forward`, plan, adopted slice state, panel verdict, or executable semantic workflow authority.
- **B1.4:** after another full recheck, atomically publishes the child plus the complete hash-bound plan, adopts the accepted prefix, initializes every remaining slice without inherited authority, leaves child validator/security panels fresh and unbound, and only then activates child execution at the first remaining slice.

Until B1.4 lands, a B1.3 claim, branch, or worktree is not a runnable continuation and no reader may infer semantic adoption from its existence.

## Non-goals

- Do not weaken the whole-story pre-PR gate.
- Do not build a cross-run merge train or sibling-continuation join.
- Do not replay already reviewed accepted slices.
- Do not change or remove the current v1 narrow or post-PR continuation paths in this docs-only slice.
