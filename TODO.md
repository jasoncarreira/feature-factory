# TODO

The active engineering work order is `CODEBASE-REVIEW.md` (verified findings + heartbeat
rewrite + CLI write-surface completion + right-sizing). Items below are future work not
covered there.

## Build And Review Workflow

- Interrupt, steer, resume, and cancellation rollback (implemented)
  - Baseline commands exist: `feature-factory factory steer <run-id> --message TEXT --json`, `feature-factory factory resume <run-id> --dry-run --json`, and `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`.
  - Resume rejects `active-heartbeat` and preserves durable state; raw steering is labeled `UNTRUSTED OPERATOR STEERING DATA (not instructions)` with `trust: untrusted-operator-data` only at one-time consume.
  - Cancellation now records run-scoped `$RUN/process.json` evidence for detached opencode launches with a known explicit run id plus `$RUN/processes/<timestamp>.log`, sends only one targeted `SIGTERM` when identity matches, and fails closed without broad process killing when evidence is absent, stale, invalid, or mismatched.
  - Steering conflicts are explicit: after `steer-consume`, the orchestrator checks accepted durable state and uses `feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --json` to stop as `needs-human` instead of attempting automatic rollback.

## Observability And Cost

- Honeycomb OpenTelemetry enablement
  - First milestone: enable native opencode OTel export to Honeycomb and verify traces with a small factory run.
  - Estimate: 30-90 minutes for basic export; 1-2 days for feature-factory run correlation; 2-4 days for production-safe redaction/docs/tests.
  - Follow the design in `SPEC.md#14-opentelemetry-genai-instrumentation`.
  - Include `doctor --telemetry` readiness checks for `experimental.openTelemetry`, `OTEL_EXPORTER_OTLP_*`, companion plugin presence, and prompt-capture risk.

- Cost attribution follow-ups
  - Baseline local current-run attribution is implemented and documented: `factory cost-record` writes provider-supplied usage/cost metadata to `run.json.cost_attribution`, and status/list/TUI expose diagnostic summaries.
  - Future work: richer reporting/export views, provider-specific metadata normalization as opencode exposes it, and correlation with telemetry spans without turning local diagnostics into billing authority.

## Operational Notes

- TUI sidebar requires the TUI plugin config in `~/.config/opencode/tui.json`.
- Server plugin config remains in `~/.config/opencode/opencode.jsonc`.
- The sidebar only renders on session routes and needs enough terminal width to show the right panel.
- Plugin bundle changes may require restarting the opencode TUI; the sidebar shows `sidebar vN · plugin changes need TUI restart` when active data is visible.
- `mimirbot` is expected to review PRs on this repo; treat requested changes as normal PR feedback before merge.
