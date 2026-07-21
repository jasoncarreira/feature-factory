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

## B5 integration amendment decision

Status: canonical B5.1 design, planned but not runtime authority. B5.2-B5.4 must
implement and prove this contract before the generic route may replace new PR #79
repair admission.

### Architectural additions

| Addition | Driver | Considered seams | Why insufficient | Smallest extension |
|---|---|---|---|---|
| Checked integration-amendment reviewer callback protocol | B5.3 fresh exact-commit independent review | Ordinary semantic review provenance and existing plugin Task hook | Semantic provenance is fenced during amendment and prewritten review is forgeable | One checked fresh `work-reviewer` plugin route plus the two cataloged immutable reviewer claim/closure sidecars and create-only review |

### Scope and admission

The generic integration amendment is a singleton, pre-panel and pre-PR repair for
one newly exposed failure in a nonmerged direct consumer of an already merged,
independently approved owner slice. It may change only paths already inside that
owner's accepted `effective_paths`, including owner-owned supporting tests or
fixtures. It does not expand ownership or amend the owner's accepted contract.

Admission requires all of the following under the run lock:

1. The run is `running`, its accepted decomposition and delivery envelope are
   current, and its branch and registered worktree are clean at one full baseline
   commit.
2. The owner is `merged`, has complete current APPROVE evidence/review/dispatch/Git
   authority with no unresolved finding, and is the sole effective owner of the
   defect path. The consumer differs from the owner, directly depends on it, and is
   pristine `pending`: `attempts: 0`, with no branch, worktree, blocked reason,
   attempt history, evidence/review/merge binding, or dispatch field. A blocked,
   running, review, merged, or previously attempted consumer rejects before claim
   creation as `integration-amendment-consumer-not-pristine-pending`.
3. No slice is `running` or `review`; test-verifier is absent or pristine at attempt
   zero; validator, security, `gates.pre_pr`, PR fence, PR URL/tuple, and actual
   post-PR authority are absent.
4. No legacy repair or generic amendment exists. `special_builder_dispatch` is
   absent and no orphan or unconsumed special claim/closure exists. Ordinary
   dispatches may retain exact closed history, but none may be active, unknown,
   orphaned, or unconsumed. Completed historical test/artifact claims and receipts
   are allowed; active/unknown claims and unclaimed receipts are not.
5. The selected artifact belongs to the pending consumer's current accepted delivery
   unit. The factory derives its exact subject, program, ordered args, baseline branch
   ref, full HEAD/tree, cwd, and registered worktree. The caller supplies none of
   those values.

Textual integration conflicts, artifact corruption, unowned or sibling-owned test
and fixture excursions, privileged control-plane paths, ownership expansion, and
changes to public or persisted contracts, product scope, security boundaries,
generated ownership, decomposition, or the accepted owner contract are excluded.
The independent amendment review has closed `accepted_contract`, `public_contract`,
`persisted_contract`, `product_scope`, `security_boundary`,
`generated_ownership`, and `decomposition` dispositions. APPROVE and an autonomous
retry both require every disposition to be `preserved`.

Actual post-PR authority is absent only when `post_pr` is absent/null or is a valid
attempt-zero `disabled`/`awaiting-pr` policy shell with empty evidence and null
observation, remediation, continuation review, terminal fact, and PR operation.
Every other post-PR value excludes amendment admission. Post-PR remediation remains
a separate state machine.

### Factory-owned reproduction

`factory amendment ... report` accepts owner, consumer, defect path, and consumer
artifact ID only. The factory exclusively create-publishes a failure execution
claim before spawning the accepted artifact's shell-free command in the exact clean
baseline worktree. It uses the existing reduced environment, timeout, process-close,
stream-limit, and captured-prefix hash policy. After execution it reobserves the
same accepted plan/review, branch ref, full HEAD, registered worktree, index, and
untracked-file cleanliness before publishing or consuming authority.

The baseline is the sole report substrate. No consumer branch, commit, worktree,
untracked file, or synthetic owner/consumer overlay is read or copied. Verification
runs the byte-identical probe against the staged integration tree, whose only delta
is the reviewed owner-owned path set. A probe or fixture available only on a consumer
branch is outside the generic route. It cannot authorize publication; blocked and
branch-only incidents remain a disjoint narrowed legacy/recovery class.

| Observed report outcome | Durable result |
|---|---|
| exited 0 | Complete pass claim/receipt exact-replays and creates no amendment (`not-reproduced`). |
| exited nonzero | Complete fail claim/receipt may be consumed exactly once by `reported`; a crash after receipt but before the manifest fences semantic work until exact report replay binds it. |
| signaled, launch error, timeout, or output limit | Complete diagnostic fail claim/receipt exact-replays but never creates an amendment. |
| process outcome, authority, or receipt publication indeterminate | Claim becomes `unknown` with exact reason `process-outcome-indeterminate`, `authority-changed`, or `receipt-publication-indeterminate`; no supported retry or clear exists. |
| post-process HEAD/index/worktree dirtiness or authority drift | `authority-changed` unknown; model/caller cleanup claims grant no authority. |

Verification uses a separate create-only claim/receipt at the staged integration
commit and reruns the exact same consumer subject and program/args in the exact clean
integration worktree. Exited zero advances to `verified`; a decided nonzero,
signaled, launch-error, timeout, or output-limit result blocks from `integrated`;
active/unknown verification remains `integrated` and stops automation.

### Canonical identity, refs, and pre-manifest fence

The closed amendment identity contains `schema_version: 1`, kind
`integration-amendment-identity`, `run_id`, canonical repository-relative
`defect_path`, and the complete closed `admission` object. Canonical bytes recursively
sort object keys lexicographically, preserve array order, use JSON string escaping and
no insignificant whitespace, then encode UTF-8 with no BOM or trailing newline.
Non-JSON values reject. `amendment_id` is the unpadded SHA-256 base64url digest of
those bytes and matches `[A-Za-z0-9_-]{43}`. Ordinary `*_hash` values remain
`sha256:<64 lowercase hex>` over exact sidecar bytes.

Let `A` be that 43-character ID and `N` be attempt 1 or 2. The refs are fixed:

| Purpose | Exact ref or identity |
|---|---|
| singleton report claim | `evidence/integration-amendment.report.claim.json` |
| report receipt | `evidence/integration-amendment-<A>.report.receipt.json` |
| verification claim | `evidence/integration-amendment-<A>.verify.claim.json` |
| verification receipt | `evidence/integration-amendment-<A>.verify.receipt.json` |
| review | `reviews/integration-amendment-<A>.attempt-<N>.json` |
| build branch | `refs/heads/<run.branch>--amend-<A>-a<N>` |
| build worktree | `<repo>/.opencode/worktrees/<run.branch>--amend-<A>-a<N>` |
| staging ref | `refs/opencode/integration-amendments/<A>/staged` |
| staging worktree | `<repo>/.opencode/worktrees/<run.branch>--amend-<A>-staged` |
| special-dispatch instance | `<A>:attempt-<N>` |

The dispatch claim and closure keep the existing SHA-256/NUL-framed special-dispatch
name derivation over run ID, `special`, route `integration-amendment`, and instance;
raw caller IDs never become path components.

The fixed report claim is a permanent per-run singleton tombstone created under the
run lock before process spawn. Its identity bytes and amendment ID serialize reports
with different caller selectors. The complete observation table is closed:

| Claim / receipt / manifest | Meaning and only permitted action |
|---|---|
| all absent | one report may create the active fixed claim |
| active claim only | owned or unresolved process; all semantic writers reject |
| unknown claim, with optional exact bound receipt | operator reconciliation; no retry, clear, terminalization, or legacy fallback |
| completed pass plus exact receipt, no manifest | settled `not-reproduced`; ordinary work may continue; no second report |
| completed diagnostic fail plus exact signal/launch-error/timeout/output-limit receipt, no manifest | settled diagnostic; ordinary work may continue; no second report |
| completed nonzero fail plus exact receipt, no manifest | unconsumed report; all semantic writers reject; exact report replay creates `reported` |
| exact completed nonzero claim/receipt plus matching manifest | consumed singleton authority |
| receipt without claim | invalid orphan; fail closed |
| manifest, review, verification, or dispatch sidecar without its exact legal claim/binding | invalid cross-bound orphan; fail closed |

Malformed or foreign bytes at a fixed ref are a permanent conflict. A different
identity never receives another report-claim path. Ordinary writers, all amendment
transitions, generic run writers, slice/step/gate/panel/PR/post-PR writers, heartbeat,
resume/recovery, terminalization, cleanup, continuation, legacy report admission,
`validateRun`, and `checkRunConsistency` inspect this tombstone and its complete
sidecar inventory under lock and immediately before protected replacement. Cleanup
protects rather than deletes pre-manifest claims and invalid or unknown authority.

### Closed manifest and state model

Root `run.json` remains schema version 1 and gains optional closed
`integration_amendment`. The generic record is closed to common keys
`schema_version`, `kind`, `amendment_id`, `status`, `owner_slice_id`,
`consumer_slice_id`, `defect_path`, `verification_artifact_id`, `admission`,
`failure_execution`, `max_attempts`, `attempts`, `created_at`, and `updated_at`,
plus only the state-specific `integration`, `verification`, `publication`, or
`blocked` keys below. `schema_version` is 1, `kind` is
`integration-amendment`, and `max_attempts` is exactly 2. No generic pre-release
shape has a compatibility path.

`admission` is closed to `baseline_ref`, `baseline_commit`, `baseline_tree`,
`worktree`, `probe`, `owner`, and `consumer`. The owner snapshot is closed to `id`,
`stack`, `depends_on`, `declared_paths`, `effective_paths`, `status`, `attempts`,
`attempt_reviews`, `evidence_ref`, `evidence_hash`, `review_ref`, `review_hash`,
`reviewed_commit`, and `merge_commit`. The consumer snapshot is closed to `id`,
`stack`, `depends_on`, `declared_paths`, `effective_paths`, `status`, and `attempts`;
it is exactly pristine pending. The probe is closed to `schema_version`, `kind`,
`delivery_unit_id`, `consumer_slice_id`, `verification_artifact_id`,
`test_plan_index`, `test_plan_entry`, `program`, `args`, and `substrate`, with
`schema_version: 1`, kind `integration-amendment-probe`, and substrate
`feature-baseline`. There is no second persisted whole-plan hash: every consumer
reobserves accepted decomposition authority and byte-compares these owner/consumer
snapshots.

`failure_execution` and `verification` are closed
`{claim_ref,claim_hash,receipt_ref,receipt_hash}` bindings. `attempts` is append-only.
Attempt 1 and 2 are closed records whose `building` form contains `attempt`,
`state`, `build_base_commit`, `branch_ref`, and `worktree`; `reviewed` additionally contains
`dispatch_claim_ref`, `dispatch_claim_hash`,
`dispatch_closure_ref`, `dispatch_closure_hash`, `candidate_commit`,
`candidate_tree`, sorted unique Git-observed `changed_paths`, `review_ref`,
`review_hash`, `reviewed_commit`, and `reviewed_tree`. Starting attempt 2 retains
attempt 1's complete REJECT review, dispatch closure, candidate, tree, and paths.

Attempt 1 `build_base_commit` equals `admission.baseline_commit`. Attempt 2 exists
only after exact attempt-1 REJECT with all seven dispositions preserved, and its
`build_base_commit` equals attempt 1 `reviewed_commit`. Attempts are append-only,
strictly numbered from 1, and at most two. A reviewed commit equals the dispatch
closure completion head and the clean build ref/worktree HEAD; its tree is
`reviewed_commit^{tree}`. `changed_paths` is sorted, unique, nonempty, derived with
`--no-renames` from the admission baseline, and wholly inside the frozen owner
`effective_paths`.

`integration` is closed to `ref`, `worktree`, `commit`, and `tree`.
`publication` is closed to `branch_ref`, `previous_commit`, `commit`, and
`published_at`. `blocked` is closed to `origin`, `reason`, and `blocked_at`, where
origin is exactly `reported`, `building`, `reviewed-approve`, `reviewed-reject`,
`integrated`, or `verified`.

