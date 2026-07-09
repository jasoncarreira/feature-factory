# Simplification Spec: Remove the Provenance/Proof Layer

## Motivation

Seven dogfood runs in this repo's `.opencode/factory/` produced one completed PR. The rest
died in two loops caused by the provenance layer itself:

1. **The stale-attestation trap.** `SKILL.md` tells the orchestrator to remediate a rejected
   slice in place ("route required fixes back to the same builder in the same slice
   worktree"), but the authority validator re-verifies *every* accepted attestation against
   live git state forever (`provenance-authority.js` validation loop), and the heartbeat
   asserts that authority every 30 seconds (`assertRunAuthorityValid` in `heartbeatTick`).
   Any fix commit advances the branch past the attested head and the run's own watchdog
   kills it: `"slice-observation.head: slice commit is X, expected Y"`.
2. **The non-converging review loop.** Reviewer prompts mandate "default to blocking on
   anything not ruled out" against a codebase that is wall-to-wall trust-boundary code, with
   findings (fake `gh` on PATH, local history rewrite, cross-run replay) that the README's
   own trust model explicitly declares out of scope. `max_retries: 3`, then terminal block.

The proof system has no consumer. The people who act on run state are (a) the human
answering gates, who reads the artifacts, and (b) the PR reviewer plus CI, who read the
diff. Neither reads `attestations/index.json`. The README already concedes the layer cannot
stop a motivated local actor ("local-only, not cryptographic or tamper-proof"). We are not
minting crypto; we are opening a draft PR that humans review.

## Goals

- Keep what makes runs correct and durable: schema-validated `run.json`, atomic locked
  state transitions, the gate question/answer protocol, observed evidence, bounded review
  loops, liveness heartbeat, TUI monitoring.
- Delete everything whose only purpose is *proving* history to a hypothetical skeptical
  consumer: attestations, hash chains, merge-chain proofs, authority validation, reviewer
  worktree-cleanliness proofs, the safe-git "policy" framing.
- Replace retroactive, continuous enforcement with **transition-time invariant checks**:
  evaluated once, inside the run-json lock, at the moment of the transition, never again.
- Make the documented workflow (fix-in-place remediation, post-merge worktree cleanup)
  actually legal.

## Non-goals

- No change to the agent chain (story → research → spec → decompose → build → test →
  validate → PR) or to the three gates.
- No change to the observe-don't-trust discipline: the orchestrator still re-derives diffs
  and re-runs tests itself before accepting builder claims.
- No weakening of the human boundary: draft PR only, humans review and merge.
- Not a rewrite. Modules keep their names and call sites where practical.

## New trust statement (replaces README "Trust model and provenance authority")

> The factory is a local development tool. Its enforcement targets **orchestrator and agent
> error**, not a malicious operator (who owns the machine and is out of scope). Three
> mechanisms provide correctness: (1) `run.json` and all state files are schema-validated on
> every read and written atomically under a lock; (2) provenance-sensitive transitions
> (gate decisions, slice merges, PR recording, terminal results) go through transition
> helpers that check their preconditions once, at transition time; (3) build/test claims
> are accepted only from orchestrator-observed evidence, and the final artifact is a draft
> PR reviewed by humans with CI.

---

## Module-by-module plan

### `src/provenance-authority.js` (2,327 lines) — DELETE

Delete the module: attestation creation (`createRunBaseAttestation`,
`createSliceObservationAttestation`, `createReviewApprovalAttestation`,
`createDirectReviewedCommitAttestation`, `createGateDecisionAttestation`,
`createMergeChainAttestation`, `createPrCreatedAttestation`), hashing/chain
(`withAttestationHash`, `verifyAttestationHash`, `createAttestationIndex`,
`canonicalJson`, `hashValue`), the accepted-graph walk and every
`validate*Attestation` function, `AUTHORITY_MODEL`, `ATTESTATION_TYPES`.

Salvage into two small modules (~150 lines total):

- `src/worktrees.js`: `parseWorktreeListPorcelain`, `checkWorktreeIdentity`,
  `deriveExpectedWorktreePath`. Used by cleanup, recovery, and the merge precondition
  check. These answer "is this a worktree of this repo on this branch" — correctness, not
  proof.
- `src/refs.js`: `resolveDurableRoots`, `resolveDurableRef` and the typed wrappers
  (`resolveEvidenceRef`, `resolveReviewRef`, `resolveArtifactRef`, `resolveGateRef`).
  Path-containment on refs (an `evidence_ref` must resolve inside the run dir, no
  escapes/symlink tricks) is a real correctness guard against orchestrator path mistakes.
  Drop `resolveAttestationRef` and the `attestations` durable root.

`hashFile` moves to wherever gate snapshot hashing lands (see gate protocol below).
`canonicalizeGithubPrUrl` moves next to the `pr-created` transition.

### `src/review-guard.js` (800 lines) — DELETE

The reviewed-worktree guard existed to *prove* reviewers didn't mutate the worktree.
Reviewers are already `permission: edit: deny` subagents; that is the enforcement. The
SKILL keeps one sentence: after a reviewer returns, run `git -C $WT status --porcelain`;
if dirty, restore with `git checkout -- . && git clean -fd`, discard the review, and re-run
it once. No guard reports, no attested-clean-HEAD recovery protocol, no
`buildReviewGuardBlockReport`. `listHiddenIndexPaths` in `safe-git.js` (its only caller is
the guard) goes with it.

### `src/safe-git.js` (410 lines) — SLIM to `src/git.js` (~120 lines)

Keep a single git spawn helper with timeout and output caps — that's good engineering, not
paranoia. Keep `GIT_TERMINAL_PROMPT=0` and a no-pager env. Delete the anti-tamper surface:
`SAFE_GIT_POLICY`, `getTrustedGitPath` PATH pinning, the `SAFE_GIT_ENV_OVERRIDES` scrub
list, `SAFE_GIT_PREFIX_ARGS` config-neutralization, `buildSafeGitEnv`. If the operator's
git config or PATH is hostile, they own the machine; out of scope by the trust statement.

### `src/validate.js` (1,061 lines) — KEEP the correctness half (~450 lines)

Keep unchanged: `validateRun`, `validateSlicesPlan`, `validateHeartbeatState`,
`validateFactoryLock`, `validateRunDir`, `pendingProtectedGate`, `ValidationError`, the
status enums, review tiers, `HEARTBEAT_*` constants.

Delete: `validateRunAuthority` and every helper that exists only for it
(`requireCurrentPrePrApprovals`, `matchesIntegratedFeatureReviewApproval`,
`sliceRequiresAuthority`, `sliceMatchesObservation`, `findSliceMergeEntry`,
`SENSITIVE_SLICE_STATUSES`, `INTEGRATED_FEATURE_SUBJECT_TYPES`, attestation
resolution/comparison helpers).

Add: `checkRunConsistency(runDir, run)` — **advisory referential integrity**, returning
`{ok, checks[]}` like today's validator but with no git re-observation and no authority
semantics:

- every `evidence_ref` / `review_ref` / `artifact_ref` / gate `question_ref` named in
  `run.json` resolves (via `refs.js`) to an existing file;
- a slice with `status: merged` has a non-null `merge_commit`, `review_ref`, `evidence_ref`;
- an approved gate has a recorded answer and `answered_at`;
- `run.validator.verdict` / `run.security_review.verdict` values are in-enum and their
  report/review files exist;
- `pr_url` set ⇒ `gates.pre_pr.status === "approved"`.

`factory validate` runs schema + consistency and reports failures as findings. Nothing
consumes consistency results automatically; it is a doctor tool, not a gate.

### `src/run-state.js` (1,521 lines) — KEEP core, slim transitions (~900 lines)

This is the "atomic state transition tools" layer we keep on purpose.

Keep unchanged: `withRunJsonLock`, `transitionRunJson` (atomic temp-file+rename write,
schema validation on read and write), `transitionRunStep`, `transitionRunSlice`,
`transitionLifecycleRun`, `transitionTerminalResult`, `heartbeatOnce`,
`assertHeartbeatOwnerCapability`, `hasInFlightHeartbeatWork`, `hashRunState`.

Change:

- **`transitionGateDecision`** — drop attestation staging/rollback. Keep the pending-gate
  freshness check in light form: when a gate is marked `pending`, record
  `pending_snapshot: {question_hash, artifact_hash}` (plain `sha256:` of the files); when
  consuming an answer, refuse if the current question/artifact hashes differ from the
  snapshot ("gate material changed since the question was asked — re-present the gate").
  This guards a real race for external drivers and costs ~30 lines. Add first-class
  `approval_source` support: `human`, `external-driver`, `autonomous`, `override` are all
  reachable (see CLI).
- **`transitionPrCreated`** — becomes "record the PR atomically with preconditions", not an
  attestation flow. Preconditions checked inside the lock: `gates.pre_pr.status ===
  "approved"`, `run.validator.verdict ∈ {GO, GO-WITH-NITS}`, `run.security_review.verdict
  === "PASS"`, `pr_url` parses as a GitHub PR URL (`canonicalizeGithubPrUrl`), `pr_url` not
  already set. Drop `--head-commit/--base-commit/--remote/--github-account/--pr-body-ref`
  binding requirements; keep `--pr-url --pr-number --repository` and store what's given.
  Verifying the PR exists is the orchestrator's job per SKILL (`gh pr view <url>`), recorded
  in the final summary — not a fail-closed local proof.
- **`mutateRunJsonLocked`** — delete the "legacy path allowed only when no
  attestations/index.json" split. All writes go through the transition helpers; keep one
  escape hatch for the recover verb.

Add: **`transitionRecoverOrphan(runDir, reason)`** — if `run.status === "running"` and the
heartbeat is terminal/missing/stale past threshold, atomically set `status:
"needs-human"` with `terminal_result.reason`, and stamp the heartbeat file `stopped`. This
replaces hand-built `-replacement` runs.

### `src/factory.js` (1,360 lines) — remove authority calls (~1,100 lines)

- `heartbeatTick`: **delete the `assertRunAuthorityValid` call.** The tick checks lease
  ownership, terminal status, protected gates, in-flight work — liveness only, matching
  `factory-diagnostics`' own `authoritative: false, liveness_only: true` stance.
- `loadPublicRun` / `tryReadPublicRun`: schema validation only (`validateRun`); drop the
  authority gate on reads. Reads must never fail because a branch moved.
- `validateState`: schema + `checkRunConsistency`.
- `cleanupRun`: unchanged logic, but now actually usable — nothing holds worktrees hostage.
  Extend it to also delete the run's `attestations/` directory if present (inert legacy
  data).
