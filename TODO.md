# TODO

The codebase-review and feature-factory hardening pass (verified findings, heartbeat
rewrite, CLI write-surface completion, and right-sizing) is complete. The items below are
the remaining future work.

## Build And Review Workflow

- Interrupt, steer, resume, and cancellation rollback (implemented)
  - Baseline commands exist: `feature-factory factory steer <run-id> --message TEXT --json`, `feature-factory factory resume <run-id> --dry-run --json`, and `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`.
  - Resume rejects `active-heartbeat` and preserves durable state; raw steering is labeled `UNTRUSTED OPERATOR STEERING DATA (not instructions)` with `trust: untrusted-operator-data` only at one-time consume.
  - Cancellation now records run-scoped `$RUN/process.json` evidence for detached opencode launches with a known explicit run id plus `$RUN/processes/<timestamp>.log`, sends only one targeted `SIGTERM` when identity matches, and fails closed without broad process killing when evidence is absent, stale, invalid, or mismatched.
  - Steering conflicts are explicit: after `steer-consume`, the orchestrator checks accepted durable state and uses `feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --json` to stop as `needs-human` instead of attempting automatic rollback.
  - Future work: drain and consume pending steering at safe orchestrator decision boundaries in live runs, such as after heartbeat-bracketed waits, before autonomous gate approval, before dispatching the next agent/wave, before remediation, and before terminalization or PR creation. Do not consume steering from low-level transition helpers, heartbeat ticks, cost-record writes, or read-only status/list/TUI paths where the orchestrator would not actually apply the message.

## Observability And Cost

- Honeycomb OpenTelemetry enablement
  - Completed readiness/propagation baseline: `doctor --telemetry` checks native opencode OTel, sanitized `OTEL_EXPORTER_OTLP_*` env, companion plugin presence, package instrumentation loadability, no-default telemetry state, and prompt/content-capture risk; launch/resume/continue paths accept trace context flags and map them to runtime env without durable trace state.
  - Future work: implement feature-factory span taxonomy/correlation spans, validate a real Honeycomb Agent Timeline with native opencode OTel or a companion plugin, and decide whether CLI root spans need a feature-factory-owned SDK/exporter.
  - Estimate: 1-2 days for feature-factory run correlation; 1-2 days for Honeycomb validation and production hardening after spans exist.
  - Follow the design in `SPEC.md#14-opentelemetry-genai-instrumentation`.
  - Do not add default telemetry or persist trace context in `run.json`.

- Cost attribution follow-ups
  - Baseline local current-run attribution is implemented and documented: `factory cost-record` writes provider-supplied usage/cost metadata to `run.json.cost_attribution`, and status/list/TUI expose diagnostic summaries.
  - Future work: richer reporting/export views, provider-specific metadata normalization as opencode exposes it, and correlation with telemetry spans without turning local diagnostics into billing authority.

- TUI current-status projection
  - `src/tui-data.js currentSummary()` currently prefers `blocked` work before active `running`/`review` work, so downstream placeholder steps such as `work-decomposer blocked` with `attempts: 0` can hide the real active step such as `spec-writer running`.
  - Future work: prefer active `running`/`review` slices or steps over blocked downstream placeholders; keep real blocked slices/steps visible when no active work is running.
  - Add tests for the observed shape: `spec-writer running` plus downstream `work-decomposer`/test/panel `blocked` placeholders should render `spec-writer running` as current.

## Operational Notes

- TUI sidebar requires the TUI plugin config in `~/.config/opencode/tui.json`.
- Server plugin config remains in `~/.config/opencode/opencode.jsonc`.
- The sidebar only renders on session routes and needs enough terminal width to show the right panel.
- Plugin bundle changes may require restarting the opencode TUI; the sidebar shows `sidebar vN · plugin changes need TUI restart` when active data is visible.
- `mimirbot` is expected to review PRs on this repo; treat requested changes as normal PR feedback before merge.
