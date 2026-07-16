# Durable Authority Boundary-Retention Ledger

Status: finite design ledger for B0.4. This document does not change a production
schema, persisted shape, transition, or compatibility rule.

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
| 9 | PR79 merged slice repair | Authority class 9 |

## 1. Authority class: Plan and slices graph

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| `plan/slices.json` slice `id`, `stack`, `paths`, `depends_on`, `acceptance`, and `test_plan`; graph ordering, lane ownership, and acceptance coverage | `RETAIN` | Retain the accepted plan bytes and descriptor binding at `factory slices-seed`; the seeded `run.json.slices[]` identity is the execution manifest. |
| `final.plan.json` descriptor ref, hash, byte binding, and descriptor key shape | `RETAIN` | Retain at the planning acceptance/slice-seed boundary and validate the exact descriptor bytes before consumption. |
| Current Git path existence and the effective paths changed by a candidate commit | `REOBSERVE` | Use Git plumbing with rename detection disabled at the consuming transition; neither plan text nor evidence `changed_paths` is mutation authority. |
| A later repair's second hash of the whole plan, when it exists only to restate owner-lane authority | `CONSOLIDATE/REMOVE` | Replace with the accepted canonical `plan/slices.json`/`factory slices-seed` binding plus one owner/effective-path snapshot in the canonical amendment manifest, written by the canonical amendment admission transition. |

## 2. Authority class: Run envelope and terminal result

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Run `schema_version`, `run_id`, `external_ref`, `base_ref`, exact `base_commit`, `branch`, `worktree`, lifecycle `status`, retry/parallel limits, effective `pr_mode`, and configured GitHub account identity | `RETAIN` | Retain in `run.json` at bootstrap and through checked locked transitions. Exact commits are never shortened or replaced by branch names. |
| Terminal `status`, `run_id`, reason/reason code, summary, artifact refs, canonical PR URL, PR number, repository, and draft state | `RETAIN` | Retain once in `run.json.terminal_result` through `factory terminal`, `factory pr-created`, or the class-specific checked terminal transition. |
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
| Child `inherited_acceptance.from_run_id`, parent review ref, artifact hash, and review hash | `RETAIN` | Retain only through `factory adopt-continuation`, which verifies the parent acceptance and child copies. |
| Current accepted artifact/review bytes and parent binding at adoption | `REOBSERVE` | Resolve contained refs and hash exact bytes at step consumption and continuation adoption. File presence is insufficient. |
| A child copy of the entire parent acceptance chain or a fresh claim that seeded files are accepted | `CONSOLIDATE/REMOVE` | Replace with the parent step `acceptance` plus child `inherited_acceptance` written by `factory adopt-continuation`. |

## 5. Authority class: Slices and review/evidence bindings

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Slice id/stack/dependencies, status, branch/worktree, attempt, evidence/review refs, review binding, attempt-review history, blocked reason, and exact merge commit | `RETAIN` | Retain in `run.json.slices[]` through `factory slice-status` and `factory slice-merged`. |
| Test/reproduction evidence exact bytes and binding: subject, attempt, status, `review_ready`, command bytes, exact result, observed head, and exact `changed_paths` where applicable | `RETAIN` | Retain the evidence ref/hash at the slice or repair transition. Commands and results are evidence bytes, not summaries. |
| Independent review exact bytes and binding: subject, attempt, verdict, required fixes, review ref/hash, and exact reviewed commit where the subject has code bytes | `RETAIN` | Retain at the review transition; a later merge must consume the same review bytes and reviewed commit. |
| Candidate commit/tree, base ancestry, and changed-path set | `REOBSERVE` | Query Git at review recording and again at merge. Compare evidence `changed_paths` exactly to Git with rename detection disabled. |
| Builder/model claim fields that duplicate orchestrator-observed evidence | `CONSOLIDATE/REMOVE` | Replace with the canonical `evidence/<subject>.json` binding and `factory slice-status ... review`; producer claim blocks remain non-authoritative. |

