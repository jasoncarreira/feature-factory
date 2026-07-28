# Durable Authority Boundary-Retention Ledger

Status: current finite boundary-retention ledger. Only current record shapes are
authoritative; old or partial shapes reject fail-closed and require re-seeding.

This ledger decides which facts must survive an authority boundary and which facts
must be observed again. It is closed over the nine authority classes in the B0.3
Durable Authority Integrity Catalog. Adding another durable authority class requires
an explicit ledger revision; phrases such as "and similar fields" do not extend it.

## Dispositions

- `RETAIN` means persist the exact fact at the real authority boundary. Retained refs
  bind exact bytes, retained Git identities are full commit or tree identities, and
  retained external identities include the checked operation identity. A consumer
  still validates the retained binding and re-observes a mutable source when the
  transition says it must.
- `REOBSERVE` means obtain the fact from Git or a checked external operation at the
  consuming boundary. Do not persist a second internal attestation and later treat it
  as observation.
- `CONSOLIDATE/REMOVE` applies only to duplicate internal attestation. The row names
  the canonical manifest and transition that replace it. Consolidation is forbidden
  if it would discard unique evidence bytes, an independent decision, a Git identity,
  an external-system identity, or an idempotency/ownership control.

A model claim, producer summary, mutable working-tree file, mutable local manifest,
heartbeat, PID, or diagnostic snapshot is never a substitute for Git observation,
exact evidence/review bytes, or a checked external operation. Local files may carry a
retained byte binding, but file presence or current mutable contents alone prove
nothing. All observations are local-consistency evidence inside the trusted-host
boundary; they are not cryptographic authentication.

## Finite class index

| # | B0.3 authority class | Ledger section |
|---|---|---|
| 1 | Plan and slices graph | Authority class 1 |
| 2 | Run envelope and terminal result | Authority class 2 |
| 3 | Gates, pending snapshot, and handoff receipt | Authority class 3 |
| 4 | Steps and acceptance inheritance | Authority class 4 |
| 5 | Slices and review/evidence bindings | Authority class 5 |
| 6 | Validator, security, and PR-created result | Authority class 6 |
| 7 | Continuation and planning/draft reuse | Authority class 7 |
| 8 | Post-PR nested records | Authority class 8 |
| 9 | Generic integration amendment | Authority class 9 |

