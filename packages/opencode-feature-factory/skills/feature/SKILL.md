---
name: feature
description: >
  Software-factory orchestrator. Drives a feature from idea or ticket through a chain of focused
  agents — research, story, design, spec, decompose, parallel build, test, validate — pausing at
  three approval gates and ending in a draft PR. State is durable (a per-run manifest on disk,
  written only by the `factory` CLI), evidence is observed rather than trusted from agent prose,
  high-risk steps are reviewed, and independent slices build in parallel. The compatibility shorthand
  remains `/feature [--autonomous | --headless] [--base <branch>] [--max-retries <n>] <ticket key | feature idea>`.
  The complete foreground intake is
  `/feature [--autonomous | --headless] [--base <branch>] [--max-retries <n>] <ticket key | issue reference | feature idea>`; use
  `/feature --background [--autonomous | --headless] [--base <branch>] [--max-retries <n>] <request>` for a dedicated host session.
---

# /feature — OpenCode adapter

`factory init` stages the canonical workflow at the `workflow` path in its own response, inside the run
directory. This adapter therefore runs in a fixed order, and nothing may be reordered:

1. **Admission** — the mode, base, retry and placement rules below.
2. **Repository resolver intake** — derive `O`, read and validate `$O/.factory.json`, execute a declared
   `resolve`, and bind `R`. This step necessarily reads that file and executes commands before `init`;
   those reads and executions are the step itself and are not covered by the restriction in 4.
3. **`factory init`**, which stages the canonical workflow and returns its path as `workflow`.
4. **Read that staged file completely**, before any state read, dispatch, gate, or `factory` command other
   than `init` itself.

Steps 1 and 2 are specified here, in full, because the document that specifies everything else does not
exist until step 3. Everything after `init` is specified there. Do not read `WORKFLOW.md` next to this file: it lives outside the workspace, `external_directory` is
denied for every agent, and a run that depends on that read fails on a permission refusal rather than on
anything about the work. If the staged file is absent or unreadable, stop without effects. That bundled file is an exact build-time copy of the factory-owned canonical workflow; it is authoritative for Steps 0–7, gates, evidence, repository lifecycle, and every
durable transition. This skill is authoritative only for OpenCode invocation admission, session
placement, named-agent registration, background routing, and gate-answer delivery. If the two files
appear inconsistent, stop without effects rather than improvising.

Before resolver or configuration work, state reads, dispatch, or any factory effect, require the CLI path
named in your instructions to be readable, and invoke only that path. Never resolve `factory` from PATH and
never fetch it with `npx`, `npm exec`, `pnpm dlx`, or `bunx`; a fetched CLI can be a different generation
with its own state store. If it is not readable, stop without effects.

You are the active **run driver**: either the primary `feature-factory` agent driving a foreground
`/feature` request or the bounded `run-orchestrator` driving one run in its dedicated background host
session. OpenCode registers the exact eleven specialists named by `WORKFLOW.md`; dispatch only those
targets, await their results, and follow the workflow's observe-don't-trust boundary. OpenCode exports
the real owning session as `FACTORY_SESSION_ID`; use it as the workflow's required stable `SESSION_ID`
and never synthesize a fallback.

## Mode and base admission

Before any intake action, run-id allocation, config effect, state read, tool call, or `factory` command,
process the raw invocation arguments as follows.

First apply placement admission. Ignore leading whitespace only while locating the first token. Consume
at most one exact, case-sensitive first token `--background` and exactly one following separator; keep
the remaining inner request bytes unchanged. If it has no following request, return exactly
`missing /feature request after --background; no session or run created.` Assignment, case, punctuation,
and later variants are request content. OpenCode otherwise preserves foreground placement.

After placement, scan the maximal leading option prefix. It may contain exact case-sensitive
`--autonomous` and `--headless` tokens and at most one exact two-token `--base <value>` pair in any
order. Consume only those option spans and separators. The first other token ends the prefix; preserve
the suffix beginning there byte-for-byte for ticket detection, story or design content, resolver input,
and run-id derivation. `--base=x`, case or punctuation variants, and `--base` after the first request
token are request content.

