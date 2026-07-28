# opencode-feature-factory

Hybrid opencode server plugin, separately importable TUI registration object, and CLI for a durable, scriptable feature workflow.

It ships:

- `/feature` command registration for opencode.
- A separately importable TUI sidebar registration object that can monitor local factory runs when loaded by a compatible host.
- Feature-factory skill docs and control-plane schema.
- Twelve specialized subagents for story, research, spec, decomposition, build, tests, review, and validation, coordinated by one primary `feature-factory` agent.
- A `feature-factory` CLI with install/doctor commands and local factory state helpers.

## Documentation Status

This README is the current packaged operator contract. The repository-only [contributor](https://github.com/jasoncarreira/opencode-feature-factory/blob/main/CONTRIBUTING.md), [release](https://github.com/jasoncarreira/opencode-feature-factory/blob/main/RELEASING.md), and [change](https://github.com/jasoncarreira/opencode-feature-factory/blob/main/CHANGELOG.md) guides are current companion documentation but are not included in the published package. `SPEC.md` is proposed/internal planning, not implemented operator guidance. `DOGFOOD-LEARNINGS.md`, `RUN-LATENCY-FINDINGS.md`, and `SIMPLIFICATION.md` are historical or retrospective records, not the current contract. Future work is tracked in [GitHub issues](https://github.com/jasoncarreira/opencode-feature-factory/issues). Future design documents such as `EXTRACTION-SPEC.md` and the approved `CONTINUATION-SCOPE-DESIGN.md` remain non-authoritative for current behavior until their runtime slices ship.

## Trust Model

The proof layer removed in the simplified factory. The durable contract is local state plus transition-time checks, not a cryptographic or tamper-proof authority system.

### Threat boundary

- The local operator and host are trusted for integrity. This includes the OS and process account, local filesystem and Git repository, installed factory code, test commands and toolchain, and reviewer/verifier implementations. Operator text shown to a model is still data rather than privileged instructions at the prompt boundary.
- Model and subagent claims and stale evidence are untrusted. Re-observe claims and reject stale or mismatched evidence before a checked transition. Crashes and concurrent retries are fallible operating conditions that can leave an outcome unknown.
- The factory makes no protection claim against arbitrary modification of the local filesystem, Git history, factory code, test commands, or reviewer/verifier implementations by the operator, a host administrator, or other code with equivalent local access. Such modification is outside the threat model and can rewrite both state and the checks that read it.
- Hashes, refs, locks, tokens, snapshots, and transition checks are local consistency and provenance checks, not cryptographic authentication or generic forgery resistance. They detect stale or mismatched state and coordinate crash/retry behavior only while the trusted local substrate remains intact.
- Within that boundary, retain exact Git/test/review/merge provenance: full Git SHAs plus locally observed diffs, trees, and ancestry; exact test commands, results, attempts, and heads; review subjects, attempts, refs, hashes, and exact reviewed commits; and merge commits plus their reviewed-tree relation. A model claim never substitutes for those observations.
- Retain idempotent external-effect controls: exclusive claims or fences and exact identity/token checks precede effects, unknown crash outcomes are re-observed before retry, and effects already recorded or observed are not repeated. In particular, after a PR exists, retain its fence and record that existing PR; do not create another.

Active guarantees:

- `run.json`, gate answers, `evidence/*`, `reviews/*`, and `terminal_result` are durable local workflow state.
- Semantic manifest writes go through locked transition helpers so stale writers fail instead of overwriting newer state. `transitionGateDecision` owns approved gate writes, and `transitionPrCreated` owns completed PR state writes.
- Pending gates include `pending_snapshot` entries for `question_ref`, `question_hash`, `artifact_ref`, `artifact_hash`, and answer material. Gate answer consumption fails closed if current refs are missing, escaped, stale, or hash-mismatched.
- Detached opencode processes are cancellable only when they have run-scoped evidence from a known explicit run id: `$RUN/process.json` points at one verified process identity and `$RUN/processes/<timestamp>.log` records stdout/stderr. Run-owned detached launches fail before writing `process.json` if live process identity cannot be verified. `factory cancel` sends a single targeted `SIGTERM` only when that evidence validates; missing, invalid, stale, mismatched, or non-running evidence returns a fail-closed response and sends no signal. There is no broad process kill, process-group kill, `pkill`, or `killall` fallback.
- Effective-content provenance is recorded at run creation, resume, and review dispatch. It hashes the rendered command, resolved agent prompts, repo-seeded skills, loaded plugin source, exact dynamic review prompt bytes, OpenCode version, configured model profiles, and Git HEAD/dirty state without storing raw prompts, credentials, or dirty path names. Configured models are not reported as actual provider selections when runtime metadata is unavailable.
- Every newly started slice attempt sets `dispatch_required`. The plugin create-publishes a checked claim, binds `{dispatch_claim_ref, dispatch_claim_hash}` into the running slice, withholds its random completion capability from the Task prompt/body, then lets only the matching synchronous after-hook with a confirmed foreground result create and bind `{dispatch_closure_ref, dispatch_closure_hash}`. Failed, cancelled, unknown, or promoted-background callbacks leave the claim unresolved. Slice `review`/`merged` rows that require dispatch reject without that exact closed authority and also bind `{evidence_hash, review_hash, reviewed_commit}` all-or-none. Checked review publication appends the dispatch claim/closure tuple to that attempt's immutable review history, so later retries revalidate every prior dispatch rather than replacing its authority. It hashes exact dispatch/evidence/review bytes only when positive attempts and subjects match and evidence `head_sha`/review `reviewed_commit` equal the clean slice branch/worktree HEAD. Merge admission re-observes those bindings and requires an exact two-parent merge whose ordered second parent is that reviewed commit, whose unique full `git merge-base --all` base is valid, and whose NUL-delimited no-renames path set and per-path presence/mode/type/object identities exactly carry the reviewed change onto the integration first parent.
- Slice review and merged rows require complete current bindings plus append-only attempt history; old-shape and partial rows reject without mutation. Validator rows require `{report, report_hash, review_ref, review_hash, reviewed_head_sha}` and security rows require `{review_ref, review_hash, reviewed_head_sha}`. Checked panel publication binds both complete tuples atomically to the same clean integration HEAD. Partial tuples and old-shape completed runs reject; current merged rows stay immutable.
- PR URLs are written only through `feature-factory factory pr-created <run-id> --fence-token TOKEN`. Fence establishment derives, rather than accepts, the canonical GitHub origin repository, clean equal local/worktree/origin head, exact remote base, persisted ready/draft mode, and base ancestry. Fence establishment and reconciliation re-hash all bound slice/panel sidecars and require the current clean integration HEAD. The fence binds those values to an `ffpr-v1-...` operation identity. PR recording then re-observes GitHub and writes the canonical GitHub PR URL, number, node ID, operation ID, head/base refs and SHAs, repository, and draft state; callers cannot supply PR metadata.
- Blocked-run continuation payloads are operator data/config, not privileged instructions. Schema-v2 full-plan carry-forward is the only current continuation shape. `factory continue ... --carry-forward` validates a parent whose status is exactly `blocked`, recognized subject-consistent approved review evidence, the complete current plan and accepted rows, and the exact checked published child; it retains parent context without mutating the parent and still requires fresh tests, validator, security review, and configured PR checks.
- Every plan carries a closed root `integration_gate.required_commands` list of 1-32 ordered structured `{program,args}` entries, never shell text. Programs are trimmed, 1-255 UTF-8 bytes, and free of NUL/control characters; each command has at most 64 args, each at most 4096 UTF-8 bytes and without NUL; the encoded list is at most 64 KiB. Exact `{program:"npm",args:["run","check"]}` occurs once and last. `factory slices-seed --from plan/slices.json` resolves only exact `$RUN/plan/slices.json`, requires a regular non-symlink file with fatal UTF-8 decoding and an exact slice projection, and re-observes its bytes at commit. Work-decomposer acceptance hash-binds exact `plan/slices.json` plus its review; every plan reader and schema-v2 construction/publication/adoption/replay/resume/downstream consumer requires and rehashes both. Missing current authority rejects and requires re-seeding.
- Every plan requires closed `plan.delivery_envelope` schema v1. It has exactly one ordered delivery unit per slice, globally unique lowercase kebab-case family, obligation, and artifact IDs, and exact artifact index/text bindings to that slice's `test_plan`. Admission is active: a unit with multiple invariant families and at least six obligations, or a dependency graph deeper than four waves, routes to `checkpoint`; every other valid envelope routes to `admit`. Missing or partial envelopes reject and require re-seeding.
- Every slice-review attempt under a delivery envelope requires a complete closed `invariant_family_ledger`: exactly one disposition per current family, mapped through a current obligation to an artifact, with the enclosing reviewed commit and zero omitted or extra families. Before review, the orchestrator runs each selected exact artifact command only through `feature-factory factory artifact-execute <run-id> <slice-id> <artifact-id> --json`. Under the run lock the command create-publishes a nonce-bound claim before spawn; new claim/receipt filenames use fixed-width SHA-256 base64url identities for exact UTF-8 slice and artifact IDs rather than raw path segments, while closed records preserve original subjects. The claim binds run, slice, attempt, accepted plan hash, reviewed HEAD, artifact ID, and exact parsed program/argv. Completion create-publishes the receipt and closes the claim with the exact result and receipt hash. Active or unknown claims, unclaimed/pre-existing receipts, wrong nonces, stale/replayed bytes, caller-claimed pass results, failed/skipped dispositions, or unresolved findings cannot grant APPROVE authority or trigger duplicate execution.
- Oversized routing uses exact kind `delivery-checkpoint-routing-manifest`. Its authority order is fixed: the decomposer writes an explicit reviewed checkpoint plan; `factory slices-probe` derives a nonmutating typed valid/invalid probe from those exact bytes; `work-reviewer` returns same-attempt `APPROVE-CHECKPOINT` with one exact ordered approving child disposition per checkpoint; only then does the parent accept and publish routing authority. Over-depth is valid checkpoint routing, not `REDESIGN-REQUIRED`. Exact blocked routing parents retain empty `run.slices`, active empty `checkpoint_progress`, and one content-addressed manifest. Status/list/validate revalidate terminal, plan, probe, review, disposition, and manifest authority without applying the ordinary four-wave child limit to the parent route.
- `factory checkpoint-start <parent-run-id> <checkpoint-id> --run-id <child-run-id>` records `reserved`, create-publishes an immutable child publication claim plus branch/worktree and a complete normal child `run.json`, accepted child plan/review, and immutable `checkpoint_source`, records `child-published`, launches through ordinary resume, and records `launched` only after launch ownership. The publication claim has creation-only semantics: it prevents conflicting child creation but is not a permanent generic-writer guard. After publication the child follows the ordinary heartbeat, steering, gate, step, slice, test, panel, PR, recovery, and terminal lifecycle. Test acceptance still requires the full passing checked execution tuple whose commands exactly equal the selected request.
- Parent progress is monotonic `reserved -> child-published -> launched -> merged`, followed by parent `closed`. Record a canonical merged child with `factory checkpoint-record-merged <parent-run-id> <checkpoint-id> --json`; `checkpoint-start` automatically attempts this recovery for a launched predecessor, and `checkpoint-close` does so for a launched final child. Recording verifies the normal completed child or same-checkpoint B1 leaf, exact immutable source and full configuration, continuation claims, canonical merged PR, and fresh remote-main ancestry. Only `merged` unlocks the next checkpoint. Once every entry is merged, `factory checkpoint-close <parent-run-id> --json` publishes a reservation-free content-addressed closure artifact and atomically records its ref/hash/time in closed parent progress.
- B1 carry-forward is permitted only for nonconvergence recovery inside the same checkpoint. Every descendant copies byte-identical `checkpoint_source` and the full stored mode/account/PR/retry/post-PR/review-tier configuration; cross-checkpoint carry-forward, predecessor-row inheritance, partial PRs, cross-run merge trains, joins, and shared final panels reject. Cleanup is gated rather than universally prohibited: a child or same-checkpoint B1 descendant is eligible only when exactly one durable merged parent lineage contains its exact run ID and run hash, and cleanup reobserves that authority under the parent lock before ordinary deletion. Published/launched, stale, duplicate, or cross-checkpoint lineage remains protected.
- Schema-v2 whole-story commands run only through `feature-factory factory test-execute <run-id> --json`; the caller cannot supply a command, result, status, ref, attempt, cwd, or environment. Under the run lock the factory verifies the exact published v2 child, accepted plan/decomposition, every merged commit's ancestry, and clean branch/worktree HEAD, then persists a nonce-bound `execution_claim` before spawning the ordered argv with `shell:false`. Commands run sequentially with a reduced allowlisted environment, required `PATH`, `GIT_TERMINAL_PROMPT=0`, 300-second per-command timeout, separate 1 MiB stdout/stderr captured-prefix hashes, SIGKILL, and a 10-second close limit. Known failures do not skip later commands; indeterminate outcomes stop and require trusted out-of-band reconciliation.
- The factory create-publishes the closed receipt only at `evidence/test-verifier.attempt-N.json`, never persisting or returning raw output. Exact completed pass/fail replay performs no process or write. Active execution returns JSON code `TEST_EXECUTION_ACTIVE`; unknown or indeterminate execution returns `TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED`. Both diagnostics state that no supported factory command may clear, replace, terminalize, retry, or advance the claim and that trusted out-of-band operator/process reconciliation is required. `factory recover`, including the former `test-execution-reconciliation` reason text, generic terminal, steering conflict, step mutation, and another `test-execute` all reject active/unknown claims unchanged. B1R provides no autonomous reconciliation command or authority flag. Current acceptance requires an exact completed passing receipt, `artifacts/test-report.md`, and an independent same-attempt/same-HEAD APPROVE review; caller-authored evidence remains non-authoritative.
- `run.json.debug_snapshot` is diagnostic-only creation/resume metadata. It helps debug the factory/opencode/plugin substrate, but it is not authority for gates, reviews, merges, or PR URLs. Persisted snapshots omit sensitive keys and redact token-shaped or high-entropy credential values, including GitHub PAT shapes (`ghp_*`, `github_pat_*`, `gho_*`), OpenAI keys (`sk-proj_*`, `sk-*`), Slack tokens (`xoxb_*`), bearer/JWT/AWS-shaped values, credential-bearing URLs, and similar high-entropy secrets.
- `run.json.cost_attribution` is diagnostic-only local current-run usage/cost attribution. It is not billing authority, invoice data, quota enforcement, or cross-run chargeback state. It records provider-supplied usage and cost metadata only; the factory does not maintain pricing tables, call pricing APIs, estimate missing costs, or coerce missing usage/cost to zero.
- Trace-context launch metadata from `--parent-span-id`, `--traceparent`, and `--tracestate` is non-authoritative runtime configuration for process correlation only. It is not user instructions, not gate/review/PR authority, and not persisted in `run.json` or other durable factory state.

Limits:

- Local-only, not cryptographic or tamper-proof.
- A coherent rewrite of local files and Git history is outside the model.
- Arbitrary local filesystem or reviewer/verifier modification is outside the model; local checks do not defend against a hostile host or operator.

## Install

Install the published package and its `feature-factory` bin globally, then add the package plugin spec to the user config:

```sh
npm install -g opencode-feature-factory
feature-factory install
feature-factory doctor
```

`npm install -g` installs the package; it does not edit opencode configuration. `feature-factory install` updates `~/.config/opencode/opencode.jsonc` with one package plugin entry: it rewrites the first matching registration (preferring a tuple entry so its options survive) and removes any other duplicate string or tuple registrations for this package, including stale legacy local specs. It preserves unrelated values and existing tuple options, and an already matching registration is idempotent. JSONC input is serialized as formatted strict JSON, so comments and trailing commas are not preserved. The installer reports the effective PATH-resolved CLI as terminal-safe JSON containing exact `source`, package `version`, and SHA-256 `hash`. Shadowing definition findings produce warnings only during installation and are not changed; doctor and runtime launch apply the fail-closed policy documented below.

The installer does not add a second, independent TUI registration. The package has a separately importable TUI object, but this repository does not prove host discovery or automatic TUI activation. Restart opencode after installation or after resolving a shadowing warning; config and plugin code are loaded at startup.

## Install Locally

From this package directory:

```sh
npm link
feature-factory install --local
feature-factory doctor --local
```

`install --local` writes a `file://` URL for the package root and can upgrade the legacy local `src/plugin.js` registration. It has the same preservation, strict-JSON rewrite, idempotence, warning, single-entry, and restart behavior as the global configuration command.

Then restart opencode. Config is loaded at startup.

Local installs configure the package root, not `src/plugin.js`, so the package entry points remain available. The verified contract is still one config entry plus a separately importable TUI export, not automatic TUI activation.

## Runtime Consistency

Runtime identity is observed at four operator-relevant points:

- `feature-factory install` prints `feature-factory CLI: {"source":...,"version":...,"hash":"sha256:..."}` for the effective PATH-resolved CLI.
- `feature-factory doctor` reports the effective CLI `source`, package `version`, and SHA-256 `hash`; `--json` exposes it at `env.cli_identity` and exposes the effective configured plugin implementation at `env.plugin_identity`.
- Every foreground or detached OpenCode launch observes the executing package plugin/CLI, effective configured plugin package, effective PATH `feature-factory`, and effective PATH `opencode` before spawn. Versions are diagnostic; exact implementation/CLI bytes and bound OpenCode source/bytes are the admission checks.
- Run creation and every mutating resume persist that invocation's configured plugin and effective PATH CLI observations at `run.json.debug_snapshot.created_with.env.plugin_identity` / `cli_identity` or the corresponding `last_resumed_with.env` fields through `factory env record-created` / `record-resume`.

`plugin_identity` and `cli_identity` exist only inside `debug_snapshot`. They are redacted diagnostic-only creation/resume metadata, never top-level workflow state, provenance, gate/review/merge/PR authority, or a substitute for fresh launch admission. No config content is stored. Creation preserves the original observations; resume preserves them and records the latest observations separately.

### Launch admission

Before any factory child launch, admission reads the effective OpenCode config files under effective `XDG_CONFIG_HOME/opencode` (default `HOME/.config/opencode`), from the child cwd upward through its nearest Git root, under project `.opencode` directories, and under non-empty `OPENCODE_CONFIG_DIR` resolved relative to the child cwd. A local `file://` registration may name the package root, `src/opencode-plugin.js`, or legacy `src/plugin.js`. Exactly one local feature-factory registration must resolve to a readable package; multiple, ambiguous, malformed, or unreadable local registrations fail closed without exposing config content. A bare `opencode-feature-factory` registration uses the executing package as its fallback identity. Non-empty `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` remain unsupported and are rejected by definition admission before launch.

For a local registration, the executing package's shared `src/plugin.js` implementation and `src/cli.js` must have exact SHA-256 byte equality with the configured local package's corresponding files. The effective PATH `feature-factory` must then exactly equal that configured package's `src/cli.js`; different absolute source paths are allowed only when their bytes are equal. A missing or mismatched package/PATH CLI fails with `RUNTIME_ADMISSION_FAILED` and a terminal-safe remediation targeting the configured local package root (package A) as exact argv, not shell text:

```text
npm executable with exact argv ["install","--global","--","<observed-package-root>"]
```

Run `npm` with that exact argv, then ensure PATH `feature-factory` resolves to the accepted configured-package CLI bytes. Do not interpolate the displayed package path into a shell command.

Admission binds the executing and configured runtime package closures, existing plugin/CLI entry identities, local-registration state, and effective PATH OpenCode absolute source/hash. Each package closure covers `package.json`, every shipped `.js` file below `src/`, and every regular workflow file below `assets/` using sorted relative paths and path/content lengths; symlinks, nonregular or unreadable entries, incomplete roots, and bounded file/byte limit violations fail closed. Immediately before foreground spawn it re-reads config and re-observes every binding; detached launch performs the launcher recheck and the detached supervisor repeats it before child spawn. Configured registration removal, source/hash drift, disappearance, or an incomplete binding fails closed. The child is executed through the bound absolute OpenCode path with `shell:false`, not by resolving `opencode` again after admission.

These gates cover every production factory launch route: new `factory start`, start-as-resume, `factory resume`, schema-v2 `factory continue`, `factory checkpoint-start`, and interactive approval handoff, in foreground and detached forms.

### Global definitions

The stale-definition check uses the same environment inherited by the OpenCode child and inspects this closed inventory:

- Under `HOME`: singular and plural OpenCode `skill(s)/feature/SKILL.md`, singular and plural OpenCode `agent(s)/` definitions, plus `.claude/skills/feature/SKILL.md` and `.agents/skills/feature/SKILL.md`.
- Under effective `XDG_CONFIG_HOME/opencode` (defaulting to `HOME/.config/opencode`): singular and plural skill and agent forms.
- Under non-empty `OPENCODE_CONFIG_DIR`, resolved relative to the target repository when relative: singular and plural skill and agent forms.
- Non-empty `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT` is unsupported for factory operation and fails closed because its effective definition inventory cannot be established safely.

Absent recognized definitions are healthy. A recognized global feature skill is accepted only when its bytes exactly equal the current packaged feature skill or the sanctioned small delegator that requires the repo-seeded `.opencode/skills/feature/SKILL.md` and `SCHEMA.md`. Each recognized subagent file is accepted only when its bytes exactly equal the corresponding packaged agent. A global `feature-factory.md` primary-agent file is always stale because there is no sanctioned global primary-agent definition. Mismatched, symlinked, unreadable, ambiguous, or otherwise uninspectable recognized paths fail closed; duplicate paths from overlapping HOME/XDG/config roots are inspected once.

Install reports actionable warnings without modifying these files. Doctor classifies stale definitions or unsupported config overrides as `missing` and exits 1. New starts, resumes, continuations, checkpoint launches, and approval handoffs stop before child spawn. Direct plugin initialization and plugin `config` registration perform the same check, so loading the plugin outside the CLI is not a bypass. Remove mismatched files or replace them with exact sanctioned definitions, unset unsupported overrides, and restart OpenCode.

### Diagnostics and tooling

`feature-factory factory --help` deterministically prints normal usage to stdout, writes no unknown-command diagnostic, and exits 0. Doctor treats the supported one-level delegation policy as healthy only when the primary `feature-factory` agent has `permission.task: "allow"` and every subagent has `permission.task: "deny"`; subagent task denial is intentional, not a defect.

The installed runtime requires Node `>=20`. Child-directory publication for checkpoint and schema-v2 carry-forward routes uses Node-native filesystem rename under the factory's serialized no-overwrite checks; it does not invoke host `mv`. After Node/npm installation, autonomous runtime command dependencies are limited to the documented OpenCode, `git`, and operation-specific `gh` CLIs plus platform process inspection: Linux `/proc`, or Darwin `ps` and `lsof`. The workflow does not require `python3` or another undeclared scripting/helper runtime. Missing required tools or unsupported process inspection fails with bounded diagnostics rather than silently selecting an undeclared fallback.

## Package Surface

The published package exposes only the release-supported entry points declared in `package.json`:

- Package root `.` and `./server` resolve to the default-only `./src/opencode-plugin.js` server entry (`import "opencode-feature-factory"` or `import "opencode-feature-factory/server"`). Internal helpers remain available only from source modules so OpenCode cannot mistake them for plugin registrations.
- `./tui` resolves to the generated `./dist/tui.js` module (`import "opencode-feature-factory/tui"`).
- `./cli` resolves to `./src/cli.js` (`import "opencode-feature-factory/cli"`).
- The `feature-factory` bin resolves to `src/cli.js`.

`dist/` is generated during packing and included in the published files; it is not edited or committed as source.

## Release Checks

Run the package gates before publishing or handing off a release branch:

```sh
npm run test:unit
npm run smoke:pack
npm run check
```

- `npm run test:unit` runs the deterministic unit test suite.
- `npm run smoke:pack` builds the generated TUI through `prepack`, creates an npm package tarball, installs it into a fresh temporary project, and verifies the published package, bin, exports, plugin registration, and TUI import surfaces.
- `npm run check` is the release-safe aggregate gate and currently runs unit tests followed by package smoke.

Package smoke intentionally avoids launching interactive opencode. It checks deterministic package and registration surfaces only, so failures point to publish/install/export regressions rather than interactive terminal state.

### Node and CI support

The published package supports Node `>=20`. Repository tooling selects Node `24.11.1`; CI runs `npm ci` and `npm run check` on Node 22 and 24, while publication uses Node 24. Node 20 is supported by the package but is not a CI matrix version. See [CONTRIBUTING.md](https://github.com/jasoncarreira/opencode-feature-factory/blob/main/CONTRIBUTING.md) for repository setup and check details.

### Release workflow

Publication is tag-driven only. Pushing `v<package.json version>` (for package version `0.2.1`, `v0.2.1`) triggers the workflow, which checks out that pushed tag, selects Node 24, runs `npm ci`, enforces exact equality between the tag and `v${package.json.version}`, runs `npm run check`, and then runs `npm publish`. The publish job uses the `npm` environment and `id-token: write` for trusted publication.

The workflow does not publish from a branch or manual dispatch, and it does not bump the version, create or push the tag, generate a changelog, push commits, or create a GitHub Release. Operators own those preparatory actions. See [RELEASING.md](https://github.com/jasoncarreira/opencode-feature-factory/blob/main/RELEASING.md) for the repository release guide and [CHANGELOG.md](https://github.com/jasoncarreira/opencode-feature-factory/blob/main/CHANGELOG.md) for the verified release records.

## Local Diagnostics

Use doctor checks when diagnosing a developer machine or local opencode install; keep them separate from release gates because they depend on local tools, config, credentials, and repository state:

```sh
feature-factory doctor --local
feature-factory doctor --telemetry
npm run doctor:local
```

`feature-factory doctor --local` and `npm run doctor:local` run the local doctor path; the npm script is a convenience wrapper around `feature-factory doctor --local` for this checkout. `feature-factory doctor --telemetry` runs the telemetry-readiness checks described in the Doctor section without requiring a factory run.

## Use In opencode

```text
/feature APP-123 add the missing approval workflow
```

The server plugin registers `/feature`, one primary `feature-factory` agent, 12 specialized subagents, and the packaged feature skill at `assets/skills/feature/SKILL.md`. The separately importable TUI module default-exports an object with ID `opencode-feature-factory` and one `sidebar_content` slot at order `450`; importing or installing that export is not a promise that an opencode host automatically discovers or activates it.

The sidebar polls durable run state every few seconds, so runs created, updated, or cleaned up after the TUI starts appear without a restart. A restart is only needed to pick up a new plugin bundle: hosts load the sidebar from the built `dist/tui.js` at startup, so after changing TUI source rebuild it (`npm run build:tui`, also run by `prepack` during `npm run check`'s package smoke) and restart the TUI.

The TUI bundle deliberately does not bundle `solid-js` or `@opentui/solid`. They are `peerDependencies` declared as compatible ranges — the contract is module identity, not exact version equality: the sidebar must load the single copies provided by the host installation. Install the package where those modules resolve (for example `npm install <package>` inside `~/.config/opencode/`), then reference the bare package name:

```jsonc
// ~/.config/opencode/tui.json
{
  "plugin": ["opencode-feature-factory"]
}
```

The host detects the sidebar entry from `exports["./tui"]` in the package manifest; the root export is the server plugin and has no `tui()` hook, so it is never the sidebar entry. Do not reference a `file://` path into a development checkout: a checkout carries its own `node_modules`, so the sidebar's reactive graph runs on a second solid/opentui instance — it renders once and never repaints, no matter how often the poll updates its signals.

### Workflow Depth

The primary `feature-factory` agent is the only agent allowed to dispatch tasks. Specialized subagents cannot recursively delegate, which keeps the orchestration tree one level deep.

Research, planning, and review agents work inside the evidence they are handed: the researcher makes one scoped discovery pass with a bounded search/read budget and no repeated scans, and planning and review agents do not re-run broad repository discovery — they scope to the supplied research map, brief, diff, and observed evidence, and inspect only the remediation delta on reruns. This keeps depth and cost bounded and avoids re-scanning the whole repo every review round.

`feature-factory install` warns about stale recognized global definitions, including files that duplicate plugin-owned agent names, across the complete HOME, XDG, and OpenCode config-directory inventory described in Runtime Consistency. Runtime launch accepts only absent or exact sanctioned definitions and requires an OpenCode restart after reconciliation.

## Configure Plugin Options

By default, successful factory runs create ready-for-review PRs. Set plugin `prMode` to `"draft"` if this repo should keep successful PRs as drafts, or `"ready"` to make the default explicit. Per-run CLI flags such as `factory start --draft` or `factory start --ready` / `--no-draft` can override the plugin default for that run.

```jsonc
{
  "plugin": [
    ["opencode-feature-factory", { "prMode": "ready" }]
  ]
}
```

By default, agents use opencode's normal model resolution. You can override model and variant together through plugin `profiles`.

One profile for all feature-factory agents:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profile": {
          "model": "openai/gpt-5.6-sol",
          "variant": "xhigh"
        }
      }
    ]
  ]
}
```

Role-based profiles (a coarser alternative to the recommended exact-agent mapping below):

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "story": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "research": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "design": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "planning": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "builder": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "test": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "reviewer": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "security": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" }
        }
      }
    ]
  ]
}
```