- `persistFactoryRunCreatedProvenance` / `persistFactoryRunResumeProvenance`: keep (they
  are debug snapshots, see `provenance.js` below) but they must never block or gate
  anything — already true; just verify after the refactor.

### `src/provenance.js` (181 lines) — KEEP, RENAME to `src/env-snapshot.js`

This module is unrelated to the proof system despite the name: it captures redacted
plugin/opencode/tool versions into `run.json.factory_provenance` for debugging, and doctor
uses `detectCapabilities`. Keep the secret redaction exactly as is (it writes into files).
Rename the module and the `run.json` key (`factory_provenance` → `debug_snapshot`,
schema-versioned) so "provenance" disappears from the vocabulary. Low priority; can ship
after the deletions.

### `src/factory-diagnostics.js` (579 lines) — KEEP, remove the authority path

The heartbeat/PID/staleness conditions all stay. Delete the authority hook:
`diagnoseRunObject` currently calls `validateRunAuthority` on every invocation
(`factory-diagnostics.js:316-318`) — a full attestation-graph re-verification that spawns
git subprocesses per attestation. Remove that call and the conditions/helpers that exist
for it (`invalid-authority`, `unverifiable-authority`, `hasAcceptedRunAuthority`,
`authorityItem`, `unverifiableRunAuthorityItem`, the `validateRunAuthorityFn` option).
After this, `diagnoseRunFile` is cheap: read `run.json` + `heartbeat.json` + one PID
liveness check, zero subprocesses. Keep the `stale-heartbeat` threshold
(`max(2×interval, 120s)`) — it now only classifies, never kills, since the heartbeat no
longer asserts authority.