The same prefix may contain at most one exact two-token `--max-retries <n>` pair in any order with mode
and base options. Consume its span and separator under the same suffix-preservation rule.

Recognize retry only as the exact standalone case-sensitive token `--max-retries`. Assignment forms,
case or punctuation variants, and `--max-retries` after the first request token are request content.
Preserve `--max-retries=3`, `--MAX-RETRIES 3`, `--max-retries! 3`, and `request --max-retries 3` as request bytes.

A prefix `--base` without a value returns exactly `missing value for --base; no run created.` A second
prefix occurrence returns exactly `repeated --base; no run created.` Both refusals precede all effects.
Duplicate copies of one mode remain idempotent. Both distinct modes return exactly
`conflicting mode flags: --autonomous and --headless; choose one`. A prefix containing only admitted
mode/base options reaches the existing placement-specific missing-request refusal. A prefix with an
admitted retry option but no request reaches that same missing-request refusal before numeric validation.

A prefix `--max-retries` without a value returns exactly `missing value for --max-retries; no run created.`
A second prefix pair returns exactly `repeated --max-retries; no run created.` Structural refusals precede
numeric validation, so repetition wins even when the first retry value is invalid. All retry refusals
precede run-id allocation, config effects, context lookup, state reads, tool calls, and factory invocation.

After structural and missing-request checks, accept a retry value only when its complete token matches
ASCII `[0-9]+` and its numeric value is from 1 through 9007199254740991 inclusive. Accept `1`, `003`, and
`9007199254740991`; reject `0`, `000`, `-1`, `+1`, `1.0`, `1e2`, embedded whitespace, non-ASCII digits,
and `9007199254740992`. An invalid value returns exactly
`--max-retries must be a positive integer; no run created.`

For a consumed base, validate the exact value with `git check-ref-format --branch <value>` and require
`git show-ref --verify --quiet refs/heads/<value>` in the canonical local operator repository to exit
exactly zero. Perform both proofs before run-id allocation, config effects, context lookup, state reads,
tool calls, or factory invocation. Refuse invalid syntax, an absent exact local ref, or an observation
failure without creating a run. Pass the unchanged value only as `factory init --pr-base <value>`; for
no-base input, omit `--pr-base` without changing the preserved request suffix or other effects.

Pass a supplied retry token unchanged only as `factory init --max-retries <n>`; when retry is absent,
omit the complete `--max-retries` argv pair. A new manifest persists the supplied numeric value as
`run.json.max_retries`, so forwarded `003` persists as `3`.

For a new manifest, `--autonomous` maps only to `factory init --mode autonomous`, `--headless` maps only
to `factory init --mode headless`, and no admitted mode omits `--mode`. An existing manifest always
resumes its immutable persisted mode, base, and retry budget. Invocation options never reinitialize or
mutate it.

## Repository resolver intake, before any run-id allocation

Everything from here to the next `##` heading is the canonical pre-init section, restated verbatim: the
derivation of the operator repository root `O`, the repository command configuration and its validation,
the configured resolver path, and the absence rule. It is duplicated because a run cannot read the
canonical workflow until `factory init` has staged it, and all of this must be executed before `init` —
including deriving `O`, without which there is no path to `$O/.factory.json` and no cwd for `resolve`. The
staged workflow stays authoritative; if the two appear inconsistent, stop without effects.

A test binds this copy to the canonical text as one whole region rather than as selected sentences, so no
clause can be dropped or reworded on either side without failing. Execute it as step 2 of the order at the
top of this file: after admission, and before run-id allocation, manifest or state reads, specialist
dispatch, and every `factory` command including `init`. Its own reads of `$O/.factory.json` and its own
command executions are exempt, because they are what this step is.