Exact agent profiles take precedence over role/default/top-level profiles:

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "default": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "spec-writer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "implementation-validator": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "security-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" }
        }
      }
    ]
  ]
}
```

Supported roles: `story`, `research`, `design`, `planning`, `builder`, `test`, `reviewer`, `security`. The dedicated primary orchestrator agent, `feature-factory`, is mapped to `planning`. `security-reviewer` uses `profiles.security` when present and falls back to `profiles.reviewer` for compatibility.

Factory agents are configured with scoped non-interactive permissions (`bash`, `edit` where appropriate, `webfetch`, task delegation, and read/search tools) so `factory start --headless` cannot deadlock on opencode permission prompts. `external_directory` is explicitly denied. This permission scope applies to the factory command and factory agents, not to your global opencode sessions.

Before each `factory start`, the CLI seeds the feature skill into the target repo at `.opencode/skills/feature/SKILL.md` and `.opencode/skills/feature/SCHEMA.md`, and adds `.opencode/skills/feature/` to the repo-local `.git/info/exclude` when available. The schema is the authoritative control-plane reference for `run.json`, `factory.lock`, `heartbeat.json`, `plan/slices.json`, `evidence/*`, `reviews/*`, and `run-json.lock/`; keeping it repo-local lets agents read it without relaxing `external_directory: deny`.

Seed repair is intentionally narrow. The CLI manages only `SKILL.md` and `SCHEMA.md` in `.opencode/skills/feature/`. If `.seed-hash` is missing, empty, invalid, or `{}`, those two files are treated as absent metadata: files matching the current packaged source, their recorded seed hash, or a known previously packaged seed hash are refreshed to the current package content, while unrecognized differing content is preserved as an operator edit. Each seed pass rewrites `.seed-hash` with only the current packaged hashes for `SKILL.md` and `SCHEMA.md`; unrelated files in the skill directory are not changed or recorded.

Profile precedence is exact agent, then role, then `profiles.default`, then top-level `profile`, then opencode default. A profile may contain `model`, `variant`, or both.

### Reviewer Read-Only Guard

Reviewer-designated agents are `work-reviewer`, `implementation-validator`, and `security-reviewer`. They run with `edit: deny`, but that is not a runtime sandbox: they may still mutate through allowed `bash` or other tool paths.

Current enforcement is post-run git dirty-state detection only. After one of those agents returns, the orchestrator checks the reviewed worktree with `git -C <reviewed_worktree> status --porcelain=v1 --untracked-files=all` before accepting the result. If that status is dirty or unverifiable, the review is blocked and the reviewer output is discarded.

Limitations: this catches only git-visible changes in the reviewed worktree after the reviewer returns. It does not catch ignored files, committed or reverted changes, non-git-visible effects, or effects outside the reviewed worktree, and it does not provide OS/process sandboxing or prevention.

### Recommended Model Profile

For serious feature-factory runs, use the strongest model/effort where architectural mistakes are most expensive: planning, decomposition, review, and final validation. Builders should still run strong, but story normalization and acceptance-test writing can usually run lower.

Recommended opt-in exact-agent mapping. The package supplies no model or variant defaults, and external model availability is not guaranteed. If your provider exposes different IDs, keep the same agent/variant shape and adjust only the model strings.

Temporary OpenCode OAuth compatibility note: use Terra for `story-reader`. OpenCode currently advertises Luna, but Luna requests can fail with `Model not found gpt-5.6-luna` and retry indefinitely because the production SSE path is misconfigured. Track [anomalyco/opencode#36140](https://github.com/anomalyco/opencode/issues/36140) and reconsider Luna after the built-in OpenAI OAuth integration is fixed.

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "feature-factory": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "backend-builder": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "codebase-researcher": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "design-interpreter": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "frontend-builder": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "implementation-validator": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "security-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "spec-writer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "story-reader": { "model": "openai/gpt-5.6-terra", "variant": "low" },
          "story-writer": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "test-verifier": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "work-decomposer": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" },
          "work-reviewer": { "model": "openai/gpt-5.6-sol", "variant": "high" }
        }
      }
    ]
  ]
}
```

Canonical resolved recommendation (the package does not apply these as defaults):

| Agent | Model | Variant |
|---|---|---|
| `feature-factory` | `openai/gpt-5.6-sol` | `xhigh` |
| `backend-builder` | `openai/gpt-5.6-sol` | `high` |
| `codebase-researcher` | `openai/gpt-5.6-terra` | `high` |
| `design-interpreter` | `openai/gpt-5.6-sol` | `high` |
| `frontend-builder` | `openai/gpt-5.6-sol` | `high` |
| `implementation-validator` | `openai/gpt-5.6-sol` | `xhigh` |
| `security-reviewer` | `openai/gpt-5.6-sol` | `xhigh` |
| `spec-writer` | `openai/gpt-5.6-sol` | `xhigh` |
| `story-reader` | `openai/gpt-5.6-terra` | `low` |
| `story-writer` | `openai/gpt-5.6-sol` | `high` |
| `test-verifier` | `openai/gpt-5.6-terra` | `high` |
| `work-decomposer` | `openai/gpt-5.6-sol` | `xhigh` |
| `work-reviewer` | `openai/gpt-5.6-sol` | `high` |

Rationale:

- Planning/decomposition needs the highest reasoning budget because it determines architecture, slice boundaries, dependencies, and merge safety.
- Review/validation also needs the highest budget because it catches cross-slice correctness gaps before PR creation.
- Security review is isolated as its own profile so teams can tune adversarial review cost separately; the canonical recommendation uses `xhigh`.
- Builders benefit from high effort but can usually use a slightly cheaper model because the brief and slice spec constrain the work.
- Story reading is narrower and temporarily uses Terra/low because of the Luna OAuth compatibility issue; story writing uses Sol/high, while test verification uses Terra/high. Exact overrides are required because a role-only `story` profile cannot reproduce the two story-agent recommendations.

### Anthropic Profile

This operator-authored example uses Sonnet for implementation/research/test work and Opus for high-judgment planning, decomposition, design interpretation, review, and validation. It is not discovered provider output or an availability guarantee. Because `story-reader` and `story-writer` use different strengths in this setup, it uses exact agent overrides instead of only role keys.

Adjust model IDs to the Anthropic models available in your opencode installation.

```jsonc
{
  "plugin": [
    [
      "opencode-feature-factory",
      {
        "profiles": {
          "feature-factory": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "story-reader": { "model": "anthropic/claude-sonnet-5", "variant": "low" },
          "story-writer": { "model": "anthropic/claude-opus-4-8", "variant": "high" },
          "codebase-researcher": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "design-interpreter": { "model": "anthropic/claude-opus-4-8", "variant": "high" },
          "spec-writer": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "work-decomposer": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "backend-builder": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "frontend-builder": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "test-verifier": { "model": "anthropic/claude-sonnet-5", "variant": "medium" },
          "work-reviewer": { "model": "anthropic/claude-opus-4-8", "variant": "high" },
          "implementation-validator": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" },
          "security-reviewer": { "model": "anthropic/claude-opus-4-8", "variant": "xhigh" }
        }
      }
    ]
  ]
}
```

Resolved profile:

| Agent | Model | Variant |
|---|---|---|
| `story-reader` | Sonnet | `low` |
| `story-writer` | Opus | `high` |
| `codebase-researcher` | Sonnet | `medium` |
| `design-interpreter` | Opus | `high` |
| `feature-factory`, `spec-writer`, `work-decomposer` | Opus | `xhigh` |
| `backend-builder`, `frontend-builder` | Sonnet | `medium` |
| `test-verifier` | Sonnet | `medium` |
| `work-reviewer` | Opus | `high` |
| `implementation-validator` | Opus | `xhigh` |
| `security-reviewer` | Opus | `xhigh` |

Interactive `/feature` stores durable run state in the target repo:

```text
.opencode/factory/<run-id>/
.opencode/worktrees/<branch>/
```

## Scripted Mode

The scripted path is tracker-agnostic. Any external system can monitor the local factory state and write gate answers. The package does not know about any external queue.

Every `/feature` invocation starts with an intent gate. It classifies the request as `new-feature`, `resume`, `gate-answer`, `status`, `scripted-start`, `autonomous-start`, `pr-continuation`, or `blocked-run-continuation` before mutating state. This prevents accidental restarts and lets external drivers answer gates with the same protocol as interactive users.

Start a run through opencode:

```sh
feature-factory factory start "APP-123 add the missing approval workflow"
```

Run against a specific repo and exit at the next gate for an external driver:

```sh
feature-factory factory start --repo /path/to/repo --headless "APP-123 add the missing approval workflow"
```

Run autonomously through the factory's own reviewed gates and open a PR when safe, using the configured PR mode:

```sh
feature-factory factory start --repo /path/to/repo --autonomous "APP-123 add the missing approval workflow"
```

`factory start --dry-run` is unsupported. It is rejected before opencode launch, skill seeding, factory or worktree creation, process-state creation, detached logging, `.git/info/exclude` changes, or any other repository side effect in foreground, headless, autonomous, and detached modes. Dry-run support on commands such as `factory resume` and `factory cleanup` is command-specific and does not make start dry-run valid.

### Checked Active-Run Base Advancement

Advance one eligible ordinary active pre-PR run to a freshly observed canonical `origin/main` without resuming it:

```sh
feature-factory factory base-advance <run-id> --json
```

This automation surface is JSON-only. It requires exactly one safe bare run ID; the CLI and `advanceFactoryRunBase(runId, { cwd })` export from `opencode-feature-factory/cli` trim that primitive string exactly once and accept only the concatenation of `^[A-Za-z0-9]` and `(?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`, additionally rejecting `.`, `..`, `..` anywhere, `.lock` suffixes, path separators, explicit paths, and drive/UNC forms. `--json` may precede or follow the ID. Extra positionals and every caller-supplied repo, ref, SHA, remote, branch, worktree, force, reset, rebase, merge, outcome, or recovery option are rejected. Success exits 0 with one closed JSON document; usage and operational failures exit 1 with one closed, terminal-safe JSON error document and no raw Git diagnostics.

Eligibility is deliberately narrow and fail-closed: the selected direct-root run must be a valid ordinary `running` run with no continuation/checkpoint authority, terminal result, PR/PR fence, post-PR activity, merged or blocked slice, validator/security panel, live heartbeat/process/launch owner, pending steering boundary/action, active checked-test claim, unresolved dispatch, special-builder claim, amendment, or repair. Its integration branch and uniquely registered physical worktree must be clean, attached to the recorded branch, free of in-progress Git operations, and exactly equal to the recorded `base_commit`. Unknown, malformed, changed, unavailable, ambiguous, orphaned, or cross-bound evidence is ineligible.

The operation always acquires `run-json.lock` first and then the existing external launch fence with transient `owner_kind: base-advance`; normal resume cannot launch concurrently. While holding both, it derives all Git identity from validated durable state, freshly fetches and confirms exact `refs/heads/main` from the one canonical GitHub `origin`, requires the recorded base to be an ancestor, rechecks that target, and uses only `git merge --ff-only` in the registered integration worktree. It never resets, rebases, creates a merge commit, updates local `main` or `refs/remotes/origin/main`, recreates a worktree, or advances/rebases candidate branches and worktrees.

On a real advancement, only `run.json.base_commit` and `run.json.updated_at` may change. Every other manifest value and every artifact, plan, gate, evidence, review, sidecar, dispatch binding, candidate ref/commit/worktree/index/file, and historical baseline remain preserved. An `already-current` replay performs no manifest write or integration movement, but still performs the bounded fresh-origin observation and transient launch-fence lifecycle.

Crash recovery has three deterministic states: interruption before Git movement retries from the old eligible identity; Git advanced but manifest unbound may bind only when branch/worktree still equal the same freshly observed target and all non-Git eligibility remains unchanged; an already bound current identity replays without movement. Split, dirty, detached, moved-target, ambiguous, or otherwise unknown state fails closed without reset or repair.

This is not fresh-run initialization or rebaseline: `factory start` creates a new run on current `main` and obtains fresh planning, gates, tests, and reviews. It is also not blocked-run continuation: `factory continue` creates a new child only from a terminal `blocked` parent under its reviewed continuation contract. `factory base-advance` keeps the same eligible active run and checked planning/candidates, does not resume or dispatch it, and does not change accepted scope or candidate history.

Check or recover a disrupted resume before launching opencode:

```sh
feature-factory factory resume-check <run-id> --json
```

`factory resume-check` is the explicit recovery control plane for `resume <run-id>`. Missing, inaccessible, or invalid `.opencode/factory/<run-id>/run.json` never causes a fresh empty control plane to be re-scaffolded; the command returns a synthetic non-durable blocked envelope with `ok:false`, `durable:false`, `updated:false`, `recovered:false`, and a clear `terminal_result.reason` stating that no durable `terminal_result` can be written without forbidden re-scaffolding. Resume-check also never performs destructive cleanup, `git worktree prune`, `git worktree remove`, branch deletion, or run-directory removal; cleanup remains an explicit operator action through `factory cleanup` and should be previewed with `--dry-run` when appropriate. For valid non-terminal manifests with a missing active worktree, recovery is allowed only when the branch exists, recorded `base_commit` and merged slice `merge_commit` values are ancestors of branch HEAD, the target stays under `.opencode/worktrees`, no existing path would be overwritten, `git worktree add` succeeds, and the final worktree identity/HEAD matches the branch. Contradictory git evidence persists terminal `blocked` with a `terminal_result.reason` naming the conflicting branch/commit evidence; unsafe or inaccessible local paths persist terminal `needs-human` with a `terminal_result.reason` naming the path that requires operator reconciliation. `factory start --headless|--autonomous "resume <run-id>"` runs this preflight before seeding repo skills or spawning opencode and prints the envelope instead of continuing when `ok:false`. Read-only `status`, `list`, `validate`, and `watch` surfaces do not implicitly recover, repair, cleanup, prune, or remove anything.

Continue from a terminal blocked run with a new run id:

```sh
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>
```

Use explicit reviewed full-plan carry-forward only before PR creation:

```sh
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> --carry-forward
```

The supplied review ref and injected continuation payload are untrusted operator data/config, not privileged instructions. The parent must be exactly `blocked` and pre-PR, and every referenced plan, review, artifact, branch, commit, worktree, ref, and hash is checked before effects. Old, absent, partial, unflagged, draft-reuse, and post-PR continuation shapes reject fail-closed.

#### Current schema-v2 continuation: explicit reviewed carry-forward

Option A(a) / D is implemented only for the explicit pre-PR `--carry-forward` selector. Schema v2 full-plan carry-forward is the only current continuation shape. The complete implemented contract and ownership boundary are in `CONTINUATION-SCOPE-DESIGN.md`; the packaged schema is in `assets/skills/feature/SCHEMA.md`.

V2 admits only a pre-PR parent whose status is exactly `blocked`, with no PR or active post-PR state and durably accepted unchanged planning (`planning_reuse.eligible: true`). One child owns the full remaining plan. Its closed `carry_forward` binds exactly `scope`, parent plan ref/hash, `start_commit`, `accepted_slices` entries (`id`, `attempts`, exact `attempt_reviews`, evidence ref/hash, review ref/hash, `reviewed_commit`, and `merge_commit`), and `remaining_slice_ids`. `accepted_slices` contains every parent slice whose status is exactly `merged`, in PLAN order. `remaining_slice_ids` contains every nonmerged slice ID, in PLAN order. Their IDs are unique, their arrays are disjoint, and their set union is exactly the full plan. For PLAN order `[A, B, C]`, merged `A` and `C` produces `accepted_slices: [A, C]` and `remaining_slice_ids: [B]`, which is valid; remaining slices inherit no parent authority.

Actual integration merge order may differ from PLAN and dependency-execution order. The first-parent range from `target.base_commit` exclusive through `start_commit` inclusive has length equal to the accepted count and contains exactly once the set of accepted `merge_commit` values, with no extra commits; every commit passes its associated entry's exact B0MR merge proof. `start_commit` is the parent branch HEAD and last actual merge, or the target base when none are accepted. This does not require `accepted_slices` order to equal first-parent chain order: PLAN-ordered `accepted_slices: [A, C]` with actual first-parent chain `[C, A]` is valid. Complete parent B0MR panels at that head are optional evidence and are never inherited; every child gets a fresh final panel.

Origin-base handling is ordered: unchanged may proceed; an origin base that contains `start_commit` returns `rebaseline-required`; another moved base returns `stale-parent-base-moved`; unavailable observation fails closed. Candidate build, B1.3 allocation, staging, and the commit boundary each recheck the complete contract, including claim, branch, worktree, and closed invocation configuration.

Before schema-v2 allocation, the route contends on `refs/opencode/continuation-targets/<sha256-child-run-id>`. Its canonical create-only blob binds route schema 2, crash-stable `created_at`, and the hash of the complete continuation authority. Only exact replay may reuse it; a different schema or authority fails before child publication, claim, branch, or worktree mutation. Payload, resume, and publication consumers recheck it.

The exclusive v2 claim hashes closed parent identity as recursively lexicographic canonical UTF-8 JSON with no whitespace or trailing newline. Its literal ref is `refs/opencode/continuations/<64hex>`. A closed canonical claim blob includes the full `child_branch_ref` and contains no self ref/hash/OID. One no-replace `update-ref` transaction creates the claim ref to that blob and the child branch to `start_commit`, both with zero old OIDs; only exact same-child replay succeeds, and the worktree comes afterward. Crashes before/after commit yield neither/both refs, half-state or different-child collisions fail closed, and the permanent claim tombstone survives cleanup while allowing exact same-child recovery.

After B1.3 allocation, B1.4 stages a complete child outside run discovery, validates it, rechecks every authority immediately before one no-overwrite atomic directory publication, and only afterward creates the payload, seeds the skill, and launches. The child uses root schema 1 plus continuation schema 2, a closed persisted mode/account/PR/post-PR configuration, exact inherited planning/spec acceptance, the byte-identical full plan, PLAN-ordered immutable merged rows and authority-free pending rows, fresh gates/steering/panels, and no inherited outcomes. Fresh execution skips planning/bootstrap and starts dependency-ready remaining work; fresh test-verifier, validator, security, and whole-story pre-PR authority run only after all full-plan rows merge. Exact replay preserves progressed or terminal children and never rewrites adopted rows.

#### Slice review one-strike policy

Every slice review requires boolean `late_discovery_strike`. A consequential first-pass category discovered on attempt 2 is hash-bound as `true`, remains converging, and consumes normal attempt 3; it never creates attempt 4. Genuine implementation nonconvergence with the marker `false` may terminalize on any attempt, while every rejected final attempt must be nonconvergent. Marker-less sidecars and history are invalid current records and fail closed.

### Choosing continuation, rebaseline, or recovery

Blocked work does not always belong in `factory continue`. Choose the restart pattern from the authority that is still valid:

| Pattern | Use when | Entry point | Reused authority |
|---|---|---|---|
| **V2 carry-forward run** | An eligible pre-PR blocked parent has accepted planning and reviewed merged slices plus one complete remaining full plan. | `factory continue ... --carry-forward` | Exact accepted planning, full plan, accepted slice sidecars/merges, and the validated integration HEAD; final tests/panels/pre-PR remain fresh. |
| **Rebaseline run** | The parent base or implementation branch is stale, current `main` contains authoritative behavior that must win, or wholesale continuation would recreate superseded changes. | A new `factory start` run id on current `main`. | Old artifacts, evidence, commits, and worktrees are read-only implementation references only. |
| **Recovery run** | Useful integrated work exists, but final validation exposes multiple findings, a required scope/ownership amendment, or a foundation change forbidden by the old brief. | A new `factory start` run id on current `main`, with the complete recovery scope in the operator request. | The blocked run is read-only evidence; the new story, brief, tests, and panel establish authority. |

Use `feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> --carry-forward` only when strict schema-v2 full-plan eligibility holds. If findings are not represented by the accepted full plan, a required fix contradicts the accepted brief, or current authority is missing, abandon and re-seed a fresh run rather than introducing a narrower continuation route.

Start a current-main rebaseline with a new run id and an explicit read-only reference policy:

```sh
feature-factory factory start --autonomous --run-id <rebaseline-run-id> \
  "Rebaseline <objective> on current main. Treat <old-run-id> artifacts, worktrees, and branches as read-only references; selectively reconcile applicable changes, never merge or cherry-pick the stale branch wholesale, and rerun planning, tests, validation, and security review."
```

A rebaseline must record the fresh base, inventory current-main behavior that supersedes the old branch, assign current ownership, and produce fresh gates, decomposition, observed evidence, tests, validator/security verdicts, and PR state. Current `main` is authoritative when old tests or implementation conflict with behavior merged after the parent started.

Start a scope-expanding recovery the same way, but make the failed panel the complete new work order:

```sh
feature-factory factory start --autonomous --run-id <recovery-run-id> \
  "Recover <blocked-run-id> on current main. Preserve applicable integrated work as read-only reference, amend scope for every unresolved validator and security finding, reconcile behavior merged since the old base, and require fresh tests and a fresh final panel before one PR."
```

“Recovery run” here is an operator pattern, not a new CLI command. `factory recover <run-id>` handles an orphaned or stale run-state heartbeat and moves that existing run to human inspection; it does not rebase implementation work, amend an accepted brief, or create a replacement feature run. Likewise, `factory resume-check` repairs or validates durable resume state without changing the feature's accepted scope.

Keep superseded runs, branches, and worktrees until the replacement has captured every reference it needs. After the replacement PR is merged or the old evidence is otherwise no longer recoverable work, preview and perform explicit cleanup with `factory cleanup <old-run-id> --dry-run` followed by `factory cleanup <old-run-id>`; use `--force` only when intentionally discarding preserved unmerged branches.

Run in the background for external watchers or CI-style adapters:

```sh
feature-factory factory start --repo /path/to/repo --headless --detached "APP-123 add the missing approval workflow"
```

Detached mode returns a PID and `run_id`. A generic new detached start allocates or validates a safe available run id before launch, passes it to the workflow, writes stdout/stderr under `.opencode/factory/<run-id>/processes/<timestamp>.log`, and publishes pre-manifest `.opencode/factory/<run-id>/process.json`. An explicit `--run-id <run-id>` does not grant process-evidence authority over an existing run because run-directory, branch, and worktree collisions are rejected before spawn. Run-scoped cancellation evidence is written only for validated run-owned detached launches. If the platform inspector cannot verify the just-launched process identity, the detached launch fails closed and writes no `process.json`.

Cancel a detached run before queueing interrupt steering:

```sh
feature-factory factory cancel <run-id> --json
```

`factory cancel` is evidence-bound and fail-closed. On valid running `process.json` identity, each invocation sends at most one `SIGTERM` to the recorded PID and waits briefly to verify exit. Only verified exit changes `process.json.state` to `cancelled` and returns `ok:true`, `status:"cancelled"`, `signal:"SIGTERM"`, `process_ref:"process.json"`, `signaled:true`, and `updated:true`. If the process remains alive, the response is `ok:false`, `status:"cancel-pending"`, `signaled:true`, and `updated:true`; process state remains `running`, pending request metadata is recorded under `process.json.cancel`, and the operator may rerun cancel or stop the process manually. A rerun performs fresh fail-closed identity checks: if the exact recorded process remains live and matches the evidence, that new invocation may send one more targeted `SIGTERM`; if it has exited, the rerun confirms cancellation without signaling. Cancellation never retries automatically. This never fails open into a concurrent relaunch.

If `process.json` is missing, invalid, stale, mismatched, already non-running without a confirmable cancellation, or the signal fails, cancel returns `ok:false`, `status:"failed-closed"`, `signaled:false`, `updated:false`, and a `reason`. Failed-closed handling sends no signal, and cancellation has no broad signal, process-group signal, `pkill`, or `killall` fallback.

`factory cancel` updates only the process sidecar (`$RUN/process.json`). It is not a semantic `run.json` state transition and does not approve gates, change slices, write verdicts, or terminalize the run.

Autonomous mode is explicit opt-in. It still writes gate question files, observed evidence, reviews, and `run.json`; it records story/brief approvals only when the artifacts are complete and unambiguous, decides pre-PR from the implementation-validator/security-reviewer panel, runs bounded remediation on NO-GO, and never auto-merges. Humans review and merge PRs outside the factory.

### Remediation context reuse

During a bounded remediation loop, the orchestrator may reuse an opencode Task `task_id` only as a runtime-only, implementer-only optimization. Reuse is safe only when all of these remain unchanged from the original Task dispatch:

- Same slice-builder role: `backend-builder` or `frontend-builder`.
- Same owned remediation subject: the same slice id.
- Same slice/test worktree and same branch.
- Same live orchestrator session; `task_id` values are not portable across process restarts, `factory resume`, detached relaunches, or continuation child runs.
- Same bounded remediation loop, including the same attempt sequence and remediation owner.

Eligible reuse is limited to `backend-builder` and `frontend-builder` while that agent owns the checked slice remediation. `test-verifier` and every other role always start fresh. If any safety fact is unknown, omit `task_id` and start a fresh Task.

Checked ordinary slice-builder Tasks must run synchronously. Starting the attempt sets durable `dispatch_required`. Before dispatch, the plugin generates a random completion capability, create-publishes an immutable `dispatch/<run-slice-attempt-hash>.json` claim containing only its hash, and binds the claim ref/hash into the slice. The capability is never placed in the Task prompt or caller-controlled body; only the matching synchronous Task after-hook with exact role/prompt identity and a confirmed foreground result receives it, creates the exact capability-authenticated `.closed.json` return record with a freshly observed clean post-Task `completion_head`, and binds the closure ref/hash into the slice. Review publication requires that completion head to equal the evidence head, reviewed commit, and current slice branch/worktree HEAD. A missing, malformed, failed, promoted-background, mismatched, or unbound closure is an active/unknown outcome that blocks review publication, attempt advancement, every later dispatch for that slice, and terminal/continuation reset into another run, including after plugin restart. Review publication copies the exact claim/closure refs and hashes into that attempt's append-only history before a successor attempt may replace the current tuple. Neither sidecar contains `task_id`. Checked contexts are transported only as base64url UTF-8 JSON, preventing model-authored `@file`, `@agent`, and command-like values from becoming OpenCode prompt controls. Integration amendment, panel remediation, post-PR remediation, and integration conflict use explicit `FEATURE_FACTORY_SPECIAL_BUILDER_DISPATCH` run/route/agent markers; the plugin re-observes route-specific refs, hashes, bytes, ownership, and Git authority before injecting checked special context. Each route instance also gets a create-only durable claim and capability-authenticated foreground closure; unresolved special work fences every run mutation, terminal path, PR path, and continuation across processes. Special routes never receive `task_id` or ordinary slice-dispatch authority, and every unmarked builder Task is rejected.

OpenCode compaction does not transfer authority to the model-authored summary. The plugin exact-matches the child session's original checked prompt, revalidates the active claim, accepted plan and input hashes, slice identity, and descendant worktree identity, then re-injects the same checked context as plugin-owned system text. When an active claim has no closure and its worktree has a new clean descendant HEAD, `feature-factory factory slice-dispatch-adopt <run-id> <slice-id> <attempt> --json` may adopt that candidate for normal verification. The command accepts no caller-provided refs, hashes, token, output, session ID, call ID, or completion SHA. It derives the candidate HEAD and create-publishes `checked-slice-builder-dispatch-adoption` in the claim's exclusive `.closed.json` completion slot. Adoption intentionally attests no operator or callback provenance and grants no evidence, test, review, ownership, acceptance, or merge authority. A callback closure and candidate adoption are mutually exclusive; either record only permits the existing downstream checks to evaluate the exact completion HEAD.

A special closure requires a new clean descendant commit and remains exclusive authority until the exact route sink consumes it: amendment review publication, replacement panel publication, post-PR candidate observation, or integration-conflict merge publication. Generic writers, production heartbeat start/tick, provenance, environment, recovery, resume launch, and forced cleanup reject both active claims and closed-but-unconsumed bindings before sidecar, manifest, filesystem, or Git mutation. Completion revalidates the pre-dispatch route bytes. Every callback consumes its in-memory capability before validating the result, so a failed, mismatched, cancelled, or promoted-background callback can never be replayed as success. Panel remediation additionally derives exactly one unambiguous slice owner from the committed changed paths, requires that owner's builder stack, records `owner_slice_id`, and permits replacement reviews only at the closure's exact completion HEAD. An existing passing panel is immutable except exact verified replay. Unclaimed crash remnants fail closed instead of being adopted as builder output.

Reviewers and final panel agents must start fresh every loop. Do not pass a `task_id` to `work-reviewer`, `implementation-validator`, or `security-reviewer`; they remain read-only observers for each review/validation/security pass. Existing re-review behavior still applies: every retry passes the current `attempt` and the prior review or panel `required_fixes` list so reviewers perform the required delta review instead of reopening unchanged scope.

`task_id` is never durable factory state. Do not persist it in `run.json`, evidence records, review files, schema examples, gates, process logs intended as workflow evidence, or external tracker payloads. Persist the attempt number, evidence refs, review refs, and required fixes; keep `task_id` only in orchestrator memory for the live dispatch that may be resumed.

Monitor local state:

```sh
feature-factory factory list
feature-factory factory status <run-id> --json
feature-factory factory watch <run-id>
feature-factory factory watch --all
feature-factory factory validate <run-id>
feature-factory factory env
feature-factory factory provenance
feature-factory factory env record-created <run-id> --json
feature-factory factory env record-resume <run-id> --json
feature-factory factory cancel <run-id> --json
feature-factory factory slice-dispatch-adopt <run-id> <slice-id> <attempt> --json
feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --reason TEXT --json
feature-factory factory cost-record <run-id> --agent AGENT --step STEP --provider PROVIDER --model MODEL --input-tokens N --output-tokens N --total-tokens N --cost-total N --currency CODE --json
feature-factory factory cost-report <run-id> [--json] [--telemetry]
feature-factory factory pr-fence <run-id> --json
feature-factory factory pr-created <run-id> --fence-token TOKEN --json
```

`factory provenance` is the help-advertised compatibility alias for the diagnostic `factory env` command; neither is workflow authority.

`factory status`, `factory answer`, and `factory validate` apply code-level schema validation to `run.json`; `factory validate` also compatibility-validates `plan/slices.json` when present. `factory slices-seed <run-id> --from plan/slices.json` is run-relative, accepts no alternate path, applies fatal UTF-8 and creation-mode validation, and therefore rejects a newly seeded plan without the structured integration gate. Invalid runs appear as `invalid` in `factory list` instead of crashing the whole list.

### Cost attribution diagnostics

The factory records optional usage and cost attribution under `.opencode/factory/<run-id>/run.json` at `run.json.cost_attribution`, with `totals`, `by_agent`, and `by_slice` rollups. This block is a local current-run diagnostic surface for operators. It is not billing authority: do not use it as an invoice source, quota ledger, cross-run financial record, or chargeback contract.

Write cost attribution only through the CLI so the run-json lock, validation, and rollups stay consistent:

```sh
feature-factory factory cost-record <run-id> \
  --agent implementation-validator \
  --step implementation-validator \
  --provider openai \
  --model openai/gpt-5.6-sol \
  --input-tokens 12000 \
  --output-tokens 900 \
  --total-tokens 12900 \
  --cost-total 1.23 \
  --currency USD \
  --json
```

Semantics:

- Persist provider-supplied usage/cost metadata only. The factory must not use pricing tables, pricing APIs, local price estimates, currency conversion, or missing-to-zero coercion.
- `available` means provider, model, usage, `cost_total`, and `cost_currency` are present.
- `partial` means some usage/cost data is present but provider/model/usage/cost_total/cost_currency is incomplete; missing fields stay missing and are listed in `missing`.
- `unavailable` means the provider exposed no usage or cost data. It does not mean zero cost.
- `factory status <run-id> --json`, `factory list`, `factory watch`, and the TUI expose a cost summary (`status`, entry/agent/slice counts, token fields when supplied, `cost_total`/`cost_currency` when supplied, mixed-currency and missing-field indicators).

Read the complete current-run attribution as a report without changing factory state:

```sh
feature-factory factory cost-report <run-id>
feature-factory factory cost-report <run-id> --json
feature-factory factory cost-report <run-id> --telemetry [--json]
```

The default mode is a human-readable terminal report. `--json` emits the stable report-v1 response (`schema_version: 1`) for scripts. Both modes contain run totals and `by_agent`, `by_step`, and `by_slice` rollups, plus top-level `entry_count`, `request_count`, `agent_count`, `step_count`, `slice_count`, and `unattributed_step_entry_count`. Request count is one per persisted entry; it does not deduplicate `request_id`. Entries whose `step` is missing, `null`, empty, or whitespace-only are excluded from `by_step`, counted by `unattributed_step_entry_count`, and never placed in a synthetic group.

Every report view is recomputed at read time exclusively from `run.json.cost_attribution.entries`. Persisted attribution `status`, `totals`, `by_agent`, and `by_slice` caches are ignored, and `by_step` and report totals are never persisted. Exact, untrimmed, unsanitized nonblank agent, step, and slice strings remain distinct raw JSON map keys, including `__proto__`. Human output uses quoted, injective terminal-safe labels: printable ASCII remains readable with quote/backslash escaping, and every other UTF-16 code unit is encoded as uppercase `\uXXXX`. Display encoding never changes or merges the raw JSON identities.

Report rollups preserve the attribution contract. Empty data is `unavailable`, never zero; a validator-accepted `partial` entry with no usage or cost numeric fields remains `partial` and contributes no fabricated number. An explicit `null` in any usage or cost numeric field is treated as absence and omitted, not coerced to zero; an explicit numeric `0` remains present. `available`, `partial`, `unavailable`, `missing`, entry counts, and request counts use the existing rollup semantics.

Mixed currencies make the affected rollup `partial`, set `mixed_currency: true`, add `mixed_currency` to `missing`, and suppress both `cost_total` and `cost_currency`. Component fields such as `cost_input`, `cost_output`, `cost_cache_creation`, and `cost_cache_read` may remain separately summed for compatibility, but they are not normalized monetary totals. Consumers must not reconstruct a combined total from those components.

`factory cost-report` is a strictly local, read-only diagnostic, not billing authority. It does not mutate `run.json` or any factory file, persist derived output, acquire or wait for `run-json.lock`, require heartbeat state or accepted attestations, inspect pricing tables/APIs, price or estimate costs, convert currencies, coerce missing values, normalize provider metadata, or make network calls. It is not an invoice, quota, chargeback, finance-control, or cross-run accounting surface.

`--telemetry` opts in only for that report invocation. When valid inherited trace context exists, the response may append `telemetry.trace_id` and `telemetry.parent_span_id`; without the flag, ambient context is ignored and output is unchanged. This metadata correlates the report invocation only. It is not proof that any attribution entry, agent, step, slice, provider request, or aggregate came from that trace/span. It does not create a span, enable an exporter, persist context, or cause network traffic.

Orchestrators should record available provider usage with `factory cost-record` after the long waits for `spec-writer`, `work-reviewer`, `work-decomposer`, builders, `test-verifier`, `implementation-validator`, `security-reviewer`, and remediation. Because these waits usually run under heartbeat, stop heartbeat or verify it inactive first, then record cost attribution before terminal writes or `factory pr-created`.

Clean up terminal runs after their PRs are merged or their artifacts are no longer needed:

```sh
feature-factory factory cleanup <run-id> --dry-run
feature-factory factory cleanup <run-id>
```

Cleanup removes `.opencode/factory/<run-id>`, recorded worktrees under `.opencode/worktrees/`, and recorded local branches. For a run with `run.json`, it only runs for terminal statuses (`completed`, `blocked`, `partial`, or `needs-human`) unless `--force` is supplied. One narrow pre-manifest exception handles a detached launch that is known dead before writing `run.json`: a run directory containing process evidence may be removed only when that evidence validates and records a non-`running` state. Running evidence is refused with an instruction to cancel first, and malformed, unreadable, or mismatched evidence fails closed — liveness cannot be established, so removal requires verifying the process is dead and rerunning with `--force`. Cleanup refuses to remove run directories outside `.opencode/factory`. Unmerged branches are preserved unless `--force` is supplied. Use `--dry-run` first when you want to preview what would be removed.

When a compatible opencode host loads the separate TUI export on a session route, its observational `Feature Factory` panel reads runs under `.opencode/factory/*/run.json` in the current session directory or nested repos below it. It refreshes data every 5 seconds, caches root discovery for 30 seconds, scans at most 2,000 directories, and displays at most three run rows. When no runs exist, `No factory runs yet` keeps the panel mounted so runs started later appear during the same TUI session; an initially nonexistent cached factory root is rescanned as soon as it appears rather than waiting for the 30-second root-cache TTL. It lists active runs across those repos, including status, mode, pending gate, slice progress, validation/security verdicts, PR URL, terminal reason, and branch. Completed runs are hidden once healthy, with two exceptions: the most recent completed run stays listed, and any completed run still carrying a non-ok diagnostic remains listed until its diagnostics clear — so more than one completed run can appear at once. Restart or reload the TUI after plugin bundle changes. Package installation alone does not prove that a host discovers or automatically activates this export.

### Conservative repository cleanup sweep

Repository-wide cleanup is an explicit two-step operation. First preview the selected repository's direct `.opencode/factory/` entries without changing cleanup targets:

```sh
feature-factory factory cleanup --all --dry-run [--repo PATH] [--json]
```

The preview emits a repository- and evidence-bound digest plus an exact confirmation command. Execute only by copying that digest into the second form:

```sh
feature-factory factory cleanup --all --digest ff-cleanup-v1.<repository-sha256>.<envelope-sha256> [--repo PATH] [--json]
```

The sweep never accepts a positional run id, `--force`, or unrelated options. It deletes only runs whose status is exactly `completed` and whose current evidence positively proves all cleanup conditions: canonical PR metadata resolves to the exact merged or closed PR; every recorded local branch is contained in a freshly fetched trustworthy PR base at the current head of the canonical base branch; every recorded worktree and branch has safe containment and exact identity; and no active factory ownership, fresh heartbeat, identity-matching live process, run-state lock, shared target, or contradictory evidence remains. Open or unavailable PRs, unmerged or unprovable branches, malformed state, pre-manifest entries, unsafe paths, and any filesystem, Git, GitHub, lock, heartbeat, process, or sidecar uncertainty are skipped rather than deleted.

Execution first recomputes the complete digest and refuses a foreign or stale digest before attempting any candidate. It then acquires each candidate's run-state lock without reclaiming a contested lock and repeats the complete eligibility check while holding that lock. Evidence that changed during lock-held revalidation is skipped. The sweep never takes over a lock, force-deletes a branch, repairs a run, or broadens the recorded cleanup targets.

Human and JSON reports deterministically list every candidate with stable reason codes and aggregate `eligible`, `protected`, `skipped`, `deleted`, and `failed` counts. Preview exits 0 even when entries are protected, skipped, or fail inspection. Refused digests and report-level failures exit 1. Execution continues with independent candidates after a cleanup failure, then exits 1 if any candidate's cleanup was actually attempted and failed; ordinary fail-closed skips do not make execution fail.

Partial cleanup failures report the exact retained resources. The run directory is retained whenever an earlier worktree or branch operation fails, so operators can inspect and recover remaining artifacts rather than losing the control plane.

Runs in `blocked`, `partial`, or `needs-human` status are protected recoverable work and are never automatically deleted. Review their report reasons and handle them manually with the documented continuation, rebaseline, recovery, cancel, or single-run cleanup workflow. Use single-run `--force` only as an intentional manual decision after preserving any unique work; the repository sweep itself never uses force.

For autonomous runs, external adapters should read `run.json.terminal_result` or `factory status <run-id> --json` after the run exits. Terminal statuses are `completed`, `blocked`, `partial`, and `needs-human`; successful PR creation records `pr_url` only through the `pr-created` transition.

### Repository-wide conservative cleanup

Preview eligible completed runs in the selected repository without modifying cleanup targets:

```sh
feature-factory factory cleanup --all --dry-run --repo /path/to/repo
feature-factory factory cleanup --all --dry-run --repo /path/to/repo --json
```

The preview reports every immediate entry under that repository's physical `.opencode/factory/` root as `eligible`, `protected`, `skipped`, or `failed`, with stable reason codes and aggregate eligible, protected, skipped, deleted, and failed counts. It emits a repository-and-candidate-set digest and an exact confirmation command. Execute only by supplying that digest:

```sh
feature-factory factory cleanup --all --digest ff-cleanup-v1.<repository-sha256>.<envelope-sha256> --repo /path/to/repo
```

Sweep flags may appear in any order, but `--all` must appear exactly once and must select exactly one mode: `--dry-run` once for preview or `--digest VALUE` once for execution. `--repo PATH` and `--json` are each optional once. Sweep cleanup accepts no run ID, `--force`, repeated flag, unrelated option, short option, `--flag=value`, or `--` separator. A digest has exactly two 64-character lowercase hexadecimal components. Grammar errors produce one terminal-safe `error:` line on stderr, no report on stdout, and perform no repository inspection.

Sweep cleanup is deliberately stricter than single-run cleanup. A run is eligible only when its status is exactly `completed`, its canonical recorded GitHub PR is currently merged or closed, every recorded branch is proven contained in a freshly fetched PR base at the current head of the canonical base branch, every worktree and branch passes containment and identity checks, and no active ownership, fresh heartbeat, live identity-matching process, run lock, shared target, or contradictory evidence remains. Missing, malformed, inaccessible, stale, foreign, or otherwise unprovable evidence skips deletion; `--force` is not supported with `--all`.

Execution first resolves `--repo` to its physical identity and recomputes the complete digest. The exact physical root, device/inode identity, Git common-directory identity, and object format bind authorization; display text never does. A digest from another repository is refused as `DIGEST_FOREIGN`; changed candidate evidence is refused as `DIGEST_STALE`. Both refusals preserve the recomputed unattempted candidates and counts, provide no confirmation action, and require a fresh preview. After a matching digest, each eligible candidate is locked without lock takeover and fully revalidated immediately before mutation. Changed or contested candidates are skipped. Deletion delegates to the existing identity-checked single-run target semantics, uses no branch force deletion, retains the run directory after a partial target failure, and continues processing independent candidates.

Human diagnostics apply sensitive-value projection and terminal-safe encoding, so a displayed repository or candidate value may be `[redacted]` and is never authorization input. Preview `confirmation.argv` nevertheless retains the exact authorized physical root. When that root is sensitive-looking or terminal-hostile, the human `shell_command` uses a deterministic ASCII-only POSIX `/bin/sh` octal variable with a sentinel so even trailing newlines round-trip without exposing the path literally. JSON is the exact normalized machine report with transport escaping only: repository identity, evidence, authorization, and confirmation values are not semantically redacted. Execute, refused, and failed reports always have null confirmation.

Human and JSON execution reports distinguish deleted, protected, skipped, inspection-failed, and attempted-cleanup-failed outcomes. Preview, completed execution, refusal, attempted cleanup failure, and report-level failure each emit one complete selected report on stdout with empty stderr; grammar rejection is the only sweep outcome written to stderr instead. Ordinary protected and fail-closed skipped outcomes do not make execution fail. Any attempted-cleanup failure makes the final command exit nonzero after independent candidates finish. Report-level failures expose no usable digest or confirmation but preserve completed candidate outcomes when discovery or mutation had already begun. Runs in `blocked`, `partial`, or `needs-human` are protected recoverable work and are never automatically deleted: inspect their report reasons, recover or preserve any needed artifacts manually, then use the existing single-run cleanup command only when an operator intentionally decides how to handle that work.

### Prepare isolated GitHub CLI account directories

Before an account-bound factory run, prepare its GitHub CLI directory once. `ACCOUNT` must use the exact spelling persisted in `run.json.github_account`; that spelling selects `join(homedir(), ".config", "opencode-feature-factory", "gh", ACCOUNT)` and is case-sensitive. This is the sole supported preparation procedure:

```sh
ACCOUNT='your-exact-github-login'
CONFIG_DIR="$(
  node -e '
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    const account = process.argv[1];
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(account)) process.exit(2);
    process.stdout.write(join(homedir(), ".config", "opencode-feature-factory", "gh", account));
  ' "$ACCOUNT"
)" || exit 1