### `src/cli.js` (749 lines) — surface changes

- `factory gate-decision <run> <gate> <status>`: add `--approval-source
  human|external-driver|autonomous|override` (default `external-driver` when `--answer-ref`
  is given, `human` when `--answer` is given interactively). Remove the code that forbids
  the flag.
- `factory pr-created`: slim flags per `transitionPrCreated` above.
- `factory validate [run-id]`: schema + consistency (advisory).
- **New:** `factory recover <run-id> [--reason TEXT]` → `transitionRecoverOrphan`.
- `factory provenance` → `factory env` (alias the old name for one release).
- `factory cleanup`: unchanged UX; note in help that it removes worktrees, branches, and
  legacy `attestations/`.
- Everything else (`start`, `list`, `status`, `heartbeat`, `answer`, `watch`) unchanged.

### `src/plugin.js`, `src/doctor.js`, `src/config.js` — UNCHANGED

### `src/tui-data.js`, `src/tui.jsx` — re-enable sidebar diagnostics

The working tree currently carries TUI responsiveness fixes that set
`diagnostics: false` on every sidebar refresh. That was the right call while
`diagnoseRunFile` ran authority validation (git subprocess storm per tick, 7 runs × every
2s), but it silently disables the sidebar's stuck-run warnings — stale-heartbeat and
dead-PID conditions never render. Once the authority path is deleted from
`factory-diagnostics.js` (above), diagnostics are cheap: **remove the
`diagnostics: false` flag from the sidebar's refresh path** so liveness warnings show
again. Keep the other working-tree TUI fixes as-is (root caching, `MAX_VISIBLE_RUNS`,
overflow containment, null-safety). Also drop `invalid-authority` /
`unverifiable-authority` from `FAIL_CLOSED_CONDITIONS` in `tui-data.js` — those conditions
no longer exist.