## 1. Authority class: Plan and slices graph

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| `plan/slices.json` slice `id`, `stack`, `paths`, `depends_on`, `acceptance`, and `test_plan`; graph ordering, lane ownership, and acceptance coverage | `RETAIN` | Retain the accepted plan bytes and descriptor binding at `factory slices-seed`; the seeded `run.json.slices[]` identity is the execution manifest. |
| Root `integration_gate.required_commands` ordered closed `{program,args}` entries and exact final `npm` / `["run","check"]` identity | `RETAIN` | Retain in exact `plan/slices.json` bytes. Every plan reader, creation-mode seed, and schema-v2 carry-forward construction, publication, adoption, local mutation, and replay validates it while `carry_forward.plan_hash` binds exact bytes and order. Missing current authority rejects and requires re-seeding. |
| Required current-plan `delivery_envelope` schema v1 delivery-unit/family/obligation/artifact graph and exact test-plan bindings | `RETAIN` | Retain only inside the already hash-bound exact `plan/slices.json` bytes. Every plan requires it. Seed and accepted-decomposition observation validate and re-observe it; missing or partial envelopes reject and require re-seeding. Do not create a second plan root or hash chain. |
| Accepted work-decomposer plan and decomposition review refs/hashes | `RETAIN` | Reuse the existing closed step `acceptance` object with `artifact_ref: "plan/slices.json"` and current review ref/hash. Seed resolves only exact run-relative regular non-symlink plan bytes; test-verifier and every schema-v2 construction/publication/adoption/replay/resume/downstream consumer rehash both files, including immediately before child no-replace publication. |
| Explicit `delivery_envelope.checkpoint_plan`, typed valid admission probe, same-attempt `APPROVE-CHECKPOINT` identity, and ordered child dispositions | `RETAIN` | Retain in exact accepted plan/review bytes. The order is plan write, nonmutating `factory slices-probe`, reviewer dispositions, then parent acceptance/routing. `validateReviewedCheckpointPlan`, `buildDeliveryPlanAdmissionProbe`, accepted-decomposition observation, and `buildCheckpointRoutingManifest` consume these facts; invalid probes are complete typed diagnostics and grant no authority. |
| Content-addressed checkpoint-routing manifest source plan/review/probe/disposition binding, ordered requests, and whole-story gates | `RETAIN` | Publish only from exact accepted plan plus same-attempt `APPROVE-CHECKPOINT` review. The checked oversized terminal transition re-observes source bytes before artifact creation and terminal replacement; replay rebuilds the deterministic manifest rather than trusting retained prose. |
| Parent `checkpoint_progress` manifest binding and `reserved`, `child-published`, `launched`, `merged`, and `closed` states | `RETAIN` | `transitionCheckpointProgressReserved`, `transitionCheckpointProgressChildPublished`, `transitionCheckpointProgressLaunched`, `transitionCheckpointProgressMerged`, and `transitionCheckpointProgressClosed` are the checked writers. Every successor retains all prior facts, only merged unlocks a later entry, and closed requires all manifest entries merged plus one content-addressed closure binding. |
| Child publication claim and immutable child `checkpoint_source` | `RETAIN` | `checkpoint-start` writes the canonical `delivery-checkpoint-child-publication` blob, then `reconcileCheckpointPublication` create-publishes its one claim ref plus branch and complete normal child directory without replacement. `validateCheckpointChildPublication`, publication replay, and `validateCheckpointSource` consume the exact bindings. The claim prevents conflicting creation only; ordinary child lifecycle continues after publication, while `checkpoint_source` remains byte-identical through same-checkpoint B1 recovery. |
| Merged checkpoint completion and final closure | `RETAIN` | `factory checkpoint-record-merged` resolves and locks the normal child plus same-checkpoint B1 lineage, reobserves continuation claims, canonical merged PR, ancestry, immutable source, and full configuration, then writes the merged progress entry. `factory checkpoint-close` first records a launched final child when needed, then publishes a reservation-free content-addressed closure artifact and atomically records its ref/hash/time in closed parent progress. |
| Checkpoint cleanup authorization | `REOBSERVE` | Under the routing-parent lock, require exactly one merged progress lineage row with the exact child run ID and run hash before ordinary cleanup. Published/launched, stale, duplicate, missing, or cross-checkpoint lineage grants no cleanup authority. |
| Target continuation reservation under `refs/opencode/continuation-targets/<sha256-child-run-id>` | `RETAIN` | Create once by Git zero-OID CAS before schema-v2 allocation. Bind route schema 2, crash-stable creation time, and the complete continuation hash; payload, resume, allocation, and publication consumers require exact replay and reject cross-authority reuse. |
| `final.plan.json` descriptor ref, hash, byte binding, and descriptor key shape | `RETAIN` | Retain at the planning acceptance/slice-seed boundary and validate the exact descriptor bytes before consumption. |
| Current Git path existence and the effective paths changed by a candidate commit | `REOBSERVE` | Use Git plumbing with rename detection disabled at the consuming transition; neither plan text nor evidence `changed_paths` is mutation authority. |
| A later repair's second hash of the whole plan, when it exists only to restate owner-lane authority | `CONSOLIDATE/REMOVE` | Replace with the accepted canonical `plan/slices.json`/`factory slices-seed` binding plus one owner/effective-path snapshot in the canonical amendment manifest, written by the canonical amendment admission transition. |