mkdir -p "$CONFIG_DIR"

env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  GH_CONFIG_DIR="$CONFIG_DIR" GH_HOST=github.com \
  gh auth login --hostname github.com --git-protocol https --web

ACTUAL="$(
  env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
    GH_CONFIG_DIR="$CONFIG_DIR" GH_HOST=github.com GH_PROMPT_DISABLED=1 GH_PAGER=cat PAGER=cat \
    gh api user --jq .login
)" || exit 1

test "$ACTUAL" = "$ACCOUNT" || exit 1
printf 'verified isolated GitHub CLI configuration for %s\n' "$ACCOUNT"
unset ACTUAL CONFIG_DIR ACCOUNT
```

The browser login and exact comparison verify the isolated directory without copying or printing a token. Repeat once per account. Do not enable shell tracing (`set -x`), use `--with-token`, engage in copying or pasting tokens, or permit redirecting authentication-detail output while preparing or verifying the directory.

Factory execution never provisions these directories, logs in, copies credentials, or falls back to global configuration. Each account-bound child copies the parent environment, removes every case-insensitive spelling of `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN`, removes inherited case variants of the controlled GitHub host/configuration keys, and sets the derived `GH_CONFIG_DIR` plus `GH_HOST=github.com`, `GH_PROMPT_DISABLED=1`, `GH_PAGER=cat`, and `PAGER=cat`. It does not mutate the parent/operator environment or `process.env`. Missing, invalid, absent, or unusable prepared account state fails through the operation's existing classified/reconciliation path. There is no XDG, APPDATA, platform-root, inherited `GH_CONFIG_DIR`, or case-normalization fallback.

### Environment snapshots and PR recording

The factory records diagnostic environment snapshots explicitly:

```sh
feature-factory factory env record-created <run-id> --json
feature-factory factory env record-resume <run-id> --json
```

These commands update `run.json.debug_snapshot.created_with`, `last_resumed_with`, and `resume_count` using redacted diagnostic-only snapshots. Each new snapshot includes the effective PATH CLI `cli_identity` closed to `source`, `version`, and `hash`. It is never provenance or authority for gates, reviews, merges, PRs, or later launches. The commands must not persist raw token-shaped or high-entropy credentials such as `ghp_*`, `github_pat_*`, `gho_*`, `sk-proj_*`, `sk-*`, or `xoxb_*`.

After the final steering drain/checkpoint, Gate 3 approval, and final push, establish the checked fence before creating the external PR:

```sh
RUN_ID='your-run-id'
CONFIG_DIR="$(
  node -e '
    const { readFileSync } = require("node:fs");
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    const run = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const account = run.github_account;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(account)) process.exit(2);
    const tokens = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
    if (Object.keys(process.env).some((key) => tokens.has(key.toUpperCase()) && key !== key.toUpperCase())) process.exit(3);
    process.stdout.write(join(homedir(), ".config", "opencode-feature-factory", "gh", account));
  ' ".opencode/factory/$RUN_ID/run.json"
)" || exit 1
test -n "$CONFIG_DIR" || exit 1