---

## Transition-time invariants (the replacement for authority)

All checks run **once**, inside `withRunJsonLock`, in the transition that consumes them.
Failures throw and leave state unwritten. Nothing re-checks them later; nothing checks them
on read; the heartbeat checks nothing but liveness.

| Transition | Preconditions |
|---|---|
| Gate → `approved`/`changes_requested`/`stopped` | gate is `pending`; question file exists; answer text is well-formed; `pending_snapshot` hashes still match question/artifact files |
| Slice → `review` | `evidence_ref` resolves; evidence was written by the orchestrator this attempt |
| Slice → `merged` | review file at `review_ref` exists with `verdict: APPROVE`; `merge_commit` provided; slice branch exists (`git rev-parse --verify refs/heads/<slice-branch>`) |
| `run.validator` / `run.security_review` set to passing | report/review file exists; verdict in enum |
| `pr-created` | `pre_pr` approved; validator GO/GO-WITH-NITS; security PASS; URL canonical; `pr_url` currently null |
| Terminal `completed` | `pr_url` set; no slice in `running`/`review` |
| `recover` | status `running`; heartbeat terminal, missing, or stale |

Deliberately absent: any check that a previously recorded commit is still the branch head.
Branches move; that is what remediation is. The merge-time check that the review APPROVE
exists for *this attempt's* evidence is the accountability point, and the PR diff is the
final artifact humans judge.

## Remediation flow (now legal, document it exactly)

