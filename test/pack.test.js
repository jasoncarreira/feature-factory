// What actually ships.
//
// A workspace-level release check rather than either package's unit test, because it is about
// tarballs and the two are only meaningful together. It lives here so `npm test` runs it and neither
// package's suite has to know how the other is published.
//
// It exists because three release blockers in one review round were invisible to 99 passing tests:
// the opencode package's `files` omitted `observe/`, which both entrypoints import, so installing it
// failed outright; and the factory package's `files` omitted `agents/`, so a consumer could not run
// the chain its README documents. The predecessor had a pack smoke test that would have caught
// exactly that, and deleting it in the same change that broke the manifests is what let them through.
//
// **Runtime checks use a real `npm install` of the local tarballs.** An earlier version extracted
// them instead, justified in a comment by the claim that installing unpublished packages would go to
// the registry and fail. That claim was never tested and is false — npm resolves
// `feature-factory@0.1.0` from the sibling tarball on the same command line, writes the dependency,
// and creates the `.bin/factory` shim. Extraction is kept only for the file inventory, where no
// resolution is involved and an install would just be slower.
//
// Installing rather than extracting is what makes two contracts testable at all: **bare specifiers**
// exercise `exports` names and conditions, which importing a manifest's target path silently
// bypasses; and **`node_modules/.bin/factory`** is a symlink, which is the exact shape that broke the
// CLI's entry guard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["feature-factory", "opencode-feature-factory", "prime-agent-feature-factory"];
const PACKED_BOOTSTRAP_COMMAND = "node -e \"const f=require('fs');f.writeFileSync('packed-bootstrap-cwd',process.cwd());console.log('packed-bootstrap-out');console.error('packed-bootstrap-err')\"";
const CONFIG_SCHEMA = `{
  "resolve": "<non-empty shell command>",
  "verify": "<non-empty shell command>",
  "publish": "<non-empty shell command>",
  "publishing_identity": "<non-empty account name>",
  "verify_timeout_ms": 900000,
  "bootstrap": "<non-empty shell command>",
  "bootstrap_timeout_ms": 900000
}`;
const SKILL_CONTRACTS = [
  ["the four-required plus three-optional schema", (text) => text.includes(CONFIG_SCHEMA), CONFIG_SCHEMA],
  ["commands, identity, and optional entries are typed", (text) => /four required own properties `resolve`, `verify`, `publish`, and\s+`publishing_identity`, plus only the optional own properties `verify_timeout_ms`, `bootstrap`, and\s+`bootstrap_timeout_ms`[\s\S]*`resolve`, `verify`, `publish`, and `bootstrap` are command strings[\s\S]*`publishing_identity` is\s+a static non-empty publishing account name/u.test(text)],
  ["bootstrap and verify have independent defaults", (text) => /`verify_timeout_ms` and `bootstrap_timeout_ms` each independently default to `900000` milliseconds;\s+neither timeout shares or consumes the other's budget/u.test(text)],
  ["config validation uses runtime first-match order", (text) => text.includes("Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."), "Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."],
  ["bootstrap is CLI-owned", (text) => text.includes("Configured `bootstrap` is consumed only by CLI-owned fresh init and explicit resume; the workflow consumer validates it but never executes it itself."), "Configured `bootstrap` is consumed only by CLI-owned fresh init and explicit resume; the workflow consumer validates it but never executes it itself."],
  ["bootstrap absence is an exact no-op", (text) => text.includes("When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."), "When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."],
  ["bootstrap output stays on CLI stderr", (text) => text.includes("child stdout and stderr both routed to CLI stderr"), "child stdout and stderr both routed to CLI stderr"],
  ["tracked-only bootstrap cleanliness is explicit", (text) => text.includes("Bootstrap cleanliness examines tracked worktree and index paths only; untracked dependency output is ignored."), "Bootstrap cleanliness examines tracked worktree and index paths only; untracked dependency output is ignored."],
  ["bootstrap manifest evidence is paired", (text) => text.includes("A successful configured attempt stores the exact command in `bootstrap_command` and the numeric result in paired `bootstrap_exit`; status output remains unchanged."), "A successful configured attempt stores the exact command in `bootstrap_command` and the numeric result in paired `bootstrap_exit`; status output remains unchanged."],
  ["failed init retains no manifest", (text) => text.includes("A configured fresh-init failure retains the deterministic sandbox, emits no init JSON stdout, and leaves `run.json` absent."), "A configured fresh-init failure retains the deterministic sandbox, emits no init JSON stdout, and leaves `run.json` absent."],
  ["configured resume binds bytes and owner writes", (text) => /For configured order 7, the CLI binds the exact raw `run\.json` bytes[\s\S]*Every factory-mediated claim, force-steal, refresh, and release holds `run-json\.lock`[\s\S]*A clean zero records the command and exit `0`[\s\S]*ordinary failure with intact bindings records the exact command and integer or `null` result/u.test(text)],
  ["bootstrap exclusions preserve established consumers", (text) => /never invoked by resolver, merge verification or replay, direct repository verification, slice or Gate 3 observation, effective push, or publication/u.test(text)],
  ["resolve uses an ordinary shell in the repository root", (text) => /configured string unchanged as one ordinary shell step, with exact cwd `O`, the inherited\s+environment plus `FACTORY_INPUT`/u.test(text)],
  ["empty stdout means not recognized", (text) => /Exit zero with exactly zero stdout bytes means the resolver did not recognize an issue reference/u.test(text)],
  ["stdout is the unchanged payload with a canonical run id, a title and a body", (text) => /stdout itself is `ISSUE_PAYLOAD`[\s\S]*canonical top-level string `run_id`, a non-empty string `title`, and a string `body`[\s\S]*exact same stdout bytes unchanged to `story-reader`/u.test(text)],
  ["the payload shape is validated before anything is dispatched", (text) => /Validate `run_id`, `title`, and `body` — presence and type — before binding `R`/u.test(text)],
  ["an absent config declares no resolver at all", (text) => /An absent `\$O\/\.factory\.json` means this repository declares no resolver/u.test(text)],
  ["no tracker grammar or fetch command ships in the skill", (text) => !/\bgh\s+(?:repo|issue)\b/u.test(text)],
  ["malformed config refuses closed", (text) => text.includes("invalid factory config: .factory.json; no session or run created.")],
  ["malformed payload refuses closed, naming the reference", (text) => text.includes("factory config entry 'resolve' returned malformed payload for reference <reference>; no session or run created.")],
  ["an observed status is reported without fallback, naming the reference", (text) => text.includes("factory config entry 'resolve' failed for reference <reference> with exit status <status>; no session or run created.")],
  ["an unavailable status is reported without fallback, naming the reference", (text) => text.includes("factory config entry 'resolve' failed for reference <reference>; exit status unavailable; no session or run created.")],
  ["commands and credentials are never disclosed", (text) => /Never print,\s+quote, reproduce, log, or persist the configured command string, an expanded or resolved command line,\s+credentials, or shell\/tool diagnostics/u.test(text)],
  ["no resolver bridge, parser, capture, session, or output mechanism is added", (text) => /For configured resolver execution, add no helper module,\s+command runner, parser service[\s\S]*plugin bridge,[\s\S]*For `resolve`, use the ordinary shell result directly\. Add no stderr redirection or suppression rule,\s+separate capture policy, output channel, buffering, truncation, redaction, output-size limit[\s\S]*session/u.test(text)],
  ["resolve, verify, and publishing identity are consumed while publish remains unconsumed", (text) => /`resolve`, `verify`, and `publishing_identity` are consumed now\. Configured `publish` remains unconsumed and is not invoked\./u.test(text)],
  ["effective push is package-owned rather than deferred", (text) => text.includes("Effective push-target capture and comparison are active through the package-owned <code>factory effective-push</code> command; they are not deferred to configured `publish`."), "Effective push-target capture and comparison are active through the package-owned <code>factory effective-push</code> command; they are not deferred to configured `publish`."],
  ["verify uses the exact integration worktree and inherited process context", (text) => /`verify` \| Ordinary shell step in the exact integration-worktree cwd with inherited environment[\s\S]*stdout and stderr are inherited, informational, and unparsed[\s\S]*Exit status is authoritative/u.test(text)],
  ["verify runs after the atomic merge record and writes canonical evidence", (text) => /After\s+the atomic merged transition[\s\S]*runs that unchanged ordinary shell command in `INTEGRATION_WORKTREE` with inherited environment and\s+stdio and writes canonical `evidence\/test-verifier\.json`/u.test(text)],
  ["verify has exact closed classification and canonical unavailable evidence", (text) => /Classify it into exactly four outcomes:[\s\S]*`green`: exact run, subject, current head, and unchanged `verify` command binding, observed integer\s+exit zero, and `review_ready: true`[\s\S]*`failed`: the same exact binding with an observed nonzero integer exit, or observed zero that is not\s+review-ready[\s\S]*`unavailable`: the same exact binding with canonical `observed: false`, `exit: null`, and\s+`skipped_reason: null`[\s\S]*`unknown`: missing, unreadable, malformed, foreign, stale-head, wrong-command, missing-field, or\s+internally inconsistent evidence[\s\S]*only replay-eligible class/u.test(text)],
  ["safe replay has every fresh proof while unsafe state parks for the same safe resume", (text) => /Only matching `unavailable` evidence, no active\s+repair record, a freshly verified exact integration worktree on the recorded feature branch, current\s+integration `HEAD` equal to that row's immutable merge SHA, and a freshly observable clean tree authorize\s+replay[\s\S]*Dirty, moved, or unobservable replay\s+safety state and malformed, foreign, stale-head, wrong-command, missing-field, or internally inconsistent\s+evidence never execute\.[\s\S]*Unsafe verification evidence parks top-level needs-human; explicit resume must replay the existing reconciliation path\.[\s\S]*Clean, unchanged second-unavailable\s+exhaustion is the sole nonterminal exception[\s\S]*Top-level needs-human remains parked while replay safety is false; explicit resume does not bypass the same safety check\./u.test(text)],
  ["clean exhaustion quiesces and verifies release", (text) => /terminalize means terminate the current `factory slice … merged` CLI invocation[\s\S]*does not mean the irreversible\s+factory terminal transition[\s\S]*Await every in-flight specialist task[\s\S]*await every heartbeat already in flight[\s\S]*Outcome: repository-verify-exhausted[\s\S]*Outcome: retained-lock-error/u.test(text)],
  ["restart repeats guards and verifies an identity-agnostic new claim before replay", (text) => /later driver invocation repeats normal run selection, manifest validation, provenance, branch,\s+worktree, effective-push, and operator-ref guards[\s\S]*binds `SESSION_ID` to the actual stable host-adapter identity[\s\S]*reports that exact session as owner[\s\S]*Only then may it perform same-SHA reconciliation[\s\S]*never require session-ID inequality/u.test(text)],
  ["absent config preserves merge behavior silently", (text) => /An absent config preserves\s+the old response and emits nothing new/u.test(text)],
  ["a post-record failure preserves the merged slice and forbids its reopening, reseeding, re-observation, or redispatch", (text) => /If the row is `merged` at exactly\s+`MERGE_COMMIT`, preserve its evidence, review, refs, attempts, paths, test plan, and merge commit;[\s\S]*stop before `status\.next`, wave calculation,\s+activation, reopen, reseed, slice re-observation, or redispatch\. Never reopen or redispatch a\s+merged slice\./u.test(text)],
  ["Gate 3 is a fresh independent observation", (text) => /Gate 3 observation is always fresh and independent[\s\S]*never shares, substitutes,\s+or optimizes from a post-merge repository verification result/u.test(text)],
  ["operator ownership and privileged protection remain in force", (text) => /It remains operator-owned:[\s\S]*refused by the privileged-path policy/u.test(text)],
  ["parked path amendment is owner-verified, durable, and precedes unchanged resume", (text) => /operator may insert exactly one optional action after order 6 has verified the fresh exact owner[\s\S]*factory amend-paths "\$R" "\$SLICE_ID" --add "\$PATH" \[--add "\$PATH" \.\.\.\][\s\S]*keeps the run parked and the\s+terminal result unchanged[\s\S]*resume command never amends paths,\s+changes `test_plan`, or reseeds the plan/u.test(text), "operator may insert exactly one optional action after order 6 has verified the fresh exact owner"],
  ["configured publish remains uninvoked while identity enforcement is active", (text) => /Not invoked\. Existing `git push`, `gh pr create`, and `factory pr` behavior remains unchanged; effective push-target equality is enforced separately by <code>factory effective-push<\/code>\.[\s\S]*Active at the three mandatory guards below/u.test(text)],
  ["stale push-target deferrals are absent", (text) => !/#224|push-target migration is deferred|only `publish` remains deferred/u.test(text)],
];
const IDENTITY_README_CONTRACTS = [
  ["publishing identity is active, retained raw, and its surface is scoped", (text) => text.includes("`resolve`, `verify`, and `publishing_identity` are consumed now. Configured `publish` remains unconsumed and is not invoked.") && /validated raw `publishing_identity` is retained exactly as parsed, without trimming, normalization,\s+case-folding, or reserialization[\s\S]*`publishing_identity` itself adds no config key or syntax, run status, or factory command\. The independent `factory effective-push` command adds no state or flag/u.test(text), "`resolve`, `verify`, and `publishing_identity` are consumed now. Configured `publish` remains unconsumed and is not invoked."],
  ["all modes use exactly the three identity boundaries and absence preserves behavior", (text) => /every mode checks that identity at exactly three boundaries:[\s\S]*verified post-lock ownership[\s\S]*explicit resume is verified running[\s\S]*before reconciliation or other work; immediately before `git push`, after\s+effective push-target equality; and immediately before `gh pr create`, after the push is known\s+successful[\s\S]*absent config skips all three guards[\s\S]*preserves existing behavior/u.test(text), "With a present valid config, every mode checks that identity at exactly three boundaries: immediately"],
  ["missing or empty inherited token refuses without an invocation", (text) => /Before each guard, inherited `GH_TOKEN` must exist and contain at least one character[\s\S]*Missing or empty\s+means identity is unobservable without invoking `gh`, the network, stored authentication, credential\s+queries, or any fallback/u.test(text), "Before each guard, inherited `GH_TOKEN` must exist and contain at least one character. Missing or empty"],
  ["the exact read-only probe is parsed strictly and compared case-sensitively", (text) => text.includes("gh api --method GET /user --jq .login") && /read-only network probe as one\s+ordinary host shell step with cwd exactly `RUN_REPO`, inherited environment, and no stdin[\s\S]*direct stdout bytes, stderr bytes, and numeric status are parsed strictly[\s\S]*exactly one ASCII GitHub login plus one LF[\s\S]*compared exactly and case-sensitively[\s\S]*`gh auth status`\s+does not prove the publishing identity/u.test(text), "gh api --method GET /user --jq .login"],
  ["identity refusal is safe, actionable, and transported as one token", (text) => /mismatch names the safely rendered declared and observed values and says to authenticate as the\s+declared account; an unobservable result names the safely rendered declaration and says to launch with\s+inherited `GH_TOKEN` for it[\s\S]*deterministic ASCII-only JSON-string rendering[\s\S]*complete rendered reason is transported as one\s+shell-safe argv token and the sole `--reason` value[\s\S]*never exposed[\s\S]*never manages credentials or\s+transport/u.test(text), "A mismatch names the safely rendered declared and observed values and says to authenticate as the"],
  ["identity refusal parks, unlocks, and requires a fresh claim and explicit resume", (text) => /parks through existing `needs-human`, verifies the exact\s+persisted reason and owner, releases that owner, verifies the lock absent, and retains the sandbox[\s\S]*repeats every selection,\s+manifest, containment, config, effective-push, provenance, branch, worktree, cleanliness or recovery,\s+and exact-ref precheck[\s\S]*fresh claim with its own `FACTORY_SESSION_ID`[\s\S]*factory resume "\$R" --session "\$FACTORY_SESSION_ID" --repo "\$RUN_REPO"[\s\S]*post-resume\s+reconciliation[\s\S]*newly qualified `status\.next`[\s\S]*never reuses the released\s+session/u.test(text), "Either refusal quiesces outstanding work, parks through existing `needs-human`, verifies the exact"],
  ["identity verification is enforcement while credential setup is instruction", (text) => /Publishing-identity verification is enforcement because it prevents false-green or wrong-account\s+publication\. Credential provisioning and helper setup are instruction only[\s\S]*Existing push,\s+`gh pr create`, `factory pr`, Gate 3, merge, and approval semantics remain unchanged/u.test(text), "Publishing-identity verification is enforcement because it prevents false-green or wrong-account"],
];
const README_CONTRACTS = [
  ["the four-required plus three-optional schema", (text) => text.includes(CONFIG_SCHEMA), CONFIG_SCHEMA],
  ["commands, identity, and optional entries are typed", (text) => /four required properties and three optional properties: `verify_timeout_ms`, `bootstrap`,\s+and `bootstrap_timeout_ms`[\s\S]*`resolve`, `verify`, `publish`, and a present `bootstrap` are non-empty command\s+strings[\s\S]*`publishing_identity` is a static non-empty account name/u.test(text)],
  ["timeouts validate and default independently", (text) => /Both timeouts are positive safe integers\. `bootstrap_timeout_ms` requires `bootstrap`\.[\s\S]*Each omitted timeout independently defaults to `900000`; neither shares the other's budget/u.test(text)],
  ["config validation uses runtime first-match order", (text) => text.includes("Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."), "Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."],
  ["bootstrap execution, routing, and timeout are exact", (text) => /Only the CLI executes configured `bootstrap`: once during fresh init after clone, containment, and PR-base observation but before manifest publication, and again on every explicit resume while the run remains parked\.[\s\S]*exact configured string runs unchanged with `shell: true`, inherited environment and stdin, cwd exactly the selected sandbox, and child stdout and stderr both routed to CLI stderr[\s\S]*independent `900000` millisecond default/u.test(text)],
  ["bootstrap cleanliness and evidence are exact", (text) => /checks tracked worktree and index paths only and ignores untracked dependency output[\s\S]*clean numeric zero stores paired `bootstrap_command` and `bootstrap_exit` manifest evidence[\s\S]*Ordinary transitions preserve the pair, and status output does not expose it/u.test(text)],
  ["fresh and resumed bootstrap outcomes are exact", (text) => /failed, timed-out, dirty, or unobservable fresh init emits no JSON stdout, retains the deterministic sandbox, and leaves `run\.json` absent[\s\S]*Configured resume first binds exact raw manifest bytes[\s\S]*Ordinary failure with intact bindings records integer or `null` evidence[\s\S]*Byte mutation or owner loss preserves current state and ownership, records no evidence, and does not unpark[\s\S]*serialize with resume publication through `run-json\.lock`/u.test(text)],
  ["bootstrap absence is an exact no-op", (text) => text.includes("When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."), "When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."],
  ["bootstrap exclusions preserve established behavior", (text) => /Bootstrap never runs during resolver intake, merge verification or replay, direct repository verification, slice observation, Gate 3, effective push, configured publication, push, or PR creation\. Existing resolver, verify, configured-publish, effective-push, push, PR, and Gate 3 behavior is unchanged\./u.test(text)],
  ["resolve and verify are consumed", (text) => /`resolve`, `verify`, and `publishing_identity` are consumed now/u.test(text)],
  ["effective-push grammar and modes are exact", (text) => /factory effective-push <bootstrap\|check> <operator-repository> <sandbox-repository>[\s\S]*accepts exactly those three positional arguments and no options[\s\S]*`bootstrap` captures the\s+operator's effective push target, configures the sandbox push URL from it, then freshly captures both\s+repositories and compares them exactly[\s\S]*`check` freshly captures both targets and compares without\s+configuration/u.test(text)],
  ["stale push-target deferrals are absent", (text) => !/#224|push-target migration is deferred|only `publish` remains deferred/u.test(text)],
  ["ordinary shell, repository-root cwd, and FACTORY_INPUT", (text) => /ordinary shell step[\s\S]*repository-root cwd[\s\S]*`FACTORY_INPUT`/u.test(text)],
  ["empty and non-empty stdout have the direct contract", (text) => /Empty stdout means the input was not\s+recognized[\s\S]*Non-empty stdout is the direct,\s+unchanged `ISSUE_PAYLOAD`[\s\S]*top-level string `run_id`/u.test(text)],
  ["present invalid config refuses and absence declares no resolver", (text) => /present invalid,[\s\S]*config refuses closed[\s\S]*If `\.factory\.json` is absent, intake declares no resolver/u.test(text)],
  ["commands and credentials are not disclosed", (text) => /neither the configured or expanded\s+command line, shell diagnostics, nor credentials are printed, logged, or persisted/u.test(text)],
  ["verify follows the atomic merge record in the integration worktree", (text) => /After a slice merge is successfully and atomically recorded, `verify` starts in the exact recorded\s+integration worktree/u.test(text)],
  ["verify inherits environment and stdio without parsing output", (text) => /configured string is submitted unchanged as one ordinary shell command[\s\S]*inherited environment and stdio[\s\S]*Stdout and stderr are visible, informational,\s+and unparsed; they are not captured or persisted/u.test(text)],
  ["verify exit and canonical evidence are authoritative", (text) => /Numeric child exit status is authoritative[\s\S]*canonical\s+`evidence\/test-verifier\.json` schema[\s\S]*current merged head/u.test(text)],
  ["absence is silent after merge", (text) => /After\s+a recorded merge the factory silently returns its previous response with no repository command,\s+evidence write, or new output/u.test(text)],
  ["failure preserves the merge and routes before the next wave", (text) => /post-record\s+failure leaves the merged row and its slice evidence and review unchanged and stops before the next wave[\s\S]*test-file-only repair path/u.test(text)],
  ["classification and safe replay are fully documented", (text) => /exactly four classifications[\s\S]*`green` has exact run, `test-verifier` subject,\s+current merged head, and unchanged `verify` command binding[\s\S]*`failed` has that exact binding[\s\S]*`unavailable` has that exact binding and `observed: false`, `exit: null`,\s+and `skipped_reason: null`[\s\S]*internally inconsistent evidence is `unknown`[\s\S]*no active repair, a freshly verified\s+exact integration worktree on the recorded feature branch, the immutable merge SHA still at `HEAD`, and\s+a freshly observed clean tree/u.test(text)],
  ["clean exhaustion is nonterminal while unsafe and repair exhaustion are terminal", (text) => /Production defects, repair exhaustion, dirty or moved safety failures, invalid config, and malformed,\s+stale, foreign, wrong-command, missing-field, or inconsistent evidence terminalize `needs-human`; clean,\s+unchanged second-unavailable repository verification instead follows the nonterminal exhausted\/release\s+contract[\s\S]*Two clean, unchanged unavailable executions terminate the current CLI and driver invocations, not the\s+durable run/u.test(text)],
  ["restart verifies an identity-agnostic claim before reconciliation", (text) => /later invocation repeats all normal guards, claims with its actual\s+host-exported session ID, verifies ownership, and only then reconciles the same SHA[\s\S]*value may equal\s+the prior value/u.test(text)],
  ["Gate 3 is fresh and does not share evidence", (text) => /Gate 3 always runs a separate fresh integrated `test-verifier` observation[\s\S]*never shares, substitutes, or\s+optimizes from post-merge evidence/u.test(text)],
  ["the config remains operator-owned and privileged", (text) => /file is\s+operator-owned, committed, and protected as a privileged path/u.test(text)],
  ["path amendment preserves the seed and refuses unsafe recovery", (text) => /optional amendment runs while the status remains `needs-human`[\s\S]*original path prefix and\s+`test_plan` stay immutable[\s\S]*Duplicate, target-already-owned, malformed, privileged, replayed, or merged-slice\s+requests refuse atomically[\s\S]*Resume never amends or reseeds/u.test(text), "The optional amendment runs while the status remains `needs-human`"],
  ...IDENTITY_README_CONTRACTS,
  ["the live config is not packaged", (text) => /live config\s+is not part of this package[\s\S]*no generated config or resolver asset is shipped/u.test(text)],
];
const ROOT_README_CONTRACTS = [
  ["the four-required plus three-optional schema", (text) => text.includes(CONFIG_SCHEMA), CONFIG_SCHEMA],
  ["timeouts validate and default independently", (text) => /Both timeouts are positive safe integers\. `bootstrap_timeout_ms` requires `bootstrap`\.[\s\S]*Each omitted timeout independently defaults to `900000`; neither shares the other's budget/u.test(text)],
  ["config validation uses runtime first-match order", (text) => text.includes("Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."), "Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."],
  ["bootstrap execution, routing, and timeout are exact", (text) => /Only the CLI executes configured `bootstrap`: once during fresh init after clone, containment, and PR-base observation but before manifest publication, and again on every explicit resume while the run remains parked\.[\s\S]*exact configured string runs unchanged with `shell: true`, inherited environment and stdin, cwd exactly the selected sandbox, and child stdout and stderr both routed to CLI stderr[\s\S]*independent `900000` millisecond default/u.test(text)],
  ["bootstrap cleanliness and evidence are exact", (text) => /checks tracked worktree and index paths only and ignores untracked dependency output[\s\S]*clean numeric zero stores paired `bootstrap_command` and `bootstrap_exit` manifest evidence[\s\S]*Ordinary transitions preserve the pair, and status output does not expose it/u.test(text)],
  ["fresh and resumed bootstrap outcomes are exact", (text) => /failed, timed-out, dirty, or unobservable fresh init emits no JSON stdout, retains the deterministic sandbox, and leaves `run\.json` absent[\s\S]*Configured resume first binds exact raw manifest bytes[\s\S]*Ordinary failure with intact bindings records integer or `null` evidence[\s\S]*Byte mutation or owner loss preserves current state and ownership, records no evidence, and does not unpark[\s\S]*serialize with resume publication through `run-json\.lock`/u.test(text)],
  ["bootstrap absence is an exact no-op", (text) => text.includes("When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."), "When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."],
  ["bootstrap exclusions preserve established behavior", (text) => /Bootstrap never runs during resolver intake, merge verification or replay, direct repository verification, slice observation, Gate 3, effective push, configured publication, push, or PR creation\. Existing resolver, verify, configured-publish, effective-push, push, PR, and Gate 3 behavior is unchanged\./u.test(text)],
  ["resolve and verify are consumed", (text) => /`resolve`, `verify`, and `publishing_identity` are consumed now/u.test(text)],
  ["effective push is package-owned rather than configured publish", (text) => text.includes("Effective push-target capture and comparison are active through the package-owned `factory effective-push` command; they are not deferred to configured `publish`."), "Effective push-target capture and comparison are active through the package-owned `factory effective-push` command; they are not deferred to configured `publish`."],
  ["stale push-target deferrals are absent", (text) => !/#224|push-target migration is deferred|only `publish` remains deferred/u.test(text)],
  ["verify runs after an atomic record in the integration worktree", (text) => /After a slice merge is successfully and atomically recorded, `verify` starts in the exact recorded\s+integration worktree/u.test(text)],
  ["verify inherits environment and stdio and leaves output unparsed", (text) => /ordinary shell command[\s\S]*process environment and stdio inherited[\s\S]*Stdout and stderr remain visible,\s+informational, and unparsed/u.test(text)],
  ["verify status and canonical evidence are authoritative", (text) => /numeric child exit status is\s+authoritative[\s\S]*canonical `evidence\/test-verifier\.json` schema/u.test(text)],
  ["absent config silently preserves merge behavior", (text) => /absence silently preserves the previous merge response and progression, with no\s+repository command, evidence write, or new output/u.test(text)],
  ["post-record failure preserves merged-slice records and routes before the next wave", (text) => /post-record verification failure does not roll back\s+or rewrite the merged row or its slice evidence and review[\s\S]*stops before the next wave/u.test(text)],
  ["classification and safe replay are fully documented", (text) => /four closed classifications[\s\S]*`green` has exact run, `test-verifier` subject,\s+current merged head, and unchanged `verify` command binding[\s\S]*`failed` has that exact binding[\s\S]*`unavailable` has that exact binding and canonical `observed: false`,\s+`exit: null`, and `skipped_reason: null`[\s\S]*internally inconsistent is `unknown`[\s\S]*no active repair,\s+a freshly verified exact integration worktree on the recorded feature branch, the immutable merge SHA\s+still at `HEAD`, and a freshly observed clean tree/u.test(text)],
  ["clean exhaustion cannot also route to durable needs-human", (text) => /repair-journal exhaustion, dirty or moved replay safety failures, invalid config, unobservable\s+state, and malformed, stale, foreign, wrong-command, missing-field, or internally inconsistent evidence\s+route to durable `needs-human`[\s\S]*Clean, unchanged second-unavailable repository verification does not: it\s+uses the nonterminal exhausted\/release contract[\s\S]*Two clean, unchanged unavailable executions end only the current merge\/replay CLI invocation/u.test(text) && !/unclassifiable, interrupted, invalid-config, unobservable, or exhausted findings route to\s+`needs-human`/u.test(text)],
  ["restart verifies an identity-agnostic claim before reconciliation", (text) => /later invocation repeats every normal selection,\s+manifest, provenance, branch, worktree, push-target, and operator-ref guard, claims with its actual\s+host-exported session ID, verifies ownership, and only then reconciles the same SHA[\s\S]*may equal the old one/u.test(text)],
  ["Gate 3 is separately fresh without evidence sharing", (text) => /Gate 3 always performs its own fresh integrated `test-verifier` observation[\s\S]*never shares,\s+substitutes, or optimizes from post-merge evidence/u.test(text)],
  ["operator ownership and privileged protection remain in force", (text) => /file is\s+operator-owned, committed, and protected as a privileged path/u.test(text)],
  ["the CLI documents the owner-verified parked amendment without changing resume", (text) => /`amend-paths` is the one optional parked mutation[\s\S]*requires the exact fresh owning session[\s\S]*another slice may own the\s+same path[\s\S]*seeded prefix and `test_plan` remain immutable[\s\S]*merge still refuses unamended or privileged paths/u.test(text), "`amend-paths` is the one optional parked mutation."],
  ...IDENTITY_README_CONTRACTS,
];
const OPERATING_CONTRACTS = [
  ["the four-required plus three-optional schema", (text) => text.includes(CONFIG_SCHEMA), CONFIG_SCHEMA],
  ["timeouts validate and default independently", (text) => /Both timeouts must be positive safe integers\. `bootstrap_timeout_ms`\s+requires `bootstrap`\. Each omitted timeout independently defaults to `900000` milliseconds and neither\s+shares the other's budget/u.test(text)],
  ["config validation uses runtime first-match order", (text) => text.includes("Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."), "Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries."],
  ["bootstrap execution and routing are exact", (text) => /`bootstrap` \| The exact string runs unchanged with `shell: true`, cwd exactly the selected sandbox, inherited environment and stdin, and child stdout and stderr both routed to CLI stderr[\s\S]*again on every explicit resume while parked\. No retry/u.test(text)],
  ["bootstrap cleanliness and evidence are exact", (text) => /Bootstrap cleanliness checks tracked worktree and index paths only, so untracked dependency installation is allowed[\s\S]*paired top-level `bootstrap_command` and `bootstrap_exit` evidence[\s\S]*status response shape stays unchanged/u.test(text)],
  ["fresh and resumed bootstrap outcomes are exact", (text) => /failed, timed-out, dirty, or unobservable fresh init emits no JSON stdout, retains the deterministic sandbox, and leaves `run\.json` absent[\s\S]*Configured resume binds exact raw manifest bytes[\s\S]*Ordinary failure with intact bindings records integer or `null`[\s\S]*Manifest-byte or owner binding loss preserves current state and owner, records no evidence, and does not unpark[\s\S]*serialize with manifest publication through `run-json\.lock`/u.test(text)],
  ["bootstrap absence is an exact no-op", (text) => text.includes("When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."), "When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change."],
  ["bootstrap exclusions preserve established behavior", (text) => /Bootstrap never runs during resolver intake, merge verification or replay, direct repository verification, slice observation, Gate 3, effective push, configured publication, push, or PR creation\. Existing resolver, verify, configured-publish, effective-push, push, PR, and Gate 3 behavior is unchanged\./u.test(text)],
  ["verify runs unchanged in the integration worktree with inherited process context", (text) => /unchanged string runs as an ordinary shell command in the exact recorded integration-worktree cwd with inherited environment and stdio/u.test(text)],
  ["verify output is inherited and unparsed", (text) => /Stdout and stderr are visible, informational, and unparsed rather than captured or persisted/u.test(text)],
  ["verify status is authoritative", (text) => /Numeric child exit status is authoritative/u.test(text)],
  ["post-record evidence is canonical", (text) => /merge record commits before `verify` begins[\s\S]*canonical `evidence\/test-verifier\.json` schema/u.test(text)],
  ["failure preserves merged-slice records and blocks the next wave", (text) => /leaves the merged slice, its merge commit, its evidence, and its review unchanged and stops\s+the driver before it consults or activates the next wave/u.test(text)],
  ["failure routing keeps production source out of repair", (text) => /Production defects are not repaired on the integration branch and terminalize `needs-human`[\s\S]*confirmed test-only finding may change test files only/u.test(text)],
  ["closed classification and canonical unavailable tuple are documented", (text) => /exactly four classifications[\s\S]*`green` has exact run, `test-verifier` subject,\s+current merged head, and unchanged `verify` command binding[\s\S]*`failed` has that exact binding[\s\S]*`unavailable` has that exact binding and canonical `observed: false`,\s+`exit: null`, and `skipped_reason: null`[\s\S]*internally inconsistent evidence is `unknown`[\s\S]*Only `unavailable` may\s+execute again/u.test(text)],
  ["replay requires every fresh safety condition", (text) => /replay requires no active repair and the CLI freshly proves the\s+exact integration worktree on the recorded feature branch, unchanged recorded merge SHA at `HEAD`, and a\s+clean tree before one retry/u.test(text)],
  ["clean exhaustion cannot also route to durable needs-human", (text) => /Repair-journal exhaustion, dirty or moved replay safety failures, invalid config, unobservable state, and\s+malformed, stale, foreign, wrong-command, missing-field, or internally inconsistent evidence do the same[\s\S]*Clean, unchanged second-unavailable repository verification is explicitly excluded: it follows the\s+nonterminal exhausted\/release contract/u.test(text) && !/Unclassifiable, interrupted-unknown, invalid-config, unobservable, and exhausted outcomes do the same/u.test(text)],
  ["exhaustion and retained-lock outcomes preserve truthful durable state", (text) => /current merge\/replay CLI invocation and enclosing\s+driver invocation terminate, but the irreversible `factory terminal` transition does not run[\s\S]*`repository-verify-exhausted`[\s\S]*`retained-lock-error`/u.test(text)],
  ["restart verifies an identity-agnostic new claim before replay", (text) => /later invocation repeats normal run selection, manifest, provenance,\s+branch, worktree, effective-push, and operator-ref checks[\s\S]*claims with its actual host-exported session\s+ID; verifies that exact ownership; and only then replays the same-SHA merge[\s\S]*not string inequality/u.test(text)],
  ["absent config silently preserves prior behavior", (text) => /An absent `\.factory\.json` remains silent compatibility behavior[\s\S]*returns the same merge result as before this consumer existed/u.test(text)],
  ["Gate 3 remains fresh and independent", (text) => /Gate 3 always runs a fresh, independent integrated\s+`test-verifier` observation[\s\S]*without sharing or optimizing from the post-merge result/u.test(text)],
  ["operator ownership and privileged protection remain in force", (text) => /live file is operator-owned[\s\S]*protected by the\s+privileged-path policy/u.test(text)],
  ["operator recovery places verified amendment before separate resume", (text) => /Claim first and verify the exact fresh owner[\s\S]*operator may first\s+verify the disclosure and run `amend-paths`[\s\S]*same separate resume command[\s\S]*Resume itself never amends paths[\s\S]*merge continues to refuse any unamended or privileged path/u.test(text), "Claim first and verify the exact fresh owner."],
  ["publishing identity is active and retained raw while publish remains unconsumed", (text) => /`resolve`, `bootstrap`, `verify`, and `publishing_identity` are consumed now\. Configured `publish` remains unconsumed and is not invoked\.[\s\S]*retain the raw validated string exactly as parsed, without trimming, normalization, case-folding, or reserialization[\s\S]*Active in every mode at exactly three guards; absent config preserves existing behavior/u.test(text), "`resolve`, `bootstrap`, `verify`, and `publishing_identity` are consumed now."],
  ["effective push is package-owned rather than configured publish", (text) => text.includes("Effective push-target capture and comparison are active through the package-owned `factory effective-push` command; they are not deferred to configured `publish`."), "Effective push-target capture and comparison are active through the package-owned `factory effective-push` command; they are not deferred to configured `publish`."],
  ["the three operating boundaries preserve the publication surface", (text) => /immediately after verified post-lock ownership[\s\S]*explicit resume is verified running[\s\S]*before reconciliation or other work;\s+immediately before `git push`, after effective push-target equality; and immediately before\s+`gh pr create`, after the push is known successful[\s\S]*`publishing_identity` itself adds no config key or syntax, run status, or factory command\. The independent `factory effective-push` command adds no state or flag\.[\s\S]*Existing push, `gh pr create`, `factory pr`, Gate 3, merge, and approval semantics remain unchanged/u.test(text), "Publishing identity is checked immediately after verified post-lock ownership, or immediately after an"],
  ["stale push-target deferrals are absent", (text) => !/#224|push-target migration is deferred|only `publish` remains deferred/u.test(text)],
  ["missing or empty inherited token refuses without invoking authentication", (text) => /Before each guard, inherited `GH_TOKEN` must exist and contain at least one character[\s\S]*Missing or empty\s+parks identity as unobservable without invoking `gh`, the network, stored authentication, credential\s+queries, or any fallback/u.test(text), "Before each guard, inherited `GH_TOKEN` must exist and contain at least one character. Missing or empty"],
  ["the operator probe is exact, direct, strict, and case-sensitive", (text) => text.includes("gh api --method GET /user --jq .login") && /read-only network probe as one\s+ordinary host shell step with cwd exactly `RUN_REPO`, inherited environment, and no stdin[\s\S]*host result directly as exact stdout bytes, exact stderr bytes, and numeric status[\s\S]*exactly one ASCII login matching[\s\S]*followed by exactly one LF byte[\s\S]*compare the raw declared and observed strings exactly and case-sensitively[\s\S]*`gh auth status`; machine-active authentication is not\s+proof/u.test(text), "Use the host result directly as exact stdout bytes, exact stderr bytes, and numeric status."],
  ["both exact refusal forms are actionable", (text) => text.includes("publishing identity mismatch: declared <declared-ascii-json>, observed <observed-ascii-json>; authenticate as <declared-ascii-json> and retry.") && text.includes("publishing identity unobservable: declared <declared-ascii-json>; launch with inherited GH_TOKEN for <declared-ascii-json> as documented in OPERATING.md and retry."), "publishing identity mismatch: declared <declared-ascii-json>, observed <observed-ascii-json>; authenticate as <declared-ascii-json> and retry."],
  ["refusal values and reason transport are safe", (text) => /deterministic ASCII-only JSON-string rendering[\s\S]*lowercase `\\uXXXX` escapes[\s\S]*complete rendered reason is transported as one shell-safe argv\s+token and the sole `--reason` value[\s\S]*Never expose the token, raw stdout or stderr, diagnostics, status,\s+targets, helper output, or environment, and never manage credentials or transport/u.test(text), "Values use deterministic ASCII-only JSON-string rendering, including lowercase `\\uXXXX` escapes for"],
  ["identity refusal parks and resumes only through a fresh owner", (text) => /park through existing `needs-human`, verify the persisted\s+reason byte-for-byte and the owner, release only that owner, verify the lock absent with null owner, and\s+retain the sandbox[\s\S]*repeat\s+all selection, manifest, containment, config, effective-push, provenance, branch, worktree, cleanliness\s+or recovery, and exact-ref prechecks[\s\S]*driver's own `FACTORY_SESSION_ID`[\s\S]*factory resume "\$R" --session "\$FACTORY_SESSION_ID" --repo "\$RUN_REPO"[\s\S]*existing post-resume reconciliation[\s\S]*newly qualified\s+`status\.next`[\s\S]*Never reuse the released session/u.test(text), "On either refusal, quiesce outstanding work, park through existing `needs-human`, verify the persisted"],
  ["the shared helper and gh use one inherited token without credential management", (text) => /parent shell, launcher, or supervisor must inject and export a nonempty `GH_TOKEN`[\s\S]*same ephemeral helper configuration so Git and `gh` consume the one inherited token[\s\S]*Git credential helper reads the inherited `GH_TOKEN` as its password, while `gh` reads that same\s+inherited variable directly[\s\S]*real identity probe is a read-only network request[\s\S]*successful `gh auth status` is not a prepared environment[\s\S]*Credential\s+acquisition, storage, installation, and repair remain operator responsibilities outside this recipe/u.test(text), "The Git credential helper reads the inherited `GH_TOKEN` as its password, while `gh` reads that same"],
  ["identity verification is enforcement and helper setup is instruction", (text) => /Publishing-identity verification is enforcement because it prevents false-green or wrong-account\s+publication\. Supplying the token and installing this helper recipe are instruction only/u.test(text), "Publishing-identity verification is enforcement because it prevents false-green or wrong-account"],
];

function assertContracts(text, contracts, artifact) {
  for (const [contract, matches, negativeControl] of contracts) {
    assert.equal(matches(text), true, `${artifact} must preserve the contract that ${contract}`);
    if (negativeControl !== undefined) {
      assert.equal(matches(text.replace(negativeControl, "")), false,
        `${artifact} negative control must fail for the reason that ${contract}`);
    }
  }
}

function assertResumeInvocations(text, artifact, checkNegativeControl = true) {
  const invocations = [...text.matchAll(/`factory resume [^`]*`/gu)].map(([invocation]) => invocation);
  assert.ok(invocations.length > 0, `${artifact} must document an executable factory resume invocation`);
  for (const invocation of invocations) {
    assert.ok(invocation.includes("--session"), `${artifact} resume invocation must pass --session: ${invocation}`);
  }
  if (checkNegativeControl) {
    for (const invocation of invocations) {
      const broken = text.replace(invocation, invocation.replace("--session", "--owner"));
      assert.throws(
        () => assertResumeInvocations(broken, artifact, false),
        /must pass --session/u,
        `${artifact} needs its own negative control for the session requirement`,
      );
    }
  }
}

function pack(name, destination) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination],
    { cwd: join(root, "packages", name), encoding: "utf8" });
  const [metadata] = JSON.parse(output);
  return { tarball: join(destination, metadata.filename), files: metadata.files.map((file) => file.path) };
}

// A consumer with both tarballs really installed. Both go on one command line so npm can satisfy the
// inter-package dependency locally instead of reaching for the registry.
function installConsumer(dir) {
  const packed = Object.fromEntries(PACKAGES.map((name) => [name, pack(name, dir)]));
  const consumer = join(dir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"),
    JSON.stringify({ name: "pack-consumer", type: "module", private: true }));
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund",
    ...PACKAGES.map((name) => packed[name].tarball)], { cwd: consumer, encoding: "utf8" });
  return { consumer, packed };
}

// Imports run inside the consumer so bare specifiers resolve through its node_modules, the way a
// dependent's code would. A subprocess is the only honest way to do that from here.
function importInConsumer(consumer, script) {
  return execFileSync("node", ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8" });
}

function commitOperatorRepository(consumer) {
  writeFileSync(join(consumer, ".gitignore"), "node_modules/\n.factory/\n.factory-sandboxes/\n");
  writeFileSync(join(consumer, "operator.txt"), "committed operator fixture\n");
  writeFileSync(join(consumer, ".factory.json"), `${JSON.stringify({
    resolve: "true", verify: "true", publish: "true", publishing_identity: "factory-pack-test",
    bootstrap: PACKED_BOOTSTRAP_COMMAND, bootstrap_timeout_ms: 120000,
  }, null, 2)}\n`);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: consumer, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Factory Pack Test"], { cwd: consumer });
  execFileSync("git", ["config", "user.email", "factory-pack@example.test"], { cwd: consumer });
  execFileSync("git", ["add", ".factory.json", ".gitignore", "operator.txt", "package.json", "package-lock.json"], { cwd: consumer });
  execFileSync("git", ["commit", "-m", "Create operator fixture"], { cwd: consumer, encoding: "utf8" });
  return realpathSync(consumer);
}

describe("what actually ships", () => {
  it("packs every file the entrypoints and the docs require", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-files-"));
    try {
      const factory = pack("feature-factory", dir);
      const opencode = pack("opencode-feature-factory", dir);
      const prime = pack("prime-agent-feature-factory", dir);

      // The factory owns the host-neutral workflow and agents; each adapter owns its platform skill.
      for (const required of ["WORKFLOW.md", "bin/factory.js", "state/index.js", "README.md", "LICENSE"]) {
        assert.ok(factory.files.includes(required), `feature-factory must ship ${required}`);
      }
      assert.equal(factory.files.includes("skills/feature/SKILL.md"), false,
        "the host-neutral factory must not ship a platform skill");
      const agents = factory.files.filter((file) => file.startsWith("agents/"));
      assert.equal(agents.length, 11, `feature-factory must ship all eleven agents, packed ${agents.length}`);
      for (const [name, { files }] of [["feature-factory", factory], ["opencode-feature-factory", opencode], ["prime-agent-feature-factory", prime]]) {
        assert.deepEqual(files.filter((file) => file.startsWith(".factory/")), [],
          `${name} must not package operator-owned .factory content`);
        const repositoryCommandAssets = files.filter((file) => /(^|\/)(?:(?:factory[-_.]|generated[-_.])?(?:config|resolver)|config-resolver)(?:[./_-]|$)/u.test(file));
        assert.deepEqual(repositoryCommandAssets,
          name === "opencode-feature-factory" ? ["plugin/config.js"] : [],
          `${name} must not add a generated config or resolver asset`);
      }

      const sourceWorkflow = readFileSync(join(root, "packages", "feature-factory", "WORKFLOW.md"), "utf8");
      const sourceOpenCodeWorkflow = readFileSync(join(root, "packages", "opencode-feature-factory", "skills", "feature", "WORKFLOW.md"), "utf8");
      const sourcePrimeWorkflow = readFileSync(join(root, "packages", "prime-agent-feature-factory", "skills", "feature", "WORKFLOW.md"), "utf8");
      const sourcePackageReadme = readFileSync(join(root, "packages", "feature-factory", "README.md"), "utf8");
      const sourceRootReadme = readFileSync(join(root, "README.md"), "utf8");
      assertContracts(sourceWorkflow, SKILL_CONTRACTS, "source workflow");
      assertContracts(sourcePackageReadme, README_CONTRACTS, "source package README");
      for (const [artifact, text] of [
        ["canonical workflow", sourceWorkflow],
        ["OpenCode packaged workflow", sourceOpenCodeWorkflow],
        ["Prime packaged workflow", sourcePrimeWorkflow],
        ["package README", sourcePackageReadme],
        ["root README", sourceRootReadme],
      ]) {
        assertResumeInvocations(text, artifact);
      }

      // observe/ is not an entrypoint, which is exactly why it was left out: both entrypoints import
      // it, and nothing that only reads `exports` would notice.
      for (const required of ["plugin/index.js", "tui/dist/index.js", "observe/runs.js", "README.md", "LICENSE"]) {
        assert.ok(opencode.files.includes(required), `opencode-feature-factory must ship ${required}`);
      }
      for (const [name, packed] of [["opencode-feature-factory", opencode], ["prime-agent-feature-factory", prime]]) {
        for (const required of ["skills/feature/SKILL.md", "skills/feature/WORKFLOW.md", "README.md", "LICENSE"]) {
          assert.ok(packed.files.includes(required), `${name} must ship ${required}`);
        }
      }
      assert.ok(prime.files.includes("extensions/index.js"), "Prime adapter must ship its extension");
      // The host loads the built bundle and does not transform JSX, so shipping source instead of
      // output would fail at load with a syntax error.
      assert.deepEqual(opencode.files.filter((file) => file.endsWith(".jsx")), [],
        "raw JSX must not ship; the host cannot transform it");

      // Tests are not a release artifact. Shipping them doubles the tarball and invites a consumer to
      // run a suite against their own repository.
      for (const { files } of [factory, opencode, prime]) {
        assert.deepEqual(files.filter((file) => file.includes("test/")), []);
      }

      const readme = readFileSync(join(root, "README.md"), "utf8");
      const operating = readFileSync(join(root, "OPERATING.md"), "utf8");
      assertContracts(readme, ROOT_README_CONTRACTS, "root README");
      assertContracts(operating, OPERATING_CONTRACTS, "operator guide");
      assert.deepEqual(readme.split(/\r?\n/u).filter((line) => line.startsWith("factory init <run-id>")), [
        "factory init <run-id> [--branch B] [--worktree W] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]",
      ]);
      assert.deepEqual(readme.split(/\r?\n/u).filter((line) => line.startsWith("factory effective-push ")), [
        "factory effective-push <bootstrap|check> <operator-repository> <sandbox-repository>",
      ]);
      const readmeContracts = [
        ["fresh init receives O", /canonical operator checkout `O` as `--repo O`/u],
        ["S is deterministic", /`S = O\/\.factory-sandboxes\/<run-id>`/u],
        ["init returns selected roots", /returns its canonical `sandbox_path` and absolute `run_dir`/u],
        ["later commands use S", /returned\s+`sandbox_path` as `--repo S`/u],
        ["the clone destination is pre-reserved", /pre-reserves an empty `S`/u],
        ["one local clone is attempted", /exactly one\s+`git clone --local -- O S` attempt/u],
        ["proof precedes publication", /physical containment proof before publishing\s+`run\.json`/u],
        ["collisions are retained", /collision is retained for inspection/u],
        ["collisions are not reused, retried, or deleted", /never\s+reused, retried, or deleted during bootstrap or refusal/u],
        ["branch recovery precedes lock and dispatch", /Branch creation or recovery and provenance checks finish\s+before a lock is claimed or an agent is dispatched/u],
        ["push-target mismatch is redacted", /neither effective target is printed, persisted, or included in an error cause/u],
        ["direct O state is legacy only", /`O\/\.factory\/<run-id>` is supported only as\s+a legacy direct-run location/u],
        ["deletion is Step 7 only", /Sandbox deletion is allowed only during the verified Step 7 completed\s+handoff/u],
      ];
      for (const [contract, pattern] of readmeContracts) {
        assert.match(readme, pattern, `README must document that ${contract}`);
      }
      assert.doesNotMatch(readme, /git clean -xdf/u,
        "README must not advertise an unverified deletion path outside Step 7");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("installs from local tarballs and imports by bare specifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-install-"));
    try {
      const { consumer } = installConsumer(dir);

      // The dependency has to have resolved locally, or the install silently pulled something else.
      const manifest = JSON.parse(readFileSync(
        join(consumer, "node_modules", "opencode-feature-factory", "package.json"), "utf8"));
      const primeManifest = JSON.parse(readFileSync(
        join(consumer, "node_modules", "prime-agent-feature-factory", "package.json"), "utf8"));
      const factory = JSON.parse(readFileSync(
        join(consumer, "node_modules", "feature-factory", "package.json"), "utf8"));
      assert.equal(manifest.dependencies["feature-factory"], factory.version,
        "the installed OpenCode integration must be pinned to the installed factory");
      assert.equal(primeManifest.dependencies["feature-factory"], factory.version,
        "the installed Prime integration must be pinned to the installed factory");
      assert.deepEqual(primeManifest.pi.skills, ["./skills"]);
      assert.deepEqual(primeManifest.pi.extensions, ["./extensions"]);
      assert.deepEqual(factory.exports, { ".": "./state/index.js" },
        "the existing package export must remain sufficient");
      assert.deepEqual(factory.files,
        ["bin", "core", "observe", "state", "WORKFLOW.md", "agents", "README.md", "LICENSE"],
        "the existing files allowlist must ship the contract without generated assets");
      // The integration depends on the factory and nothing else. It registers a tool as a plain
      // object literal rather than through `@opencode-ai/plugin`'s `tool()` helper — that helper is a
      // pass-through, and depending on it would pin a host-coupled package into the packed graph for
      // no behaviour. Both host packages stay absent, so a consumer installs neither.
      for (const absent of ["@opencode-ai/plugin", "@opencode-ai/sdk"]) {
        assert.equal(manifest.dependencies[absent], undefined,
          `the integration must not depend on ${absent}; the host supplies it`);
      }

      // Bare specifiers, so `exports` names and conditions are exercised. Importing a manifest's
      // target path directly — which this test used to do — passes even when the export map is wrong.
      const output = importInConsumer(consumer, `
        const factory = await import("feature-factory");
        const plugin = await import("opencode-feature-factory");
        const tui = await import("opencode-feature-factory/tui");
        const missing = ["readRun", "readRunUnchecked", "nextAction", "validateRun"]
          .filter((name) => typeof factory[name] !== "function");
        if (missing.length) throw new Error("feature-factory is missing: " + missing.join(", "));
        if (typeof plugin.default !== "function") throw new Error("plugin root must default-export a function");
        if (typeof tui.default !== "object" || typeof tui.default.tui !== "function") {
          throw new Error("the tui entry must default-export an object carrying a tui() hook");
        }
        if (factory.transition !== undefined) throw new Error("the write path must not be exported");
        console.log("ok");
      `);
      assert.match(output, /^ok$/mu);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs the CLI through the installed .bin symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-bin-"));
    try {
      const { consumer } = installConsumer(dir);
      const operator = commitOperatorRepository(consumer);
      // `.bin/factory` is a symlink into the package. Invoking the real path instead — which this
      // test used to do — skips the one shape that broke the entry guard: `process.argv[1]` is the
      // symlink as typed while `import.meta.url` is resolved, so a naive comparison of the two makes
      // the CLI exit 0 having done nothing.
      const shim = join(consumer, "node_modules", ".bin", "factory");
      const help = execFileSync("node", [shim, "--help"], { cwd: consumer, encoding: "utf8" });
      assert.match(help, /factory init <run-id>/u, "the CLI must run through the shim and print usage");
      assert.match(help, /--issue KEY/u, "the packed CLI must advertise the active issue flag");
      assert.doesNotMatch(help, /--jira/u, "the packed CLI must not advertise the obsolete flag");

      const init = spawnSync("node", [
        shim, "init", "packed-readme", "--branch", "feature/packed-readme", "--worktree", ".",
        "--pr-base", "main", "--issue", "ISSUE-214", "--mode", "headless", "--repo", operator, "--json",
      ], { cwd: consumer, encoding: "utf8" });
      assert.equal(init.status, 0, init.stderr);
      assert.match(init.stderr, /packed-bootstrap-out/u);
      assert.match(init.stderr, /packed-bootstrap-err/u);
      const initialized = JSON.parse(init.stdout);
      const sandbox = join(operator, ".factory-sandboxes", "packed-readme");
      const runDir = join(sandbox, ".factory", "packed-readme");
      assert.equal(initialized.sandbox_path, sandbox, "installed init must return deterministic S");
      assert.equal(initialized.run_dir, runDir, "installed init must return the absolute run directory in S");
      assert.equal(existsSync(join(operator, ".factory", "packed-readme", "run.json")), false,
        "fresh installed init must not publish a legacy direct record in O");
      const run = JSON.parse(readFileSync(join(initialized.run_dir, "run.json"), "utf8"));
      assert.equal(run.issue_key, "ISSUE-214");
      assert.equal(Object.hasOwn(run, "jira_key"), false);
      assert.equal(run.bootstrap_command, PACKED_BOOTSTRAP_COMMAND);
      assert.equal(run.bootstrap_exit, 0);
      assert.equal(readFileSync(join(sandbox, "packed-bootstrap-cwd"), "utf8"), sandbox);

      // And it must actually do work through the shim, not merely print. Later reads select the
      // returned sandbox explicitly rather than relying on the operator checkout to redirect them.
      const status = execFileSync("node", [
        shim, "status", "packed-readme", "--repo", initialized.sandbox_path, "--json",
      ],
        { cwd: consumer, encoding: "utf8" });
      const selected = JSON.parse(status);
      assert.equal(selected.valid, true, "status must read the initialized record from returned S");
      assert.equal(selected.sandbox_path, initialized.sandbox_path, "status must report the selected S");
      const absent = execFileSync("node", [
        shim, "status", "nope", "--repo", initialized.sandbox_path, "--json",
      ], { cwd: consumer, encoding: "utf8" });
      assert.match(absent, /"valid": false/u, "the CLI must report an absent run rather than crash");

      const workflow = readFileSync(
        join(consumer, "node_modules", "feature-factory", "WORKFLOW.md"), "utf8");
      const opencodeWorkflow = readFileSync(
        join(consumer, "node_modules", "opencode-feature-factory", "skills", "feature", "WORKFLOW.md"), "utf8");
      const primeWorkflow = readFileSync(
        join(consumer, "node_modules", "prime-agent-feature-factory", "skills", "feature", "WORKFLOW.md"), "utf8");
      const packageReadme = readFileSync(
        join(consumer, "node_modules", "feature-factory", "README.md"), "utf8");
      assert.equal(opencodeWorkflow, workflow, "OpenCode must ship the exact factory workflow");
      assert.equal(primeWorkflow, workflow, "Prime must ship the exact factory workflow");
      assertContracts(workflow, SKILL_CONTRACTS, "installed workflow");
      assertContracts(packageReadme, README_CONTRACTS, "installed package README");
      for (const [contract, pattern] of [
        ["init is requested with O", /factory init "\$R" --branch "\$FEATURE_BRANCH"[^\n]*--repo "\$O" --json/u],
        ["S comes from the response", /RUN_REPO="<exact response sandbox_path>"/u],
        ["one local clone follows reservation", /pre-reserves the deterministic sandbox, performs exactly one\s+`git clone --local -- O S`/u],
        ["physical proof precedes run.json", /completes the physical containment proof, and only then publishes\s+`run\.json`/u],
        ["failed init is not retried", /do not substitute another destination or repeat init/u],
        ["push mismatch omits targets", /never contains either target/u],
        ["completed removal is guarded", /Only after all ref and archive verification succeeds, guard the destructive removal/u],
      ]) {
        assert.match(workflow, pattern, `installed workflow must preserve the contract that ${contract}`);
      }
      const recovery = workflow.indexOf("### Feature branch provenance and crash recovery");
      const beforeLock = workflow.indexOf("Immediately before claiming or stealing a lock", recovery);
      const lock = workflow.indexOf('factory lock "$R" claim', beforeLock);
      const dispatch = workflow.indexOf("dispatch the planned ticket", lock);
      assert.ok(recovery >= 0 && recovery < beforeLock && beforeLock < lock && lock < dispatch,
        "installed workflow must recover/prove the branch before lock and dispatch");

      // Executed *directly*, not through `node`. That is the only way the shebang and the executable
      // bit get exercised: npm sets the mode when packing a `bin` entry, and a tarball missing either
      // gives "permission denied" or "syntax error" on a machine where nobody thought to prefix node.
      const direct = execFileSync(shim, ["--help"], { cwd: consumer, encoding: "utf8" });
      assert.match(direct, /factory init <run-id>/u, "the shim must be directly executable");
      const source = readFileSync(join(consumer, "node_modules", "feature-factory", "bin", "factory.js"), "utf8");
      assert.match(source, /^#!\/usr\/bin\/env node\n/u, "and carry a shebang, or direct execution is a syntax error");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
