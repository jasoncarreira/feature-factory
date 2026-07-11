# TODO

The codebase-review and feature-factory hardening pass landed its workflow changes.
The items below are the remaining future work.

## Build And Review Workflow

- Reviewer prompt consolidation (maintenance direction, not new rules)
  - The reviewer prompts (`work-reviewer`, `security-reviewer`, `implementation-validator`) have accumulated interlocking rule blocks patch-by-patch: first-attempt completeness, acceptance bar, precedence, feasibility, trust-model rubric, structured BLOCK justification, delta/rerun rules, search discipline. Each earned its place against an observed failure, but the accretion pattern is the risk now.
  - Future work: one consolidation rewrite per prompt for coherence and brevity — same rules, integrated instead of appended. Do not add further rules without first consolidating; new failure modes should prefer orchestrator-side enforcement over more prompt text.

## Runnable Dogfood Epics

Keep each run bounded to its named outcome, consume accepted shared primitives instead
of reimplementing them, and do not write open-ended completeness acceptance criteria.

### Centralized Hardening Completion

- [ ] **Consumer migration rebaseline** (`centralized-hardening-consumer-migration-rebaseline`) - Active current-main rebaseline of the remaining consumers onto the accepted sensitive-data, terminal-output, protected-write, and process-verification primitives. Reconcile selectively reusable run-state, operator-output, and TUI work with merged PRs #52 and #53, then complete factory orchestration and CLI consumers. Preserve compatibility and focused tests; do not re-litigate accepted foundation contracts; keep generated `dist/tui.js` unowned.

### Lifecycle Cleanup

- [ ] **Conservative cleanup sweep** (`cleanup-conservative-sweep`) - One epic replacing the previous four-epic cleanup pipeline (lock-claim protocol, orphan assessment, inventory/execution engine, operator surface). Extend `factory cleanup` with a repository-wide sweep that auto-deletes only `completed` runs whose PR is merged or closed and whose branches carry no unmerged commits, and only when nothing live references them (no live `factory.lock`, fresh heartbeat, or valid process evidence). `blocked`, `partial`, and `needs-human` runs may hold recoverable work: list them in the sweep report, never auto-delete them. Require a dry-run listing before any repository-wide deletion, and skip-and-report anything uncertain. Fail closed instead of building a claim-recovery protocol for contested deletions.

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
- `mimirbot` is expected to review PRs on this repo; treat requested changes as normal PR feedback before merge.