On slice REJECT: route fixes to the same builder in the same slice worktree; builder
commits on the same slice branch; orchestrator re-observes (new `evidence/<slice>.json`,
overwriting or attempt-suffixed — pick attempt-suffixed: `evidence/<slice>.attempt-N.json`
with `run.json.slices[].evidence_ref` updated), re-reviews, and on APPROVE merges. No
branch freezing, no attempt worktrees, no reset dance. After merge, clean up the slice
worktree and branch immediately (restore `SKILL.md`'s cleanup instruction without the "if
repo policy allows" hedge).

---

## Docs and prompt changes

### `assets/skills/feature/SKILL.md` (592 → ~300 lines)

Remove: the reviewed-worktree guard protocol (§ around lines 54–90), all attestation
instructions (run-base at 193/294, slice observation at 440–448, merge-chain at 469,
direct-reviewed-commit at 496, and the per-step guard branches at 338–339, 374–375).

Rewrite:

- Slice acceptance: observe evidence → work-reviewer → on APPROVE merge; on REJECT the
  remediation flow above.
- PR step: push, create the PR with the configured PR mode, verify with `gh pr view`, then
  `feature-factory factory pr-created <run> --pr-url ... --pr-number ...`.
- Keep: intent gate, gate protocol, wave scheduling, observe-don't-trust, bounded loops,
  resume rules, guardrails.

### `assets/skills/feature/SCHEMA.md` (845 → ~300 lines)

Remove: "Accepted attestation graph", attestation file shapes, merge-chain, pr-created
binding shapes, safe-git policy section, guard-report shapes.

Fix while in there (documented-vs-enforced drift found during diagnosis):

- Document the **happy-path** `reviews/implementation-validator.json` and
  `reviews/security-reviewer.json` JSON shapes (subject = feature branch name, verdicts
  `GO|GO-WITH-NITS|NO-GO` / `PASS|BLOCK`). The current schema shows `subject:
  "integrated-feature"` in one example and never shows the validator review file at all.
- Document `evidence/<subject>.attempt-N.json` naming for remediation attempts.
- State plainly that builder claim `status: pass|blocked` is translated by the orchestrator
  into evidence `status` + `review_ready`.

### Reviewer prompts (`assets/agent/work-reviewer.md`, `security-reviewer.md`)

Two bounded-convergence rules, added to both:

1. **Trust-model rubric.** Findings that require capabilities outside the run's trust model
   (malicious local operator: PATH manipulation, git history rewrite, editing run state
   files by hand, cross-run tampering) are NONBLOCKING notes, never REJECT/BLOCK. Cite the
   trust statement.
2. **Delta rule for re-reviews.** When the input marks `attempt > 1`, judge only (a) whether
   each previously required fix landed, and (b) regressions introduced by the fix diff. Do
   not open new scope on unchanged code. New-scope observations go in notes as NONBLOCKING.

The orchestrator passes `attempt` and the prior review's `required_fixes` into every
re-review prompt (add this to SKILL Step 4/5).

### `assets/command/feature.md` (the `/feature` entry-point prompt)

Delete the "Provenance and PR authority requirements" section (lines 43–49): the
`factory provenance record-created/record-resume` mandates, the `pending_snapshot`
fail-closed language, the full-flag `pr-created` invocation, and the "trusted only after
the accepted `attestations/pr-created.json` record validates" sentence. Replace with two
lines: record the PR via `feature-factory factory pr-created <run-id> --pr-url URL
--pr-number N --repository OWNER/REPO` after verifying it with `gh pr view`; never write
`run.json.pr_url` directly. Keep the driver-mode and autonomous-gate rules (lines 29–32)
as-is — their `approval_source` values become reachable through the CLI change above.

### Prompt alignment matrix

Every producer/consumer contract must have exactly one source of truth after the rewrite.
Per-file disposition (verified by grep against the deleted vocabulary):

| File | Change |
|---|---|
| `assets/command/feature.md` | Rewrite per above — the only prompt file that mandates attestation flows |
| `assets/skills/feature/SKILL.md` | Rewrite per above |
| `assets/skills/feature/SCHEMA.md` | Rewrite per above; becomes the single source of truth for every JSON shape a prompt mentions |
| `assets/agent/work-reviewer.md` | Add trust-model rubric + delta rule. Keep the `review_ready=false` reject criterion (evidence contract survives). Rename the "Forgeable provenance / authz" lens heading to "Forgeable identity / authz" |
| `assets/agent/security-reviewer.md` | Add trust-model rubric + delta rule; same lens rename |
| `assets/agent/implementation-validator.md` | Same lens rename; document that its verdict is recorded as JSON at `reviews/implementation-validator.json` with `subject` = feature branch (see SCHEMA fix) |
| `assets/agent/backend-builder.md`, `frontend-builder.md`, `test-verifier.md` | No content change; verify the claim-block fields they emit match the SCHEMA translation table added above |
| `assets/agent/story-reader.md`, `story-writer.md`, `codebase-researcher.md`, `design-interpreter.md`, `spec-writer.md`, `work-decomposer.md` | No change (no provenance-era references) |

The "Forgeable provenance / authz" lens in the three reviewer prompts is a *generic
security lens about reviewed application code* (client-forgeable server markers), not a
reference to the factory's proof system — it stays, renamed so the vocabulary purge is
greppable.

**Acceptance check for this workstream:**
`grep -ri "attestation\|merge-chain\|safe-git\|guard report\|factory provenance\|forgeable provenance" assets/` returns zero hits. (`pending_snapshot` survives in its light
form — `{question_hash, artifact_hash}` — documented once in SCHEMA.md's gate protocol and
nowhere else.) Every file path, JSON shape, CLI invocation, and status vocabulary named in
any prompt appears in SCHEMA.md (spot-check with a doc-consistency pass at review time).

### `README.md` and `SPEC.md`

Replace README's "Trust model and provenance authority" section with the new trust
statement. In `SPEC.md`, replace the "Trust-model contract" section the same way and drop
attestation-dependent items; this simplification spec supersedes them.

---

## Test plan

- Delete `test/provenance-authority.test.js` and review-guard tests; delete authority
  cases from `test/validate.test.js` and `test/run-state.test.js`.
- Keep/extend: atomic transition tests (lock contention, rollback on precondition failure),
  gate `pending_snapshot` freshness (answer against a rewritten question refuses), the new
  merge/pr-created/terminal preconditions, `factory recover` on the three orphan shapes
  (heartbeat `error`, heartbeat missing, heartbeat stale + dead PID).
- **Fix the hanging tests**: `test/factory.test.js` currently dies with "Promise resolution
  is still pending but the event loop has already resolved" (~39s cancelled) — almost
  certainly an un-awaited heartbeat loop; ensure every `startHeartbeat` in tests is stopped
  in `finally`.
- One end-to-end state-file test: simulate a run through gates → slices (with one
  REJECT + fix-in-place remediation) → merge → panel → pr-created, asserting
  `checkRunConsistency` stays green throughout. This is the regression test for the trap.

## Migration and cleanup of existing state

Old runs need no conversion: nothing reads `attestations/` anymore, so their `run.json`
files validate as-is (drop any schema fields only the authority layer required — audit
`validateRun` for attestation-coupled required fields such as gate `pending_snapshot`
internals; make them optional).

One-time local cleanup after the code lands:

1. `factory recover blocked-run-continuation-follow-up` and
   `factory recover recovery-runtime-follow-up` (the two dead runs claiming `running`).
2. `factory cleanup <run-id>` for each terminal run — this now removes the ~43 stranded
   worktrees under `.opencode/worktrees/` and their branches, plus legacy `attestations/`.

## Sequencing

1. **Unblock (small PR):** remove `assertRunAuthorityValid` from `heartbeatTick`; add
   `factory recover`. Stops the mid-flight kills immediately, before the big deletion.
2. **Deletion (the main PR):** delete `provenance-authority.js`, `review-guard.js`; slim
   `safe-git.js` → `git.js`; strip `validate.js` / `run-state.js` / `factory.js` /
   `cli.js` per above; add `checkRunConsistency` + transition preconditions; update tests.
   SKILL.md/SCHEMA.md/prompt rewrites ship **in the same PR** — the skill references
   attestations on nearly every step, and a mixed state strands any active run.
3. **Polish:** `provenance.js` → `env-snapshot.js` rename, README/SPEC rewrite, local
   worktree/branch cleanup, `factory env` alias.

Do not run the factory on itself between steps 1 and 2 landing; every factory-driven fix
inherits the trap it is fixing. Steps 1–2 are hand-written PRs.

## Expected impact

| Area | Before | After (est.) |
|---|---|---|
| `src/` enforcement code | ~9,900 lines | ~4,300 lines |
| Skill + schema docs | 1,437 lines | ~600 lines |
| Stuck-run mechanism 1 (stale-attestation trap) | fatal within one heartbeat tick | eliminated (no retroactive checks) |
| Stuck-run mechanism 2 (review non-convergence) | terminal block at 3 retries | bounded by trust-model rubric + delta rule |
| Post-merge worktree cleanup | breaks authority; 43 stranded worktrees | legal, automatic |
| Orphaned `running` runs | hand-built `-replacement` runs | `factory recover` |

What is *not* lost: agents still cannot self-approve (reviewer verdict files are still
required at merge time), builder claims are still distrusted (observed evidence is still
the review input), gates still block, PR mode is explicit and configurable, and every state
write is still schema-validated and atomic. The enforcement moves from "prove history
continuously" to "check preconditions once at each transition".