Preserve the admitted request bytes for story content and adapter forwarding. Make a separate
derivation copy and trim only its leading and trailing whitespace for classification. Capture the
invocation checkout, resolve its Git top level, and then resolve that physically; the result is `O`:

```sh
INVOCATION_CHECKOUT="$PWD"
O="$(cd "$(git -C "$INVOCATION_CHECKOUT" rev-parse --show-toplevel)" && pwd -P)"
```

Require an absolute, nonempty `O`. Every host adapter and run driver uses the following same
configured-or-absent policy before canonical run selection, manifest or state reads, sandbox creation,
any `factory` command, placement dispatch, or specialist dispatch.

### Repository command configuration

The optional repository-owned file is `$O/.factory.json`:

```json
{
  "resolve": "<non-empty shell command>",
  "verify": "<non-empty shell command>",
  "publish": "<non-empty shell command>",
  "pr_draft": true,
  "verify_timeout_ms": 900000,
  "bootstrap": "<non-empty shell command>",
  "bootstrap_timeout_ms": 900000
}
```

The root must be a JSON object with the three required own properties `resolve`, `verify`, and `publish`,
plus only the optional own properties `pr_draft`, `verify_timeout_ms`, `bootstrap`, and
`bootstrap_timeout_ms`. `resolve`, `verify`, `publish`, and `bootstrap` are command strings; every present
command must be non-empty. There is no `publishing_identity` key: the account a run publishes as is a
property of the environment it runs in, not of the repository, and a tracked file cannot hold two values
for one repository published from both a maintainer's checkout and an automated host. A file carrying that
key is malformed, because the optional set above is closed. `pr_draft` must be a JSON boolean
when present and defaults to `true` when absent. Both timeout values must be positive
safe integers when present, and `bootstrap_timeout_ms` is valid only with a declared `bootstrap`.
`verify_timeout_ms` and `bootstrap_timeout_ms` each independently default to `900000` milliseconds;
neither timeout shares or consumes the other's budget.

Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `pr_draft`; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries.

Do not use the obsolete summary “Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries.” because it omits the earlier `pr_draft` check.

`pr_draft` is a known key, and an invalid value outranks every timeout defect and missing required entry.
The two bootstrap keys are known keys. Invalid `bootstrap` outranks missing required entries and every
timeout defect, including an invalid or otherwise orphaned bootstrap timeout. An orphaned
`bootstrap_timeout_ms` outranks its own invalid shape, and a valid bootstrap with an invalid timeout
names only `bootstrap_timeout_ms`. Validate this order before executing `resolve`.
The publishing identity is not read from this file and not resolved by the driver. `factory init` resolves
it in code -- `--publishing-identity <account>` when passed, otherwise the inherited
`FACTORY_PUBLISHING_IDENTITY` -- and refuses when neither supplies at least one character, creating no
sandbox and no run. It records the resolved value immutably in `run.json`, and `status --json` reports it
as `publishing_identity`. Bind `DECLARED_PUBLISHING_IDENTITY` from that reported value exactly as
reported, without trimming, normalizing, case-folding, or reserializing it, and never re-resolve it from
the environment, a file, or anything else.
Do not tighten the existing non-whitespace validation to the observed-login grammar: `init` requires only
that the value contain at least one character, and a declared account name that the observed-login grammar
would reject is still a legitimate declaration to compare against.
Never pass `--publishing-identity` from this workflow. The driver has no source for the value -- that is
the point of resolving it in the CLI -- so the flag would be constructed from an unbound shell variable,
expand to an empty argument, and be indistinguishable from an operator supplying one. `init` reads the
inherited environment itself. The flag exists for an explicit human or scripted invocation that has a value
to state.
Because init refuses without one, every run created at or after 0.8.0 carries a nonempty value; a manifest
written earlier may report `null`, which is the only case that skips the publishing-identity guards.
Never derive this value from `gh`, the token, stored authentication, or Git configuration: an expectation
read from the credential being checked would always match, and the guard would stop guarding.
Credential values must not appear in the file; command strings may refer only to credentials supplied
through inherited environment-variable names.

