# TODO

## Active Runs

- `jsonc-config-parsing`
  - Status: `running`; autonomous factory run paused after Gate 1.
  - Goal: replace hand-rolled JSONC config stripping with a real parser or explicit JSON-only contract.
  - Current gate: story approved autonomously; brief gate pending.
  - Next: resume from a clean checkout after the review-guard fix is committed.

## Wrapper Epics

### Release Readiness And Packaging

- Package/TUI export compatibility
  - `npm pack` + fresh install currently leaves `import('opencode-feature-factory/tui')` failing with `ERR_UNKNOWN_FILE_EXTENSION .jsx`.
  - Add a JS wrapper/build output for TUI, or remove the export until OpenCode consumes it safely.
  - Include packed-install coverage for `opencode-feature-factory`, `/server`, and `/tui` imports.

- Fresh consumer install smoke
  - Current install/release path is local-dev shaped (`npm link` + `feature-factory install --local`).
  - Add a true pack/install tarball smoke in a scratch project.
  - Verify CLI, plugin config install, OpenCode debug/restart behavior, `/feature`, agents, and TUI registration.
  - Investigate why bare-package plugin config did not register commands/agents while file-url local install did.

- Portable CI/check scripts
  - `npm run check` currently includes `doctor --local`, which fails in environments without user OpenCode config.
  - Split deterministic package gates from local environment diagnostics.
  - Suggested scripts: `test`, `pack-smoke`, `doctor`, and `doctor:local`.

- License hygiene
  - `package.json` declares MIT but the tarball has no `LICENSE` file.
  - Add `LICENSE` and ensure it is included in packed releases.

### Provenance And Terminal State Authority

- PR URL authority for completed runs
  - Current flow uses the dedicated `pr-created` attestation recorded by `feature-factory factory pr-created <run-id> --json` after draft PR creation.
  - Keep monitoring for provider-specific PR observation gaps; `run.pr_url` and `terminal_result.pr_url` must continue to fail closed without a matching accepted `attestations/pr-created.json` binding.

- Persist factory provenance at run creation/resume
  - Current flow persists redacted diagnostic snapshots in `run.json.factory_provenance` through `factory provenance record-created <run-id> --json` and `factory provenance record-resume <run-id> --json`.
  - Keep this as diagnostic metadata, not proof; do not weaken redaction for token-shaped/high-entropy credentials such as `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, and `xoxb_*`.

- Tighten gate answer preconditions
  - Current flow records `pending_snapshot` on pending gates and verifies question/artifact/answer refs and hashes before consuming answers.
  - Continue adding fixtures for missing, escaped, stale, or overlapping gate refs as new edge cases are found.

### Factory Robustness And Durability

- Factory stale/recovery diagnostics
  - Add diagnostics before relying heavily on detached runs.
  - Surface stale heartbeat, missing process, missing worktree, invalid run state, and recoverable vs terminal conditions clearly.
  - Prefer explicit `blocked`/`needs-human` terminal state over zombie or silently restarted runs.

- Non-destructive disrupted-worktree recovery
  - Make the factory robust when its working directory/worktree disappears or becomes inaccessible mid-run.
  - Do not silently re-scaffold an empty run control plane if `.opencode/factory/<run-id>` or the active worktree is missing/disrupted.
  - If prior durable state is available, recover from it and reconcile with git branch/commit evidence.
  - If prior durable state cannot be recovered, fail loudly with terminal `blocked` or `needs-human` plus clear `terminal_result.reason`.

- Automated blocked-run continuation
  - Add a `factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>` workflow.
  - Treat the blocked branch/worktrees and review artifacts as read-only source context.
  - Use the final/blocking review as the remediation spec seed while preserving the original story/brief as scope boundaries.
  - Record parent run, blocked branch/commit, review ref/hash, and original artifact refs in continuation provenance.
  - Fail closed if the blocked branch, review, or provenance cannot be verified.
  - Open a draft PR only after the normal validator/security gates pass.

- Crash-durability for atomic writes
  - Consider fsync-on-rename for `run.json` and heartbeat writes if crash durability is required.
  - Current atomic rename gives atomic visibility, not necessarily durable persistence across power loss.

### Config And User Environment Compatibility

- JSONC config parsing
  - Replace hand-rolled JSONC config stripping with a real JSONC parser, or document strict JSON-only support.
  - Inline comments and trailing commas are common in OpenCode-shaped config files.

### Build And Review Workflow Hardening

- Slice commit contract enforcement
  - Builders must commit their slice changes on the slice branch.
  - Builders must leave the slice worktree clean and report the commit SHA.
  - Orchestrator prompts must not tell builders to leave changes uncommitted unless intentionally running a patch-only workflow.
  - Review/merge must reject dirty or uncommitted builder worktrees.
  - Slice state must not advance to `review` or `merged` without observed branch diff, clean worktree, test/evidence output, and commit SHA.
  - If a builder returns dirty/uncommitted changes, route back to the builder for remediation instead of reviewing or merging.

- Interrupt, steer, and resume
  - Add a correction-file or command contract for redirecting running factory work.
  - Ensure resumed runs consume steering input without losing durable state.
  - Avoid restarting from scratch when only direction changes.

- Remediation context reuse
  - Reuse implementer context across remediation loops where safe.
  - Keep reviewers fresh and read-only.
  - Feed reviewers prior findings as input without preserving reviewer execution context.

### Observability And Cost

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