## 2. Authority class: Run envelope and terminal result

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Run `schema_version`, `run_id`, `external_ref`, `base_ref`, exact `base_commit`, `branch`, `worktree`, lifecycle `status`, retry/parallel limits, effective `pr_mode`, and configured GitHub account identity | `RETAIN` | Retain in `run.json` at bootstrap and through checked locked transitions. Exact commits are never shortened or replaced by branch names. |
| Terminal `status`, `run_id`, reason/reason code, summary, artifact refs, and the universal PR operation/node/head/base tuple | `RETAIN` | Retain once in `run.json.terminal_result` through `factory terminal`, checked `factory pr-created`, or the class-specific checked terminal transition. Completed PR results require `{pr_url,pr_number,pr_node_id,repository,operation_id,head_ref,head_sha,base_ref,base_sha,draft}`; old-shape or partial completed tuples reject. |
| Oversized checkpoint terminal variant | `RETAIN` | The class-specific transition writes exactly pre-PR `blocked`, reason `oversized-plan-checkpoint-routing-required`, null PR identity, and one content-addressed `checkpoint_routing` artifact. Generic or malformed terminal records cannot claim this route. |
| Current branch ref, worktree identity, HEAD, commit existence, trees, and required ancestry | `REOBSERVE` | Query Git at resume, merge, repair, push, and terminal consumption boundaries; a mutable `run.json` branch/worktree string cannot substitute. |
| A free-standing producer or model terminal-success claim | `CONSOLIDATE/REMOVE` | Replace with `run.json.terminal_result` written by `factory terminal` or `factory pr-created` after their checked preconditions. |

## 3. Authority class: Gates, pending snapshot, and handoff receipt

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Gate identity/status, artifact/question/answer refs, approval source, decision, acceptance time, and `pending_snapshot` refs/hashes/creation time | `RETAIN` | Retain through `factory gate-decision`; the pending snapshot binds the exact material that may be decided. |
| `handoff_receipt` schema/kind/gate, approval fingerprint, pending-snapshot hash, answer hash, steering generation, and accepted time | `RETAIN` | Retain unchanged at the interactive approval boundary and require it at the launch handoff. |
| Current question, artifact, and answer bytes and current steering generation | `REOBSERVE` | Hash the contained files and inspect lock-protected steering state when the gate decision or handoff consumes them. |
| A copied gate approval, answer summary, or caller-supplied `approved` boolean outside the gate record | `CONSOLIDATE/REMOVE` | Replace with `run.json.gates.<gate>` and its receipt written by `factory gate-decision`; no parallel approval manifest is authoritative. |

## 4. Authority class: Steps and acceptance inheritance

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Step agent, status, attempt, artifact/evidence/review refs, and acceptance artifact/review refs and hashes | `RETAIN` | Retain at `factory step ... accepted|rejected|blocked`; accepted state binds the exact artifact and optional review bytes. |
| Schema-v2 test-verifier `execution_claim` active/completed/unknown variants and fixed factory receipt ref/hash | `RETAIN` | `factory test-execute <run-id> --json` writes the nonce-bound active claim before spawn and completes it only after create-only receipt publication. Generic transitions cannot clear or manufacture it. |
| Exact accepted commands, clean child HEAD, merged ancestry, process exit/signal/timeout/output-limit/launch result, stream prefix lengths/hashes, and receipt bytes | `REOBSERVE` | Recheck plan/decomposition/Git authority before claim and publication; derive the closed receipt from shell-free bounded process events. Never trust caller result fields or persist raw output. |
| Active/unknown claim disposition | `RETAIN` | Every supported CLI and exported transition retains the exact claim/hash and rejects unchanged: all `factory recover` reasons (including former magic text), generic terminal, steering conflict, step mutation, and `test-execute` retry. Caller/model text and fake flags grant no authority. B1R has no autonomous terminal/retry/clear path; trusted out-of-band operator/process reconciliation is required. |
| Caller-authored test evidence or proof booleans | `CONSOLIDATE/REMOVE` | Replace with the completed passing factory receipt plus `artifacts/test-report.md` and an independent same-attempt/same-HEAD APPROVE review. |
| Schema-v2 child accepted planning and immutable accepted slice rows | `RETAIN` | Retain only through checked full-plan carry-forward publication, which verifies parent acceptance and copies exact plan/review/slice sidecar bytes. |
| Current accepted artifact/review bytes and parent binding at carry-forward publication | `REOBSERVE` | Resolve contained refs and hash exact bytes at construction, publication, replay, resume, and downstream consumption. File presence is insufficient. |
| A child copy of the entire parent acceptance chain or a fresh claim that seeded files are accepted | `CONSOLIDATE/REMOVE` | Replace with the parent step `acceptance` plus the schema-v2 `carry_forward` plan hash and immutable accepted rows written by checked publication. |