An absent `$O/.factory.json` means no resolver is declared, per the absence rule below. It says nothing
about the publishing identity, which comes from `init` rather than from this file, so a repository with no
config file still carries a recorded identity and still runs every publishing-identity guard. If the path is present but malformed, do not execute any entry
and refuse exactly:

> invalid factory config: .factory.json; no session or run created.

The named config refusals are exactly:

> invalid factory config: .factory.json entry 'pr_draft' must be a boolean; no session or run created.
>
> invalid factory config: .factory.json entry 'bootstrap' must be a non-empty string; no session or run created.
>
> invalid factory config: .factory.json entry 'bootstrap_timeout_ms' requires a declared bootstrap command; no session or run created.
>
> invalid factory config: .factory.json entry 'bootstrap_timeout_ms' must be a positive integer; no session or run created.
>
> invalid factory config: .factory.json entry 'verify_timeout_ms' must be a positive integer; no session or run created.

This refusal stops under the same effect-free boundary as every configured resolver refusal below.

#### Configured resolver path

With a valid present file, execute `resolve` before issue, ticket, design, or free-text classification.
Submit the configured string unchanged as one ordinary shell step, with exact cwd `O`, the inherited
environment plus `FACTORY_INPUT`, and no positional argument or structured stdin. `FACTORY_INPUT` is
the exact admitted request remainder after mode-prefix removal, preserving its whitespace and bytes.

Interpret the ordinary shell result directly:

1. Exit zero with exactly zero stdout bytes means the resolver did not recognize an issue reference.
   Continue existing ticket, design, and free-text derivation from the original admitted request. Do
   not use the compatibility issue resolver and do not dispatch `story-reader`.
2. Exit zero with non-empty stdout means stdout itself is `ISSUE_PAYLOAD`. It must be one JSON object
   with a canonical top-level string `run_id`, a non-empty string `title`, and a string `body` (a body
   may be empty; a title may not) alongside any other repository issue fields:
   ```json
   {
     "run_id": "205",
     "title": "Issue title",
     "body": "Issue body",
     "url": "https://tracker.example/issues/205"
   }
   ```
   Validate `run_id`, `title`, and `body` — presence and type — before binding `R` or dispatching
   anything, without extracting, wrapping, reserializing, normalizing, or otherwise changing the
   payload. A payload missing `title` or `body`, or carrying either at the wrong type, is malformed and
   refuses below; it must not reach `story-reader` to be discovered as missing fields there. Give the exact same stdout bytes unchanged to `story-reader` as
   `ISSUE_PAYLOAD` and untrusted supplied normalization input; the specialist performs no external
   lookup.
3. An observed non-zero exit refuses exactly:

   > factory config entry 'resolve' failed for reference <reference> with exit status <status>; no session or run created.

4. A failure with no observable numeric status refuses exactly:

   > factory config entry 'resolve' failed for reference <reference>; exit status unavailable; no session or run created.

The configured `run_id` must match `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`. A digit-only value must be
positive decimal without leading zeroes. Bind `R` exactly to that value; through existing Step 0
behavior it becomes the adapter run ID, expected-ID comparison value, manifest candidate name,
sandbox name, and default feature-branch suffix. Non-empty stdout that is not a single JSON object,
lacks the canonical top-level `run_id`, or contains an invalid `run_id` refuses exactly:

> factory config entry 'resolve' returned malformed payload for reference <reference>; no session or run created.

These refusals stop before canonical run selection, placement dispatch, manifest or state reads,
sandbox creation, every `factory` command, or specialist dispatch. They never continue through the ticket, `story-reader`, or
`story-writer` paths. `<reference>` is `FACTORY_INPUT` exactly as admitted, truncated to its
first 200 characters — the operator's own input, which is why naming it discloses nothing. Never print,
quote, reproduce, log, or persist the configured command string, an expanded or resolved command line,
credentials, or shell/tool diagnostics. A refusal contains only the exact entry name, the reference, and
the status classification above; without the reference an operator resolving several references cannot
tell which one failed. Successful non-empty resolver stdout is the required payload and remains
unchanged.