## 6. Authority class: Validator, security, and PR-created result

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Validator and security subject, attempt, verdict, required fixes, report/review refs and hashes, exact independent review bytes, and reviewed commit/head where recorded | `RETAIN` | Retain through `factory verdicts`; PR creation must consume the passing bound panel result. |
| PR/GitHub external identities: host, owner/repository, PR number/node identity when available, canonical URL, head/base refs and SHAs, draft state, and external creation operation identity | `RETAIN` | Retain at the fenced `factory pr-created` boundary and in the completed terminal result. |
| Actual PR existence and current GitHub URL/number/repository/head/base/draft state, including an unknown create outcome | `REOBSERVE` | Use a checked `gh pr view` or equivalent GitHub operation before recording or retrying. After a PR exists, record that PR and never create another. |
| A second PR-success or passing-panel attestation in an internal wrapper | `CONSOLIDATE/REMOVE` | Replace with `run.json.validator`, `run.json.security_review`, and `run.json.terminal_result` written by `factory verdicts` and fenced `factory pr-created`. |

The `steering.pr_fence` token, generation, state hash, and creation time are `RETAIN`
controls from immediately before `gh pr create` until the PR is recorded or creation is
definitively observed not to have happened. `run-json.lock/` must serialize fence
creation/consumption. A missing or mismatched token never authorizes the effect, and an
unknown external outcome is always re-observed before retry.

## 7. Authority class: Continuation and planning/draft reuse

| Authority-bearing field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| Continuation schema/kind/time/summary; parent run/status/ref/hash/branch/exact commit/worktree; selected review kind/ref/hash/subject/verdict/source/fixes; and target run/branch/worktree/base ref/exact base commit | `RETAIN` | Retain in child `run.json.continuation` through `factory continue`; parent identity remains read-only. |
| Every parent artifact/evidence/review kind/ref/hash binding and planning-reuse or draft-reuse fields, attempt ceiling, and remaining budget | `RETAIN` | Retain through `factory continue`; accepted reuse is finalized only by `factory adopt-continuation`. |
| Parent manifest, selected review, context bytes, parent/target Git identities, and target base ancestry | `REOBSERVE` | Resolve/hash contained refs and query Git during continuation admission and again when adoption consumes them. |
| A second whole parent proof chain in the child, or acceptance inferred from copied mutable files | `CONSOLIDATE/REMOVE` | Replace with `run.json.continuation`, parent step `acceptance`, and child `inherited_acceptance` written by `factory continue` plus `factory adopt-continuation`. |

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

## 9. Authority class: PR79 merged slice repair

This is the explicit disposition for the PR #79 `run.json.merged_slice_repair`
record. It governs successor consolidation; persisted legacy records keep their
original schema and are not rewritten, stripped, or reinterpreted by this ledger.