## 5. Authority class: Slices and review/evidence bindings

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Slice id/stack/dependencies, status, branch/worktree, attempt, evidence/review refs, successor `evidence_hash`/`review_hash`/`reviewed_commit`, blocked reason, and exact merge commit | `RETAIN` | Retain in `run.json.slices[]` through checked `factory slice-status` and `factory slice-merged`; the successor triple is all-or-none only for review/merged. |
| Test/reproduction evidence exact bytes and binding: subject, attempt, status, `review_ready`, command bytes, exact result, observed head, and exact `changed_paths` where applicable | `RETAIN` | Retain the evidence ref/hash at the slice or repair transition. Commands and results are evidence bytes, not summaries. |
| Independent review exact bytes and binding: subject, attempt, verdict, convergence, required `late_discovery_strike`, remaining fix count, required fixes, review ref/hash, and exact reviewed commit where the subject has code bytes | `RETAIN` | Retain at the review transition and in append-only `attempt_reviews`; a later retry, merge, nonconvergence terminalization, or integration-amendment consumer must consume the same review bytes, reviewed commit, and strike marker. |
| Required closed review `invariant_family_ledger` schema v1, including complete family/artifact dispositions, checked receipt refs/hashes, typed probe/result, reviewed commit, and unresolved findings | `RETAIN` | Retain inside the existing exact review bytes/hash. Every delivery-envelope review attempt contains exactly one current disposition per family. Slice-review publication/history/merge re-observe each exact completed execution claim and receipt; APPROVE requires every outcome pass and no unresolved findings. |
| Checked verification-artifact execution claim and receipt | `RETAIN` | Before spawn, `factory artifact-execute` create-publishes a nonce-bound active claim binding run/slice/attempt/plan/HEAD/artifact/program/argv. New refs use fixed-width SHA-256 base64url encodings of exact UTF-8 slice/artifact identities instead of raw path segments; closed records retain original identity. Completion create-publishes the receipt and closes that exact claim with status plus receipt hash. Active/unknown, unclaimed, wrong-nonce, stale, concurrent, or replay-divergent evidence is fail-closed and cannot authorize review. |
| Candidate commit/tree, slice branch/worktree HEAD and cleanliness, merge parents/base, and changed-path/object set | `REOBSERVE` | Query Git at review recording and merge. Merge requires ordered parents `P1,R`, unique full base `B`, equal NUL-safe no-renames path sets `B..R`/`P1..M`, and equal per-path absence or mode/type/object identity. |
| Builder/model claim fields that duplicate orchestrator-observed evidence | `CONSOLIDATE/REMOVE` | Replace with the canonical `evidence/<subject>.json` binding and `factory slice-status ... review`; producer claim blocks remain non-authoritative. |

