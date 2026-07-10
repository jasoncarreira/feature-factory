# Dogfood Learnings — what building the factory on itself taught us

A retrospective from analyzing the 15 self-hosted feature-factory runs under
`.opencode/factory/` (the tool built almost entirely by running itself), their
`reviews/`/`evidence/`, and all 57 process logs in `.opencode/factory/processes/`
(~15 MB). Read-only analysis; no runs were modified.

## TL;DR

- **The factory works.** 14 of 15 runs completed end-to-end and shipped a PR (6 ready, 8
  draft). Robustness visibly improved over the week — the newest process logs have zero
  failure signatures.
- **Fragility was never the model.** No provider, model, rate-limit, or auth errors across
  57 logs. What broke autonomous runs was the host environment and a few structural gaps.
- **The review loop converges; remediation is what churns.** Reviewers stayed on the delta
  and the trust-model rubric correctly downgraded out-of-scope findings. Multi-round
  remediation was caused by builders shipping partial fixes to open-ended "sanitize every
  sink" requirements.
- **The same vulnerability classes recur per-feature** because there is no centralized
  hardened primitive for them. This is the single highest-leverage thing to fix.

---

## 1. Outcomes

| | count | runs |
|---|---|---|
| Completed + shipped PR | 14 / 15 | all except `steering-drain-boundaries` |
| Ready PR (`draft:false`) | 6 | cost-attribution #30, cost-reporting-export #38, honeycomb-otel-readiness #34, interrupt-cancellation-rollback #33, tui-active-session-refresh #32, tui-current-summary-projection #37 |
| Draft PR | 8 | #18, #21, #22, #23, #24, #25, #28, #29 |
| Orphaned (running, dead process) | 1 | steering-drain-boundaries |

Every slice in every terminal run reached `merged` — zero `blocked`/`review`/`running`
slices anywhere. Every reached gate is `approved`; no terminal run is `blocked`/`partial`/
`needs-human`.

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
4. **`max_retries=3` exhaustion → blocked.** 3 runs terminated cleanly as `blocked` after
   the retry ceiling and required a human — designed escalation, but a real fraction of
   "autonomous" runs could not finish unattended.
5. **Benign transient hiccups (recovered):** wrong-cwd `not a git repository` probes (3
   logs), transient `gh` "Repository not found" (3×), stale-heartbeat detections up to
   ~30 min — the recovery machinery being exercised on real stalls.

**Not observed:** no provider/model/rate-limit/auth errors, no uncaught exceptions, no
merge conflicts (only test names), no `AI_APICallError`/overloaded. The fragility was the
environment, not the LLM.

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

> **These are the same classes flagged in the open-PR reviews** (#34 NEL escaping, #33
> cancel liveness, #40 NEL again). They recur per-feature precisely because each feature
> re-implements — and re-misses — the same guard.

## 4. Operational gaps still present after hardening

- **Orphans still occur.** `steering-drain-boundaries` is stuck `status: running` with a
  dead pid, a held `factory.lock`, no `heartbeat.json`, `updated_at` frozen at
  `created_at`, and all 5 steps at `blocked`/`attempts:0`. It is the original
  "orphan claiming running" pattern, unchanged — and ironically the run meant to harden
  steering. Clean `factory recover` target.
- **Queued steering can be silently dropped.** `tui-active-session-refresh` shipped ready
  PR #32 while carrying an undrained 592-char `steering.pending` directive (queued
  16:02:57) that was never applied — an operator instruction vanished with no signal.
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
- **Cost instrumentation is inert.** Where present it is always `status: "unavailable"`,
  `entry_count: 0` — and the run literally named `cost-attribution` carries no
  `cost_attribution` block at all. The feature shipped but never captured data in practice.

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
- PR outcomes cross-checked with `gh pr list --state all`; branch merge status verified
  against `origin/main`.