#### Absence means no repository resolver

An absent `$O/.factory.json` means this repository declares no resolver. Do not recognize, fetch, or
resolve a reference: continue existing ticket, design, and free-text derivation from the original
admitted request, exactly as for a declared resolver that exited zero with empty stdout. There is no
built-in tracker grammar and no built-in fetch command anywhere in this skill.

Reference intake exists only where a repository declares it. A repository that wants `205`, `#205`, or a
tracker URL to select a run declares a `resolve` command recognizing those forms and returning the
payload above. Recognition belongs to the declaration for the same reason fetching does: deciding that a
bare integer is a reference, rather than a feature description, is repository-specific.

This repository declares its own in `.factory.json`, so `205`, `#205`, and the canonical issue URL still
select run `205` — through that declaration rather than through anything built in.

## Operating modes

Exact leading invocation flags choose a mode only for fresh initialization. Once a manifest exists,
its immutable persisted `run.json.mode` controls gate handling on that invocation and every later
resume; invocation flags do not select resumed behavior:

- **interactive** — the foreground `/feature` driver persists and presents each gate, then waits for
  `approve` / `changes: <...>` / `stop`; a background driver instead performs the verified park below,
  releases its lock, and ends its turn without deciding the gate.
- **headless** — a gate that requires a human records `needs-human` and stops.
- **autonomous** — gates may be decided without a human only under the preconditions below.

## Background dispatch and the run-orchestrator

For admitted background input, the primary derives the canonical run ID through the shared Step 0
policy before any background tool call. It then invokes the single registered `feature_background` tool
with `operation: "start"`, that canonical `runId`, and the unchanged inner `request`. It does not read or
initialize a manifest, create a sandbox or worktree, run a `factory` command, claim a lock, dispatch a
specialist, or drive a stage. The tool uses only its plugin-provided authenticated client and captured
scope; the primary and the run-orchestrator never construct a URL, port, credential, raw session call,
process, or alternate orchestration layer.

The deterministic association title is
`feature-factory:<runId>@<base64url(UTF-8 captured worktree)>`. Exact title equality in the captured
directory's complete host-session list is the only association. A start that finds one or more matching
sessions reports them and creates or prompts none. With no match, the tool creates one titled session
and admits the unchanged request asynchronously to `run-orchestrator`. A successful admission means
only that the host accepted the prompt; it does not prove execution or completion. The primary returns
immediately so its conversation remains usable. Do not persist placement, session association, tool
uncertainty, or any new manifest key or state file.

The dedicated background session receives a bounded control part followed by the unchanged inner
request produced by outer admission as a separate text part.
The `run-orchestrator` applies only the inner maximal mode/base/retry-prefix
admission and shared derivation before its first `factory` command. It never repeats outer background
placement admission on the forwarded inner request, so an inner second `--background` remains request
content. It requires the derived result to equal the expected canonical run ID in the control part. A
mismatch stops without manifest, lock, or CLI mutation. Only this background session initializes or
resumes the run, uses its own real `FACTORY_SESSION_ID`, owns every state-changing `factory` command,
dispatches specialists, observes its builders, and drives Steps 0 through 7.

The only specialized task targets a run driver may dispatch are exactly:

For the OpenCode background driver, the host’s flat task allow makes the task tool available but does
not enforce the target names below. The list and its exclusions are prompt/skill policy.

- `story-reader`
- `story-writer`
- `codebase-researcher`
- `design-interpreter`
- `spec-writer`
- `work-decomposer`
- `work-reviewer`
- `test-verifier`
- `implementation-validator`
- `backend-builder`
- `frontend-builder`