## 6. Authority class: Validator, security, and PR-created result

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Validator subject/attempt/verdict/report/review refs plus current `report_hash`/`review_hash`/`reviewed_head_sha`, and security subject/attempt/verdict/review ref plus current `review_hash`/`reviewed_head_sha` | `RETAIN` | Retain atomically through `factory verdicts`; both complete current rows are required, and PR readiness consumes the passing bound panel result. Missing or partial tuples reject. |
| Current PR fence identity `{operation_id,repository,head_ref,head_sha,base_ref,base_sha,draft}` plus token, generation, state hash, and creation time | `RETAIN` | Derive all-or-none from canonical GitHub origin, exact clean local/worktree/remote head, exact remote base equal to `run.base_commit`, base ancestry, and persisted `run.pr_mode`. `operation_id` is the specified `ffpr-v1` canonical-JSON SHA-256 identity. A present zero/partial tuple rejects validation and requires re-seeding. |
| PR/GitHub external identities: canonical URL, number, node identity, repository, head/base refs and SHAs, draft state, and external creation operation identity | `RETAIN` | Retain at checked reconciliation in the completed terminal result and, when enabled, `post_pr.pr_operation`. New direct and post-PR completion use the same universal tuple. |
| Actual PR existence/state and exact operation marker, including an unknown create outcome | `REOBSERVE` | Account-switch, then perform the shell-free bounded `state=all`, exact owner/head and base query. Strictly normalize all tuple fields and follow only valid Link pagination for at most 10 pages. After a PR exists, reconcile it and never create another. |
| A second PR-success or passing-panel attestation in an internal wrapper | `CONSOLIDATE/REMOVE` | Replace with `run.json.validator`, `run.json.security_review`, and `run.json.terminal_result` written by `factory verdicts` and fenced `factory pr-created`. |

The external body carries exactly one standalone
`<!-- opencode-feature-factory:pr-operation=<operation_id> -->` marker. Unique exact open
normally records; unique exact merged completes without polling; closed-unmerged is
`needs-human`; absent, ambiguous, and unknown retain the fence. Only complete checked
absence authorizes clear. Every present fence requires the complete current identity
tuple; invalid or partial fences reject rather than reconcile.
An unknown external outcome is always re-observed before retry.

## 7. Authority class: Schema-v2 full-plan continuation

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Continuation schema/kind/time/summary; parent run/status/ref/hash/branch/exact commit/worktree; selected review; target identity; closed configuration; and `scope: "full-remaining-plan"` carry-forward partition | `RETAIN` | Retain in child `run.json.continuation` through explicit checked `factory continue ... --carry-forward`; parent identity remains unchanged. |
| Exact accepted plan hash, immutable accepted rows and sidecars, and nonempty disjoint remaining slice IDs | `RETAIN` | Retain through schema-v2 child publication. The accepted and remaining IDs are PLAN-ordered and their set union is the complete plan. |
| Parent manifest, selected review, accepted plan/review/sidecar bytes, parent/target Git identities, and target base ancestry | `REOBSERVE` | Resolve/hash contained refs and query Git during construction, allocation, publication, replay, resume, and downstream consumption. |
| A second whole parent proof chain in the child, or acceptance inferred from copied mutable files | `CONSOLIDATE/REMOVE` | Replace with the closed schema-v2 continuation, exact `carry_forward.plan_hash`, and immutable accepted rows written by checked publication. |

Parent and child continuation identity is never reduced to a prompt, branch label, or
mutable path. The exact parent/child run ids, commits, hashes, and review bytes survive
the handoff.

