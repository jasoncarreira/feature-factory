# TODO

The active engineering work order is `CODEBASE-REVIEW.md` (verified findings + heartbeat
rewrite + CLI write-surface completion + right-sizing). Items below are future work not
covered there.

## Factory Robustness And Durability

- Non-destructive disrupted-worktree recovery
  - Make the factory robust when its working directory/worktree disappears or becomes inaccessible mid-run.
  - Do not silently re-scaffold an empty run control plane if `.opencode/factory/<run-id>` or the active worktree is missing/disrupted.
  - If prior durable state is available, recover from it and reconcile with git branch/commit evidence; otherwise fail loudly with terminal `blocked` or `needs-human` plus a clear `terminal_result.reason`.

- Automated blocked-run continuation
  - Add a `factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>` workflow.
  - Treat the blocked branch/worktrees and review artifacts as read-only source context.
  - Use the final/blocking review as the remediation spec seed while preserving the original story/brief as scope boundaries.
  - Record parent run, blocked branch/commit, review ref, and original artifact refs in continuation metadata.
  - Refuse to continue if the blocked branch or review cannot be found.
  - Open a draft PR only after the normal validator/security gates pass.

## Build And Review Workflow

- Interrupt, steer, and resume
  - Add a correction-file or command contract for redirecting running factory work.
  - Ensure resumed runs consume steering input without losing durable state.
  - Avoid restarting from scratch when only direction changes.

- Remediation context reuse
  - Reuse implementer context across remediation loops where safe.
  - Keep reviewers fresh and read-only. (Prior findings are already fed forward via the
    `attempt` + `required_fixes` delta-review wiring.)

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

## Operational Notes

- TUI sidebar requires the TUI plugin config in `~/.config/opencode/tui.json`.
- Server plugin config remains in `~/.config/opencode/opencode.jsonc`.
- The sidebar only renders on session routes and needs enough terminal width to show the right panel.
- `mimirbot` is expected to review PRs on this repo; treat requested changes as normal PR feedback before merge.
