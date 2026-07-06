# TODO

## Active Runs

- `reviewer-sandboxing`
  - Status: `completed`; PR merged.
  - Goal: enforce read-only reviewer behavior with post-review dirty-state detection.
  - Next: run `factory cleanup reviewer-sandboxing` after the cleanup command is committed.

- `conservative-review-tiers`
  - Status: `running`
  - Current gate: `brief`; decomposition attempt 1 rejected.
  - Goal: add minimal review-tier metadata and conservative defaults for risky changes.
  - Next: fix slice decomposition so `review-tier-contract` owns AC2 coverage and `SKILL.md` initialization/backfill assertions.

## Feature Factory Hardening Backlog

- Reviewer sandboxing
  - Add a minimal enforceable guard after every reviewer-designated subagent invocation.
  - Check the reviewed worktree with `git status --porcelain=v1 --untracked-files=all`.
  - Block/fail the review if the worktree is dirty or cleanliness cannot be verified.
  - Document that this is post-run dirty-state detection, not OS/process sandboxing.
  - Add tests for clean reviewer output, dirty reviewer output, and blocked reporting.

- Slice commit contract enforcement
  - Builders must commit their slice changes on the slice branch.
  - Builders must leave the slice worktree clean and report the commit SHA.
  - Orchestrator prompts must not tell builders to leave changes uncommitted unless intentionally running a patch-only workflow.
  - Review/merge must reject dirty or uncommitted builder worktrees.
  - Slice state must not advance to `review` or `merged` without an observed branch diff, clean worktree, test/evidence output, and commit SHA.
  - If a builder returns dirty/uncommitted changes, route back to the builder for remediation instead of reviewing or merging.

- Long-running phase heartbeat liveness
  - Keep `run.json.heartbeat_at` fresh while the factory is blocked waiting on long-running reviewer subagents, builders, tests, or remediation slices.
  - Known quiet stages include the `pre_pr` review panel and remediation work such as `fix-panel-*`, where the primary loop may be busy but not writing `run.json`.
  - Add a background heartbeat ticker or equivalent run-dir activity while panel/build/remediation tasks are in flight.
  - This complements the Mimir adapter-side fix that now treats stale heartbeat as a probe instead of an auto-fail.
  - Goal: avoid false stuck detection during legitimate long-running work, without relying on a broad external 4h timeout for normal liveness.

- Non-destructive disrupted-worktree recovery
  - Make the factory robust when its working directory/worktree disappears or becomes inaccessible mid-run.
  - Do not silently re-scaffold an empty run control plane if `.opencode/factory/<run-id>` or the active worktree is missing/disrupted.
  - If prior durable state is available, recover from it and reconcile with git branch/commit evidence.
  - If prior durable state cannot be recovered, fail loudly with a terminal `blocked` or `needs-human` status and a clear `terminal_result.reason`.
  - A run whose control plane vanishes should be observably dead or explicitly recoverable, not invisibly restarted as an empty/zombie run.
  - Frame this as robustness to external worktree disruption; do not assume opencode deleted the directory.

- Conservative review tiers
  - Define the initial tier vocabulary and semantics.
  - Persist selected tier in durable run state or plan metadata.
  - Apply conservative defaults when no explicit tier is selected for risky changes.
  - Keep lower-risk/lighter-tier runs from inheriting unrelated strict behavior.

- Interrupt, steer, and resume
  - Add a correction-file or command contract for redirecting running factory work.
  - Ensure resumed runs consume steering input without losing durable state.
  - Avoid restarting from scratch when only direction changes.

- Cost attribution
  - Record per-agent and per-slice token/cost usage.
  - Persist cost data in durable run artifacts.
  - Surface cost summaries in CLI/status and eventually TUI.

- Remediation context reuse
  - Reuse implementer context across remediation loops where safe.
  - Keep reviewers fresh and read-only.
  - Feed reviewers prior findings as input without preserving reviewer execution context.

## Operational Notes

- TUI sidebar requires the TUI plugin config in `~/.config/opencode/tui.json`.
- Server plugin config remains in `~/.config/opencode/opencode.jsonc`.
- The sidebar only renders on session routes and needs enough terminal width to show the right panel.
