---
name: feature
description: >
  Software-factory orchestrator. Drives a feature from idea or ticket through a chain of focused
  agents — research, story, design, spec, decompose, parallel build, test, validate — pausing at
  three approval gates and ending in a draft PR. State is durable (a per-run manifest on disk,
  written only by the `factory` CLI), evidence is observed rather than trusted from agent prose,
  high-risk steps are reviewed, and independent slices build in parallel. The compatibility shorthand
  remains `/feature [--autonomous | --headless] <ticket key | feature idea>`.
  The complete foreground intake is
  `/feature [--autonomous | --headless] <ticket key | issue reference | feature idea>`; use
  `/feature --background [--autonomous | --headless] <request>` for a dedicated host session.
---

# /feature — OpenCode adapter

Before any intake, state read, tool call, client call, or `factory` command, read `WORKFLOW.md` located
next to this file completely. That bundled file is an exact build-time copy of the factory-owned canonical workflow; it is authoritative for Steps 0–7, gates, evidence, repository lifecycle, and every
durable transition. This skill is authoritative only for OpenCode invocation admission, session
placement, named-agent registration, background routing, and gate-answer delivery. If the two files
appear inconsistent, stop without effects rather than improvising.

You are the active **run driver**: either the primary `feature-factory` agent driving a foreground
`/feature` request or the bounded `run-orchestrator` driving one run in its dedicated background host
session. OpenCode registers the exact eleven specialists named by `WORKFLOW.md`; dispatch only those
targets, await their results, and follow the workflow's observe-don't-trust boundary. OpenCode exports
the real owning session as `FACTORY_SESSION_ID`; use it as the workflow's required stable `SESSION_ID`
and never synthesize a fallback.

## Mode admission

Before any intake action, including ticket, story, or design detection, branch intent, run-id
derivation, manifest or state reads, and every `factory` command, process the raw invocation arguments
as follows:

First apply placement admission. Ignore leading whitespace only while locating the first token. If that
token is not exactly and case-sensitively `--background`, preserve the entire invocation as foreground
input. A later token, a mode token before it, casing or punctuation variants, assignment forms, and
near misses are ordinary foreground request content. If the first token is `--background`, it is the
outer selector. An exact terminal `--background` with no separator, or one followed only by whitespace,
returns exactly `missing /feature request after --background; no session or run created.` before run-id
derivation and every tool, client, state, or CLI effect. Otherwise require a following whitespace
separator, consume the leading syntax, the selector, and exactly one separator character, and preserve
every remaining code unit as the inner request. `--background` is placement, never a mode, and a second
selector is inner request content.

Apply the following mode-prefix algorithm to the foreground input or to a copy of the unchanged inner
request. Trimming for missing-request classification and run-id derivation never changes bytes forwarded
to a background session:

1. Ignore leading whitespace. The **mode prefix** is the maximal consecutive sequence of
   whitespace-delimited tokens that are exactly and case-sensitively `--autonomous` or `--headless`.
   The first other token ends the prefix.
2. If both distinct flags occur in that prefix, in either order, return exactly:
   `conflicting mode flags: --autonomous and --headless; choose one`. Return immediately, before any
   intake, run-id derivation, state read, or CLI action. Never fall back to interactive or another
   mode.
3. Otherwise remove every token in the recognized prefix and its separating whitespace. Use only the
   unchanged remainder for ticket detection, story content, design detection, branch intent, and
   run-id derivation.
4. Apply exactly one mapping for a new manifest:
   - `--autonomous` maps only to `factory init --mode autonomous`.
   - `--headless` maps only to `factory init --mode headless`.
   - With no recognized leading mode token, omit `--mode`; existing `factory init` records
     `interactive`.

Those three compatibility phrases name init command stems, not runnable invocations. The selected
fresh-run invocation is fully qualified in Step 0 and ends with `--repo "$RUN_REPO"`.

Repeated copies of one recognized flag are idempotent: remove them all and select that mode once. An
exact mode token after the first other token is request content and neither selects nor conflicts.
Natural-language intent, `--interactive`, capitalization variants, abbreviations, assignment or
punctuation forms, quoted lookalikes, and near misses are request content, not selectors. Do not add a
generic malformed-option rejection.

After successful nonconflicting admission, reject an empty, whitespace-only, or mode-only foreground
remainder with exactly `missing /feature request; no run created.` Reject the corresponding background
remainder with exactly `missing /feature request after --background; no session or run created.` These
rejections and a mode conflict precede run-id derivation and every tool, client, state, or CLI action.

After successful nonconflicting admission, an existing manifest always resumes its immutable persisted
mode. Invocation flags never reinitialize, compare, or mutate an existing run's mode.

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
The `run-orchestrator` applies only the inner maximal mode-prefix
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

For an interactive background session, an orderly pending-gate park is complete only after all of
these actions:

1. Await every in-flight specialized task call and stop heartbeat calls, including awaiting one already
   in flight.
2. Select `ARTIFACT` from the exact map and directly verify that it exists. Before Pre-PR, refresh
   `gates/pre_pr.md` as required by Gate 3 and verify it exists.
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