## 8. Authority class: Post-PR nested records

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Post-PR schema, immutable effective policy, phase, attempt, observation epoch/expected head/poll identity and counters, check/review jobs and result bindings | `RETAIN` | Retain in `run.json.post_pr` through the checked post-PR state transitions. |
| Failure source/fingerprint, failed head, failure evidence ref/hash, remediation id/role/subject/attempt/stage, dispatch id/status, and external dispatch operation token | `RETAIN` | Retain at failure admission and dispatch boundaries so crash/retry reconciliation addresses the same operation. |
| Observed remediation changes/paths, exact candidate commit/head/tree, remediation evidence ref/hash, and append-only evidence refs | `RETAIN` | Retain at changes-observed/committed transitions and bind exact evidence bytes. |
| Revalidation canonical evidence ref/hash/verdict, validator and security refs/hashes/verdicts/reviewed commit, and exact independent review bytes | `RETAIN` | Retain at the checked post-PR revalidation transition. |
| Push status, remote-before SHA, local-head SHA/tree, remote-after SHA, push operation identity/token, and push time | `RETAIN` | Retain at push-pending/remote-confirmed so a crash never turns an unknown push into permission to push different bytes. |
| Continuation review ref/hash and terminal fact/reason/trigger identity | `RETAIN` | Retain at the checked post-PR terminal transition. |
| Current GitHub checks, reviews, PR identity/head, and remote ref before observation, retry, publish, or terminal disposition | `REOBSERVE` | Use checked GitHub/Git remote operations; mutable local post-PR state is only the retained binding, not the external observation. |
| Current local commit/tree/changed paths and remote-before/local/remote-after equality | `REOBSERVE` | Query Git immediately before review binding and push, and after push before remote confirmation. |
| Duplicate job summaries, panel summaries, push-success booleans, or model-reported external status | `CONSOLIDATE/REMOVE` | Replace with `run.json.post_pr` records written by `transitionPostPrState`, `transitionPostPrFailure`, and `transitionPostPrTerminal`. |

## 9. Authority class: Generic integration amendment

Generic integration amendment is the sole in-place repair authority. It is admitted
only for a factory-observed baseline failure in one pristine pending direct consumer
of an independently approved merged owner. Continuation, checkpoint, non-pristine,
old-shape, or otherwise ineligible cases reject before effects and proceed only after
checked terminalization through a fresh schema-v2 full-plan carry-forward child.

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Factory-owned failing execution claim and receipt | `RETAIN` | Create-publish the singleton report claim before shell-free execution, then bind the exact receipt and outcome at amendment admission. Active or unknown outcomes remain fail-closed. |
| Admission baseline and pristine consumer snapshot | `RETAIN` | Bind the exact clean feature ref/commit/tree/worktree, merged owner authority, pristine consumer, selected verification artifact, and amendment identity at report admission. |
| Accepted plan and owner/effective-path authority | `REOBSERVE` | Rehash the strict current `plan/slices.json` and accepted review, then derive current owner authority and changed paths from Git at every consuming boundary. Do not persist a second whole-plan hash. |
| Append-only amendment attempts | `RETAIN` | Retain attempt baseline, branch/worktree, dispatch claim/closure, candidate commit/tree, changed paths, and review binding through checked build/review transitions. |
| Independent review and reviewer callback provenance | `RETAIN` | Bind the fresh exact-commit seven-disposition review plus immutable callback claim and closure. Review without closure, active claim, and orphan/cross-bound state reject. |
| Staged integration, passing verification, and feature publication | `RETAIN` | Retain distinct integration, verification, and publication boundaries; final feature movement uses old-OID CAS and exact worktree reconciliation. |
| Current Git commits, trees, paths, refs, worktrees, and accepted sidecar bytes | `REOBSERVE` | Recheck immediately before every state replacement or external effect; caller/model summaries never substitute. |
| A local/model statement that the amendment was reviewed, integrated, verified, or published | `CONSOLIDATE/REMOVE` | Replace with the canonical amendment manifest and its checked claim, receipt, review, integration, verification, and publication bindings. |