| PR #79 field or fact | Disposition | Canonical boundary or replacement |
|---|---|---|
| `plan_hash` | `CONSOLIDATE/REMOVE` for a successor authority; `RETAIN` unchanged in persisted legacy records | Replace a second whole-plan chain with accepted `plan/slices.json`/`factory slices-seed` authority and a canonical owner/effective-path snapshot in the canonical amendment manifest, written by the canonical amendment admission transition. Re-observe that snapshot at every consuming lane check. |
| Owner slice, consumer slice, defect path, status, attempt, and fixed attempt ceiling | `RETAIN` | Retain as incident identity/lifecycle at repair admission; do not infer them from a prompt or mutable path. |
| Original reproduction `evidence_ref` and `evidence_hash`, including exact failing command/result bytes, subject, attempt, and head | `RETAIN` | Retain at report/admission and re-hash the exact evidence bytes at each later transition. |
| `baseline_commit` | `RETAIN` | Retain the exact feature-head commit observed when the attempt starts; re-observe existence and ancestry from Git at review/merge. |
| `reviewed_commit`, `review_ref`, and `review_hash`, including independent review bytes, attempt, verdict, and required fixes | `RETAIN` | Retain at review; merge re-hashes the review and re-observes the exact reviewed commit/tree. |
| `repair_evidence_ref` and `repair_evidence_hash` | `CONSOLIDATE/REMOVE` only when the repair facts exist exactly once in the canonical amendment manifest; otherwise `RETAIN` | Canonical replacement is the amendment attempt evidence binding written by the canonical amendment evidence transition. Consumption must re-observe its bytes, candidate commit/tree, and Git-derived changed paths; a summary or copied hash is insufficient. Legacy PR #79 records retain the field. |
| `verification_ref` and `verification_hash`, including exact passing reproduction command/result bytes and verified head | `RETAIN` | Retain at repair merge/verification and re-hash before downstream consumption. |
| `merge_commit` and the equality `merge_commit^{tree} = reviewed_commit^{tree}` | `RETAIN` | Retain the exact merge commit and exact reviewed tree relation at merge; re-observe both trees, feature-head equality, ancestry, and owner-lane changed paths from Git. |
| A local/model statement that the repair was reviewed, merged, or verified | `CONSOLIDATE/REMOVE` | Replace with the canonical amendment manifest and its admission, evidence, review, merge, and verification transitions; for legacy records, use the existing checked `factory repair` transitions. |

The retained PR #79 failure, review, and verification hashes and all baseline,
reviewed, and merge commit/tree identities are boundary controls, not duplicate proof
ceremony. They must not be removed by a simplification pass.

## External-effect ownership and idempotency controls

These controls accompany the applicable class above; they do not create a tenth
authority class.

| Control | Disposition | Boundary rule |
|---|---|---|
| `run-json.lock/` ownership and verified directory/file identity | `RETAIN` while the mutation is in flight | Observation and mutation stay under the same verified lock; a precheck is not mutation authority. |
| `process-launch.lock/owner.json` run/execution identity, launch kind/phase, process identity, and nonce | `RETAIN` through launch handoff/reconciliation | Create exclusively; phase change/release requires exact nonce, prior phase, directory/file identity, and live process identity. Ambiguity fails closed. |
| Gate/terminal boundary token and steering generation/state hash | `RETAIN` from `factory boundary-open` until atomic consumption | The privileged transition consumes the exact token under lock. |
| Dispatch/remediation action-claim token, operation kind/generation, and started/abort result | `RETAIN` until the external action start is recorded or safely aborted | `factory boundary-cross`, `factory action-started`, and exact-token `factory action-abort` are the canonical transitions. Unknown start outcome is reconciled, not repeated. |
| PR fence token and PR-create operation/external identity | `RETAIN` until `factory pr-created` or definitive no-create observation | Never clear after a PR exists; re-observe GitHub after an unknown outcome and record the existing PR. |
| Post-PR dispatch, push, check, review, and publication operation ids/tokens | `RETAIN` through their terminal observation | A retry addresses the same operation or begins only after checked absence/failure; success booleans do not replace external identity. |

## Compatibility and single-authority rule

- Persisted legacy records keep their original schema. Readers validate and consume
  them under the schema/version that wrote them; there is no eager rewrite, field
  stripping, synthetic backfill, or reinterpretation of missing successor fields.
- A successor may consolidate a legacy duplicate only at a checked transition that
  writes the named canonical replacement and preserves every unique retained fact.
- No two repair authorities may be active for one run. Admission and resume must
  reject concurrent active/nonterminal overlap among a legacy `merged_slice_repair`,
  a canonical amendment repair, and post-PR remediation. Complete/terminalize the
  active authority or start the prescribed recovery/continuation run; never mirror
  one repair into a second active state machine.
- This ledger changes documentation and tests only. It adds no production manifest,
  transition, command, schema field, or migration.