feature-factory factory pr-fence <run-id> --json
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  GH_CONFIG_DIR="$CONFIG_DIR" GH_HOST=github.com GH_PROMPT_DISABLED=1 GH_PAGER=cat PAGER=cat \
  gh pr create ...
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  GH_CONFIG_DIR="$CONFIG_DIR" GH_HOST=github.com GH_PROMPT_DISABLED=1 GH_PAGER=cat PAGER=cat \
  gh pr view <url>
unset CONFIG_DIR RUN_ID
```

The fence response supplies `fence.token`; the durable fence supplies `{operation_id,repository,head_ref,head_sha,base_ref,base_sha,draft}` all-or-none. `operation_id` is `ffpr-v1-` plus lowercase SHA-256 of canonical UTF-8 JSON `{"base_commit":...,"branch":...,"created_at":...,"repository":...,"run_id":...}` in lexical key order. Append exactly one standalone `<!-- opencode-feature-factory:pr-operation=<operation_id> -->` line to the external PR body. Fence creation rechecks canonical PR readiness under the run lock and blocks new steering and every other `run.json` writer so the checked state cannot churn between external creation and reconciliation.

```sh
feature-factory factory pr-created <run-id> --fence-token TOKEN --json
```

`factory pr-created` rejects a missing, mismatched, or stale fence, rejects caller PR metadata, and accepts only the run ID and exact fence token. Through the persisted GitHub account it performs a bounded, account-scoped, token-stripped, shell-free `GET repos/{repository}/pulls?state=all&head={owner}:{head_ref}&base={base_ref}&per_page=100`, following only valid Link pagination for at most 10 pages. A unique exact open PR records the universal operation/node/head/base tuple and either completes or starts enabled post-PR observation; a unique exact merged PR completes without polling. Closed-unmerged becomes `needs-human`; absent, ambiguous, malformed, foreign/repeated/incomplete pagination, adapter failure, or other unknown observation retains the fence and does not claim completion.

Only complete checked absence permits `feature-factory factory pr-fence <run-id> --clear --fence-token TOKEN --json`; a caller assertion that creation failed is not authority. After an external PR exists, never clear the fence: keep the token and reconcile that PR with `factory pr-created`. Every present fence must carry the complete current `{operation_id,repository,head_ref,head_sha,base_ref,base_sha,draft}` identity tuple; zero or partial identity rejects validation and requires re-seeding.

The ready/draft choice comes only from persisted `run.json.pr_mode` at fence establishment. `factory pr-created` has no `--draft`, URL, number, repository, node-ID, or SHA override.

## Heartbeat helper and monitoring

The orchestrator has an internal heartbeat helper for long `Task` and builder/reviewer/test waits:

```sh
feature-factory factory heartbeat <run-id> --status --json
```

Operational semantics:

- Start heartbeat immediately before a long `Task` wait begins with `feature-factory factory heartbeat <run-id> --start --phase <phase> --json`. During that wait, the helper writes `$RUN/heartbeat.json` and advances `run.json.heartbeat_at` under the shared `run-json.lock/` lock.
- `heartbeat.json` contains `{ schema_version, run_id, phase, pid, interval_ms, last_tick_at }`. Treat it as liveness-only data, not authority. External watchers should not infer workflow ownership or write authority from PID/sidecar contents.
- Freshness is derived at read time: `age(last_tick_at) <= max(2 * interval_ms, 120000ms)` and the recorded PID is alive.
- Heartbeat starts only while the manifest already shows real in-flight factory work through a `running` step or a `running`/`review` slice.
- Heartbeat is intentionally absent while the factory is paused at the `story`, `brief`, or `pre_pr` gates; external monitors should read `run.json.gates` for those waits.
- Stop heartbeat in a `finally`/after-return path with `feature-factory factory heartbeat <run-id> --stop --json`. Stop is best-effort; semantic writes are serialized by the run-json lock, not heartbeat state.
- External watchers should treat `heartbeat.json` as liveness only and use `factory status <run-id> --json` / `terminal_result` for durable workflow meaning.

Long-wait heartbeat guard for operators and maintainers:

1. Mark in-flight state first when heartbeat requires it, so `run.json` already shows a `running` step, `running` slice, or `review` slice.
2. Start heartbeat immediately before long `Task`/subagent dispatch/wait; never after the dispatch has already begun.
3. Stop heartbeat in the after-return/`finally` path.
4. Do not perform the next semantic `run.json` / factory CLI state write while the long-wait heartbeat remains active; stop heartbeat or verify inactive first.

Use these phase labels by convention: `spec-review`, `decomposition-review`, `builder-wave`, `slice-review`, `test-verifier`, `test-rerun`, `test-review`, `implementation-validator`, `security-reviewer`, `remediation`, `post-pr-observation`, `post-pr-remediation`, and `post-pr-revalidation`. `spec-review` brackets both the `spec-writer` Task dispatch/wait and the following `work-reviewer` wait; `decomposition-review` brackets both the `work-decomposer` Task dispatch/wait and the following `work-reviewer` wait. Post-PR phases bracket GitHub checks/review observation, routed remediation, and panel/local revalidation waits respectively. Each long wait uses its own heartbeat start immediately before dispatch/wait and stop in the after-return/`finally` path before the next semantic `run.json` / factory CLI state write. Protected gates `story`, `brief`, and `pre_pr` stay heartbeat-free. The phase is opaque/non-enforced by validation beyond being non-empty; heartbeat remains liveness-only and not authority.

Cost attribution is one of the semantic writes that must wait until heartbeat is stopped or verified inactive. Record `factory cost-record` entries after each provider-backed long wait and before terminal-result writes or `factory pr-created`.

## Detached run diagnostics

`factory status`, `factory list`, `factory validate`, `factory watch`, and the TUI expose detached-run diagnostics as output-only observations. Diagnostics do not change `run.json`, `heartbeat.json`, or gate schemas.

Diagnostic envelopes use this shape:

```json
{
  "schema_version": 1,
  "checked_at": "2026-07-08T00:00:00.000Z",
  "authoritative": true,
  "status": "ok",
  "severity": "info",
  "classification": "healthy",
  "summary": "No diagnostics",
  "items": [
    {
      "condition": "stale-heartbeat",
      "classification": "recoverable",
      "severity": "warning",
      "status": "warning",
      "message": "Heartbeat has not advanced within the stale threshold.",
      "action": "Inspect the run log and validate durable state before resuming; do not restart blindly.",
      "authoritative": false,
      "checked_at": "2026-07-08T00:00:00.000Z",
      "evidence": { "source": "heartbeat.json", "liveness_only": true }
    }
  ]
}
```

Condition enum: `stale-heartbeat`, `missing-heartbeat-process`, `missing-worktree`, `invalid-run-state`, `newer-schema`, `protected-gate`, `terminal-run`. Classification enum: `healthy`, `recoverable`, `blocked`, `needs-human`, `terminal`, `invalid`; `invalid` is first-class and must not be collapsed into `blocked`. Status enum: `ok`, `warning`, `error`. Severity enum: `info`, `warning`, `error`, `critical`.

When multiple diagnostic items are present, the top-level `classification`, `status`, `severity`, and `summary` come from one primary item using this priority order: classification `invalid` > `blocked` > `needs-human` > `recoverable` > `terminal` > `healthy`; severity `critical` > `error` > `warning` > `info`; status `error` > `warning` > `ok`; condition `invalid-run-state` > `newer-schema` > `missing-worktree` > `missing-heartbeat-process` > `stale-heartbeat` > `protected-gate` > `terminal-run`; then original detection order.

Operator-facing condition mapping:

| Condition | Classification / status / severity | Operator action |
|---|---|---|
| `stale-heartbeat` | `recoverable` / `warning` / `warning` | Inspect logs and validate durable state before resuming; do not restart blindly. |
| `missing-heartbeat-process` | `recoverable` / `warning` / `warning` | Treat as heartbeat-helper liveness only; inspect logs/state before deciding recovery. |
| `missing-worktree` | `blocked` / `error` / `error` | Restore the worktree or clean up/recover from durable state. |
| `invalid-run-state` | `invalid` / `error` / `critical` | Treat `run.json` or required sidecars as untrusted until schema/JSON validation passes. |
| `newer-schema` | `invalid` / `error` / `critical` | `run.json` failed validation with unknown keys only, every other constraint passing: the record was written by a newer schema than this reader. Still fail-closed and workflow-blocking for this reader; read it with a build that recognizes the schema. |
| `protected-gate` | `needs-human` / `warning` / `warning` | Answer the pending protected gate (`story`, `brief`, or `pre_pr`) or stop the run. |
| `terminal-run` | `completed`/`partial` => `terminal` / `ok` / `info`; `blocked` => `blocked` / `error` / `error`; `needs-human` => `needs-human` / `warning` / `warning` | Read `terminal_result`; no heartbeat/worktree liveness action is required for valid terminal runs. |

Heartbeat and PID evidence is liveness-only, never authority. `missing-heartbeat-process` refers to the heartbeat helper PID recorded in `heartbeat.json`, not a detached opencode process; there is no durable run-id-to-opencode-PID registry. PID checks are race-prone and may be affected by PID reuse, so diagnostic items from heartbeat/process evidence carry `authoritative: false` and `evidence.liveness_only: true`.

Heartbeat diagnostics are emitted only while `run.json` shows heartbeat-bracketed in-flight work: a `running` step, `running` slice, or `review` slice. Idle/bootstrap runs, blocked steps, protected gates, and valid terminal states suppress stale-heartbeat and missing-heartbeat-process alarms because no heartbeat helper should be active for those states.

Diagnostics are fail-closed for invalid local state. `diagnostics.authoritative` is true only when `run.json` schema validation and required sidecars pass. Heartbeat data, PID liveness, process existence, worktree strings, status booleans, and mutable `run.json` claims are not enough to infer a healthy run.

Answer gates by writing the same files an interactive user would approve through chat:

```sh
feature-factory factory answer <run-id> story approve
feature-factory factory answer <run-id> brief "changes: split frontend and backend slices"
feature-factory factory answer <run-id> pre_pr stop
```

The factory writes:

- `.opencode/factory/<run-id>/run.json`
- `.opencode/factory/<run-id>/gates/<gate>.question.md`
- artifacts, plan, evidence, review files, and gate `pending_snapshot` state

External drivers write only:

```text
.opencode/factory/<run-id>/gates/<gate>.answer
```

Allowed answers:

```text
approve
changes: <specific requested change>
stop
```

After writing an answer, resume by invoking `/feature resume <run-id>` or:

```sh
feature-factory factory start --repo /path/to/repo --headless "resume <run-id>"
```

External driver loop:

1. Start with `factory start --repo <repo> --headless "<prompt or resume>"`.
2. Read `.opencode/factory/<run-id>/gates/<gate>.question.md`.
3. Decide externally.
4. Write the answer with `factory answer`.
5. Resume with `factory start --headless "resume <run-id>"`.

This lets end users run the workflow interactively from opencode, while automated systems can monitor and drive it without the factory depending on any one tracker.

Use `--run-id <run-id>` on new starts when an external driver needs a predictable factory directory name:

```sh
feature-factory factory start --repo <repo> --run-id issue-123 --headless "<work order>"
```

`--run-id` is validated as a bare safe factory run id, rejected for `resume <run-id>` starts, and passed as `driver.run_id` for new-run bootstrap only.

Thin autonomous adapter loop:

1. Claim external work.
2. Check out the repo.
3. Run `feature-factory factory start --repo <repo> --run-id <run-id> --autonomous "<work order>"`.
4. Read `run.json.terminal_result`.
5. Mirror `status`, `pr_url`, and `reason` back to the external system.

## Doctor

`feature-factory doctor` checks the local opencode/plugin environment before a long run:

```sh
feature-factory doctor --local
feature-factory doctor --local --profiles
feature-factory doctor --local --provider-smoke
feature-factory doctor --telemetry
```

It checks the effective PATH CLI source/version/hash, OpenCode run support, plugin registration, command/agent/skill registration, the complete global-definition inventory and unsupported config overrides, the supported primary-allow/subagent-deny Task policy, provider auth visibility, `HOME`, `git`, `gh`, base branch detection, and whether `.opencode/factory/` / `.opencode/worktrees/` are gitignored. Stale definitions are an actionable `missing` result, while exact packaged/sanctioned definitions or absence are healthy.

`--provider-smoke` is accepted by the CLI but omitted from the current help text. It runs a real `opencode run` in the selected working directory, with a 30-second default timeout, once per distinct resolved model string—not once per provider or agent. These calls can consume quota or incur cost. A success is point-in-time evidence that invocation and authentication worked for that model; it is not a deterministic release check and does not guarantee future credentials, model availability, capacity, or provider service.

### Telemetry readiness and trace propagation

Telemetry is off by default. The factory has no default exporter, no default network side effects, and no durable telemetry state; local `run.json`, gates, evidence, reviews, and transition checks remain the workflow contract. Enable telemetry explicitly with plugin option `telemetry.enabled: true` or `FEATURE_FACTORY_OTEL_ENABLED=true`, and initialize an OpenTelemetry SDK/exporter through native opencode, a companion plugin, or operator runtime setup.

Honeycomb / native OTel setup uses standard OTLP environment variables and opencode's native switch:

```sh
FEATURE_FACTORY_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=${HONEYCOMB_API_KEY},x-honeycomb-dataset=feature-factory
OTEL_RESOURCE_ATTRIBUTES=service.name=feature-factory,deployment.environment=dev
```

```jsonc
{
  "experimental": { "openTelemetry": true },
  "plugin": [
    ["opencode-feature-factory", { "telemetry": { "enabled": true, "mode": "native-opencode" } }]
  ]
}
```

`feature-factory doctor --telemetry` reports these readiness categories:

- native opencode `experimental.openTelemetry` status and whether native AI SDK spans are expected;
- OTLP endpoint readiness from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`;
- sanitized OTLP header presence from `OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS`, showing only header names and replacing values with `[redacted]`;
- service/resource readiness from `OTEL_SERVICE_NAME` or `service.name` in `OTEL_RESOURCE_ATTRIBUTES`;
- companion telemetry plugin presence, such as `@devtheops/opencode-plugin-otel`;
- package instrumentation loadability for `@opentelemetry/api`, proving the package is loadable and exports `trace`, `context`, and `SpanStatusCode` without requiring an SDK/exporter;
- feature-factory telemetry enablement source (`plugin.telemetry.enabled`, `FEATURE_FACTORY_OTEL_ENABLED`, or default-off);
- content-capture risk and redaction status.