Execution claims use kind `integration-amendment-execution-claim` and subject
`integration-amendment:<A>:<phase>`. Their phase is exactly `report|verify`. Active,
completed, and unknown are the only persisted states. Completed requires status
`pass|fail` and an exact receipt hash. Unknown requires exactly one of
`process-outcome-indeterminate`, `authority-changed`, or
`receipt-publication-indeterminate`; no known receipt is represented by both
`receipt_status` and `receipt_hash` being JSON null, while an observed receipt binds
both a known receipt outcome and its exact hash. One null and one non-null rejects.

Execution receipts use kind `integration-amendment-execution-receipt` and the same
phase-specific subject. Their `commands` array contains exactly one result using the
closed command-result and stream schema documented under **Evidence And Review
Files** in `assets/skills/feature/SCHEMA.md`: exact result keys `index`, `program`,
`args`, `outcome`, `status`, `exit_code`, `signal`, `error_code`, `duration_ms`,
`stdout`, and `stderr`; exact stream keys `captured_bytes`, `sha256`, and `truncated`;
and the existing outcome/nullability rules. Receipt status is `pass` only for exited
zero and otherwise `fail`. `review_ready` is true only for report nonzero-exit or
verification pass, the two outcomes consumable by an amendment successor.

Reviews use kind `integration-amendment-review` and subject
`integration-amendment:<A>`. `dispositions` is a closed object with exactly the seven
named keys, each `preserved|changed`. APPROVE requires all preserved and empty
`required_fixes`. REJECT requires normalized nonempty fixes; only all-preserved REJECT
may start attempt 2, while any changed disposition blocks.

The executable discriminated union has these canonical variants:

| Variant | Required authority |
|---|---|
| `amendment-reported` | empty attempts and exact consumed failing execution |
| `amendment-building-attempt-1` / `-2` | last append-only attempt is building; attempt 2 retains reviewed REJECT attempt 1 |
| `amendment-reviewed-approve-attempt-1` / `-2` | last attempt is reviewed and exact external review is APPROVE |
| `amendment-reviewed-reject-attempt-1` / `-2` | last attempt is reviewed and exact external review is REJECT |
| `amendment-integrated` | last review APPROVE plus exact staged integration binding |
| `amendment-verified` | integrated plus exact passing verification binding |
| `amendment-merged` | verified plus exact feature-ref/worktree publication binding |
| `amendment-blocked-from-reported` | reported fields plus exact blocked origin/reason/time |
| `amendment-blocked-from-building` | last building attempt plus exact blocked origin/reason/time |
| `amendment-blocked-from-reviewed-approve` | last APPROVE review plus exact blocked origin/reason/time |
| `amendment-blocked-from-reviewed-reject` | last REJECT review plus exact blocked origin/reason/time |
| `amendment-blocked-from-integrated` | integration retained plus exact blocked origin/reason/time |
| `amendment-blocked-from-verified` | integration and verification retained plus exact blocked origin/reason/time |

The transition graph is `reported -> building(1) -> reviewed`; REJECT with preserved
scope may advance once to `building(2) -> reviewed`; APPROVE advances
`reviewed -> integrated -> verified -> merged`. Any nonterminal state may block
only when no process/Task/ref effect is active or unknown. `merged` and all blocked
variants are terminal, and one run never starts a second generic amendment.

The separate `integrated`, `verified`, and `merged` states are required crash
boundaries: staged reviewed-tree publication, checked passing reproduction, and
feature-ref/worktree publication are distinct effects and none implies the next.

### Git and external-effect recovery

The builder uses a deterministic no-replace build branch/worktree and an exact
attempt-specific special-dispatch claim/closure. Runtime callback IDs and withheld
capability remain process-local selectors; durable authority is only the immutable
claim/closure. An active, unknown, or closed-but-unconsumed dispatch fences semantic
mutation and is never redispatched.

Review derives a nonempty NUL-delimited `--no-renames` baseline-to-candidate path
set, exposing both rename sides. Every path must be canonical and owner-owned;
owner-owned supporting tests/fixtures are allowed. The review sidecar is create-only,
fresh, and binds exact attempt, baseline, candidate commit/tree, changed paths,
scope dispositions, verdict, and fixes.

The minimal checked reviewer callback seam is `src/plugin.js`. It accepts only a
foreground fresh `work-reviewer` Task carrying the fixed amendment-review marker,
with no `task_id`, background execution, or delegation. Before dispatch it
create-publishes kind `checked-integration-amendment-review-dispatch-claim` at the
deterministic `dispatch/<sha256>.amendment-review.json` ref. The claim closes exactly
to `schema_version`, `kind`, run/amendment/attempt/agent, baseline and candidate
commit/tree, fixed review ref, checked-context hash, completion-token hash,
`claimed_at`, and deterministic closure ref. Only the same in-memory session/call/
agent/prompt callback may create-publish the review and kind
`checked-integration-amendment-review-dispatch-closure`; the closure closes exactly
to claim ref/hash, run/amendment/attempt/agent, context hash, review ref/hash,
completion token, and `returned_at`.

Reviewer-effect inventory classifies exactly `absent`, `active-claim-only`,
`review-published-without-closure`, `closed-unconsumed`, `consumed`, or
`orphan-or-cross-bound`. Every non-absent unconsumed state fences semantic mutation,
including amendment block; only the exact `review` transition may consume
`closed-unconsumed`. Review bytes without closure are an unknown external effect and
require operator reconciliation, never redispatch. Exact callback replay after review
or closure publication verifies existing bytes and never replaces them. Consumed
claim/closure/review provenance is immutable and revalidated by every downstream
amendment consistency consumer. The sidecars add no `run.json` field or schema bump;
persisted runs without them remain compatible only before reviewer dispatch, while
every reviewed generic attempt requires both rows.

The plugin keeps a pending callback capability through completion and deletes it on
success or any stale, cross-role, malformed, token, context, or output failure. It
retains that capability only when completion classifies a publication ambiguity by
observing the review or closure target at the exact expected bytes and binding. The
identical second callback exact-replays those bytes and finishes closure without
replacement; conflicting bytes are never replayable.

