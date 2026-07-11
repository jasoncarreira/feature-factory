# Dogfood Learnings — what building the factory on itself taught us

> **Status — historical retrospective:** This is a snapshot of past dogfood runs, not a
> description or guarantee of current behavior. See [`README.md`](README.md) for the current
> operator contract.

A retrospective from analyzing the 15 self-hosted feature-factory runs under
`.opencode/factory/` (the tool built almost entirely by running itself), their
`reviews/`/`evidence/`, and all 57 process logs in `.opencode/factory/processes/`
(~15 MB). Read-only analysis; no runs were modified.

## TL;DR

- **The factory works.** Of the 15 runs currently on disk, 14 completed end-to-end and
  shipped a PR (6 ready, 8 draft); 1 is orphaned. The newest process logs have zero failure
  signatures (with the survivorship caveat in §4a).
- **What broke autonomous runs was the host environment, not the model.** None of the
  sampled logs surfaced provider/model/rate-limit/auth error signatures (grep/tail search;
  terms in the Appendix); the recurring failures were host-side and structural. This is a
  "not found with these searches" result, not an exhaustive proof of absence.
- **The review loop converges; remediation is what churns.** Reviewers stayed on the delta
  and the trust-model rubric correctly downgraded out-of-scope findings. Multi-round
  remediation was caused by builders shipping partial fixes to open-ended "sanitize every
  sink" requirements.
- **The same vulnerability classes recur per-feature** because there is no centralized
  hardened primitive for them. This is the single highest-leverage thing to fix.