Sanitized OTLP env behavior is diagnostic-only: `doctor --telemetry` never prints OTLP header values or credential-bearing endpoint URLs. Header values such as Honeycomb API keys are reported as present and redacted; token-shaped values (`ghp_*`, `github_pat_*`, `sk-*`, bearer/JWT/AWS-shaped strings, credential-bearing URLs, and high-entropy secrets) are scrubbed before display.

Native opencode/AI SDK telemetry may capture prompts, completions, tool arguments, or tool results outside feature-factory's redaction path. `doctor --telemetry` warns when native opencode OTel is enabled or when feature-factory content-capture flags (`captureMessages`, `captureToolArguments`, `captureToolResults`, `captureReviews`, or `captureEvidence`) are enabled. Production telemetry should use upstream prompt/output suppression, an OpenTelemetry Collector redaction processor, a trusted non-production telemetry environment, or feature-factory-only metadata spans.

The launch commands accept trace-context flags for runtime correlation:

```sh
feature-factory factory start --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 --tracestate vendor=value "APP-123 add workflow"
feature-factory factory start --parent-span-id 00f067aa0ba902b7 "APP-123 add workflow"
feature-factory factory resume <run-id> --traceparent <w3c-traceparent> --tracestate <w3c-tracestate>
feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> --parent-span-id <16-hex-span-id>
```