Integration creates or exact-replays a deterministic staging ref/worktree whose
commit has ordered parents `[baseline_commit, reviewed_commit]` and tree equal to
the reviewed tree. The unique full merge base is baseline. Baseline-to-reviewed and
first-parent-to-integration no-renames path sets are equal, and every changed path
has identical absence or mode/type/object identity in reviewed and integration trees.
The feature ref still equals baseline through verification.

Final publication uses the mutation itself as authority:
`git update-ref <feature-ref> <integration-commit> <baseline-commit>`. Baseline must
be an ancestor of integration. Recovery accepts exactly three cases:

1. Feature ref and clean worktree/index are at baseline: run the CAS, then reconcile.
2. Feature ref and clean worktree/index are already at integration: exact replay.
3. Feature ref is integration while the registered worktree/index exactly retain the
   pre-CAS clean baseline snapshot: finish the checked worktree reconciliation.

Every other ref, index, worktree, untracked, symlink, merge/rebase, foreign, or dirty
state fails closed. `merged` publishes only after the ref and registered worktree are
both clean at exact integration. Deterministic hooks and tests cover immediately
before and after claim creation, process/receipt publication, Task claim/closure,
staging ref/worktree creation, feature CAS, worktree reconciliation, and protected
`run.json` replacement. Unreferenced commit objects grant no authority.

### Consumers, continuation, and migration

Before `merged`, ordinary builder dispatch, slice start/review/merge, artifact/test
execution, steps/test-verifier, panels, gate boundaries/decisions, pre-PR fence, PR,
post-PR mutation, ordinary resume/recovery, continuation, cleanup, and generic
terminalization are fenced. A checked blocked amendment permits only checked run
terminalization. After `merged`, every downstream consumer rehashes amendment
sidecars and reobserves accepted plan/owner snapshots. The admission-time owner,
pristine consumer, all-slice plan identity, integration, verification, and publication
authority remain immutable; the live admitted consumer may advance only through
checked normal slice states whose evidence, review, current and historical builder
dispatch sidecars, and Git merge are revalidated. The feature HEAD must be the tip of
the exact first-parent chain of recorded checked slice merges rooted at the amendment
integration commit. Fresh final tests/panels remain required, and the original merged-
owner row remains historical rather than being rewritten.

The checked pending-to-running transition first observes that exact feature-chain tip,
requires the supplied first-attempt branch and registered clean worktree to equal it,
and persists it as immutable `authorized_baseline_commit`. First dispatch and every
history `diff_base_commit` bind that value; retries start only at the immediately prior
reviewed commit. Merge and every post-merge consistency reader require the Git merge
base to equal the authorized baseline and require the ownership-reviewed and integrated
path sets to be identical, so an ahead branch cannot hide owner, sibling, control-plane,
or otherwise allowed pre-dispatch commits.

The admitted consumer remains byte-identical pristine pending throughout the
amendment. Publication does not reactivate, reset, or synthesize slice authority.
After `merged`, normal dependency scheduling starts its first attempt from the new
integration HEAD. A blocked or previously attempted consumer is deliberately
ineligible because existing blocked slices are terminal and B5 introduces no unsafe
blocked-to-running transition, attempt reset, consumer overlay, or branch rewrite.

V1 and V2 continuation are intentionally unsupported for any parent or child carrying
`integration_amendment`. Construction, target reservation/allocation, publication,
adoption, payload parsing/replay, local-authority checks, resume, and synthetic child
injection all reject before effects with
`integration-amendment-continuation-unsupported`. Supporting amendment continuation
would require a separately approved sidecar-copy and first-parent proof design.

Persisted `merged_slice_repair` records retain their original schema and may progress
through their original transition/dispatch/readers. Generic and legacy records cannot
coexist. After every generic parity case passes in the same reviewed tree, new legacy
admission is retired only for pristine-pending, baseline-substrate incidents covered
by the generic route. A blocked, previously attempted, or branch-only consumer stays
in the explicitly narrowed legacy/recovery class; it cannot fall back after any
generic claim or tombstone exists. Legal successors of an already persisted legacy
record remain unchanged. This makes the two admission sets disjoint rather than
keeping competing maximally strict workflows for one incident.

### Finite source-to-sink matrix

| Sink | Required amendment policy |
|---|---|
| `validateRun` / `checkRunConsistency` | closed variant; exact claim/receipt/review/dispatch bytes and Git identities; no generic/legacy overlap |
| fixed report-claim inventory | classify absent/active/unknown/settled/unconsumed/consumed/orphan under lock; never infer authority from a missing manifest |
| all amendment transitions | exact prior variant, current plan/owner/branch/sidecars, idempotent same-input replay, protected replacement recheck |
| generic run writers | cannot create, change, or remove amendment or its authority bindings |
| special builder prepare/complete | exact `integration-amendment` route, owner-stack agent, attempt, branch/worktree/head, immutable claim/closure |
| ordinary dispatch and slice start/review/merge | reject unresolved/blocked amendment; merged route reobserves owner overlay |
| artifact and final test execution / steps | reject unresolved/blocked amendment; merged route requires exact current integration and fresh authority |
| panels / Gate 3 / pre-PR fence / PR | reject unresolved/blocked amendment; rehash merged route before publication |
| resume / heartbeat / terminal / recovery / cleanup | no bypass; active/unknown effects stay fail-closed; blocked routes only to checked terminalization |
| post-PR | report rejects actual post-PR authority; post-PR transitions reject unresolved amendment; merged then proceeds normally |
| V1/V2 continuation | reject any generic amendment at construction, allocation, publication, adoption, replay, and resume |

### PR #79 parity inventory

B5.4 maps the existing finite adversarial suite individually to the generic route:

| # | Existing category | Generic decision sink |
|---|---|---|
| 1 | report eligibility | checked failure execution and report admission |
| 2 | ratified ownership and overlap | current effective-owner observation |
| 3 | quiescence and attempt ceiling | build transition |
| 4 | special dispatch derivation | generic prepare/complete route |
| 5 | heartbeat dispatch fence | heartbeat pre-mutation check |
| 6 | abbreviated commit | full-SHA review binding |
| 7 | changed paths and write-once review | Git path observation/create-only review |
| 8 | resulting feature head | staged verify then feature CAS |
| 9 | unresolved resume fence | resume projection |
| 10 | blocked terminalization | checked block then terminal boundary |
| 11 | exact-file lanes | effective ownership matcher |
| 12 | exact reviewed commit | dispatch closure/review binding |
| 13 | divergent merge tree | reviewed/integration tree proof |
| 14 | stale verdict or attempt | external review consumer |
| 15 | rename source | no-renames two-endpoint path set |
| 16 | frozen owner authority | plan/owner reobservation |
| 17 | original evidence drift | failure claim/receipt rehash |
| 18 | canonical lane text | path normalization |
| 19 | unsupported globs | accepted plan/lane validator |
| 20 | slice quiescence | slice start/merge fences |
| 21 | step fence | step/test-verifier fences |
| 22 | gate fence | gate boundary/decision fences |
| 23 | post-PR exclusion | canonical actual-authority predicate |
| 24 | pre-integration admission | test/panel/gate/fence/PR absence |
| 25 | heartbeat work | building/review wait classification |
| 26 | consistency drift | sidecar/Git consistency consumers |
| 27 | generic mutation denial | scoped run-writer guard |
| 28 | sidecar/Git publication races | deterministic pre/post effect hooks |

### CLI and durable catalog

The planned strict CLI is:

```text
factory amendment <run-id> report --owner-slice ID --consumer-slice ID --defect-path PATH --artifact-id ID --json
factory amendment <run-id> build --attempt 1|2 --json
factory amendment <run-id> review --json
factory amendment <run-id> integrate --json
factory amendment <run-id> verify --json
factory amendment <run-id> merge --json
factory amendment <run-id> block --reason TEXT --json
```

No command accepts caller hashes, refs, commands, cwd, worktree, changed paths,
commits, trees, verdicts, process outcomes, or status booleans. Fixed sidecar names
derive from the canonical amendment ID and attempt.

The generic route expands durable authority class 9 because it protects the same
merged-owner acceptance asset. It does not create class 10. Catalog rows separately
cover every manifest variant above; failure and verification claim active,
completed-pass, completed-fail, and three unknown variants; pass, nonzero, signal,
launch-error, timeout, and output-limit receipts; APPROVE/REJECT amendment reviews;
special-dispatch run binding, immutable claim, and immutable closure; and the two
production reviewer-dispatch claim/closure rows. The finite total is 48 rows. Runtime
callback session/call IDs are process-local selectors; the completion capability is
retained only in the immutable claim/closure binding. Each row has a concrete target or
record-specific nonempty exclusion for all twelve families: missing key, unknown key,
wrong schema, kind, time, type, ref, hash, bytes, descriptor key-shape drift, stale
identity, and cross-bound identity. All eight legacy PR #79 variants remain registered.
B5.4 activates all 48 generic rows, bringing the complete durable catalog to exactly
196 variants and 195 production-covered variants while retaining
`final-plan-descriptor` as the sole future-only row.

### Canonical machine-readable B5.1 contract

The JSON object between the markers is normative. Family-level catalog policy applies
to every explicitly listed variant in that family; no wildcard or inferred variant is
allowed. B5.2-B5.4 may add runtime fields only by first changing this design contract
and its independent structural fixture.

