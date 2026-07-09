# TODO

The active engineering work order is `CODEBASE-REVIEW.md` (verified findings + heartbeat
rewrite + CLI write-surface completion + right-sizing). Items below are future work not
covered there.

## Build And Review Workflow

- Interrupt, steer, and resume (implemented baseline)
  - Baseline commands exist: `feature-factory factory steer <run-id> --message TEXT --json`, `feature-factory factory resume <run-id> --dry-run --json`, and `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`.
  - Resume rejects `active-heartbeat` and preserves durable state; raw steering is labeled `UNTRUSTED OPERATOR STEERING DATA (not instructions)` with `trust: untrusted-operator-data` only at one-time consume.
  - Future work: live cancellation/kill of running opencode and semantic rollback when steering conflicts with completed artifacts.

## Observability And Cost

- Honeycomb OpenTelemetry enablement
  - First milestone: enable native opencode OTel export to Honeycomb and verify traces with a small factory run.
  - Estimate: 30-90 minutes for basic export; 1-2 days for feature-factory run correlation; 2-4 days for production-safe redaction/docs/tests.
  - Follow the design in `SPEC.md#12-opentelemetry-genai-instrumentation`.
  - Include `doctor --telemetry` readiness checks for `experimental.openTelemetry`, `OTEL_EXPORTER_OTLP_*`, companion plugin presence, and prompt-capture risk.

- Cost attribution
  - Record per-agent and per-slice token/cost usage.
  - Persist cost data in durable run artifacts.
  - Surface cost summaries in CLI/status and eventually TUI.

- TUI active-session refresh hardening
  - An already-open opencode TUI process can keep rendering stale Feature Factory sidebar data after the plugin bundle changes, requiring a TUI restart/reload to pick up fixes.
  - Add an explicit reload/debug path or document the active-session limitation so stale sidebar state is easier to diagnose during long factory runs.

## Operational Notes

- TUI sidebar requires the TUI plugin config in `~/.config/opencode/tui.json`.
- Server plugin config remains in `~/.config/opencode/opencode.jsonc`.
- The sidebar only renders on session routes and needs enough terminal width to show the right panel.
- `mimirbot` is expected to review PRs on this repo; treat requested changes as normal PR feedback before merge.
