// Claims the prose makes about what the CLI permits, executed.
//
// Three times in this rebuild a fix shipped carrying a new instance of the defect it fixed, and all
// three were prose: an example naming a removed flag, an instruction reading a field the CLI does not
// expose, and a recovery path the CLI refuses. The ceiling test closed the first class by parsing
// invocations, but it cannot read a *claim* — "amend the plan and re-review it" names no flag and no
// command, and is simply false.
//
// A general prose checker is not worth building. This is the practical version, opencode's shape: a
// small table of high-risk state-machine claims, each binding a prose fragment to a setup, an action,
// and an expected outcome. The fragment is asserted present, so rewording the prose without revisiting
// the behaviour fails here rather than drifting silently.
//
// Add a row when prose starts asserting what the CLI will or will not allow. Do not add one for
// ordinary guidance — this is for claims that would send an operator down a path that does not exist.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initFresh, seedLegacyRun } from "./init-fixture.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(pkg, "bin", "factory.js");
const RUN = "app-1";
const NOW = "2026-07-30T12:00:00Z";
const PASSING_TEST_COMMAND = "git --no-pager log -1 --format=%H";
const FACTORY_ENV = { ...process.env };
delete FACTORY_ENV.FORCE_COLOR;

const PLAN = {
  slices: [{ id: "s1", stack: "backend", paths: ["src/"], depends_on: [], acceptance: ["AC1"], test_plan: [PASSING_TEST_COMMAND] }],
};

function project(name) {
  const repo = mkdtempSync(join(tmpdir(), `ff-claim-${name}-`));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "feature");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "base.ts"), "base\n");
  writeFileSync(join(repo, ".gitignore"), ".factory/\n/.factory-sandboxes/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return repo;
}

function commitConfiguredPath(repo, branch = "integration") {
  const path = join(repo, "configured");
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: repo });
  mkdirSync(path);
  writeFileSync(join(path, "base.ts"), "configured\n");
  execFileSync("git", ["add", "configured"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "configured worktree"], { cwd: repo });
  return path;
}

// Small steps rather than one do-everything fixture: a claim should set up only what it asserts
// about, or every failure is ambiguous about which rule fired.
function decide(repo, gate, decision) {
  factory(repo, ["gate", RUN, gate, "pending", "--now", NOW]);
  return factory(repo, ["gate", RUN, gate, decision, "--now", NOW]);
}

function activateSlice(operator) {
  const initialized = seeded(operator);
  execFileSync("git", ["checkout", "-q", "-b", "slice"], { cwd: initialized.repository });
  writeFileSync(join(initialized.repository, "src", "work.ts"), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: initialized.repository });
  execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: initialized.repository });
  const activated = factory(initialized.repository, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
  assert.equal(activated.ok, true, activated.out);
  const base = /base_ref: ([0-9a-f]{40})/u.exec(activated.out);
  return { ...initialized, base: base?.[1] ?? null };
}

function factory(repo, args) {
  try {
    return { ok: true, out: execFileSync("node", [CLI, ...args, "--repo", repo], { encoding: "utf8", env: FACTORY_ENV }) };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
  }
}

function seeded(operator) {
  const initialized = initFresh(operator, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
  writeFileSync(join(initialized.runDir, "plan", "slices.json"), JSON.stringify(PLAN));
  assert.equal(decide(initialized.repository, "brief", "approved").ok, true);
  assert.equal(factory(initialized.repository, ["slices-seed", RUN, "--now", NOW]).ok, true);
  return initialized;
}

const NEEDS_HUMAN_PROSE = [
  ["persisted-mode", "Persisted mode parks a top-level needs-human stop; after the cause is fixed, explicitly resume it with factory resume before continuing.", "needs-human is final"],
  ["headless", "Headless mode exits its host turn with top-level needs-human parked; a later host must explicitly resume it with factory resume.", "headless needs-human is terminal"],
  ["mode-result", "Mode result needs-human means parked and explicitly resumable; only completed, partial, and blocked are final.", "needs-human is a final result"],
  ["stop-command", "Enter the parked stop with factory terminal R needs-human --reason TEXT; leave it only by explicit factory resume R --session $SESSION_ID --repo S, which refuses unless that session already holds a fresh lock: claim, then verify, then resume.", "terminal needs-human ends the run permanently"],
  ["parked-status", "For top-level needs-human, status exposes the durable next action, but no command may execute it before explicit factory resume.", "terminal:needs-human"],
  ["report", "Report top-level needs-human as parked with its reason and explicit factory resume command.", "report needs-human as final"],
  ["retention", "Retain the sandbox for top-level needs-human while parked, then explicitly resume it after the external fix.", "the retained sandbox cannot resume"],
  ["failed-gate", "An autonomous failed gate parks top-level needs-human; fix the durable gate cause before explicit factory resume.", "a failed gate permanently ends the run"],
  ["gate-restart", "After an autonomous needs-human gate stop, explicitly resume only after the existing pre-lock and ownership checks pass.", "start a replacement run"],
  ["bootstrap-resume-parked", "For configured order 7, the CLI binds the exact raw `run.json` bytes, the validated parked manifest, a forward `updated_at`, and the exact fresh owner before running bootstrap while durable status remains `needs-human`.", "bootstrap changes durable status before execution"],
  ["bootstrap-resume-failure", "An ordinary failure with intact bindings records the exact command and integer or `null` result, advances `updated_at`, remains `needs-human`, preserves progress and the historical result, and refuses; a later explicit resume reruns bootstrap.", "discards the historical result"],
  ["identity-park", "factory terminal \"$R\" needs-human --reason <REASON_TOKEN> --repo \"$RUN_REPO\"", "completed"],
  ["identity-report", "Only after all of those steps succeed report the parked run, `RUN_REPO`, `Status: needs-human`, the exact", "final"],
  ["malformed-evidence", "Malformed verification evidence parks top-level needs-human; fix the evidence source and explicitly resume without editing evidence or run.json.", "malformed evidence makes the run final"],
  ["unsafe-evidence", "Unsafe verification evidence parks top-level needs-human; explicit resume must replay the existing reconciliation path.", "resume may bypass unsafe evidence"],
  ["unsafe-retry", "An unsafe repository-verification retry parks top-level needs-human; clean the external cause before explicit factory resume and merge replay.", "unsafe retry is restart-ineligible forever"],
  ["moved-head", "A moved integration head parks top-level needs-human; restore provenance before explicit factory resume and safety replay.", "a moved head requires hand-finishing"],
  ["replay-safety", "Top-level needs-human remains parked while replay safety is false; explicit resume does not bypass the same safety check.", "needs-human can never be restarted"],
  ["production-defect", "A production defect parks top-level needs-human; after the external fix, explicitly resume the intact run.", "a production defect requires a new run"],
  ["repair-status", "Status is exactly `planned`, `committed`, `verified`, `failed`, `exhausted`, or `needs-human`.", "envelope resume clears this repair-record"],
  ["repair-planned-transition", "`planned → committed|needs-human`", "factory resume resolves the repair-record"],
  ["repair-committed-transition", "`committed → verified|failed|exhausted|needs-human`", "factory resume resolves the repair-record"],
  ["repair-guard", "In Step 4, an eligible repair-record `needs-human` has exactly one exit: the operator explicitly invokes `factory repair-reverify <run-id> <record-id> --session ID`, which reruns the captured trigger at the recorded merge; failed create-only evidence remains blocking, the first canonical pass resolves it permanently, envelope resume cannot clear it, and the unchanged original entry plus every separate re-verification evidence item remain disclosed.", "envelope resume authorizes this repair-record"],
  ["path-amendment", "park `needs-human` with that diagnosis; only the verified owner may use the optional", "resume silently widens ownership"],
  ["generic-stop", "Use terminal needs-human only to park a running envelope; use explicit factory resume after the cause is fixed.", "terminal needs-human is a final outcome"],
  ["generic-retention", "A top-level needs-human sandbox stays retained while parked and continues only after explicit factory resume.", "retained needs-human cannot continue"],
  ["gate-three-repair", "At Gate 3, an eligible repair-record `needs-human` has exactly one exit: the operator explicitly invokes `factory repair-reverify <run-id> <record-id> --session ID`, which reruns the captured trigger at the recorded merge; failed create-only evidence remains blocking, the first canonical pass resolves it permanently, envelope resume cannot clear it, and the unchanged original entry plus every separate re-verification evidence item remain disclosed.", "envelope resume satisfies Gate 3 repair"],
  ["publication-repair", "Before publication, an eligible repair-record `needs-human` has exactly one exit: the operator explicitly invokes `factory repair-reverify <run-id> <record-id> --session ID`, which reruns the captured trigger at the recorded merge; failed create-only evidence remains blocking, the first canonical pass resolves it permanently, envelope resume cannot clear it, and the unchanged original entry plus every separate re-verification evidence item remain disclosed.", "resume makes this repair publishable"],
  ["publication-record", "In final publication, an eligible repair-record `needs-human` has exactly one exit: the operator explicitly invokes `factory repair-reverify <run-id> <record-id> --session ID`, which reruns the captured trigger at the recorded merge; failed create-only evidence remains blocking, the first canonical pass resolves it permanently, envelope resume cannot clear it, and the unchanged original entry plus every separate re-verification evidence item remain disclosed.", "envelope resume erases publication repair"],
  ["handoff", "Completed handoff remains final, while top-level needs-human is parked and requires explicit factory resume.", "needs-human is excluded from resume"],
  ["autonomous-failure", "Autonomous gate failure parks top-level needs-human; quiesce and unlock before a later explicit factory resume.", "autonomous gate failure is final"],
  // The satisfiability check's park. `forbidden` is the drift that matters: an unsatisfiable brief
  // is only caught if the run stops, and "and continue" on this line would invert the rule while
  // leaving every word of the requirement in place.
  ["satisfiability-park", "not work to attempt: park with `needs-human`, name both sides, and", "and continue"],
  ["bounded-loop", "A bounded loop parks top-level needs-human; explicit resume may repark it if the external cause remains unfixed.", "bounded-loop needs-human cannot resume"],
];

const RESUME_ORDER = [
  "Resume order 1 — bind the selected manifest to the intended retained sandbox, prove physical containment, and obtain qualified status for that bound manifest.",
  "Resume order 2 — run the post-selection operator exact-ref-absent guard.",
  "Resume order 3 — complete the existing effective-push proof.",
  "Resume order 4 — accept the feature branch only after existing reflog/provenance, branch/worktree binding, seed ancestry, cleanliness/recovery, and operator exact-ref rechecks pass in their current order.",
  "Resume order 5 — immediately before claiming, rerun the final operator exact-ref-absent guard.",
  "Resume order 6 — claim with the current host session or perform a justified existing steal, then verify qualified status still shows this fresh owner and the parked result originally observed.",
  "Resume order 7 — invoke explicit factory resume with the verified owning session, then verify running status, unchanged historical terminal result, real next action, and the same fresh owner.",
  "Resume order 8 — run only existing post-lock reconciliation for an already-recorded merge, its evidence, and repository verification.",
  "Resume order 9 — continue solely from the newly qualified status.next.",
];

const BOOTSTRAP_POLICY_FRAGMENTS = [
  "Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `pr_draft`; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries.",
  "Configured `bootstrap` is consumed only by CLI-owned fresh init and explicit resume; the workflow consumer validates it but never executes it itself.",
  "When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change.",
  "Bootstrap cleanliness examines tracked worktree and index paths only; untracked dependency output is ignored.",
  "Bootstrap has an independent `900000` millisecond default and budget; it does not change resolver, verify, configured publish, effective-push, push, PR, or Gate 3 behavior.",
  "A successful configured attempt stores the exact command in `bootstrap_command` and the numeric result in paired `bootstrap_exit`.",
  "A configured fresh-init failure retains the deterministic sandbox, emits no init JSON stdout, and leaves `run.json` absent.",
  "For configured order 7, the CLI binds the exact raw `run.json` bytes",
  "Every factory-mediated claim, force-steal, refresh, and release holds `run-json.lock`",
  "A clean zero records the command and exit `0`",
  "child stdout and stderr both routed to CLI stderr",
  "never invoked by resolver, merge verification or replay, direct repository verification, slice or Gate 3 observation, effective push, or publication",
];

const BOOTSTRAP_POLICY_CONTRACTS = [
  ...BOOTSTRAP_POLICY_FRAGMENTS.map((fragment, index) => [
    `fragment-${index}`, fragment, (text) => text.includes(fragment),
  ]),
  ["schema-optionals", "`publishing_identity`, plus only the optional own properties `pr_draft`, `verify_timeout_ms`, `bootstrap`, and", (text) => /root must be a JSON object with the four required own properties `resolve`, `verify`, `publish`, and\s+`publishing_identity`, plus only the optional own properties `pr_draft`, `verify_timeout_ms`, `bootstrap`, and\s+`bootstrap_timeout_ms`/u.test(text)],
  ["command-shapes", "`bootstrap_timeout_ms`. `resolve`, `verify`, `publish`, and `bootstrap` are command strings; every present", (text) => /`resolve`, `verify`, `publish`, and `bootstrap` are command strings; every present\s+command must be non-empty/u.test(text)],
  ["timeout-shape", "safe integers when present, and `bootstrap_timeout_ms` is valid only with a declared `bootstrap`.", (text) => /Both timeout values must be positive\nsafe integers when present, and `bootstrap_timeout_ms` is valid only with a declared `bootstrap`/u.test(text)],
  ["timeout-defaults", "`verify_timeout_ms` and `bootstrap_timeout_ms` each independently default to `900000` milliseconds;", (text) => /`verify_timeout_ms` and `bootstrap_timeout_ms` each independently default to `900000` milliseconds;\s+neither timeout shares or consumes the other's budget/u.test(text)],
  ["bootstrap-precedence", "The two bootstrap keys are known keys. Invalid `bootstrap` outranks missing required entries and every", (text) => /Invalid `bootstrap` outranks missing required entries and every\ntimeout defect, including an invalid or otherwise orphaned bootstrap timeout/u.test(text)],
  ["invalid-bootstrap-refusal", "invalid factory config: .factory.json entry 'bootstrap' must be a non-empty string; no session or run created.", (text) => text.includes("invalid factory config: .factory.json entry 'bootstrap' must be a non-empty string; no session or run created.")],
  ["orphan-timeout-refusal", "invalid factory config: .factory.json entry 'bootstrap_timeout_ms' requires a declared bootstrap command; no session or run created.", (text) => text.includes("invalid factory config: .factory.json entry 'bootstrap_timeout_ms' requires a declared bootstrap command; no session or run created.")],
  ["invalid-timeout-refusal", "invalid factory config: .factory.json entry 'bootstrap_timeout_ms' must be a positive integer; no session or run created.", (text) => text.includes("invalid factory config: .factory.json entry 'bootstrap_timeout_ms' must be a positive integer; no session or run created.")],
  ["timeout-boundary", "below apply only to repository `verify` shell attempts; the bootstrap timeout applies only to CLI-owned", (text) => /verify timeout and bounded retry\nbelow apply only to repository `verify` shell attempts; the bootstrap timeout applies only to CLI-owned\ninit and explicit resume/u.test(text)],
];

function checkNeedsHumanProse(prose) {
  for (const [id, required, forbidden] of NEEDS_HUMAN_PROSE) {
    if (prose.split(required).length !== 2) throw new Error(id);
    const line = prose.split("\n").find((entry) => entry.includes(required));
    if (!line || line.includes(forbidden)) throw new Error(id);
  }
  if ((prose.match(/needs-human/gu) ?? []).length !== NEEDS_HUMAN_PROSE.length + 2) throw new Error("needs-human-count");
}

// Every *executable* resume instruction must pass the session. The command rejects without it, so an
// instruction that omits it tells a driver to run something that cannot succeed -- which is what shipped
// once already: the prose said "with no session flag" while the CLI had just been made to require one.
function checkResumeInvocations(prose) {
  for (const line of prose.split("\n")) {
    if (!/`factory resume [^`]*`/u.test(line)) continue;
    for (const invocation of line.match(/`factory resume [^`]*`/gu) ?? []) {
      if (!invocation.includes("--session")) throw new Error(`resume-invocation-without-session: ${invocation}`);
    }
  }
}

function checkResumeOrder(prose) {
  const markers = prose.split("\n").filter((line) => line.startsWith("Resume order "));
  if (!markers.every((marker, index) => marker === RESUME_ORDER[index]) || markers.length !== RESUME_ORDER.length) {
    throw new Error("resume-order");
  }
}

function checkBootstrapContract(prose, [id, marker, matches]) {
  if (!prose.split("\n").some((entry) => entry.includes(marker)) || !matches(prose)) {
    throw new Error(`bootstrap-policy:${id}`);
  }
}

function checkBootstrapPolicy(prose) {
  for (const contract of BOOTSTRAP_POLICY_CONTRACTS) checkBootstrapContract(prose, contract);
}

function isAsciiWord(byte) {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a)
    || byte === 0x5f || (byte >= 0x61 && byte <= 0x7a);
}