<!-- integration-amendment-contract:start -->
```json
{
  "schema_version": 1,
  "kind": "integration-amendment-design-contract",
  "runtime_authority": false,
  "identity": {
    "keys": ["schema_version", "kind", "run_id", "defect_path", "admission"],
    "canonicalization": "recursive-lexicographic-object-keys-array-order-json-utf8-no-bom-no-newline",
    "id": "sha256-base64url-unpadded-43",
    "fixture_input": {"run_id":"r","schema_version":1,"kind":"integration-amendment-identity","defect_path":"src/a.js","admission":{"baseline_ref":"refs/heads/f"}},
    "fixture_canonical_json": "{\"admission\":{\"baseline_ref\":\"refs/heads/f\"},\"defect_path\":\"src/a.js\",\"kind\":\"integration-amendment-identity\",\"run_id\":\"r\",\"schema_version\":1}",
    "fixture_id": "GLwRWjMLO_9ciKDTgfdfvqAOkPOVy_Y_4nunddvBoWY"
  },
  "eligibility": {
    "consumer_status": "pending",
    "consumer_attempts": 0,
    "consumer_forbidden_keys": ["branch", "worktree", "blocked_reason", "attempt_reviews", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"],
    "substrate": "feature-baseline",
    "consumer_after_merge": "byte-identical-pristine-pending",
    "excluded_consumer_classes": ["blocked", "previously-attempted", "branch-only"]
  },
  "refs": {
    "report_claim": "evidence/integration-amendment.report.claim.json",
    "report_receipt": "evidence/integration-amendment-<A>.report.receipt.json",
    "verify_claim": "evidence/integration-amendment-<A>.verify.claim.json",
    "verify_receipt": "evidence/integration-amendment-<A>.verify.receipt.json",
    "review": "reviews/integration-amendment-<A>.attempt-<N>.json",
    "review_dispatch_claim": "dispatch/<sha256(run-id NUL integration-amendment-review NUL A NUL N)>.amendment-review.json",
    "review_dispatch_closure": "dispatch/<same-sha256>.amendment-review.closed.json",
    "build_branch": "refs/heads/<run.branch>--amend-<A>-a<N>",
    "build_worktree": "<repo>/.opencode/worktrees/<run.branch>--amend-<A>-a<N>",
    "staging_ref": "refs/opencode/integration-amendments/<A>/staged",
    "staging_worktree": "<repo>/.opencode/worktrees/<run.branch>--amend-<A>-staged",
    "dispatch_instance": "<A>:attempt-<N>"
  },
  "field_sets": {
    "admission": ["baseline_ref", "baseline_commit", "baseline_tree", "worktree", "probe", "owner", "consumer"],
    "owner": ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"],
    "consumer": ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts"],
    "probe": ["schema_version", "kind", "delivery_unit_id", "consumer_slice_id", "verification_artifact_id", "test_plan_index", "test_plan_entry", "program", "args", "substrate"],
    "execution_binding": ["claim_ref", "claim_hash", "receipt_ref", "receipt_hash"],
    "attempt_building": ["attempt", "state", "build_base_commit", "branch_ref", "worktree"],
    "attempt_reviewed": ["attempt", "state", "build_base_commit", "branch_ref", "worktree", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash", "candidate_commit", "candidate_tree", "changed_paths", "review_ref", "review_hash", "reviewed_commit", "reviewed_tree"],
    "integration": ["ref", "worktree", "commit", "tree"],
    "publication": ["branch_ref", "previous_commit", "commit", "published_at"],
    "blocked": ["origin", "reason", "blocked_at"],
    "review": ["schema_version", "kind", "subject", "amendment_id", "attempt", "build_base_commit", "reviewed_commit", "reviewed_tree", "changed_paths", "dispositions", "verdict", "required_fixes", "reviewed_at"],
    "claim_active": ["schema_version", "kind", "phase", "subject", "state", "nonce", "amendment_id", "identity", "run_id", "probe", "head_sha", "tree_sha", "cwd", "receipt_ref", "claimed_at"],
    "claim_completed": ["schema_version", "kind", "phase", "subject", "state", "nonce", "amendment_id", "identity", "run_id", "probe", "head_sha", "tree_sha", "cwd", "receipt_ref", "claimed_at", "completed_at", "status", "receipt_hash"],
    "claim_unknown": ["schema_version", "kind", "phase", "subject", "state", "nonce", "amendment_id", "identity", "run_id", "probe", "head_sha", "tree_sha", "cwd", "receipt_ref", "claimed_at", "failed_at", "reason", "receipt_status", "receipt_hash"],
    "receipt": ["schema_version", "kind", "phase", "subject", "run_id", "amendment_id", "claim_nonce", "probe", "head_sha", "tree_sha", "cwd", "started_at", "completed_at", "duration_ms", "status", "review_ready", "commands"],
    "review_dispatch_claim": ["schema_version", "kind", "run_id", "amendment_id", "attempt", "agent", "baseline_commit", "candidate_commit", "candidate_tree", "review_ref", "context_hash", "completion_token_hash", "claimed_at", "closure_ref"],
    "review_dispatch_closure": ["schema_version", "kind", "claim_ref", "claim_hash", "run_id", "amendment_id", "attempt", "agent", "context_hash", "review_ref", "review_hash", "completion_token", "returned_at"]
  },
  "dispositions": ["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"],
  "discriminator_rules": {
    "kinds": {
      "identity": "integration-amendment-identity",
      "probe": "integration-amendment-probe",
      "claim": "integration-amendment-execution-claim",
      "receipt": "integration-amendment-execution-receipt",
      "review": "integration-amendment-review",
      "review_dispatch_claim": "checked-integration-amendment-review-dispatch-claim",
      "review_dispatch_closure": "checked-integration-amendment-review-dispatch-closure"
    },
    "subjects": {
      "execution": "integration-amendment:<A>:<phase>",
      "review": "integration-amendment:<A>"
    },
    "claim": {
      "phases": ["report", "verify"],
      "states": ["active", "completed", "unknown"],
      "completed_statuses": ["pass", "fail"],
      "unknown_reasons": ["process-outcome-indeterminate", "authority-changed", "receipt-publication-indeterminate"],
      "unknown_no_receipt": {"receipt_status":null,"receipt_hash":null},
      "unknown_receipt_binding": "both-known-outcome-and-exact-hash-or-both-null"
    },
    "receipt": {
      "statuses": ["pass", "fail"],
      "command_count": 1,
      "review_ready": ["report:nonzero-exit", "verify:pass"]
    },
    "review": {
      "verdicts": ["APPROVE", "REJECT"],
      "disposition_values": ["preserved", "changed"],
      "approve": "all-preserved-and-empty-required-fixes",
      "retry": "reject-all-preserved-and-nonempty-required-fixes",
      "block": "any-changed-disposition-or-second-reject"
    },
    "command_result_contract": {
      "source": "assets/skills/feature/SCHEMA.md#evidence-and-review-files",
      "keys": ["index", "program", "args", "outcome", "status", "exit_code", "signal", "error_code", "duration_ms", "stdout", "stderr"],
      "stream_keys": ["captured_bytes", "sha256", "truncated"],
      "outcomes": ["exited", "signaled", "timeout", "output-limit", "launch-error"],
      "nullability": "existing-closed-command-result-nullability"
    }
  },
  "manifest_variants": [
    {"id":"amendment-reported","status":"reported","attempt_shape":"empty","extra_keys":[]},
    {"id":"amendment-building-attempt-1","status":"building","attempt_shape":"building-1","extra_keys":[]},
    {"id":"amendment-building-attempt-2","status":"building","attempt_shape":"reject-1-building-2","extra_keys":[]},
    {"id":"amendment-reviewed-approve-attempt-1","status":"reviewed","attempt_shape":"approve-1","extra_keys":[]},
    {"id":"amendment-reviewed-reject-attempt-1","status":"reviewed","attempt_shape":"reject-1","extra_keys":[]},
    {"id":"amendment-reviewed-approve-attempt-2","status":"reviewed","attempt_shape":"reject-1-approve-2","extra_keys":[]},
    {"id":"amendment-reviewed-reject-attempt-2","status":"reviewed","attempt_shape":"reject-1-reject-2","extra_keys":[]},
    {"id":"amendment-integrated","status":"integrated","attempt_shape":"last-approve","extra_keys":["integration"]},
    {"id":"amendment-verified","status":"verified","attempt_shape":"last-approve","extra_keys":["integration","verification"]},
    {"id":"amendment-merged","status":"merged","attempt_shape":"last-approve","extra_keys":["integration","verification","publication"]},
    {"id":"amendment-blocked-from-reported","status":"blocked","attempt_shape":"empty","extra_keys":["blocked"],"origin":"reported"},
    {"id":"amendment-blocked-from-building","status":"blocked","attempt_shape":"last-building","extra_keys":["blocked"],"origin":"building"},
    {"id":"amendment-blocked-from-reviewed-approve","status":"blocked","attempt_shape":"last-approve","extra_keys":["blocked"],"origin":"reviewed-approve"},
    {"id":"amendment-blocked-from-reviewed-reject","status":"blocked","attempt_shape":"last-reject","extra_keys":["blocked"],"origin":"reviewed-reject"},
    {"id":"amendment-blocked-from-integrated","status":"blocked","attempt_shape":"last-approve","extra_keys":["integration","blocked"],"origin":"integrated"},
    {"id":"amendment-blocked-from-verified","status":"blocked","attempt_shape":"last-approve","extra_keys":["integration","verification","blocked"],"origin":"verified"}
  ],
  "claim_variants": [
    {"id":"amendment-report-claim-active","phase":"report","state":"active","status":null,"reason":null},
    {"id":"amendment-report-claim-completed-pass","phase":"report","state":"completed","status":"pass","reason":null},
    {"id":"amendment-report-claim-completed-fail","phase":"report","state":"completed","status":"fail","reason":null},
    {"id":"amendment-report-claim-unknown-process-outcome-indeterminate","phase":"report","state":"unknown","status":null,"reason":"process-outcome-indeterminate"},
    {"id":"amendment-report-claim-unknown-authority-changed","phase":"report","state":"unknown","status":null,"reason":"authority-changed"},
    {"id":"amendment-report-claim-unknown-receipt-publication-indeterminate","phase":"report","state":"unknown","status":null,"reason":"receipt-publication-indeterminate"},
    {"id":"amendment-verify-claim-active","phase":"verify","state":"active","status":null,"reason":null},
    {"id":"amendment-verify-claim-completed-pass","phase":"verify","state":"completed","status":"pass","reason":null},
    {"id":"amendment-verify-claim-completed-fail","phase":"verify","state":"completed","status":"fail","reason":null},
    {"id":"amendment-verify-claim-unknown-process-outcome-indeterminate","phase":"verify","state":"unknown","status":null,"reason":"process-outcome-indeterminate"},
    {"id":"amendment-verify-claim-unknown-authority-changed","phase":"verify","state":"unknown","status":null,"reason":"authority-changed"},
    {"id":"amendment-verify-claim-unknown-receipt-publication-indeterminate","phase":"verify","state":"unknown","status":null,"reason":"receipt-publication-indeterminate"}
  ],
  "receipt_variants": [
    {"id":"amendment-report-receipt-pass","phase":"report","outcome":"pass"},
    {"id":"amendment-report-receipt-nonzero-exit","phase":"report","outcome":"nonzero-exit"},
    {"id":"amendment-report-receipt-signal","phase":"report","outcome":"signal"},
    {"id":"amendment-report-receipt-launch-error","phase":"report","outcome":"launch-error"},
    {"id":"amendment-report-receipt-timeout","phase":"report","outcome":"timeout"},
    {"id":"amendment-report-receipt-output-limit","phase":"report","outcome":"output-limit"},
    {"id":"amendment-verify-receipt-pass","phase":"verify","outcome":"pass"},
    {"id":"amendment-verify-receipt-nonzero-exit","phase":"verify","outcome":"nonzero-exit"},
    {"id":"amendment-verify-receipt-signal","phase":"verify","outcome":"signal"},
    {"id":"amendment-verify-receipt-launch-error","phase":"verify","outcome":"launch-error"},
    {"id":"amendment-verify-receipt-timeout","phase":"verify","outcome":"timeout"},
    {"id":"amendment-verify-receipt-output-limit","phase":"verify","outcome":"output-limit"}
  ],
  "review_variants": ["amendment-review-approve", "amendment-review-reject"],
  "dispatch_variants": ["amendment-dispatch-binding-active", "amendment-dispatch-binding-closed", "amendment-dispatch-claim", "amendment-dispatch-closure"],
  "review_dispatch_variants": ["amendment-review-dispatch-claim", "amendment-review-dispatch-closure"],
  "catalog_policy": {
    "manifest_variants": {"writer":"factory amendment checked transition","readers":["validateRun","checkRunConsistency","successor amendment transition","merged amendment downstream guard"],"tests":["integration-amendment-contract","integration-amendment-runtime","durable-record-mutations"]},
    "claim_variants": {"writer":"factory amendment report/verify executor","readers":["validateRun","checkRunConsistency","execution replay","successor amendment transition"],"tests":["integration-amendment-contract","integration-amendment-runtime","durable-record-mutations"]},
    "receipt_variants": {"writer":"factory amendment report/verify executor","readers":["validateRun","checkRunConsistency","execution replay","successor amendment transition"],"tests":["integration-amendment-contract","integration-amendment-runtime","durable-record-mutations"]},
    "review_variants": {"writer":"factory amendment review transition","readers":["validateRun","checkRunConsistency","integrate transition","retry transition"],"tests":["integration-amendment-contract","integration-amendment-runtime","durable-record-mutations"]},
    "dispatch_variants": {"writer":"integration-amendment special-dispatch prepare/complete hook","readers":["validateRun","checkRunConsistency","review transition","unresolved-dispatch guard"],"tests":["integration-amendment-contract","factory-integration-amendment","durable-record-mutations"]},
    "review_dispatch_variants": {"writer":"src/plugin.js checked work-reviewer before/after callback through prepare/complete integration-amendment review dispatch","readers":["validateIntegrationAmendmentReviewDispatchClaim","validateIntegrationAmendmentReviewDispatchClosure","inspectIntegrationAmendmentInventory reviewer-effect classifier","callback replay","review transition","downstream amendment consistency"],"tests":["integration-amendment-contract","integration-amendment-runtime","plugin","durable-record-mutations"]}
  },
  "review_dispatch_observations": ["absent", "active-claim-only", "review-published-without-closure", "closed-unconsumed", "consumed", "orphan-or-cross-bound"],
  "review_dispatch_compatibility": {"run_schema_bump":false,"pre-dispatch_legacy":"absent-compatible","reviewed_attempt":"claim-and-closure-required","publication":"create-only-exact-replay-no-overwrite","unresolved":"semantic-fence-and-operator-reconciliation-no-redispatch","consumed":"immutable-downstream-revalidation"},
  "transitions": ["reported->building-1", "building-1->reviewed-approve-1", "building-1->reviewed-reject-1", "reviewed-reject-1->building-2", "building-2->reviewed-approve-2", "building-2->reviewed-reject-2", "reviewed-approve-1->integrated", "reviewed-approve-2->integrated", "integrated->verified", "verified->merged"],
  "blocked_origins": ["reported", "building", "reviewed-approve", "reviewed-reject", "integrated", "verified"],
  "report_outcomes": [
    {"outcome":"pass","decision":"settled-no-manifest"},
    {"outcome":"nonzero-exit","decision":"reported-on-exact-consumption"},
    {"outcome":"signal","decision":"settled-diagnostic-no-manifest"},
    {"outcome":"launch-error","decision":"settled-diagnostic-no-manifest"},
    {"outcome":"timeout","decision":"settled-diagnostic-no-manifest"},
    {"outcome":"output-limit","decision":"settled-diagnostic-no-manifest"},
    {"outcome":"indeterminate","decision":"unknown-operator-reconciliation"}
  ],
  "verification_outcomes": [
    {"outcome":"pass","decision":"verified"},
    {"outcome":"nonzero-exit","decision":"blocked-from-integrated"},
    {"outcome":"signal","decision":"blocked-from-integrated"},
    {"outcome":"launch-error","decision":"blocked-from-integrated"},
    {"outcome":"timeout","decision":"blocked-from-integrated"},
    {"outcome":"output-limit","decision":"blocked-from-integrated"},
    {"outcome":"indeterminate","decision":"remain-integrated-and-fence"}
  ],
  "report_claim_observations": ["all-absent", "active-claim-only", "unknown-claim-optional-bound-receipt", "completed-pass-receipt-no-manifest", "completed-diagnostic-receipt-no-manifest", "completed-nonzero-receipt-no-manifest", "completed-nonzero-receipt-matching-manifest", "receipt-without-claim", "cross-bound-or-orphan-sidecar"],
  "publication_cases": ["ref-and-clean-worktree-at-baseline", "ref-and-clean-worktree-at-integration", "ref-at-integration-worktree-at-exact-clean-pre-cas-baseline"],
  "writer_fences": ["amendment-transitions", "generic-run-writers", "slice-writers", "step-writers", "gate-writers", "panel-writers", "pre-pr-and-pr-writers", "post-pr-writers", "heartbeat-writers", "resume-and-recovery", "terminalization", "cleanup", "continuation", "legacy-report-admission", "validateRun", "checkRunConsistency"],
  "continuation_boundaries": ["construction", "target-reservation", "allocation", "publication", "adoption", "payload-replay", "local-authority-check", "resume"],
  "migration": ["persisted-legacy-progresses-unchanged", "generic-and-legacy-never-coexist", "generic-tombstone-forbids-legacy-fallback", "generic-retires-legacy-only-for-pristine-pending-baseline-substrate", "blocked-previously-attempted-and-branch-only-remain-narrowed-legacy-recovery", "all-28-adversarial-guarantees-port-before-cutover"],
  "parity": [
    {"id":1,"category":"report eligibility","sink":"checked failure execution and report admission"},
    {"id":2,"category":"ratified ownership and overlap","sink":"current effective-owner observation"},
    {"id":3,"category":"quiescence and attempt ceiling","sink":"build transition"},
    {"id":4,"category":"special dispatch derivation","sink":"generic prepare/complete route"},
    {"id":5,"category":"heartbeat dispatch fence","sink":"heartbeat pre-mutation check"},
    {"id":6,"category":"abbreviated commit","sink":"full-SHA review binding"},
    {"id":7,"category":"changed paths and write-once review","sink":"Git path observation/create-only review"},
    {"id":8,"category":"resulting feature head","sink":"staged verify then feature CAS"},
    {"id":9,"category":"unresolved resume fence","sink":"resume projection"},
    {"id":10,"category":"blocked terminalization","sink":"checked block then terminal boundary"},
    {"id":11,"category":"exact-file lanes","sink":"effective ownership matcher"},
    {"id":12,"category":"exact reviewed commit","sink":"dispatch closure/review binding"},
    {"id":13,"category":"divergent merge tree","sink":"reviewed/integration tree proof"},
    {"id":14,"category":"stale verdict or attempt","sink":"external review consumer"},
    {"id":15,"category":"rename source","sink":"no-renames two-endpoint path set"},
    {"id":16,"category":"frozen owner authority","sink":"plan/owner reobservation"},
    {"id":17,"category":"original evidence drift","sink":"failure claim/receipt rehash"},
    {"id":18,"category":"canonical lane text","sink":"path normalization"},
    {"id":19,"category":"unsupported globs","sink":"accepted plan/lane validator"},
    {"id":20,"category":"slice quiescence","sink":"slice start/merge fences"},
    {"id":21,"category":"step fence","sink":"step/test-verifier fences"},
    {"id":22,"category":"gate fence","sink":"gate boundary/decision fences"},
    {"id":23,"category":"post-PR exclusion","sink":"canonical actual-authority predicate"},
    {"id":24,"category":"pre-integration admission","sink":"test/panel/gate/fence/PR absence"},
    {"id":25,"category":"heartbeat work","sink":"building/review wait classification"},
    {"id":26,"category":"consistency drift","sink":"sidecar/Git consistency consumers"},
    {"id":27,"category":"generic mutation denial","sink":"scoped run-writer guard"},
    {"id":28,"category":"sidecar/Git publication races","sink":"deterministic pre/post effect hooks"}
  ]
}
```
<!-- integration-amendment-contract:end -->

### B5 exclusions

No post-PR remediation replacement, textual conflict resolver, artifact repair,
ownership expansion, public/persisted/product/security/generated/decomposition
change, multiple amendment list, continuation support, owner-row rewrite, automatic
PR/merge, new authority class, remote service, or cryptographic integrity claim is
introduced by B5.
