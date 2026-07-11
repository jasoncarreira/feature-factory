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

These epics replace the over-broad `lifecycle-cleanup-recovery` and `git-test-harness-hardening` runs while preserving their material review constraints below. Keep each run bounded to its named outcome, and consume shared primitives from `centralized-hardening-primitives` when available instead of reimplementing them.

### Lifecycle Cleanup And Recovery

- [ ] **Safe cleanup lock claims** (`cleanup-lock-claim-recovery`) - Define and implement an ownership-stable, crash-recoverable cleanup mutation-claim protocol with deterministic concurrency and orphaned-claim recovery coverage. An orphaned claim must be recoverable through verified dead-local ownership without deleting a live or replacement claim.
- [ ] **Orphan lifecycle assessment** (`orphan-lifecycle-assessment`) - Centralize read-only process/heartbeat/run-state classification and checked orphan recovery so missing, dead, live, stale, contradictory, and uncertain evidence remain fail-closed and actionable.
- [ ] **Cleanup inventory and execution engine** (`cleanup-inventory-execution`) - Build conservative per-run and repository-wide inventory, planning, revalidation, execution, and partial-failure behavior for recorded and legacy factory resources. Depends on the lock-claim and orphan-assessment epics.
- [ ] **Cleanup operator surface** (`cleanup-operator-surface`) - Integrate the engine into per-run and sweep CLI workflows, package-log retention, stable human/JSON output, compatibility behavior, and operational documentation. Depends on the cleanup engine.

### Git And Test Harness Hardening

- [ ] **Hermetic Git fixture isolation** (`git-fixture-isolation`) - Centralize repository-owned fixture Git execution, ignore host global/system configuration, disable signing for fixture commits, migrate duplicate helpers, and enforce the boundary structurally without changing production Git behavior.
- [ ] **Owned test process supervision** (`owned-test-process-supervisor`) - Provide a bounded, identity-verified process ownership and termination protocol with complete cross-module message/result contracts, parent-held descendant identity after supervisor exit, coherent escalation, and no-survivor outcomes across supported platforms.
- [ ] **Leak attribution and bounded test runner** (`test-leak-attribution-runner`) - Attribute unresolved tests and completed-handle leaks through file/worker lifecycle correlation that remains correct under normal concurrency, apply measured phase/check deadlines, and integrate non-destructive package smoke plus actionable diagnostics. Depends on owned process supervision.

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