A `run-orchestrator` must not dispatch itself, `feature-factory`, another `run-orchestrator`, or an
arbitrary project-owned agent. It accepts one admitted request, loads and follows this skill, and drives
exactly one run. It selects or resumes only the deterministic existing sandbox path defined in Step 0
and never creates a different worktree, clone, isolation directory, replacement run, or orchestration
layer. It reads durable state only through
`factory status "$R" --json --repo "$RUN_REPO"`, claims through Step 0, and continues solely from
`status.next` or `nextAction`. It never hand-writes `run.json`.

Persisted mode determines what each driver may do:

| Persisted mode | Foreground driver | Background run-orchestrator | Background gate answer |
|---|---|---|---|
| `interactive` | Persist and present the pending gate, then wait for a real human | Perform the verified park below, release its lock, and end the turn | Route only to the associated same session after an explicit human response |
| `headless` | Preserve terminal `needs-human` | Terminalize `needs-human`; never masquerade as an interactive parked gate | Refused |
| `autonomous` | Decide only when the existing preconditions authorize it | Decide under the same rules and continue through draft PR and mandatory Step 7 | Refused |

An inability to ask a human never promotes interactive or headless to autonomous. When a headless run
reaches a human gate, terminalize with reason exactly `headless run reached a human gate`:

```sh
factory terminal "$R" needs-human --reason "headless run reached a human gate" --repo "$RUN_REPO"
```

Verify qualified status durably reports `terminal:needs-human` and that exact terminal reason, retain
the selected sandbox and repository, and stop.

The gate artifact map is exact:

| Gate | Name | Run-relative artifact |
|---|---|---|
| Story | `story` | `artifacts/story.md` |
| Brief | `brief` | `artifacts/technical-brief.md` |
| Pre-PR | `pre_pr` | `gates/pre_pr.md` |

Those references are run-relative and stored verbatim, so a run-relative reference `X` is physically
`$RUN_REPO/.factory/$R/X`. Create and read artifacts there; pass only the run-relative reference.

For an interactive background session, an orderly pending-gate park is complete only after all of
these actions:

1. Await every in-flight specialized task call and stop heartbeat calls, including awaiting one already
   in flight.
2. Select `ARTIFACT` from the exact map and directly verify that it exists at
   `$RUN_REPO/.factory/$R/$ARTIFACT`. Before Pre-PR, refresh
   `.factory/$R/gates/pre_pr.md` as required by Gate 3 and verify it exists.
3. Persist the named gate as pending with the existing qualified command and `--artifact "$ARTIFACT"`.
4. Directly verify the artifact still exists, the manifest records that gate as `pending` with exactly
   `ARTIFACT`, and qualified status reports the named gate pending.
5. Release only that background session's lock exactly as:
   `factory lock "$R" release --session "$SESSION_ID" --repo "$RUN_REPO"`.
6. Re-run qualified status and verify the lock is no longer held by that session.

Only then end the background turn with this successful park contract:

```text
Run: <R>
Run repository: <RUN_REPO>
Outcome: parked-pending-gate
Gate: <GATE>
Artifact: <run-relative ARTIFACT>
Status: pending
```

If release fails or qualified status still reports that session's lock, do not claim success or park.
Return `Outcome: retained-lock-error`, the same run, repository, gate, and artifact, `Status: pending`,
`Lock: retained`, and the actual error. Crash recovery remains outside this flow.

### Answering a parked gate in the same session

A primary `feature-factory` interaction routes a background answer only from one of these sources:

1. Explicit form `<canonical-run-id> approve`, `<canonical-run-id> stop`, or
   `<canonical-run-id> changes: <verbatim feedback>`. The first token is the canonical run ID and all
   remaining bytes are the one decision.
2. A bare decision when the current conversation contains exactly one prior background-tool result
   identifying one run ID in captured scope. That result supplies lookup identity only and is not proof
   that the admitted prompt executed.