The current states are separately cataloged as reported, building attempts 1/2,
reviewed APPROVE/REJECT attempts 1/2, integrated, verified, merged, and blocked from
reported/building/reviewed-approve/reviewed-reject/integrated/verified. Failure and
verification claims/receipts, APPROVE/REJECT reviews, and dispatch binding/claim/
closure are independent sidecar rows. Runtime callback selectors and withheld
capabilities are not durable authority and remain excluded. Every generic row receives
all twelve target-or-reasoned-exclusion dispositions from the finite mutation catalog.
The fixed per-run report claim is the pre-manifest singleton tombstone: ordinary
writers classify active, unknown, settled, unconsumed, consumed, and orphan states
before mutation and never infer absence from a missing manifest. The canonical B5.1
contract registers exactly 48 current rows: 16 manifests, 12 execution claims, 12
receipts, two reviews, four builder-dispatch rows, and two production reviewer-
dispatch claim/closure rows. The reviewer rows are immutable class-9 provenance:
the claim binds the checked fresh callback context before Task execution and the
closure binds exact callback review bytes. Active claim, review without closure, and
closed-unconsumed observations fence semantic work; only exact review consumption
converts closed-unconsumed to immutable consumed provenance. Orphan/cross-bound
observations reject, and callback replay verifies existing bytes without overwrite.
All 48 rows are active production catalog entries. Together with the remaining
catalog they produce exactly 188 total variants and 187 production-covered
variants; `final-plan-descriptor` remains the sole future-only row.

The existing durable slice variants now include optional immutable
`authorized_baseline_commit` for checked post-amendment progress; this is a new
consequential field in those rows, not a new catalog variant. Checked start derives it
from the exact clean feature HEAD, and dispatch, history, ownership review, merge proof,
and post-merge consistency all reobserve it and its exact path-set equality.

Any generic record makes schema-v2 continuation unsupported. There is no fallback
repair route, sidecar-copy authority, first-parent salvage route, compatibility
reader, or replacement repair state machine.

## External-effect ownership and idempotency controls

These controls accompany the applicable class above; they do not create a tenth
authority class.

| Control | Disposition | Boundary rule |
|---|---|---|
| `run-json.lock/` ownership and verified directory/file identity | `RETAIN` while the mutation is in flight | Observation and mutation stay under the same verified lock; a precheck is not mutation authority. |
| `process-launch.lock/owner.json` run/execution identity, launch kind/phase, process identity, and nonce | `RETAIN` through launch handoff/reconciliation | Create exclusively; phase change/release requires exact nonce, prior phase, directory/file identity, and live process identity. Ambiguity fails closed. |
| Gate/terminal boundary token and steering generation/state hash | `RETAIN` from `factory boundary-open` until atomic consumption | The privileged transition consumes the exact token under lock. |
| Dispatch/remediation action-claim token, operation kind/generation, and started/abort result | `RETAIN` until the external action start is recorded or safely aborted | `factory boundary-cross`, `factory action-started`, and exact-token `factory action-abort` are the canonical transitions. Unknown start outcome is reconciled, not repeated. |
| PR fence token and deterministic PR-create operation/external identity | `RETAIN` until checked `factory pr-created` reconciliation or complete checked absence | The observation and mutation remain under the run lock with a second pre-publication observation. Never clear after a PR exists; ambiguous/unknown retains the fence. |
| Post-PR dispatch, push, check, review, and publication operation ids/tokens | `RETAIN` through their terminal observation | A retry addresses the same operation or begins only after checked absence/failure; success booleans do not replace external identity. |

## Current-shape and single-authority rule

- Readers accept only the current closed shape. Old, marker-less, partial, unknown,
  or incompatible records reject before semantic mutation or external effect and
  require abandonment and re-seeding.
- Slice review and merged rows require complete current bindings/history. Validator
  and security panels require their complete current tuples together. Present PR
  fences require the complete current identity tuple. There is no upgrade, backfill,
  read-only completion, or reconciliation path.
- Generic integration amendment is the sole in-place repair authority. Post-PR
  remediation remains a separate phase-specific state machine, not a fallback for
  amendment-ineligible pre-PR state.
- Ordinary slice closure has exactly two current forms: capability-authenticated
  callback closure or checked candidate adoption. No compatibility closure kind or
  widened key set is authoritative.