Runtime env mapping preserves operator-provided OTel env and adds trace context only when supplied: `--traceparent` sets `TRACEPARENT` and `FEATURE_FACTORY_TRACEPARENT`; `--tracestate` sets `TRACESTATE` and `FEATURE_FACTORY_TRACESTATE`; `--parent-span-id` or the span id inside `--traceparent` sets `FEATURE_FACTORY_PARENT_SPAN_ID`. If both `--parent-span-id` and `--traceparent` are supplied, the parent span ids must match. These values are non-authoritative runtime launch metadata, not instructions, not persisted in `run.json`, and not used to approve gates, reviews, PRs, or terminal state.

## Slice Execution Model

The factory decomposes an approved technical brief into a dependency DAG:

```text
.opencode/factory/<run-id>/plan/slices.json
```

Each slice records `id`, `stack`, `paths`, `depends_on`, `acceptance`, and `test_plan`.

The orchestrator computes waves from `depends_on`:

- A slice can run when all dependencies are `merged`.
- A root slice is wave 1, and the longest dependency path may span at most four waves (prefer three or fewer for a shorter critical path).
- Same-wave slices must be file-disjoint.
- Shared hotspots are serialized into later waves.
- Up to `max_parallel_slices` run concurrently within a wave; this does not relax the depth cap.
- Each slice carries one dominant hard concern (per-slice width budget); a fourth wave is used to keep slices within that budget, not to grow the critical path arbitrarily. When the width budget cannot be met within four waves, decomposition returns `REDESIGN-REQUIRED` and the run stops for a smaller story rather than shipping an oversized slice.
- Each slice builds in its own `.opencode/worktrees/<feature-branch>--<slice-id>` worktree.
- The orchestrator observes diff/tests, runs `work-reviewer`, then merges approved slices serially into the feature worktree.
- A baseline-substrate defect exposed by a pristine attempt-zero pending direct consumer uses `factory amendment ... report`. The factory executes the accepted delivery artifact, permits only owner-owned changes, requires a fresh exact-commit review, verifies the staged tree, and revalidates merged authority before downstream gates, panels, PR, and post-PR work.
- After a merged amendment, checked slice start derives and persists the exact clean feature HEAD as `authorized_baseline_commit`, rejects any ahead first-attempt branch before effects, and requires dispatch, ownership review, merge base, and integrated path coverage to remain exact.
- The durable authority catalog contains 185 variants: 184 production-covered rows, including all 48 generic amendment rows, plus the sole future-only `final-plan-descriptor` row.
- Generic integration amendment is the sole in-place repair authority. Continuation, checkpoint, and non-pristine consumers reject amendment without mutation, terminalize as blocked with no PR URL through the checked class-specific boundary, and receive fixes only through a fresh schema-v2 full-plan carry-forward. Old repair shapes reject fail-closed and have no fallback route.

