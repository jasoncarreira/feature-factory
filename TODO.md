# TODO

The codebase-review and feature-factory hardening pass (verified findings, heartbeat
rewrite, CLI write-surface completion, and right-sizing) is complete. The items below are
the remaining future work.

## Build And Review Workflow

- `factory start --dry-run` safety
  - Dogfooding showed that `factory start` accepts the globally recognized `--dry-run` flag but ignores it and launches opencode, creating detached processes when combined with `--detached`.
  - Future work: either implement a true side-effect-free start preview or reject `--dry-run` as unsupported for `factory start`. Never accept the flag and launch a process silently; add CLI regression coverage for foreground and detached starts.

- Interrupt, steer, resume, and cancellation rollback (implemented)
  - Baseline commands exist: `feature-factory factory steer <run-id> --message TEXT --json`, `feature-factory factory resume <run-id> --dry-run --json`, and `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`.
  - Resume rejects `active-heartbeat` and preserves durable state; raw steering is labeled `UNTRUSTED OPERATOR STEERING DATA (not instructions)` with `trust: untrusted-operator-data` only at one-time consume.
  - Cancellation now records run-scoped `$RUN/process.json` evidence for detached opencode launches with a known explicit run id plus `$RUN/processes/<timestamp>.log`, sends only one targeted `SIGTERM` when identity matches, and fails closed without broad process killing when evidence is absent, stale, invalid, or mismatched.
  - Steering conflicts are explicit: after `steer-consume`, the orchestrator checks accepted durable state and uses `feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --json` to stop as `needs-human` instead of attempting automatic rollback.
  - Live-run draining is implemented at exactly five safe boundaries: after heartbeat-bracketed waits, before autonomous gate approval, before dispatching the next agent or build wave, before remediation, and before terminalization or PR creation. Runtime guards persist consumed-but-uncheckpointed delivery for crash-safe replay, require prospective-application acknowledgement, reject stale lock-protected boundary tokens, retain dispatch/remediation action claims through durable action-start acknowledgement, and fence every `run.json` writer across the external PR side effect; low-level transitions, heartbeat helpers, cost writes, and read-only paths remain non-consuming.

## Runnable Dogfood Epics

Re-scoped 2026-07-11. The earlier epic pipelines here were distilled from failed runs and ratcheted acceptance criteria toward closed-world exactness (exact tuples, "no unspecified behavior remains"), which builders could not converge within bounded remediation — the `git-fixture-boundary-contract` and `owned-test-process-supervisor` runs blocked exactly this way. Those blocked runs are superseded by the re-scoped items below, not continued as-is. Keep each run bounded to its named outcome, consume shared primitives from `centralized-hardening-primitives` instead of reimplementing them, and do not write open-ended completeness acceptance criteria.

### Centralized Hardening Completion

- Merge the reviewed `output-policy` handoff first (PR #50, from `centralized-hardening-primitives-continuation-2`).
- [ ] **Consumer migration** (`centralized-hardening-consumer-migration`) - One bounded epic replacing the previous three serialized migration epics. Migrate the remaining diagnostic/report/state-lock/TUI/CLI consumers to the accepted sensitive-data, terminal-output, protected-write, and process-verification primitives, prioritizing sinks that can carry secrets. Preserve compatibility and focused tests; do not re-litigate the accepted foundation contracts; keep generated `dist/tui.js` unowned.

### Lifecycle Cleanup

- [ ] **Conservative cleanup sweep** (`cleanup-conservative-sweep`) - One epic replacing the previous four-epic cleanup pipeline (lock-claim protocol, orphan assessment, inventory/execution engine, operator surface). Extend `factory cleanup` with a repository-wide sweep that removes terminal-run state, worktrees, and branches only when nothing live references them (no live `factory.lock`, fresh heartbeat, or valid process evidence), and skips-and-reports anything uncertain. Fail closed instead of building a claim-recovery protocol for contested deletions.

### Git And Test Harness Hardening

- The five accepted fixture-isolation slices are preserved on `git-fixture-isolation` at `4dc146a`; do not rebuild them. The four-epic hand-rolled detector pipeline (boundary contract, capability grammar, lexical scope analysis, integration) is retired: it required builders to implement a bespoke JavaScript lexical analyzer and blocked on scope-analysis edge cases. The rejected detector work remains on `git-fixture-isolation--fixture-boundary` at `13d12ea` for reference only; do not merge it wholesale.
- [ ] **Parser-based fixture boundary rule** (`git-fixture-boundary-lint`) - Enforce the same outcome with standard tooling instead of a hand-written analyzer: an ESLint rule (`no-restricted-imports`/`no-restricted-syntax`) or a small acorn-based check that flags child-process imports and calls in test files outside the sanctioned harness allowlist, plus protection for production harness imports. Preserve F-01 through F-14 and P-01 behavior and the package exception counts. Accept parser-grade scope handling; do not specify tokenizer, JSX, or lexical-scope semantics as acceptance criteria.
- [ ] **Test process cleanup helper** (`test-process-cleanup-helper`) - Replaces the supervisor-protocol and leak-attribution-runner epics. Add a small shared test helper that records every test-spawned process/process group and terminates survivors on teardown, and scope slice-level test runs to the slice's named tests while the full suite stays at the pre-PR gate. This targets the observed `cli-cost-report`/`cli-heartbeat` parallel-load flakes directly; no cross-module message contracts, replay fingerprints, or platform escalation matrices.

## Observability And Cost

- Honeycomb OpenTelemetry enablement
  - Completed readiness/propagation baseline: `doctor --telemetry` checks native opencode OTel, sanitized `OTEL_EXPORTER_OTLP_*` env, companion plugin presence, package instrumentation loadability, no-default telemetry state, and prompt/content-capture risk; launch/resume/continue paths accept trace context flags and map them to runtime env without durable trace state.
  - Future work: implement feature-factory span taxonomy/correlation spans, validate a real Honeycomb Agent Timeline with native opencode OTel or a companion plugin, and decide whether CLI root spans need a feature-factory-owned SDK/exporter.
  - Estimate: 1-2 days for feature-factory run correlation; 1-2 days for Honeycomb validation and production hardening after spans exist.
  - Follow the design in `SPEC.md#14-opentelemetry-genai-instrumentation`.
  - Do not add default telemetry or persist trace context in `run.json`.

- Cost attribution follow-ups
  - Baseline local current-run attribution and read-only reporting are implemented and documented: `factory cost-record` writes provider-supplied usage/cost metadata to `run.json.cost_attribution`; status/list/TUI expose diagnostic summaries; and `factory cost-report` provides human, JSON report-v1, and invocation-correlation modes.
  - Future work: provider-specific metadata normalization as opencode exposes it. Genuine telemetry span taxonomy/correlation and SDK/export validation remain tracked above; report invocation IDs alone are not entry-to-span proof. Keep all cost surfaces local diagnostics rather than billing authority.

## Operational Notes

- TUI sidebar requires the TUI plugin config in `~/.config/opencode/tui.json`.
- Server plugin config remains in `~/.config/opencode/opencode.jsonc`.
- The sidebar only renders on session routes and needs enough terminal width to show the right panel.
- Plugin bundle changes may require restarting the opencode TUI; the sidebar shows `sidebar vN · plugin changes need TUI restart` when active data is visible.
- `mimirbot` is expected to review PRs on this repo; treat requested changes as normal PR feedback before merge.