function asciiLower(byte) {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function recognizedReferences(body) {
  const keywords = ["close", "closed", "closes", "fix", "fixed", "fixes", "resolve", "resolved", "resolves"];
  const references = [];
  for (let start = 0; start < body.length; start += 1) {
    if (start > 0 && isAsciiWord(body[start - 1])) continue;
    for (const keyword of keywords) {
      let cursor = start;
      let matches = true;
      for (const expected of Buffer.from(keyword)) {
        if (cursor >= body.length || asciiLower(body[cursor]) !== expected) {
          matches = false;
          break;
        }
        cursor += 1;
      }
      if (!matches) continue;
      while (body[cursor] === 0x20) cursor += 1;
      if (body[cursor] !== 0x23 || body[cursor + 1] < 0x30 || body[cursor + 1] > 0x39) continue;
      cursor += 2;
      while (body[cursor] >= 0x30 && body[cursor] <= 0x39) cursor += 1;
      let lineStart = start;
      while (lineStart > 0 && body[lineStart - 1] !== 0x0a) lineStart -= 1;
      let lineEnd = cursor;
      while (lineEnd < body.length && body[lineEnd] !== 0x0a) lineEnd += 1;
      references.push({ lineStart, lineEnd });
      start = cursor - 1;
      break;
    }
  }
  return references;
}

function transformIssuePublication({ issueKey, title, body }) {
  const originalTitle = Buffer.from(title);
  const originalBody = Buffer.from(body);
  if (typeof issueKey !== "string" || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(issueKey)) {
    return { ok: true, title: originalTitle, body: originalBody };
  }
  const prefix = Buffer.from(`${issueKey} : `);
  // The description marker is a line of its own, not a byte-zero prefix: prefixing inline destroyed
  // leading Markdown, turning `## Summary` into plain text on this change's own PR (#272).
  const bodyMarker = Buffer.from(`${issueKey} :\n\n`);
  const decoratedTitle = Buffer.concat([prefix, originalTitle]);
  let decoratedBody = Buffer.concat([bodyMarker, originalBody]);
  const references = recognizedReferences(originalBody);
  if (!/^[0-9]+$/u.test(issueKey)) {
    return references.length === 0
      ? { ok: true, title: decoratedTitle, body: decoratedBody }
      : { ok: false };
  }
  if (references.length === 0) {
    const separator = decoratedBody.at(-1) === 0x0a ? "\n" : "\n\n";
    decoratedBody = Buffer.concat([decoratedBody, Buffer.from(`${separator}Closes #${issueKey}\n`)]);
    return { ok: true, title: decoratedTitle, body: decoratedBody };
  }
  if (references.length !== 1) return { ok: false };
  const reference = references[0];
  const completeLine = originalBody.subarray(reference.lineStart, reference.lineEnd);
  if (reference.lineStart === 0 || !completeLine.equals(Buffer.from(`Closes #${issueKey}`))) return { ok: false };
  return { ok: true, title: decoratedTitle, body: decoratedBody };
}

const PUBLICATION_FRAGMENTS = {
  close: "For a numeric key with no recognized reference, append exact bytes `\\nCloses #<issue_key>\\n` when the decorated body already ends LF",
  canonical: "For a numeric key with exactly one recognized reference, proceed only when its complete undecorated line is byte-exactly `Closes #<issue_key>` and begins after at least one LF",
  numericRefusal: "For a numeric key, refuse before target comparison or publication on duplicate references, noncanonical spelling, case, spacing, surrounding text, CRLF, or a reference to another issue.",
  prefix: "The description marker occupies its own line followed by one blank line and carries no trailing space",
  nonnumeric: "For a valid nonnumeric key, add both prefixes and no closing reference, and refuse before target comparison or publication if the undecorated body contains any recognized reference.",
  invalid: "For an invalid or absent issue key, do not scan, refuse, prefix, or rewrite because of references; pass the original title and body bytes through exactly, and introduce no closing reference.",
  absent: "An absent `issue_key` is explicitly exempt from the title-prefix, description-prefix, and closing-reference requirements.",
};

function checkPublicationContract(prose) {
  if (!prose.includes(PUBLICATION_FRAGMENTS.close)) {
    throw new Error("publication-policy:missing-no-reference-closing-rule");
  }
}

const PUBLICATION_FIXTURES = [
  ["numeric-lf-no-reference", "270", "Ship", "Summary\n", "270 : Ship", "270 :\n\nSummary\n\nCloses #270\n", PUBLICATION_FRAGMENTS.close],
  ["numeric-non-lf-no-reference", "270", "Ship", "Summary", "270 : Ship", "270 :\n\nSummary\n\nCloses #270\n", PUBLICATION_FRAGMENTS.close],
  ["numeric-canonical-own-line", "270", "Ship", "Summary\nCloses #270\n", "270 : Ship", "270 :\n\nSummary\nCloses #270\n", PUBLICATION_FRAGMENTS.canonical],
  ["numeric-first-line-canonical", "270", "Ship", "Closes #270\n", null, null, PUBLICATION_FRAGMENTS.canonical],
  ["numeric-duplicate", "270", "Ship", "Closes #270\nCloses #270\n", null, null, PUBLICATION_FRAGMENTS.numericRefusal],
  ["numeric-fixes", "270", "Ship", "Fixes #270\n", null, null, PUBLICATION_FRAGMENTS.numericRefusal],
  ["numeric-mixed-case-spaces", "270", "Ship", "cLoSeS  #270\n", null, null, PUBLICATION_FRAGMENTS.numericRefusal],
  ["numeric-inline-surrounded", "270", "Ship", "Text (Closes #270) text\n", null, null, PUBLICATION_FRAGMENTS.numericRefusal],
  ["numeric-crlf", "270", "Ship", "Summary\r\nCloses #270\r\n", null, null, PUBLICATION_FRAGMENTS.numericRefusal],
  ["numeric-other-issue", "270", "Ship", "Closes #271\n", null, null, PUBLICATION_FRAGMENTS.numericRefusal],
  ["hyphenated-clean", "ABC-270", "Ship", "Summary\n", "ABC-270 : Ship", "ABC-270 :\n\nSummary\n", PUBLICATION_FRAGMENTS.prefix],
  ["hyphenated-reference", "ABC-270", "Ship", "Fixes #270\n", null, null, PUBLICATION_FRAGMENTS.nonnumeric],
  ["invalid-byte-identity", "bad_key", "Ship", "Fixes #999\n", "Ship", "Fixes #999\n", PUBLICATION_FRAGMENTS.invalid],
  ["absent-byte-identity", undefined, "Ship", "Fixes #999\n", "Ship", "Fixes #999\n", PUBLICATION_FRAGMENTS.absent],
];

const PUBLICATION_CLAIMS = PUBLICATION_FIXTURES.map(([id, issueKey, title, body, expectedTitle, expectedBody, fragment]) => ({
  id: `publication-${id}`,
  file: "WORKFLOW.md",
  fragment,
  expect: expectedTitle === null ? "refused" : "allowed",
  matches: expectedTitle === null ? /publication refused/u : /publication transformed/u,
  act() {
    const result = transformIssuePublication({ issueKey, title: Buffer.from(title), body: Buffer.from(body) });
    if (expectedTitle === null) return { ok: result.ok, out: "publication refused\n" };
    assert.equal(result.ok, true);
    assert.deepEqual(result.title, Buffer.from(expectedTitle));
    assert.deepEqual(result.body, Buffer.from(expectedBody));
    return { ok: true, out: "publication transformed\n" };
  },
}));

// Each claim: where the prose lives, the exact fragment that makes the claim, and the behaviour it
// asserts. `expect: "refused"` means the CLI must reject; `"allowed"` means it must succeed.
const CLAIMS = [
  ...PUBLICATION_CLAIMS,
  {
    // Step 4's prose promised the opposite of what Gate 3 enforces: "the slices that did merge still reach a
    // PR instead of being discarded", while the pre_pr approval refuses unless *every* slice is `merged`. A
    // real run followed the enforced half -- mimir 1423 went `partial` with three merged slices and published
    // nothing -- and the prose was read as evidence that a correct run had a defect. Prose asserting what the
    // CLI permits, wrongly, is exactly the class this file exists for, so the corrected sentence is pinned to
    // the refusal that makes it true.
    id: "partial-is-surfaced-not-published",
    file: "WORKFLOW.md",
    fragment: "A `partial` run is **surfaced, not published**",
    expect: "refused",
    matches: /every slice/u,
    act(repo) {
      const { repository } = seeded(repo);
      // A seeded-but-unmerged slice is the same shape a partial run reaches: work exists, the plan did not
      // finish. Approving pre_pr is the transition that authorizes publication, so its refusal here is the
      // mechanism the prose now describes. The gate is opened pending first, or the refusal would be about
      // gate sequencing rather than about the unmerged slice, and story is approved because the refusal
      // order checks gates before slices -- reaching the slice check is the whole point of this claim.
      assert.equal(decide(repository, "story", "approved").ok, true);
      return decide(repository, "pre_pr", "approved");
    },
  },
  {
    id: "no-amend-and-reseed",
    file: "agents/work-decomposer.md",
    fragment: "`factory slices-seed` refuses a second seed",
    expect: "refused",
    matches: /slices are already seeded/u,
    act(repo) {
      const { repository, runDir } = seeded(repo);
      const path = join(runDir, "run.json");
      const before = JSON.parse(readFileSync(path, "utf8")).slices
        .map(({ paths, test_plan: testPlan }) => ({ paths, test_plan: testPlan }));
      writeFileSync(join(runDir, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], paths: ["src/", "lib/"], test_plan: ["changed"] }] }));
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: "slices are already seeded\n" });
      const after = JSON.parse(readFileSync(path, "utf8")).slices
        .map(({ paths, test_plan: testPlan }) => ({ paths, test_plan: testPlan }));
      assert.deepEqual(after, before);
      return result;
    },
  },
  {
    id: "parked-owner-may-amend-before-separate-resume",
    file: "agents/work-decomposer.md",
    fragment: "`amend-paths` recovery may append the concrete paths and durable reason before a separate explicit",
    expect: "allowed",
    matches: /status: needs-human[\s\S]*added_paths/u,
    act(repo) {
      const { repository, runDir } = seeded(repo);
      const reason = "  verified omitted path  ";
      assert.equal(factory(repository, ["terminal", RUN, "needs-human", "--reason", reason, "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a"]).ok, true);
      const result = factory(repository, ["amend-paths", RUN, "s1", "--add", "docs/api.md", "--add", "shared/not-created.ts",
        "--reason", reason, "--session", "session-a", "--now", "2026-07-30T12:01:00Z"]);
      assert.equal(result.ok, true, result.out);
      const parked = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.deepEqual(parked.slices[0].paths, ["src/", "docs/api.md", "shared/not-created.ts"]);
      assert.deepEqual(parked.slices[0].path_amendments[0], {
        added_paths: ["docs/api.md", "shared/not-created.ts"], reason, session: "session-a", at: "2026-07-30T12:01:00.000Z",
      });
      assert.deepEqual(parked.slices[0].test_plan, PLAN.slices[0].test_plan);
      assert.equal(factory(repository, ["resume", RUN, "--session", "session-a", "--now", "2026-07-30T12:02:00Z"]).ok, true);
      const resumed = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.deepEqual(resumed.slices[0].path_amendments, parked.slices[0].path_amendments);
      return result;
    },
  },
  {
    id: "terminal-is-the-escape",
    file: "agents/work-decomposer.md",
    fragment: 'factory terminal <run-id> needs-human --reason "<what the plan got wrong>"',
    expect: "allowed",
    matches: /needs-human/u,
    act(repo) {
      const { repository } = seeded(repo);
      return factory(repository, ["terminal", RUN, "needs-human", "--reason", "the plan gave s1 too little scope", "--now", NOW]);
    },
  },
  {
    id: "empty-test-plan-waives-tests",
    file: "agents/work-decomposer.md",
    fragment: "An **empty** array is a deliberate waiver",
    expect: "allowed",
    matches: /review_ready: true/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], test_plan: [] }] }));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      assert.equal(factory(repository, ["slices-seed", RUN, "--now", NOW]).ok, true);
      execFileSync("git", ["checkout", "-q", "-b", "slice"], { cwd: repository });
      writeFileSync(join(repository, "src", "work.ts"), "work\n");
      execFileSync("git", ["add", "-A"], { cwd: repository });
      execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: repository });
      const base = execFileSync("git", ["rev-parse", "feature"], { cwd: repository, encoding: "utf8" }).trim();
      factory(repository, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
      // No --test-cmd on purpose: the waiver is the only thing that can make this review-ready.
      return factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base, "--attempt", "1", "--now", NOW]);
    },
  },
  {
    // `--claim` had no CLI-level coverage at all before this row: `reconcileClaim` was tested as a function,
    // so nothing exercised the argument form, and the one documented use named an undefined variable. A run
    // passed the report inline, the CLI resolved that JSON as a filename, and a committed green slice was
    // discarded on the ENOENT.
    id: "builder-report-is-a-path-resolved-against-run-repo",
    file: "WORKFLOW.md",
    fragment: "`BUILDER_REPORT` is a path and not the report. Write the builder's returned report to",
    expect: "allowed",
    matches: /review_ready: true/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      // Written where the workflow says, and passed as the path the workflow says -- relative to RUN_REPO,
      // which for this file is exactly the documented `.factory/<run-id>/artifacts/...`.
      const reference = join(".factory", RUN, "artifacts", "s1-builder-attempt-1.json");
      writeFileSync(join(repository, reference), JSON.stringify({
        status: "completed", slice: "s1", files_changed: ["src/work.ts"],
        commit, tests: { cmd: PASSING_TEST_COMMAND, exit: 0 }, blockers: [],
      }));
      const result = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--claim", reference, "--now", NOW]);
      assert.equal(result.ok, true, result.out);
      const evidence = JSON.parse(readFileSync(join(runDir, "evidence", "s1.json"), "utf8"));
      // The point of the row: the path form is read, so reconciliation actually ran.
      assert.deepEqual(evidence.claim_reconciliation, { claimed: true, mismatches: [] });
      return result;
    },
  },
  {
    id: "a-claim-that-misstates-the-test-result-is-recorded",
    file: "WORKFLOW.md",
    fragment: "reconciliation compares `commit`,",
    expect: "allowed",
    matches: /review_ready: false/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      const reference = join(".factory", RUN, "artifacts", "s1-builder-attempt-1.json");
      // A builder claiming a pass it did not get, and a commit it did not make. Both are compared.
      writeFileSync(join(repository, reference), JSON.stringify({
        status: "completed", slice: "s1", files_changed: ["src/work.ts"],
        commit: "0".repeat(40), tests: { cmd: PASSING_TEST_COMMAND, exit: 0 }, blockers: [],
      }));
      const result = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--claim", reference, "--now", NOW]);
      assert.equal(result.ok, true, result.out);
      const evidence = JSON.parse(readFileSync(join(runDir, "evidence", "s1.json"), "utf8"));
      assert.equal(evidence.claim_reconciliation.claimed, true);
      assert.deepEqual(evidence.claim_reconciliation.mismatches.map((entry) => entry.field), ["commit", "tests.exit"]);
      return result;
    },
  },
  {
    // The report path carries the attempt, so the attempt has to come from durable state. Ambient "this is
    // the first try" is not merely untidy: the merge compares evidence.attempt to the persisted row and
    // refuses the mismatch, so a driver that guesses spends a build and a review before finding out.
    id: "the-attempt-comes-from-the-persisted-slice-row",
    file: "WORKFLOW.md",
    fragment: "SLICE_ATTEMPT = RECORDED_SLICE.attempts",
    expect: "allowed",
    matches: /review_ready: true/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      // A retry, recorded the way the CLI records one. From here the row says 2 and nothing else may.
      const retried = factory(repository, ["slice", RUN, "s1", "running", "--attempts", "2",
        "--worktree", ".", "--branch", "slice", "--now", NOW]);
      assert.equal(retried.ok, true, retried.out);
      const persisted = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))
        .slices.find((entry) => entry.id === "s1").attempts;
      assert.equal(persisted, 2);

      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      const report = { status: "completed", slice: "s1", files_changed: ["src/work.ts"], commit, tests: { cmd: PASSING_TEST_COMMAND, exit: 0 }, blockers: [] };
      const forAttempt = (attempt) => {
        const reference = join(".factory", RUN, "artifacts", `s1-builder-attempt-${attempt}.json`);
        writeFileSync(join(repository, reference), JSON.stringify(report));
        return reference;
      };

      // Ambient state: the driver assumes attempt 1 and names its report accordingly. `observe` accepts it,
      // which is exactly why the workflow has to bind the attempt -- the cost lands later, at the merge.
      const ambient = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--claim", forAttempt(1), "--now", NOW]);
      assert.equal(ambient.ok, true, ambient.out);
      assert.equal(JSON.parse(readFileSync(join(runDir, "evidence", "s1.json"), "utf8")).attempt, 1);
      // Bound as the workflow binds it, so the merge reaches the attempt comparison rather than refusing
      // earlier for a missing evidence_ref.
      assert.equal(factory(repository, ["slice", RUN, "s1", "review",
        "--evidence-ref", "evidence/s1.json", "--now", NOW]).ok, true);
      const merged = factory(repository, ["slice", RUN, "s1", "merged", "--merge-commit", commit, "--now", NOW]);
      assert.equal(merged.ok, false, "evidence from a guessed attempt must not reach a merge");
      assert.match(merged.out, /is for attempt 1, slice is at attempt 2/u);

      // The persisted attempt, and its own report path. This is the documented spelling.
      const result = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", String(persisted), "--test-cmd", PASSING_TEST_COMMAND, "--claim", forAttempt(persisted), "--now", NOW]);
      assert.equal(result.ok, true, result.out);
      const evidence = JSON.parse(readFileSync(join(runDir, "evidence", "s1.json"), "utf8"));
      assert.equal(evidence.attempt, 2);
      assert.deepEqual(evidence.claim_reconciliation, { claimed: true, mismatches: [] });
      return result;
    },
  },
  {
    // The distinction the requirement rests on: the builder step must supply a claim, while the CLI keeps the
    // flag optional because `test-verifier` and agent steps have no builder report to supply. If the CLI ever
    // required it globally, those subjects could not be observed at all.
    id: "a-subject-with-no-builder-report-still-observes",
    file: "WORKFLOW.md",
    fragment: "**This step requires `--claim`.**",
    expect: "allowed",
    matches: /review_ready: true/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      const result = factory(repository, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW]);
      assert.equal(result.ok, true, result.out);
      const evidence = JSON.parse(readFileSync(join(runDir, "evidence", "test-verifier.json"), "utf8"));
      assert.deepEqual(evidence.claim_reconciliation, { claimed: false, mismatches: [] });
      return result;
    },
  },
  {
    id: "an-inline-claim-names-the-mistake",
    file: "WORKFLOW.md",
    // Single line on purpose: the sentence that follows it wraps, and a fragment spanning the wrap fails
    // for reflow rather than for the rule it guards.
    fragment: "the two flags do not share a coordinate system",
    expect: "refused",
    matches: /--claim expects a path to a JSON file holding the builder's report, not the report itself/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      const inline = JSON.stringify({ status: "completed", slice: "s1", tests: { cmd: PASSING_TEST_COMMAND, exit: 0 } });
      const result = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--claim", inline, "--now", NOW]);
      // Refused before any evidence is written, and the message is about the argument rather than a file that
      // was never supposed to exist.
      assert.ok(!result.out.includes("ENOENT"), `the refusal should not read as a missing file: ${result.out}`);
      assert.equal(existsSync(join(runDir, "evidence", "s1.json")), false);
      return result;
    },
  },
  {
    id: "slice-observe-command-must-be-ratified",
    file: "WORKFLOW.md",
    fragment: "`SLICE_TEST_COMMAND` must be copied verbatim from one persisted ratified `test_plan` entry; `factory observe` refuses any other supplied slice command.",
    expect: "refused",
    matches: /test command for slice 's1' must exactly match one ratified test_plan entry/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      const received = "git --no-pager log -1";
      const result = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", received, "--now", NOW]);
      assert.ok(result.out.includes(`expected ${JSON.stringify(PLAN.slices[0].test_plan)}; received ${JSON.stringify(received)}`));
      assert.equal(existsSync(join(runDir, "evidence", "s1.json")), false);
      return result;
    },
  },
  {
    id: "omitted-test-plan-is-refused",
    file: "agents/work-decomposer.md",
    fragment: "Omitting the field is refused outright",
    expect: "refused",
    matches: /test_plan: must be an array of strings/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      const { test_plan: _omitted, ...withoutTestPlan } = PLAN.slices[0];
      writeFileSync(join(runDir, "plan", "slices.json"),
        JSON.stringify({ slices: [withoutTestPlan] }));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      return factory(repository, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "slices-seed-requires-plan-envelope",
    file: "WORKFLOW.md",
    fragment: "Run `work-decomposer` → `plan/slices.json` (required top-level shape: `{ \"slices\": [...] }`) and the\nhuman-readable `plan/plan.md`.",
    expect: "refused",
    matches: /^plan\/slices\.json must have top-level shape \{ "slices": \[\.\.\.\] \}\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      const path = join(runDir, "run.json");
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN.slices));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const before = readFileSync(path);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: 'plan/slices.json must have top-level shape { "slices": [...] }\n' });
      assert.deepEqual(readFileSync(path), before);
      return result;
    },
  },
  {
    id: "slices-seed-refuses-empty-content",
    file: "agents/work-reviewer.md",
    fragment: "For `work-decomposer`, do not approve unless the supplied `plan/slices.json` is a top-level object with array-valued `slices` (the exact seedable shape `{ \"slices\": [...] }`); inspect only the supplied artifact, not a broader plan schema.",
    expect: "refused",
    matches: /^plan\/slices\.json has no slices\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      const path = join(runDir, "run.json");
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify({ slices: [] }));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const before = readFileSync(path);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: "plan/slices.json has no slices\n" });
      assert.deepEqual(readFileSync(path), before);
      return result;
    },
  },
  {
    id: "brief-approval-binds-the-presented-plan-bytes",
    file: "WORKFLOW.md",
    fragment: "Only after that approval succeeds, invoke the separate first seed using the exact plan bytes that were\npresented.",
    expect: "refused",
    matches: /^plan\/slices\.json changed since the brief gate was presented; re-present it before approving\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      const plan = join(runDir, "plan", "slices.json");
      const path = join(runDir, "run.json");
      assert.equal(decide(repository, "story", "approved").ok, true);
      // Present plan A, then swap the file while the gate is still pending. Binding at approval
      // instead of at presentation would hash B here and call it approved.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--now", NOW]).ok, true);
      const bound = JSON.parse(readFileSync(path, "utf8")).plan_digest;
      assert.match(bound ?? "", /^sha256:[0-9a-f]{64}$/u, "presenting the brief gate must bind the plan bytes");
      writeFileSync(plan, JSON.stringify({ slices: [{ ...PLAN.slices[0], id: "s2", test_plan: [] }] }));
      const before = readFileSync(path);
      const result = factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]);
      assert.deepEqual(result, { ok: false,
        out: "plan/slices.json changed since the brief gate was presented; re-present it before approving\n" });
      assert.deepEqual(readFileSync(path), before, "a refused approval must not touch the manifest");
      // Restoring the presented bytes lets the same approval through, so the guard binds bytes
      // rather than blocking the flow.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).plan_digest, bound, "approval must keep the presented digest");
      return result;
    },
  },
  {
    id: "slices-seed-binds-the-approved-plan-bytes",
    file: "WORKFLOW.md",
    fragment: "Only after that approval succeeds, invoke the separate first seed using the exact plan bytes that were\npresented.",
    expect: "refused",
    matches: /^plan\/slices\.json is not the plan the brief gate approved\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      const plan = join(runDir, "plan", "slices.json");
      const path = join(runDir, "run.json");
      // Approve plan A, then swap the file for a plan B nobody reviewed.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const swapped = { slices: [{ ...PLAN.slices[0], id: "s2", paths: ["other/"], test_plan: [] }] };
      writeFileSync(plan, JSON.stringify(swapped));
      const before = readFileSync(path);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: "plan/slices.json is not the plan the brief gate approved\n" });
      assert.deepEqual(readFileSync(path), before);
      // The approved plan still seeds, so the guard binds bytes rather than blocking the flow.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["slices-seed", RUN, "--now", NOW]).ok, true);
      return result;
    },
  },
  {
    id: "slices-seed-requires-brief-approval",
    file: "WORKFLOW.md",
    fragment: "Never invoke `slices-seed` before Brief approval.",
    expect: "refused",
    matches: /^slices-seed requires the Brief gate to be approved\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.deepEqual(run.slices, []);
      assert.equal(run.gates.story.status, "approved");
      assert.equal(run.gates.brief, undefined);
      return result;
    },
  },
  {
    id: "brief-approval-records-unseeded-state",
    file: "WORKFLOW.md",
    fragment: "On approval, record only the Brief decision. This produces a durable Brief-approved, zero-slices state",
    expect: "allowed",
    matches: /"brief": "approved"[\s\S]*"slices": \[\][\s\S]*"next": "seed-slices"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.equal(run.gates.brief.status, "approved");
      assert.deepEqual(run.slices, []);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "approved-plan-uses-separate-first-seed",
    file: "WORKFLOW.md",
    fragment: "Only after that approval succeeds, invoke the separate first seed",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const status = factory(repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(status.out).next, "seed-slices");
      return factory(repository, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "pending-brief-changes-loop-represents-revised-plan",
    file: "WORKFLOW.md",
    fragment: "`pending` → `changes` → revise → `pending` → re-present → decision.",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      const planPath = join(runDir, "plan", "slices.json");
      writeFileSync(planPath, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "changes", "--now", NOW]).ok, true);
      assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).slices, []);
      const revised = { slices: [{ ...PLAN.slices[0], paths: ["src/revised/"] }] };
      writeFileSync(planPath, JSON.stringify(revised));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).slices[0].paths, revised.slices[0].paths);
      return result;
    },
  },
  {
    id: "failed-first-seed-retries-identical-presented-bytes",
    file: "WORKFLOW.md",
    fragment: "restore the exact unchanged presented bytes and retry that\nfirst seed.",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      const planPath = join(runDir, "plan", "slices.json");
      const presented = `${JSON.stringify(PLAN, null, 2)}\n`;
      writeFileSync(planPath, presented);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      rmSync(planPath);
      const failed = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.equal(failed.ok, false);
      assert.match(failed.out, /^could not read plan\/slices\.json:/u);
      const status = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(status.gates.brief, "approved");
      assert.deepEqual(status.slices, []);
      assert.equal(status.next, "seed-slices");
      writeFileSync(planPath, presented);
      assert.equal(readFileSync(planPath, "utf8"), presented);
      return factory(repository, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "approved-plan-reopens-before-byte-change",
    file: "WORKFLOW.md",
    fragment: "reopen the approved\nBrief directly to `pending` **before mutating the plan**",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      const planPath = join(runDir, "plan", "slices.json");
      const presented = JSON.stringify(PLAN);
      writeFileSync(planPath, presented);
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--now", NOW]).ok, true);
      assert.equal(readFileSync(planPath, "utf8"), presented);
      const revised = { slices: [{ ...PLAN.slices[0], test_plan: ["git status --short"] }] };
      writeFileSync(planPath, JSON.stringify(revised));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).slices[0].test_plan, revised.slices[0].test_plan);
      return result;
    },
  },
  {
    id: "approved-unseeded-status-outranks-later-work",
    file: "WORKFLOW.md",
    fragment: "whose status reports `next: seed-slices`",
    expect: "allowed",
    matches: /"next": "seed-slices"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      assert.equal(factory(repository, ["step", RUN, "test-verifier", "running", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "pre_pr", "pending", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "active-driver-owns-state-transitions",
    file: "WORKFLOW.md",
    fragment: "The active run driver owns every state-changing `factory` command for\nits run.",
    expect: "allowed",
    matches: /"story": "pending"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "exact-gate-artifact-map",
    file: "WORKFLOW.md",
    // The coordinate system travels with the map. Pinning only the three paths leaves the two facts that
    // make them usable -- that the reference is run-relative and that its physical home is the run
    // directory -- free to be deleted or contradicted.
    fragment: "| Story | `story` | `artifacts/story.md` |\n| Brief | `brief` | `artifacts/technical-brief.md` |\n| Pre-PR | `pre_pr` | `gates/pre_pr.md` |\n\nThose references are run-relative, and the CLI stores `--artifact` verbatim.\nA run-relative reference `X` is physically `$RUN_REPO/.factory/$R/X`: create and read every artifact there,",
    expect: "allowed",
    matches: /gate: pre_pr\nstatus: pending/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      // Two separately stated things, and the duplication is the whole point. `physical` is where the run
      // puts each artifact under the run directory; `artifacts` is the reference spelling handed to
      // `--artifact`. Deriving the write path from the reference -- the obvious way to write this -- makes
      // the test tautological: the file lands wherever the reference points, so no reference can ever fail
      // to resolve. Keeping them independent is what lets a changed coordinate system fail here.
      const physical = {
        story: "artifacts/story.md",
        brief: "artifacts/technical-brief.md",
        pre_pr: "gates/pre_pr.md",
      };
      const artifacts = {
        story: "artifacts/story.md",
        brief: "artifacts/technical-brief.md",
        pre_pr: "gates/pre_pr.md",
      };
      for (const location of Object.values(physical)) {
        mkdirSync(dirname(join(runDir, location)), { recursive: true });
        writeFileSync(join(runDir, location), `${location}\n`);
      }
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", artifacts.story, "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "approved", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", artifacts.brief, "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repository, ["gate", RUN, "pre_pr", "pending", "--artifact", artifacts.pre_pr, "--now", NOW]);
      assert.equal(result.ok, true, result.out);
      const gates = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).gates;
      assert.equal(gates.story.artifact, artifacts.story);
      assert.equal(gates.brief.artifact, artifacts.brief);
      assert.equal(gates.pre_pr.artifact, artifacts.pre_pr);
      // Resolution, not just storage: each persisted reference, joined onto the run directory, must land on
      // the file written at its independently stated physical location. A repository-relative `--artifact`
      // spelling fails here, because `.factory/<run-id>/artifacts/story.md` resolves from the run directory
      // to `.factory/<run-id>/.factory/<run-id>/artifacts/story.md`, which nothing created.
      for (const [name, location] of Object.entries(physical)) {
        assert.equal(existsSync(join(runDir, gates[name].artifact)), true,
          `${name}: persisted reference ${gates[name].artifact} does not resolve under the run directory`);
        assert.equal(readFileSync(join(runDir, gates[name].artifact), "utf8"), `${location}\n`,
          `${name}: persisted reference resolves to something other than the artifact written at ${location}`);
        assert.equal(existsSync(join(runDir, ".factory", RUN, location)), false,
          `${name}: a repository-relative spelling must not resolve under the run directory`);
      }
      return result;
    },
  },
  {
    id: "same-background-session-changes-and-represents",
    file: "WORKFLOW.md",
    fragment: "`changes-at-gate:<name>`, revises only the affected stage, and re-presents it pending.",
    expect: "allowed",
    matches: /gate: story\nstatus: pending/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      const verified = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(verified.mode, "interactive");
      assert.equal(verified.gates.story, "pending");
      assert.equal(verified.lock_session, "session-a");
      assert.equal(factory(repository, ["gate", RUN, "story", "changes", "--now", NOW]).ok, true);
      assert.equal(JSON.parse(factory(repository, ["status", RUN, "--json"]).out).next, "changes-at-gate:story");
      writeFileSync(join(runDir, "artifacts", "story.md"), "revised story\n");
      return factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]);
    },
  },
  {
    id: "same-background-session-stops-unlocked-and-nonterminal",
    file: "WORKFLOW.md",
    fragment: "This is an unlocked\nnonterminal stop: do not terminalize it",
    expect: "allowed",
    matches: /"lock": "absent"[\s\S]*"story": "stop"[\s\S]*"terminal_result": null[\s\S]*"next": "stopped-at-gate:story"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      const verified = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(verified.mode, "interactive");
      assert.equal(verified.gates.story, "pending");
      assert.equal(verified.lock_session, "session-a");
      assert.equal(factory(repository, ["gate", RUN, "story", "stop", "--now", NOW]).ok, true);
      const stopped = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(stopped.next, "stopped-at-gate:story");
      assert.equal(stopped.terminal_result, null);
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      const result = factory(repository, ["status", RUN, "--json"]);
      const unlocked = JSON.parse(result.out);
      assert.equal(unlocked.lock, "absent");
      assert.equal(unlocked.lock_session, null);
      assert.equal(unlocked.next, "stopped-at-gate:story");
      assert.equal(unlocked.terminal_result, null);
      return result;
    },
  },

  // opencode's next five, in its order. Each was enforced and unstated, or stated and unproven.
  {
    id: "seeded-plan-freezes-an-approved-gate",
    file: "WORKFLOW.md",
    fragment: "**Once the plan is seeded, only Gate 3 may re-open.**",
    expect: "refused",
    matches: /gate 'story' cannot be re-opened once approved and its plan is seeded/u,
    act(repo) {
      const { repository } = seeded(repo);
      assert.equal(decide(repository, "story", "approved").ok, true);
      return factory(repository, ["gate", RUN, "story", "pending", "--now", NOW]);
    },
  },
  // The other side of the same line. A run that discovers at spec time that its approved story
  // contradicts itself has nothing built to strand, and blocking it cost a whole run.
  {
    id: "unseeded-approved-gate-still-reopens",
    file: "WORKFLOW.md",
    fragment: "**Before the plan is seeded, an approved gate still re-opens**",
    expect: "allowed",
    matches: /"story": "approved"/u,
    act(repo) {
      // Initialized but *not* seeded — that is the whole distinction.
      const { repository } = initFresh(repo, [RUN, "--branch", "work", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  // The other half of that rule, and the reason it is stated in two halves: the first live run
  // asked for a story change at Gate 1, found the gate frozen, and abandoned the run for a
  // replacement. `changes` asks for another round, so the round has to be reachable.
  {
    id: "changes-reopens-at-any-gate",
    file: "WORKFLOW.md",
    fragment: "**`changes` is a request for another round, not the end of the run.**",
    expect: "allowed",
    matches: /"story": "approved"/u,
    act(repo) {
      const { repository } = seeded(repo);
      assert.equal(decide(repository, "story", "changes").ok, true);
      // The revision is a *different* document, which is the point: a decided gate's artifact is
      // frozen, so pointing at the new one has to go through the re-open.
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "pre-pr-may-reopen",
    file: "WORKFLOW.md",
    fragment: "factory gate <run-id> pre_pr pending",
    expect: "allowed",
    matches: /status: pending/u,
    act(repo) {
      const { repository } = seeded(repo);
      // Decided as `changes` rather than `approved`: approving pre_pr runs the publication check,
      // which this claim is not about.
      assert.equal(decide(repository, "pre_pr", "changes").ok, true, "a decided gate is the precondition");
      return factory(repository, ["gate", RUN, "pre_pr", "pending", "--now", NOW]);
    },
  },
  {
    id: "publication-needs-all-three-gates",
    file: "WORKFLOW.md",
    fragment: "**all three gates currently approved**",
    expect: "refused",
    matches: /every gate must be approved; not approved: story\(absent\)/u,
    act(repo) {
      const { repository } = seeded(repo);
      // pre_pr alone, which is all the old check consulted.
      return decide(repository, "pre_pr", "approved");
    },
  },
  {
    id: "merge-needs-two-parents",
    file: "WORKFLOW.md",
    fragment: "refuses a merge commit that does not have exactly two parents",
    expect: "refused",
    matches: /has 1 parent; a slice merge must be a two-parent merge \(use --no-ff\)/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      // Everything the merge proof needs *except* two parents, so only that rule can explain the
      // refusal — the masking trap this suite keeps rediscovering.
      const observed = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW]);
      assert.match(observed.out, /review_ready: true/u, observed.out);
      const head = execFileSync("git", ["rev-parse", "slice"], { cwd: repository, encoding: "utf8" }).trim();
      writeFileSync(join(runDir, "reviews", "s1.json"), JSON.stringify({
        subject: "s1", reviewer: "work-reviewer", verdict: "APPROVE", attempt: 1,
        reviewed_commit: head, findings: [], required_fixes: [], checked_against: ["brief"],
      }));
      factory(repository, ["slice", RUN, "s1", "review", "--evidence-ref", "evidence/s1.json",
        "--review-ref", "reviews/s1.json", "--now", NOW]);
      execFileSync("git", ["checkout", "-q", "work"], { cwd: repository });
      execFileSync("git", ["merge", "-q", "--ff-only", "slice"], { cwd: repository });
      const merged = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      return factory(repository, ["slice", RUN, "s1", "merged", "--merge-commit", merged, "--now", NOW]);
    },
  },
  {
    id: "base-ref-immutable-after-activation",
    file: "WORKFLOW.md",
    fragment: "`base_ref` is fixed when the slice is activated and cannot be changed afterwards",
    expect: "refused",
    matches: /base_ref is immutable once recorded/u,
    act(repo) {
      const { repository, base } = activateSlice(repo);
      assert.match(String(base), /^[0-9a-f]{40}$/u, "activation must report the base it recorded");
      // Move the branch, then re-activate. The CLI observes the *new* head, so if base_ref were
      // writable twice this would silently re-point the slice's diff baseline.
      execFileSync("git", ["checkout", "-q", "work"], { cwd: repository });
      writeFileSync(join(repository, "src", "later.ts"), "later\n");
      execFileSync("git", ["add", "-A"], { cwd: repository });
      execFileSync("git", ["commit", "-q", "-m", "later"], { cwd: repository });
      return factory(repository, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
    },
  },
  {
    id: "init-needs-no-branch-or-worktree",
    file: "WORKFLOW.md",
    fragment: "**Do not ask the engineer for a branch or worktree.**",
    expect: "allowed",
    matches: /branch: feature\/app-1/u,
    act(repo) {
      // The whole invocation an orchestrator should need. Both required flags are gone, and what was
      // recorded is reported back so the branch it must create is not left implicit.
      execFileSync("git", ["checkout", "-q", "-b", "main"], { cwd: repo });
      execFileSync("git", ["branch", "-D", "feature"], { cwd: repo });
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      assert.equal(initialized.response.branch, `feature/${RUN}`);
      assert.equal(initialized.response.worktree, ".");
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "pr-base-uses-configured-worktree",
    file: "WORKFLOW.md",
    fragment: "Otherwise require the symbolic branch in the configured operator worktree",
    expect: "allowed",
    matches: /pr_base: integration/u,
    act(repo) {
      const configured = commitConfiguredPath(repo);
      assert.equal(execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: configured, encoding: "utf8" }).trim(), "integration");
      const initialized = initFresh(repo, [RUN, "--worktree", "configured", "--now", NOW]);
      assert.equal(existsSync(join(initialized.repository, "configured")), true);
      assert.equal(initialized.response.worktree, "configured");
      assert.equal(initialized.response.pr_base, "integration");
      const status = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(status.ok, true, status.out);
      assert.equal(JSON.parse(status.out).pr_base, "integration");
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "pr-base-override-bypasses-worktree-observation",
    file: "WORKFLOW.md",
    fragment: "An explicit `PR_BASE` wins.",
    expect: "allowed",
    matches: /pr_base: release\/1/u,
    act(repo) {
      commitConfiguredPath(repo);
      execFileSync("git", ["branch", "release/1", "HEAD"], { cwd: repo });
      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
      execFileSync("git", ["branch", "-D", "integration"], { cwd: repo });
      const initialized = initFresh(repo, [RUN, "--worktree", "configured", "--pr-base", "release/1", "--now", NOW]);
      assert.equal(existsSync(join(initialized.repository, "configured")), true);
      assert.equal(initialized.response.worktree, "configured");
      const status = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(status.ok, true, status.out);
      assert.equal(JSON.parse(status.out).pr_base, "release/1");
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "detached-pr-base-is-refused",
    file: "WORKFLOW.md",
    fragment: "detached, missing, escaping, or unprovable worktree state is refused by init.",
    expect: "refused",
    matches: /could not observe a symbolic branch in PR base worktree '\.' for sandbox/u,
    act(repo) {
      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
      execFileSync("git", ["branch", "-D", "feature"], { cwd: repo });
      const result = factory(repo, ["init", RUN, "--now", NOW]);
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      assert.equal(existsSync(join(sandbox, ".git")), true);
      assert.equal(existsSync(join(sandbox, ".factory", RUN, "run.json")), false);
      return result;
    },
  },
  {
    id: "missing-pr-base-worktree-is-refused",
    file: "WORKFLOW.md",
    fragment: "detached, missing, escaping, or unprovable worktree state is refused by init.",
    expect: "refused",
    matches: /physical containment could not be proved for sandbox/u,
    act(repo) {
      const result = factory(repo, ["init", RUN, "--worktree", "missing", "--now", NOW]);
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      assert.equal(existsSync(join(sandbox, ".git")), true);
      assert.equal(existsSync(join(sandbox, ".factory", RUN, "run.json")), false);
      return result;
    },
  },
  {
    id: "outside-pr-base-worktree-is-refused",
    file: "WORKFLOW.md",
    fragment: "detached, missing, escaping, or unprovable worktree state is refused by init.",
    expect: "refused",
    matches: /configured worktree escapes the sandbox/u,
    act(repo) {
      const sentinel = join(repo, "outside-sentinel");
      writeFileSync(sentinel, "outside stays\n");
      const result = factory(repo, ["init", RUN, "--worktree", repo, "--now", NOW]);
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      assert.equal(existsSync(join(sandbox, ".git")), true);
      assert.equal(existsSync(join(sandbox, ".factory", RUN, "run.json")), false);
      assert.equal(readFileSync(sentinel, "utf8"), "outside stays\n");
      return result;
    },
  },
  {
    id: "existing-new-manifest-is-resumed-not-reinitialized",
    file: "WORKFLOW.md",
    fragment: "Once a manifest candidate exists, do\nnot call `factory init` again or backfill a missing legacy `pr_base`.",
    expect: "refused",
    matches: /run 'app-1' already exists at '.*run\.json'; run status\/resume with --repo/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      const path = join(initialized.runDir, "run.json");
      const before = readFileSync(path, "utf8");
      const result = factory(repo, ["init", RUN, "--pr-base", "other", "--now", NOW]);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.match(result.out, new RegExp(initialized.repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      const status = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(status.out).valid, true);
      return result;
    },
  },
  {
    id: "existing-manifest-resumes-from-status",
    file: "WORKFLOW.md",
    fragment: "run `factory status <run-id> --json` and resume; never",
    expect: "allowed",
    matches: /"valid": true[\s\S]*"next": "gate:story"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "existing-legacy-manifest-is-resumed-not-backfilled",
    file: "WORKFLOW.md",
    fragment: "Once a manifest candidate exists, do\nnot call `factory init` again or backfill a missing legacy `pr_base`.",
    expect: "refused",
    matches: /run 'app-1' already exists at '.*run\.json'; run status\/resume with --repo/u,
    act(repo) {
      const { runDir } = seedLegacyRun(repo, RUN, { branch: "feature", pr_base: undefined });
      const path = join(runDir, "run.json");
      const before = readFileSync(path, "utf8");
      const result = factory(repo, ["init", RUN, "--pr-base", "other", "--now", NOW]);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(Object.hasOwn(JSON.parse(before), "pr_base"), false);
      return result;
    },
  },
  {
    id: "scaffold-only-sandbox-is-retained",
    file: "WORKFLOW.md",
    fragment: "A refused or uncertain init retains its\nreported state and path for inspection; do not substitute another destination or repeat init.",
    expect: "refused",
    matches: /sandbox destination '.*\.factory-sandboxes\/app-1' already exists without a manifest; it was not reused, changed, or deleted/u,
    act(repo) {
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      const scaffold = join(sandbox, ".factory", RUN, "plan");
      mkdirSync(scaffold, { recursive: true });
      const sentinel = join(scaffold, "sentinel");
      writeFileSync(sentinel, "scaffold stays\n");
      const result = factory(repo, ["init", RUN, "--now", NOW]);
      assert.equal(readFileSync(sentinel, "utf8"), "scaffold stays\n");
      assert.equal(existsSync(join(sandbox, ".git")), false);
      return result;
    },
  },
  {
    id: "new-status-exposes-pr-base",
    file: "WORKFLOW.md",
    fragment: "Only a\nsuccessful JSON response selects paths.",
    expect: "allowed",
    matches: /pr_base: feature/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      const json = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(json.out).pr_base, "feature");
      assert.equal(JSON.parse(json.out).pr_draft, true);
      const plain = factory(initialized.repository, ["status", RUN]);
      assert.match(plain.out, /^pr_draft: true$/mu);
      return plain;
    },
  },
  {
    id: "explicit-false-status-exposes-ready-policy",
    file: "WORKFLOW.md",
    fragment: 'The ready-for-review publication signature is `gh pr create --base "<pr_base>" --head "<branch>" --title "<title>" --body-file "<body-file>"`.',
    expect: "allowed",
    matches: /pr_draft: false/u,
    act(repo) {
      writeFileSync(join(repo, ".factory.json"), `${JSON.stringify({ resolve: "true", verify: "true", publish: "true", publishing_identity: "test", pr_draft: false })}
`);
      execFileSync("git", ["add", ".factory.json"], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "configure ready policy"], { cwd: repo });
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      assert.equal(Object.hasOwn(initialized.response, "pr_draft"), false);
      const json = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(json.out).pr_draft, false);
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "unknown-init-outcome-stops-on-invalid-manifest",
    file: "WORKFLOW.md",
    fragment: "An invalid candidate is surfaced and never replaced.",
    expect: "allowed",
    matches: /"valid": false[\s\S]*"error": "run: unknown keys: unexpected"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      const path = join(initialized.runDir, "run.json");
      const run = JSON.parse(readFileSync(path, "utf8"));
      run.unexpected = true;
      writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
      const before = readFileSync(path, "utf8");
      const result = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(readFileSync(path, "utf8"), before);
      return result;
    },
  },
  {
    id: "unknown-init-outcome-stops-on-missing-steps-manifest",
    file: "WORKFLOW.md",
    fragment: "An invalid candidate is surfaced and never replaced.",
    expect: "allowed",
    matches: /"valid": false[\s\S]*steps/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      const path = join(initialized.runDir, "run.json");
      const run = JSON.parse(readFileSync(path, "utf8"));
      delete run.steps;
      writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
      const before = readFileSync(path);
      let result;
      assert.doesNotThrow(() => { result = factory(initialized.repository, ["status", RUN, "--json"]); });
      assert.equal(result.ok, true);
      const parsed = JSON.parse(result.out);
      assert.equal(parsed.valid, false);
      assert.match(parsed.error, /steps/u);
      assert.equal(Object.hasOwn(parsed, "next"), false);
      assert.deepEqual(readFileSync(path), before);
      return result;
    },
  },
  {
    id: "legacy-step-six-requires-human-base-without-inference-or-backfill",
    file: "WORKFLOW.md",
    fragment: "For a legacy manifest where `pr_base` is absent or null, stop and\nrequire a human/operator to choose or confirm the exact target, then pass that value through\n`gh pr create --base`. Never infer it from HEAD, the feature branch, repository or forge defaults, and\nnever backfill the legacy manifest.",
    expect: "allowed",
    matches: /"pr_base": null/u,
    act(repo) {
      const { repository, runDir } = seedLegacyRun(repo, RUN, { branch: "feature", pr_base: undefined });
      const path = join(runDir, "run.json");
      const before = readFileSync(path, "utf8");
      const plain = factory(repository, ["status", RUN]);
      assert.equal(plain.out.includes("pr_base:"), false);
      const result = factory(repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(result.out).pr_draft, true);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(Object.hasOwn(JSON.parse(before), "pr_base"), false);
      assert.equal(Object.hasOwn(JSON.parse(before), "pr_draft"), false);
      return result;
    },
  },
  {
    id: "step-six-reads-recorded-pr-base",
    file: "WORKFLOW.md",
    fragment: "gh pr create --draft --base \"<pr_base>\" --head \"<branch>\" --title \"<title>\" --body-file \"<body-file>\"",
    expect: "allowed",
    matches: /"pr_base": "feature"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "repository-resolver-contract-declares-its-own-intake",
    file: "WORKFLOW.md",
    fragment: BOOTSTRAP_POLICY_CONTRACTS[0][1],
    expect: "allowed",
    matches: /"run_id": "205"/u,
    act(repo) {
      const prose = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
      const configured = /#### Configured resolver path\n\n([\s\S]*?)\n\n#### Absence means no repository resolver/u.exec(prose)?.[1] ?? "";
      const absence = /#### Absence means no repository resolver\n\n([\s\S]*?)\n\n#### Resolver and repository verification boundaries/u.exec(prose)?.[1] ?? "";
      const boundaries = /#### Resolver and repository verification boundaries\n\n([\s\S]*?)\n\n#### Remaining intake classification/u.exec(prose)?.[1] ?? "";
      const checkPublishingIdentityConfig = (text) => {
        assert.match(text, /Retain the validated `publishing_identity` string exactly as parsed, without trimming,\s+normalizing, case-folding, or reserializing it, as `DECLARED_PUBLISHING_IDENTITY` for this driver\s+invocation/u);
        assert.match(text, /Do not tighten the existing non-whitespace validation to the observed-login grammar/u);
        assert.match(text, /Do not bind `DECLARED_PUBLISHING_IDENTITY` and skip every publishing-identity\s+guard, preserving the existing behavior/u);
        assert.match(text, /`resolve`, `verify`, and `publishing_identity` are consumed now\. Configured `publish` remains unconsumed and is not invoked\./u);
        assert.match(text, /Effective push-target capture and comparison are active through the package-owned <code>factory effective-push<\/code> command; they are not deferred to configured `publish`\./u);
        assert.match(text, /`publishing_identity` \| No runtime input; retain the raw validated config string for this driver invocation \| Exact case-sensitive string compared with the observed login[\s\S]*Active at the three mandatory guards below; absent config preserves existing behavior/u);
        assert.doesNotMatch(text, /remains deferred to #224|push-target migration is deferred|`publish` and `publishing_identity` remain deferred|consumption is deferred to #216/u);
      };
      checkPublishingIdentityConfig(prose);
      checkBootstrapPolicy(prose);
      for (const contract of BOOTSTRAP_POLICY_CONTRACTS) {
        const [id, marker] = contract;
        assert.throws(
          () => checkBootstrapContract(prose.replace(marker, ""), contract),
          (error) => error.message === `bootstrap-policy:${id}`,
        );
      }
      for (const marker of [
        "Retain the validated `publishing_identity` string exactly as parsed",
        "Do not tighten the existing non-whitespace validation",
        "Do not bind `DECLARED_PUBLISHING_IDENTITY`",
        "Configured `publish` remains unconsumed and is not invoked.",
        "Effective push-target capture and comparison are active through the package-owned <code>factory effective-push</code> command",
        "Active at the three mandatory guards below",
      ]) assert.throws(() => checkPublishingIdentityConfig(prose.replace(marker, "")));
      assert.match(prose, /`publishing_identity` is a static non-empty publishing account name in the\s+file itself, not a command, token, credential, or command result/u);
      assert.match(prose, /Credential values must not appear in the file/u);
      assert.match(prose, /An absent `\$O\/\.factory\.json` means no resolver is declared/u);
      assert.match(prose, /This refusal stops under the same effect-free boundary as every configured resolver refusal below/u);
      assert.match(configured, /configured string unchanged as one ordinary shell step, with exact cwd `O`, the inherited\nenvironment plus `FACTORY_INPUT`, and no positional argument or structured stdin/u);
      assert.match(configured, /`FACTORY_INPUT` is\nthe exact admitted request remainder after mode-prefix removal, preserving its whitespace and bytes/u);
      assert.match(configured, /Exit zero with exactly zero stdout bytes means the resolver did not recognize an issue reference/u);
      assert.match(configured, /Exit zero with non-empty stdout means stdout itself is `ISSUE_PAYLOAD`/u);
      assert.match(configured, /canonical top-level string `run_id`, a non-empty string `title`, and a string `body`/u);
      // #213 promised title and body as the minimum payload; validating only run_id left
      // `{"run_id":"x"}` dispatchable, with story-reader discovering the gap downstream.
      assert.match(configured, /Validate `run_id`, `title`, and `body` — presence and type — before binding `R`/u);
      assert.match(configured, /exact same stdout bytes unchanged to `story-reader` as\n   `ISSUE_PAYLOAD`/u);
      assert.match(configured, /configured `run_id` must match `\^\[a-z0-9\]\(\?:\[a-z0-9\._-\]\*\[a-z0-9\]\)\?\$`/u);
      assert.match(configured, /digit-only value must be\npositive decimal without leading zeroes\. Bind `R` exactly to that value/u);
      assert.match(configured, /becomes the adapter run ID, expected-ID comparison value, manifest candidate name,\nsandbox name, and default feature-branch suffix/u);
      for (const refusal of [
        "invalid factory config: .factory.json; no session or run created.",
        "invalid factory config: .factory.json entry 'verify_timeout_ms' must be a positive integer; no session or run created.",
        "factory config entry 'resolve' returned malformed payload for reference <reference>; no session or run created.",
        "factory config entry 'resolve' failed for reference <reference> with exit status <status>; no session or run created.",
        "factory config entry 'resolve' failed for reference <reference>; exit status unavailable; no session or run created.",
      ]) assert.ok(prose.includes(refusal), `resolver refusal is missing: ${refusal}`);
      assert.match(configured, /refusals stop before canonical run selection, placement dispatch, manifest or state reads,\nsandbox creation, every `factory` command, or specialist dispatch/u);
      assert.match(configured, /They never continue through the ticket, `story-reader`, or\n`story-writer` paths/u);
      assert.match(configured, /Never print,\nquote, reproduce, log, or persist the configured command string, an expanded or resolved command line,\ncredentials, or shell\/tool diagnostics/u);
      // Blocker 2: a refusal that names only the entry leaves an operator resolving several references
      // unable to tell which one failed. The reference is the operator's own input, so naming it
      // discloses nothing the non-disclosure rule protects -- command text and credentials still never
      // appear.
      assert.match(configured, /`<reference>` is `FACTORY_INPUT` exactly as admitted, truncated to its\nfirst 200 characters/u);
      assert.match(configured, /without the reference an operator resolving several references cannot\ntell which one failed/u);
      assert.doesNotMatch(configured, /GitHub|\bgh\s+(?:repo|issue)\b|\b(?:curl|wget)\b|["']recognized["']|command runner|parser service|\bbridge\b|\bprotocol\b|\bcache\b|payload handoff|output-size|\btimeout\b|\bretry\b|\bbuffering\b|\btruncation\b|\bredaction\b|\bstderr\b|session (?:field|key|persistence|title)/iu);
      assert.match(absence, /An absent `\$O\/\.factory\.json` means this repository declares no resolver/u);
      assert.match(absence, /Do not recognize, fetch, or\nresolve a reference/u);
      assert.match(absence, /There is no\nbuilt-in tracker grammar and no built-in fetch command anywhere in this skill/u);
      assert.match(absence, /Recognition belongs to the declaration for the same reason fetching does/u);
      assert.match(absence, /This repository declares its own in `\.factory\.json`, so `205`, `#205`, and the canonical issue URL still\nselect run `205`/u);
      // The first acceptance criterion of #213, asserted over the whole skill rather than one section:
      // the shipped skill names no tracker and fetches from none. A default that reappears anywhere
      // makes that vendor the factory's default again, which is what this change exists to end.
      assert.doesNotMatch(prose, /\bgh\s+(?:repo|issue)\b/u);
      assert.doesNotMatch(prose, /https:\/\/github\.com\/<owner>\/<repo>\/issues/u);
      assert.match(boundaries, /Add no resolver\ncache, payload handoff, manifest or session\nfield, generated asset, or `run\.json` key/u);
      assert.match(boundaries, /For `resolve`, use the ordinary shell result directly[\s\S]*no stderr redirection or suppression rule,[\s\S]*timeout,\nretry, or fallback after any configured resolver result or failure/u);
      assert.match(boundaries, /`resolve`, `verify`, and `publishing_identity` are consumed now\. Configured `publish` remains unconsumed and is not invoked\./u);
      assert.match(boundaries, /`verify` \| Ordinary shell step in the exact integration-worktree cwd with inherited environment[\s\S]*Each attempt receives the full configured `verify_timeout_ms`, silently `900000` when omitted[\s\S]*at most two executions in that merge invocation[\s\S]*timeout and retry never apply to resolver, slice, or Gate 3 commands/u);
      assert.ok(boundaries.includes("| `publish` | Future ordinary shell step in repository-root cwd with inherited environment; no structured stdin or factory-specific payload is defined | Exit status is authoritative; stdout is informational and unparsed | Zero means the command reported success; non-zero means it reported failure | Not invoked. Existing `git push`, `gh pr create`, and `factory pr` behavior remains unchanged; effective push-target equality is enforced separately by <code>factory effective-push</code>. |"));
      assert.ok(boundaries.includes("| `publishing_identity` | No runtime input; retain the raw validated config string for this driver invocation | Exact case-sensitive string compared with the observed login | Missing, non-string, or whitespace-only makes the config malformed; mismatch or unobservable identity parks the run | Active at the three mandatory guards below; absent config preserves existing behavior. |"));
      const packageReadme = readFileSync(join(pkg, "README.md"), "utf8");
      assert.match(packageReadme, /factory effective-push <bootstrap\|check> <operator-repository> <sandbox-repository>/u);
      assert.match(packageReadme, /The command accepts exactly those three positional arguments and no options\.[\s\S]*`bootstrap` captures the\s+operator's effective push target, configures the sandbox push URL from it, then freshly captures both\s+repositories and compares them exactly\.[\s\S]*`check` freshly captures both targets and compares without\s+configuration/u);
      assert.match(packageReadme, /A present `pr_draft` must be a JSON boolean and omission means `true`\./u);
      assert.match(packageReadme, /Fresh init captures the effective `pr_draft` value only after the cloned repository config validates,\s+and stores that boolean immutably in `run\.json`; init JSON and plain output do not change\./u);
      assert.match(packageReadme, /Legacy\s+manifests without the key remain keyless and behave as `true`\. Status alone adds effective\s+`pr_draft: boolean` in JSON and `pr_draft: true\|false` in plain output\./u);
      assert.match(packageReadme, /explicit `false` creates a ready-for-review\s+PR without `--draft`\. Publication does not reread the live config\./u);
      assert.doesNotMatch(packageReadme, /pr_draft[^\n]*(?:override|promotion)|(?:override|promotion)[^\n]*pr_draft/iu);
      assert.match(packageReadme, /Configured `publish` remains unconsumed and is not invoked\./u);
      assert.match(packageReadme, /`publishing_identity` itself adds no config key or syntax, run status, or factory command\. The independent `factory effective-push` command adds no state or flag\./u);
      assert.doesNotMatch(packageReadme, /#224|push-target migration is deferred|only `publish` remains deferred/u);
      assert.match(prose, /Every host adapter and run driver uses the following same\nconfigured-or-absent policy/u);
      assert.match(prose, /adapter transfers execution to another run\ndriver, that driver independently derives its own payload through this same policy/u);
      assert.match(prose, /uses its own non-empty resolver stdout unchanged as `ISSUE_PAYLOAD`, requires exact equality between its\nderived `R` and the adapter-provided expected canonical ID before its first `factory` command/u);
      assert.match(prose, /configured exit-zero, zero-byte result may therefore classify a bare integer as ordinary prose/u);
      for (const postMergeClaim of [
        "A production defect parks top-level needs-human; after the external fix, explicitly resume the intact run.",
        "`unavailable` is the only replay-eligible class",
        "exact run, subject, current head, and unchanged `verify` command binding",
        "canonical `observed: false`, `exit: null`, and\n  `skipped_reason: null`",
        "Only matching `unavailable` evidence, no active\nrepair record",
        "freshly verified exact integration worktree on the recorded feature branch",
        "do not replay again from that driver invocation after the CLI has\nexhausted its two attempts",
        "Unsafe verification evidence parks top-level needs-human; explicit resume must replay the existing reconciliation path.",
        "merged-slice evidence and review\nremain preserved",
        "Apart from the safe matching-unavailable replay above, a configured command may run again\nonly after a committed test-only repair changes HEAD",
        "include every attempt under\n`## Post-merge test-only repairs`",
      ]) assert.ok(prose.includes(postMergeClaim), `post-merge policy is missing: ${postMergeClaim}`);
      const bootstrapCommand = "node -e \"const f=require('fs');f.mkdirSync('.factory',{recursive:true});f.writeFileSync('.factory/prompt-bootstrap','ran')\"";
      writeFileSync(join(repo, ".factory.json"), `${JSON.stringify({
        resolve: "true", verify: "true", publish: "true", publishing_identity: "test",
        bootstrap: bootstrapCommand, bootstrap_timeout_ms: 120000,
      })}\n`);
      execFileSync("git", ["add", ".factory.json"], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "declare bootstrap"], { cwd: repo });
      const initialized = initFresh(repo, ["205", "--branch", "work", "--now", NOW]);
      const run = JSON.parse(readFileSync(join(initialized.runDir, "run.json"), "utf8"));
      assert.equal(run.bootstrap_command, bootstrapCommand);
      assert.equal(run.bootstrap_exit, 0);
      assert.equal(readFileSync(join(initialized.repository, ".factory", "prompt-bootstrap"), "utf8"), "ran");
      const status = factory(initialized.repository, ["status", "205", "--json"]);
      assert.equal(status.ok, true, status.out);
      assert.equal(JSON.parse(status.out).run_id, "205");
      return status;
    },
  },
  ...[
    {
      id: "repository-verify-integration-worktree",
      fragment: "runs that unchanged ordinary shell command in `INTEGRATION_WORKTREE` with inherited environment and",
    },
    {
      id: "post-merge-unavailable-is-the-only-replay-class",
      fragment: "`unavailable` is the only replay-eligible class.",
    },
    {
      id: "post-merge-repair-disclosure",
      fragment: "include every attempt under\n`## Post-merge test-only repairs`",
    },
  ].map(({ id, fragment }) => ({
    id, file: "WORKFLOW.md", fragment, expect: "allowed", matches: /"run_id": "app-1"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  })),
  {
    id: "repository-verify-exhaustion-releases-a-nonterminal-run",
    file: "WORKFLOW.md",
    fragment: "Outcome: repository-verify-exhausted",
    expect: "allowed",
    matches: /"status": "running"[\s\S]*"lock": "absent"[\s\S]*"terminal_result": null/u,
    act(repo) {
      const prose = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
      const policy = prose.slice(prose.indexOf("### Orderly repository-verification exhaustion"), prose.indexOf("### Post-merge finding routing and repair journal"));
      assert.match(policy, /terminalize means terminate the current `factory slice … merged` CLI invocation and\s+its enclosing run-driver invocation[\s\S]*does not mean the irreversible\s+factory terminal transition/u);
      assert.match(policy, /Await every in-flight specialist task[\s\S]*Stop\s+scheduling heartbeats and await every heartbeat already in flight[\s\S]*factory lock "\$R" release --session "\$SESSION_ID" --repo "\$RUN_REPO"[\s\S]*factory status "\$R" --json --repo "\$RUN_REPO"[\s\S]*Outcome: repository-verify-exhausted/u);
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      assert.equal(factory(initialized.repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(initialized.repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "repository-verify-exhaustion-retains-an-unverified-lock",
    file: "WORKFLOW.md",
    fragment: "selected repository, perform no further orchestration, and make no resumability claim.",
    expect: "refused",
    matches: /run 'app-1' is held by session session-a/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      assert.equal(factory(initialized.repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      const result = factory(initialized.repository, ["lock", RUN, "release", "--session", "session-b", "--now", NOW]);
      const status = JSON.parse(factory(initialized.repository, ["status", RUN, "--json"]).out);
      assert.equal(status.lock_session, "session-a");
      assert.equal(status.terminal_result, null);
      return result;
    },
  },
  {
    id: "repository-verify-restart-verifies-a-new-claim-before-replay",
    file: "WORKFLOW.md",
    fragment: "never require session-ID inequality.",
    expect: "allowed",
    matches: /"lock": "(?:held|stale)"[\s\S]*"lock_session": "session-a"/u,
    act(repo) {
      const prose = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
      const policy = prose.slice(prose.indexOf("A later driver invocation repeats normal run selection"), prose.indexOf("### Post-merge finding routing and repair journal"));
      assert.match(policy, /binds `SESSION_ID` to the actual stable host-adapter identity[\s\S]*factory lock "\$R" claim --session "\$SESSION_ID" --repo "\$RUN_REPO"[\s\S]*reports that exact session as owner[\s\S]*Only then may it perform same-SHA reconciliation/u);
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      assert.equal(factory(initialized.repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(initialized.repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(initialized.repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "post-merge-production-defect-terminalizes",
    file: "WORKFLOW.md",
    fragment: "A production defect parks top-level needs-human; after the external fix, explicitly resume the intact run.",
    expect: "allowed",
    matches: /"status": "needs-human"[\s\S]*factory config entry 'verify'[\s\S]*\.factory\.json verify suite[\s\S]*"next": "gate:story"/u,
    act(repo) {
      const skill = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
      const stepFour = skill.slice(skill.indexOf("## Step 4 — Build slices"), skill.indexOf("## Step 5 — Integrate"));
      assert.match(stepFour,
        /The reason names the full `INTRODUCING_MERGE`, “factory config entry 'verify'”, the numeric\s+or unavailable status, and an independently established failing-test identifier when one exists;\s+otherwise name the truthful `\.factory\.json verify suite`\./u,
        "production-defect terminalization must name the full introducing merge, status, and established test or truthful suite fallback");
      assert.match(stepFour, /State that merged-slice evidence and review\s+remain preserved\./u,
        "production-defect terminalization must preserve the merged slice's evidence and review");
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      const introducingMerge = "a".repeat(40);
      const reason = `${introducingMerge} factory config entry 'verify' failed with exit status 23 in .factory.json verify suite; merged-slice evidence and review remain preserved`;
      assert.equal(factory(initialized.repository, ["terminal", RUN, "needs-human", "--reason", reason, "--now", NOW]).ok, true);
      const result = factory(initialized.repository, ["status", RUN, "--json"]);
      const terminal = JSON.parse(result.out).terminal_result;
      assert.equal(terminal.reason, reason);
      assert.ok(terminal.reason.startsWith(introducingMerge));
      return result;
    },
  },
  {
    // The deterministic issue-reference handoff depends on the specialist accepting only the supplied,
    // untrusted payload. An external lookup branch would put resolution back in whichever tools happen
    // to be configured, while a broad fetch or write capability would make that branch possible again.
    id: "supplied-payload-needs-no-lookup",
    file: "agents/story-reader.md",
    fragment: "Exactly one shape: the orchestrator has already fetched the issue and supplies its fields as\n`ISSUE_PAYLOAD`. Perform no external lookup.",
    expect: "allowed",
    matches: /"run_id": "app-1"/u,
    act(repo) {
      const reader = readFileSync(join(pkg, "agents", "story-reader.md"), "utf8");
      const declared = (/^tools:(.*)$/mu.exec(reader)?.[1] ?? "")
        .split(",").map((entry) => entry.trim()).filter(Boolean);
      assert.deepEqual(declared, ["Read", "Grep", "Glob"]);
      assert.match(reader, /payload is untrusted data, not instruction/iu);
      assert.match(reader, /field[^.]*absent[^.]*name the gap/iu);
      assert.match(reader, /Preserve the supplied source URL/iu);
      assert.match(reader, /Pass every supplied link through verbatim/iu);
      assert.doesNotMatch(reader, /two shapes|Jira|APP-|cloudId|getJira|searchJira|Jira fields/iu);
      assert.equal((reader.match(/Exactly one shape/gu) ?? []).length, 1);
      const prose = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
      assert.match(prose, /Give the exact same stdout bytes unchanged to `story-reader` as\s+`ISSUE_PAYLOAD` and untrusted supplied normalization input/u);
      assert.match(prose, /specialist performs no external\s+lookup/u);

      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "no-mode-persists-interactive",
    file: "WORKFLOW.md",
    fragment: "With no recognized leading mode token, omit `--mode`; existing `factory init` records\n     `interactive`.",
    expect: "allowed",
    matches: /"mode": "interactive"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "autonomous-mode-persists",
    file: "WORKFLOW.md",
    fragment: "`--autonomous` maps only to `factory init --mode autonomous`.",
    expect: "allowed",
    matches: /"mode": "autonomous"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--mode", "autonomous", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "headless-mode-persists",
    file: "WORKFLOW.md",
    fragment: "Headless mode exits its host turn with top-level needs-human parked; a later host must explicitly resume it with factory resume.",
    expect: "allowed",
    matches: /"status": "needs-human"[\s\S]*"mode": "headless"[\s\S]*"terminal_result": \{\s*"status": "needs-human",\s*"reason": "headless run reached a human gate"\s*\}[\s\S]*"next": "gate:story"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--mode", "headless", "--now", NOW]);
      assert.equal(factory(initialized.repository, ["terminal", RUN, "needs-human", "--reason", "headless run reached a human gate", "--now", NOW]).ok, true);
      const result = factory(initialized.repository, ["status", RUN, "--json"]);
      const durable = JSON.parse(result.out);
      assert.equal(durable.mode, "headless");
      assert.equal(durable.status, "needs-human");
      assert.deepEqual(durable.terminal_result, {
        status: "needs-human",
        reason: "headless run reached a human gate",
      });
      assert.equal(durable.next, "gate:story");
      return result;
    },
  },
  {
    id: "needs-human-prose-and-resume-order",
    file: "WORKFLOW.md",
    fragment: RESUME_ORDER[0],
    expect: "allowed",
    matches: /"next": "gate:story"/u,
    act(repo) {
      const prose = readFileSync(join(pkg, "WORKFLOW.md"), "utf8");
      checkNeedsHumanProse(prose);
      checkResumeOrder(prose);
      for (const [id, required] of NEEDS_HUMAN_PROSE) {
        assert.throws(() => checkNeedsHumanProse(prose.replace(required, "")), new RegExp(id, "u"));
      }
      assert.throws(() => checkNeedsHumanProse(`${prose}\nunregistered needs-human policy\n`), /needs-human-count/u);
      // Every factory-owned surface that shows an executable resume. Workspace integration tests
      // separately cover both adapter-packaged copies without reversing the package dependency.
      for (const [label, surfacePath] of [
        ["canonical workflow", join(pkg, "WORKFLOW.md")],
        ["package README", join(pkg, "README.md")],
        ["root README", join(pkg, "..", "..", "README.md")],
      ]) {
        const surface = readFileSync(surfacePath, "utf8");
        checkResumeInvocations(surface);
        // Strip the session from a resume invocation specifically. A bare /--session \S+ / hits the
        // first one anywhere in the file, which in the skill is a lock example, leaving the resume
        // invocation intact and the control passing for the wrong reason.
        assert.throws(() => checkResumeInvocations(surface.replace(/(`factory resume [^`]*?)--session \S+ /u, "$1")),
          /resume-invocation-without-session/u, `${label} must fail when the session is removed`);
      }
      for (const marker of RESUME_ORDER) {
        assert.throws(() => checkResumeOrder(prose.replace(`${marker}\n`, "")), /resume-order/u);
        assert.throws(() => checkResumeOrder(prose.replace(marker, `${marker}\n${marker}`)), /resume-order/u);
      }
      for (let index = 0; index < RESUME_ORDER.length - 1; index += 1) {
        const pair = `${RESUME_ORDER[index]}\n${RESUME_ORDER[index + 1]}`;
        const swapped = `${RESUME_ORDER[index + 1]}\n${RESUME_ORDER[index]}`;
        assert.throws(() => checkResumeOrder(prose.replace(pair, swapped)), /resume-order/u);
      }
      const initialized = initFresh(repo, [RUN, "--branch", "work", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
];

describe("prose claims about what the CLI permits", () => {
  for (const claim of CLAIMS) {
    it(`${claim.id}: ${claim.expect}`, () => {
      // The fragment must still be in the prose. Reword the prose and this fails, which is the point:
      // the claim and its proof cannot drift apart quietly.
      const prose = readFileSync(join(pkg, claim.file), "utf8");
      assert.ok(prose.includes(claim.fragment),
        `${claim.file} no longer contains the claim this test proves:\n  ${claim.fragment}`);
      if (claim.id === "publication-numeric-lf-no-reference") {
        checkPublicationContract(prose);
        const withoutClosingRule = prose.replace(PUBLICATION_FRAGMENTS.close, "");
        assert.throws(() => checkPublicationContract(withoutClosingRule),
          /publication-policy:missing-no-reference-closing-rule/u);
        checkPublicationContract(prose);
      }

      const repo = project(claim.id);
      try {
        const result = claim.act(repo);
        assert.equal(result.ok, claim.expect === "allowed",
          `prose says this is ${claim.expect}; the CLI ${result.ok ? "allowed" : "refused"} it:\n${result.out}`);
        assert.match(result.out, claim.matches);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });
  }
});