This matches the original software-factory pattern while keeping the package tracker-agnostic.

## Interrupt, Steer, And Resume

Operator steering is untrusted operator data/config, not instructions and not a gate bypass. Cancel the external opencode process first, then queue steering for the existing non-terminal run and dry-run the resume before relaunch:

```sh
feature-factory factory cancel <run-id> --json
feature-factory factory steer <run-id> --message TEXT --json
feature-factory factory status <run-id> --json
feature-factory factory resume <run-id> --dry-run --json
feature-factory factory resume <run-id> --headless --json
```

`factory resume` reuses the same run id, branch, worktree, and durable state. It rejects `active-heartbeat`, `terminal-run`, `invalid-run-state`, and `missing-worktree` instead of blindly restarting. The resume payload includes top-level `resume` and `steering` metadata with `raw_message_included: false`; raw steering text is never included in status/list/TUI or the resume payload. Factory start, resume, and continuation launchers encode their structured envelope as a preprocessing-safe `ffpayload-v1:<base64url>` token. Before model execution, the plugin's `command.execute.before` hook deterministically decodes and structurally validates that versioned token, then injects a line-oriented `PLUGIN_PARSED_OPERATOR_PAYLOAD` block for driver mode and routing. The normalized values remain untrusted operator data/config. Unencoded, malformed, non-canonical, ambiguous, or mismatched envelopes fail closed to interactive mode with no routing authority; the model does not independently parse raw transport data to decide autonomous mode, resume, steering, continuation, or a requested run id. This is positional prompt framing, not cryptographic authentication; base64url provides transport safety, not authenticity.