Explicit form takes precedence. Accept exactly one decision: `approve`, `stop`, or the exact lowercase
prefix `changes: ` followed by non-whitespace feedback. Preserve changes feedback verbatim. Reject an
invalid decision before the tool with exactly
`invalid gate answer: expected exactly approve, changes: <feedback>, or stop; no run changed.` Bare
input with zero or multiple contextual run IDs returns exactly
`cannot route gate answer: provide one canonical run id or use a conversation with exactly one prior background tool result.`
Ordinary foreground gate handling remains unchanged when no background target is selected.

Invoke `feature_background` with `operation: "answer"`, the run ID, and only the unchanged `decision`.
The tool finds the exact titled session in captured scope and sends that same session one asynchronous
text part containing only the decision. Never add the run ID, gate, repository, explanation, delivery
metadata, or a second part. Zero matches means the run is not backgrounded; multiple matches are
ambiguous. Neither case falls back to local gate mutation or another session.

When the same background session receives the answer, it must have parked that run in an earlier turn.
Before mutation, reselect the original `R` and `RUN_REPO`, run qualified status, and verify a nonterminal
run in persisted `interactive` mode with exactly one pending gate and no conflicting lock. Claim with
the same real `FACTORY_SESSION_ID`, then repeat the qualified status verification. Do not steal a lock
for answer ingress. Refuse an early answer, a mismatched run or repository, no or multiple pending gates,
a terminal run, a non-pending gate, or answer injection into headless or autonomous mode. If refusal
follows a claim, release that same session, verify the unlock, and return without a gate mutation.

Map the one human response only through these existing transitions:

- `approve` runs `factory gate "$R" "$GATE" approved --repo "$RUN_REPO"`.
- `changes: <feedback>` keeps the feedback verbatim in task context, adds no run key, runs
  `factory gate "$R" "$GATE" changes --repo "$RUN_REPO"`, follows
  `changes-at-gate:<name>`, revises only the affected stage, and re-presents it pending.
- `stop` runs `factory gate "$R" "$GATE" stop --repo "$RUN_REPO"`, requires qualified status
  `next: stopped-at-gate:<GATE>`, awaits in-flight work, stops and awaits heartbeat calls, releases the
  same session with the exact qualified release command, and verifies the run is unlocked. Return the
  run, repository, `Outcome: stopped-at-gate`, gate, and `Status: stop`. This is an unlocked
  nonterminal stop: do not terminalize it, initialize a replacement, or invite another resume.
  If release fails, return the retained-lock-error contract instead.

For `approve` and `changes`, re-read qualified status and resume solely from `status.next`. Never
initialize a replacement or repeat completed stages except the intentional changes loop. Continue until
the next interactive gate parks through the same verified sequence or the run reaches its existing
terminal/completed path.

Gate answers never use delivery, steer, queue, wait, or a starter-conversation dependency. Never treat
`admittedSeq`, prompt response data, or title existence as proof that execution occurred. A returned or
thrown unknown list, create, or `prompt_async` outcome is reported verbatim through the tool's unknown
result and stops that operation. Do not automatically retry, re-list, create, prompt, or recover it.
Closure uncertainty is not durable: plugin reload performs no client call and proves nothing. Only a
later explicit human request starts a new checked operation. A later start first title-deduplicates a
possibly successful create; title lookup still cannot prove a prompt ran. A later answer rechecks the
persisted pending gate and mode before mutation.

Terminal reporting follows persisted state. Headless retains its selected sandbox and exact
`needs-human` result. Autonomous continues only while the existing gate preconditions hold, then uses
the existing draft-PR flow and mandatory Step 7 handoff. Interactive `stop` retains the selected run
repository without terminalizing. Blocked, partial, and needs-human runs report their selected sandbox
status and repository. After completed sandbox archive/removal, query and report the canonical
post-completion repository selected by Step 7, never the stale sandbox. Report only existing status,
terminal result, and PR URL; add no durable fields.