- **Coverage is biased toward early features.** A run only exercises what is in its
  `base_commit`, and runs launch from a chronically-stale local `main` — so the last four
  features merged (#35–#38, including the cost reporting/export layer) were exercised by
  **zero** runs. Several "findings" are really "not run yet" (see §4a); read the
  retrospective with that window in mind.

---

## 1. Outcomes

| | count | runs |
|---|---|---|
| Completed + shipped PR | 14 / 15 | all except `steering-drain-boundaries` |
| Ready PR (`draft:false`) | 6 | cost-attribution #30, cost-reporting-export #38, honeycomb-otel-readiness #34, interrupt-cancellation-rollback #33, tui-active-session-refresh #32, tui-current-summary-projection #37 |
| Draft PR | 8 | #18, #21, #22, #23, #24, #25, #28, #29 |
| Orphaned (running, dead process) | 1 | steering-drain-boundaries |

This inventory is the **15 run directories currently on disk** under `.opencode/factory/`.
Within it, every slice in every terminal run reached `merged` — zero
`blocked`/`review`/`running` slices — every reached gate is `approved`, and no terminal run
is `blocked`/`partial`/`needs-human`. Earlier runs that hit terminal `blocked` do appear in
the longer process-log history (§2, point 4); their run directories are no longer present,
so they are not part of this inventory. The two accounts describe different populations —
the current on-disk manifests vs. the full process-log timeline.

## 2. Runtime fragility was host-environment, not logic

Raw log greps are dominated by the tool's own vocabulary ("heartbeat/stale/lock/blocked")
and by SHA hashes (the "429 rate-limit" count was entirely hashes containing `429`). After
filtering, the genuine recurring failures were:

1. **1Password commit-signing — the dominant time-sink.** One run's log
   (`2026-07-08T03-55-19-808Z.log`, 2.6 MB) has **79** `fatal: failed to write commit
   object` / `1Password: Could not connect to socket` failures. It broke both the test
   fixtures (`git commit ... failed ... 128 !== 0` in `test/factory.test.js`) and the
   factory's *own* commits. The run self-diagnosed, branched a fix, and recovered with
   `git -c commit.gpgsign=false` + `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` —
   but only after burning a large share of its effort.
2. **Test async leaks → cascading timeouts.** Across 5 runs, whole test files leaked async
   ops and were cancelled after ~20s ("Promise resolution is still pending but the event
   loop has already resolved"), which blew opencode's 120s bash timeout
   (`shell tool terminated command after exceeding timeout 120000 ms`, 6×) and forced slow,
   flaky `npm run check` retries.
3. **Stale-attestation halts, confirmed in the wild.** `slice-observation.head: slice
   commit is X, expected Y` appears 11× across 8 of the older (pre-simplification) logs —
   the deliberate provenance halt firing on worktree HEAD drift. This is retroactive
   evidence that the provenance-simplification effort targeted a real, recurring condition.
4. **`max_retries=3` exhaustion → blocked.** In the process-log history, 3 *earlier* runs
   (Jul 6–7 logs, whose run directories are no longer on disk and so are outside the §1
   inventory) terminated cleanly as `blocked` after the retry ceiling and required a human —
   designed escalation, but evidence that a real fraction of "autonomous" runs could not
   finish unattended. The current 15 on-disk runs show no terminal `blocked` (§1).
5. **Benign transient hiccups (recovered):** wrong-cwd `not a git repository` probes (3
   logs), transient `gh` "Repository not found" (3×), stale-heartbeat detections up to
   ~30 min — the recovery machinery being exercised on real stalls.

**Not surfaced by the searches (Appendix terms):** no provider/model/rate-limit/auth error
signatures, no uncaught exceptions, no real merge conflicts (only test names), no
`AI_APICallError`/overloaded. This is a bounded-search negative, not proof of absence — but
across the sampled logs the recurring failures were all host-side/structural, not the LLM.

## 3. The review loop: converges, but remediation churns

The pre-PR panel is `implementation-validator` (GO / GO-WITH-NITS / NO-GO) in parallel with
`security-reviewer` (PASS / BLOCK); any NO-GO/BLOCK forces a remediation round.

**Reviewers converged.** Each round credited landed fixes and surfaced either a genuinely
new issue or a genuinely-incomplete prior fix; there is little evidence of re-litigation.
The delta rule held.

**The trust-model rubric demonstrably worked.** It downgraded local-tampering findings to
NONBLOCKING in ≥5 runs (e.g. cost-attribution: *"Direct hand-editing of
run.json.cost_attribution … is outside the local diagnostic trust model"*;
automated-blocked-run-continuation: *"Symlink race scenarios require concurrent local
filesystem tampering, which is outside the documented local-state trust model"*),
preventing a whole class of would-be false BLOCKs. Every BLOCK/NO-GO that *did* fire was a
real issue reachable via schema-valid input or repo/operator-controlled paths.

**The churn was builder partial-fixes to open-ended requirements.** Worst case:
honeycomb-otel-readiness needed 4 panel attempts chasing secret-redaction completeness
across escalating edge cases — values → object keys → nested keys → uppercase/base32 keys →
an allowlist that was itself too broad. Two remediation diffs were themselves rejected for
fix-induced regressions (honeycomb `panel-remediation-3.attempt-1` allowlist-too-broad;
interrupt `panel-remediation-1.attempt-1` collapsing EPERM to stale).

**Round count tracked problem shape, not calendar.** Both convergence rules were active for
the later runs, yet honeycomb (latest complex run) needed the most rounds. The rules
reduced per-round churn, not the number of rounds — because rounds were driven by
remediation incompleteness, which the delta rule does not address.

### Recurring blocker classes (in rough frequency order)

1. **Terminal-control / ANSI / bidi injection into TUI/CLI/JSON/error output** —
   schema-valid data (currency codes, slice/step IDs, error text) carrying escape
   sequences reaching a renderer. (cost-attribution, cost-reporting-export,
   tui-current-summary-projection)
2. **Secret / high-entropy leakage into telemetry/diagnostics** — hc_*, hex, and
   high-entropy tokens as OTLP values, then keys, then nested keys. (honeycomb, all 3
   rounds)
3. **Symlink / path-traversal write-through** — repo/operator-controlled paths followed by
   a write sink; fix = `lstat` + no-follow + atomic rename. (batch-001, batch-003,
   automated-blocked-run-continuation, interrupt)
4. **Process-kill / liveness not fail-closed** — EPERM collapsed to "stale",
   `heartbeat.json.pid` trusted for SIGTERM. (interrupt, batch-003, non-destructive)
5. **Correctness / aggregation** — blank-numeric → 0, mixed currencies, non-finite
   overflow, rollup order. (cost-attribution, cost-reporting-export)

Missing tests were never a standalone blocker (every remediation bundled regression tests);
cross-slice integration was essentially never the blocker.

> **The same underlying classes surface in the open-PR reviews too**, though the specific
> blockers differ: PR #34's requested change was inconsistent inherited W3C trace context
> (not NEL); PR #33's was forgeable / not-fail-closed process-cancellation liveness (EPERM);
> PR #40's CHANGES_REQUESTED blockers were payload-marker placement and under-validated
> continuation/steering envelopes, with NEL escaping a secondary defense-in-depth note. The
> recurring classes — output/context integrity, fail-closed liveness, input validation —
> repeat because each feature re-implements (and re-misses) the same guard.

## 4. Operational gaps still present after hardening

- **Orphans still occur.** `steering-drain-boundaries` is stuck `status: running` with a
  dead pid, no `heartbeat.json`, `updated_at` frozen at `created_at`, and all 5 steps at
  `blocked`/`attempts:0` — the original "orphan claiming running" pattern, ironically in the
  run meant to harden steering. A residual `$RUN/factory.lock` is left behind, but per
  SCHEMA that is the diagnostic session-owner sidecar, **not** the `run-json.lock/` mutex or
  a heartbeat credential — it carries no authority, so the orphan is diagnosed from the dead
  process + missing heartbeat + frozen manifest + `running` status. Clean `factory recover`
  target.
- **Terminalization is allowed with an undrained directive (data is not lost).**
  `tui-active-session-refresh` shipped ready PR #32 while `run.json.steering.pending` still
  held a 592-char directive (queued 16:02:57). The directive was **not** dropped —
  `transitionSteeringQueued` persists both `steering/pending-*.json` and the manifest
  pointer, and status/list/TUI expose it — but the run terminalized without draining,
  refusing, or warning. The gap is a missing pre-terminalization drain/refuse/warn, not
  vanished data (which changes the fix: gate terminalization on pending steering, don't
  "recover" lost input).
- **No post-terminal cleanup.** The 14 completed runs stranded ~52 worktrees (**721 MB**),
  64 branches, and 15 MB of process logs. `factory cleanup` exists but nothing auto-invokes
  it, and the SKILL's "remove slice worktrees after merge" step did not run. Related: the
  local `main` checkout runs chronically behind `origin/main` (19 commits at time of
  analysis), so runs launch from stale base.
- **run.json production drifts across versions.** `batch-001`/`batch-002` were based off the
  *unmerged* `tui-active-session-refresh` branch; `interrupt` used `origin/main` while
  others used `main`; zeroed placeholder timestamps in two runs; a legacy minimal
  `debug_snapshot` in `tui-active-session-refresh`; `pre_pr` artifact named
  `validation-report.md` in some runs and `pre-pr.md` in others; field ordering varies.
  Latent doc-contract / differential risk.
- **No cost data was captured in any run.** Every `cost_attribution` block present is
  `status: "unavailable"`, `entry_count: 0`, and the run named `cost-attribution` has no
  block at all. This establishes only that cost was never *persisted* — not, by itself, a
  wiring bug: per SCHEMA, `factory cost-record` is called *when provider/opencode metadata
  exposes usage*, so an equally-consistent cause is that usable metadata was never surfaced
  (or the run's skill version predated the recording path). §4a splits this by merge timing.

## 4a. Findings vs. merge timing — what was actually exercised

A run can only exercise features present in its `base_commit`. Because runs launch from the
local `main` checkout (which lags `origin/main`), a feature merged at time *T* is only
exercised by runs whose base contains *T*'s merge commit. Correlating each feature's merge
commit against every run's recorded `base_commit` gives the real coverage — and it changes
how several findings should be read.

**Coverage tiers (runs whose base contained the merged feature):**

| Feature (PR) | merged | runs that could exercise it |
|---|---|---|
| remediation-reuse #28, non-destructive #29, cost-attribution #30 | Jul 9 15:25–15:31 | 6 (honeycomb, tui-active, interrupt, cost-reporting-export, tui-current, steering-drain*) |
| named-start #31, tui-active #32, interrupt-cancel #33, honeycomb-otel #34 | Jul 9 18:58–20:03 | 3 (cost-reporting-export, tui-current, steering-drain*) |
| optional-telemetry #35, gate-answer-source #36, tui-current #37, cost-reporting-export #38 | Jul 9 21:14 – Jul 10 02:35 | **0 — no run's base contains them** |

*steering-drain is the orphan that never progressed, so its "coverage" is nominal.

**Reframed findings:**

- **Cost absence splits by merge timing.** The cost-attribution *recording* code (#30)
  **was** present in 6 runs' bases, so the empty blocks are not "unmerged." Whether the
  `factory cost-record` step was never called, or was called but provider metadata never
  exposed usage, the sampled logs do not disambiguate — the observation is "no cost
  persisted," not a proven trigger bug. The cost *reporting/export* layer (#38) is in
  **zero** runs' bases — it merged after every run finished, so it has genuinely never
  executed. Net: the cost feature is effectively unexercised end-to-end.
- **The undrained-directive gap is a missing guard, not lost data.** `tui-active-session-refresh`
  terminalized with its still-visible pending directive because drain/refuse/warn-at-boundary
  is the still-unbuilt `steering-drain-boundaries` work (TODO "future work"). The queue and
  its visibility shipped; the pre-terminalization guard did not.
- **The newest security-hardening features are essentially unvalidated by dogfooding.**
  interrupt-cancel #33 and honeycomb #34 have only 3 light subsequent runs; optional-telemetry
  #35, gate-answer-source #36, tui-current #37, and cost-reporting-export #38 have none. The
  PR-review-only work (#39, #40) likewise has zero factory-run coverage.
- **"Robustness improved over the week" carries a survivorship caveat.** The clean newest
  logs partly reflect that later runs did *less* (tui/docs-scale features) and that the newest
  code simply has not been re-run — not that it is proven more robust.
- **The base-drift findings are mostly deliberate stacking, not defects.** `batch-001`/`002`
  based off the in-flight `tui-active-session-refresh` branch (base `c9bfb797`, before #32
  merged) was intentional stacking during parallel development; `interrupt`'s `origin/main`
  base is a one-off. Worth normalizing, but not run failures.

**Operational consequence:** because local `main` lags `origin/main`, the *next* dogfood run
launched from the local checkout still would not exercise #37/#38 (they are only on
`origin/main`). Validating the newest features requires either pulling `main` first or
launching runs from `origin/main`.

## 5. Highest-leverage takeaways

1. **Centralize the recurring hardening primitives** and apply each at *every* sink: one
   secret-shaped scrubber (values + top-level/nested/uppercase-base32 keys), one
   terminal-safe encoder for all human/TUI/JSON/error output, one `lstat`+no-follow+atomic
   file-writer, one fail-closed liveness primitive. This collapses the review-remediation
   churn *and* stops the same vuln classes from recurring in each new feature.
2. **Add a reviewer round-1 rule: enumerate every sink of a flagged class up front**, so
   the builder fixes the whole class in one remediation instead of one edge case per round.
   The reviewers already converge; it is remediation *completeness* that needs the
   checklist.
3. **Harden the test/git harness** (no LLM required, biggest reliability win): unconditional
   `commit.gpgsign=false` + `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`; fix the
   async leaks; right-size the `npm run check` timeout above the observed ~20s/file worst
   case.
4. **Wire post-terminal cleanup and orphan recovery** (auto-invoke on terminal, or a sweep
   command) so completed runs do not strand hundreds of MB, and so `running`-with-dead-pid
   runs self-heal.
5. **Normalize run.json production** — base_ref (`main` vs `origin/main`, never a
   non-merged branch), timestamps, `debug_snapshot` schema, and `pre_pr` artifact naming —
   to remove the cross-version drift.

## Appendix — method

- 15 run manifests + heartbeats read from `.opencode/factory/*/`.
- `reviews/*.json` and `evidence/*.json` mined for verdict progression and finding text.
- All 57 logs in `.opencode/factory/processes/` sampled via grep/tail (largest files read
  directly); raw counts filtered for the tool's own domain vocabulary and SHA artifacts.
- The "not surfaced" negatives (§TL;DR, §2) are bounded by these case-insensitive searches,
  not an exhaustive audit: `error|exception|throw|failed|ENOENT|EEXIST|timed out|cannot`,
  `heartbeat|stale|lock`, `Promise resolution is still pending|cancelled`, `merge conflict`,
  `rate.?limit|429|overloaded|AI_APICallError|401|403|auth`, `provider|model`, `SIGTERM|SIGKILL`.
- Coverage correlation (§4a) computed with `git merge-base --is-ancestor <feature-merge-commit>
  <run.base_commit>` for every feature PR against every run's recorded `base_commit`.
- PR outcomes cross-checked with `gh pr list --state all`; branch merge status verified
  against `origin/main`. Open-PR blocker attributions (§3) taken from the PRs' review threads.