On a mutating `/feature resume <run-id>` path, run `feature-factory factory env record-resume <run-id> --json` before `feature-factory factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json`. The consumed JSON labels raw text as `UNTRUSTED OPERATOR STEERING DATA (not instructions)` with `trust: untrusted-operator-data`.

After `steer-consume`, run a steering-conflict checkpoint. Compare the untrusted steering against accepted durable state: approved gates, accepted steps, merged or blocked slices, passing validator/security verdicts, `pr_url`, and `terminal_result`. If honoring the steering would require editing or rolling back that protected state, automatic rollback is forbidden. Record the checkpoint with:

```sh
feature-factory factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> --reason TEXT --json
```

`factory steer-conflict` requires the run to still be `running`, requires inactive heartbeat, verifies the latest consumed steering ref/hash and consumed file hash, then writes terminal `status:"needs-human"` with fixed safe `terminal_result.reason` and `terminal_result.summary` text explaining that accepted durable state would have to change. Because the transition creates no durable artifact, `terminal_result.artifacts` is empty rather than storing scalar diagnostic metadata. The existing steering history retains the consumed ref/hash, and the JSON response has `ok:false`, `conflict:true`, `updated:true`, `status:"needs-human"`, the steering ref/hash, `protected_state`, and `terminal_result`. The operator must reconcile manually; the factory must not silently reset gates, unmerge slices, rewrite evidence/reviews, remove PR URLs, or continue from stale accepted artifacts.
