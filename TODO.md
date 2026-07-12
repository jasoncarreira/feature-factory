# TODO

The codebase-review and feature-factory hardening pass landed its workflow changes.
The items below are the remaining future work.

## Build And Review Workflow

- [ ] Monitor reviewer entailment closure over the next few feature runs
  - Evidence to watch: a later review introduces a required structural, compatibility, state-transition, rendered-output, or test consequence that was deterministically implied by an earlier finding against the same abstraction. The CR/CRLF line-writer finding appearing after prior ownership remediation is the initial example, not yet enough evidence for another prompt rule.
  - If the pattern recurs, update the consolidated reviewer procedure so each `required_fixes` entry closes its direct, bounded entailments across known input classes, compatibility decisions, state transitions, exact outputs, and mapped assertions. Do not turn this into an open-ended edge-case search or add placeholder-word policing.

- [ ] Treat post-PR CI failure as a validation failure and remediate (bounded)
  - Today the workflow ends at `pr-created`: the factory creates the gated PR and stops, so a red CI run or a reviewer `changes_requested` is invisible to it. Close the loop by making CI status a first-class gate outcome — a failing required check is a NO-GO, handled by the same bounded remediation path as a pre-PR panel NO-GO, not a new subsystem.
  - Shape: after `pr-created`, an opt-in bounded step polls `gh pr checks` and PR review state **until the first terminal verdict** (checks pass/fail, or changes requested). Green/approved → done. Red → capture the failing check name, log excerpt, and likely owning slice/path as observed CI evidence (attempt-suffixed), route the top failure to the owning builder or the `test-verifier` integration gate, re-observe, and re-run, counted against `run.json.max_retries` like every other remediation loop. On exhaustion, terminalize `blocked`/`needs-human` with the captured CI failure. A blocked-run continuation can resume it.
  - Explicitly out of scope: a standing background monitor/daemon, an event bus, persistent PR subscriptions, or auto-reacting to arbitrary PR comments. This is one bounded watch per run reusing the existing remediation/continuation/terminal primitives — not always-on infrastructure.
  - Security scanning is a project concern, not a builder concern: the factory reacts only to the pass/fail of whatever checks the repository's own CI already runs; it does not add SAST, secrets, dependency, or SBOM scanning of its own.

## Runnable Dogfood Epics

Keep each run bounded to its named outcome, consume accepted shared primitives instead
of reimplementing them, and do not write open-ended completeness acceptance criteria.

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
