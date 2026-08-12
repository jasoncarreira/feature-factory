#!/usr/bin/env node
// False-green enforcement: parked preflights precede effects; every mutation uses checked atomic CAS.
// Initialization alone creates run.json through atomic no-clobber publication.
// The orchestrator calls this CLI instead of writing control-plane state directly.
// Flags are declared per command; unknown options fail rather than becoming missing fields.
// Schema validation surrounds every state write.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { nextAction, readRun, readRunUnchecked } from "../state/index.js";
import { transition } from "../state/transition.js";
import { buildEvidence, DEFAULT_BOOTSTRAP_TIMEOUT_MS, DEFAULT_REPOSITORY_VERIFY_TIMEOUT_MS, deriveReviewReady, EVIDENCE_KEYS, evidenceRef, git, observeAncestry, observeCleanliness, observeTrackedCleanliness, observeWorktree, privilegedPaths, proveInitContainment, resolveWorktree, runBootstrap, unownedPaths } from "../observe/index.js";
import { assertPublicationReady, assertReviewBinding, observeMergeProof, readEvidence, readReview, readValidatorReview } from "../observe/review.js";
import { archiveReviewAttempt } from "../state/review-archive.js";
import { writeProtectedJsonAtomic } from "../core/atomic-write.js";
import { enforceEffectivePushTarget } from "../core/effective-push.js";
import { resolveSpawnExecutable } from "../core/executable.js";
import { dispatchInitPublication } from "./init-publication.js";
import { CONTROL_PLANE, SCHEMA_VERSION, GATE_NAMES, GATE_STATUSES, MODES, SLICE_STATUSES, STEP_STATUSES, TERMINAL_STATUSES, repositoryRelativePath, validateRun } from "../state/schema.js";
import {
  claimSessionLock, inspectSessionLock, refreshSessionLock, releaseSessionLock, SessionLockHeldError,
} from "../state/session-lock.js";

export const COMMANDS = Object.freeze({
  init: Object.freeze(["--repo", "--branch", "--worktree", "--pr-base", "--issue", "--mode", "--max-parallel-slices", "--max-retries", "--now", "--json"]),
  status: Object.freeze(["--repo", "--json"]),
  "amend-paths": Object.freeze(["--repo", "--add", "--reason", "--session", "--now", "--json"]),
  resume: Object.freeze(["--repo", "--session", "--now", "--json"]),
  // No --force: `lock <id> steal` is the same operation with a name that says what it
  // does, and two spellings of "take someone else's lock" is one too many.
  lock: Object.freeze(["--repo", "--session", "--branch", "--ttl-ms", "--now", "--json"]),
  heartbeat: Object.freeze(["--repo", "--session", "--now", "--json"]),
  gate: Object.freeze(["--repo", "--artifact", "--now", "--json"]),
  step: Object.freeze(["--repo", "--attempts", "--review-ref", "--evidence-ref", "--now", "--json"]),
  terminal: Object.freeze(["--repo", "--reason", "--now", "--json"]),
  "slices-seed": Object.freeze(["--repo", "--from", "--now", "--json"]),
  slice: Object.freeze(["--repo", "--attempts", "--worktree", "--branch", "--evidence-ref", "--review-ref", "--merge-commit", "--now", "--json"]),
  // No --skip-tests-reason: whether a slice needs tests is ratified in its test_plan at
  // seeding, not asserted at observation time by the party being observed.
  observe: Object.freeze(["--repo", "--worktree", "--base", "--attempt", "--test-cmd", "--repository-verify", "--claim", "--status", "--blocked-reason", "--now", "--json"]),
  validator: Object.freeze(["--repo", "--report", "--now", "--json"]),
  pr: Object.freeze(["--repo", "--url", "--now", "--json"]),
  "effective-push": Object.freeze([]),
});

const BOOLEAN_FLAGS = new Set(["--json", "--repository-verify"]);
const INIT_OPERATIONS = Object.freeze({
  cwd: () => process.cwd(), resolvePath: resolve, joinPath: join,
  realpath: realpathSync, lstat: lstatSync, mkdir: mkdirSync, readdir: readdirSync,
  runGit: git, prove: proveInitContainment, publish: dispatchInitPublication,
});

class CliError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CliError";
  }
}

export async function run(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return usage();
  if (!Object.hasOwn(COMMANDS, command)) throw new CliError(`unknown command '${command}' (try --help)`);
  const { positional, flags } = parse(command, rest);
  const handler = HANDLERS[command];
  return handler(positional, flags);
}

function parse(command, args) {
  const allowed = COMMANDS[command];
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!allowed.includes(arg)) throw new CliError(`unknown option '${arg}' for '${command}'`);
    if (BOOLEAN_FLAGS.has(arg)) {
      flags[key(arg)] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`${arg} requires a value`);
    const flagKey = key(arg);
    if (arg === "--add") flags[flagKey] = [...(flags[flagKey] ?? []), value];
    else flags[flagKey] = value;
    index += 1;
  }
  return { positional, flags };
}

const key = (flag) => flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());

function planDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Enforcement, not instruction: an entry observe cannot execute has no legal move once seeded.
// Whole tokens, never a substring scan -- observe spawns with `shell: false`, so a metacharacter inside an
// argv element is inert payload, and scanning every character refuses commands that run fine. Quotes are
// therefore absent; `>>`/`<<` are listed because token equality does not imply `>` covers them. The
// end-to-end rows record which real command a substring scan mangled.
const REFUSED_TEST_TOKENS = Object.freeze(["&&", "||", ";", "|", "&", "<", ">", ">>", "<<"]);
function assertExecutableTestPlan(slices, cwd, missingOnly = false) {
  for (const slice of slices) for (const entry of Array.isArray(slice.test_plan) ? slice.test_plan : []) {
    if (typeof entry !== "string") continue;
    const prefix = `slice '${slice.id}' test_plan entry ${JSON.stringify(entry)} cannot be executed by observe as argv without a shell: `;
    const tokens = entry.split(" ").filter(Boolean);
    const argv0 = tokens[0];
    if (!argv0) throw new Error(`${prefix}argv[0] is missing`);
    if (missingOnly) continue;
    const refused = tokens.find((token) => REFUSED_TEST_TOKENS.includes(token));
    if (refused) throw new Error(`${prefix}contains shell operator token ${JSON.stringify(refused)}`);
    const found = resolveSpawnExecutable(argv0, { cwd });
    if (found.reason === "unsupported-platform") throw new Error(`${prefix}argv[0] resolution is POSIX-only and cannot predict this platform's shell-free spawn (${found.platform}); seeding refuses rather than admit a command observe may fail to run`);
    if (!found.ok) throw new Error(`${prefix}argv[0] ${JSON.stringify(argv0)} did not resolve to an executable via ${found.source} from repository cwd ${JSON.stringify(cwd)}`);
  }
}

// Read when the gate is *presented*, not when it is approved. Approval-time hashing left a window:
// present plan A, edit plan/slices.json to plan B while the gate is still pending, approve, and the
// approval hashes B - so the digest proved the seed matched what the approval command read rather
// than what a human was shown. Presenting is the moment the plan is put in front of somebody, and
// the skill already says to reopen the gate to `pending` before mutating the plan, so a legitimate
// revision re-presents and re-binds. A presentation with no plan file is refused: the plan is the
// artifact that gate exists to review.
function presentedPlanDigest(runDir) {
  try {
    return planDigest(readFileSync(join(runDir, "plan/slices.json")));
  } catch (error) {
    throw new CliError(`could not read plan/slices.json to bind the brief presentation: ${error.message}`);
  }
}

// `pending` binds the presented bytes. `approved` keeps that binding and refuses if the file has
// moved since, so the window between presentation and decision is closed rather than re-hashed.
// Any other decision clears it: nothing is bound until a plan is presented again.
function briefDigestFor(decision, state, runDir) {
  if (decision === "pending") return presentedPlanDigest(runDir);
  if (decision !== "approved") return null;
  if (!state.plan_digest) throw new CliError("the brief gate was not presented; move it to pending first");
  if (state.plan_digest !== presentedPlanDigest(runDir)) {
    throw new CliError("plan/slices.json changed since the brief gate was presented; re-present it before approving");
  }
  return state.plan_digest;
}

function runDirFor(flags, runId) {
  if (!runId) throw new CliError("a <run-id> is required");
  return join(resolve(flags.repo ?? process.cwd()), CONTROL_PLANE, runId);
}

function assertRunNotParked(runDir, command) {
  const run = readRun(runDir);
  if (run.status === "needs-human") {
    throw new CliError(`factory ${command} refuses while run status is needs-human; run factory resume first`);
  }
  return run;
}

function assertFreshSessionOwner(runDir, runId, session, command) {
  const held = inspectSessionLock(runDir);
  if (held.state === "absent") {
    throw new CliError(`factory ${command} requires a held session lock for run '${runId}'; claim it with 'lock ${runId} claim --session ${session}'`);
  }
  if (held.state === "stale") {
    throw new CliError(`factory ${command} refuses a stale session lock for run '${runId}' (owner ${held.owner.session}, heartbeat ${held.owner.heartbeat_at}); take it with 'lock ${runId} steal --session ${session}'`);
  }
  if (held.owner.session !== session) {
    throw new CliError(`run '${runId}' is held by session ${held.owner.session}, not ${session}; take it with 'lock ${runId} steal --session ${session}'`);
  }
  return held.owner;
}

function sameSessionOwner(runDir, bound) {
  const held = inspectSessionLock(runDir);
  if (held.state !== "fresh" || Date.parse(held.owner.heartbeat_at) < Date.parse(bound.heartbeat_at)) return false;
  return ["session", "run_id", "branch", "claimed_at", "pid"]
    .every((keyName) => isDeepStrictEqual(held.owner[keyName], bound[keyName]));
}

function validatePathAdditions(slice, additions) {
  for (const path of additions) {
    if (!repositoryRelativePath(path)) {
      throw new CliError(`added path '${path}' must be non-empty, repository-relative, and contain no '..' segment`);
    }
  }
  const privileged = privilegedPaths(additions);
  if (privileged.length > 0) throw new CliError(`cannot amend privileged control-plane paths: ${privileged.join(", ")}`);
  const seen = new Set();
  for (const path of additions) {
    if (seen.has(path)) throw new CliError(`duplicate requested path '${path}'`);
    seen.add(path);
  }
  for (const path of additions) {
    if (unownedPaths([path], slice.paths).length === 0) {
      throw new CliError(`slice '${slice.id}' already owns requested path '${path}'`);
    }
  }
}

// The integration branch's worktree and currently observed head. Three call sites asked
// this in four lines each with slightly different wording. The branch is named explicitly
// rather than observed as HEAD: recording a merge legitimately runs with a different
// branch checked out, and binding to whatever happens to be there makes the observation
// depend on the orchestrator's directory state.
//
// `commit` may be null — an unobservable head is a different refusal at each call site,
// so the decision stays with the caller rather than being flattened here.
function integrationHead(repo, run) {
  const worktree = resolveWorktree(repo, run.worktree);
  if (!worktree) throw new CliError(`integration worktree '${run.worktree}' is not observable`);
  return { worktree, commit: observeWorktree(worktree, run.branch, { ref: run.branch }).commit };
}

class RepositoryConfigError extends Error {}

function requireIntegrationWorktree(repo, run, suppliedWorktree) {
  let repository;
  let committed;
  let supplied;
  try {
    repository = realpathSync(resolve(repo));
    const committedPath = resolveWorktree(repository, run.worktree);
    const suppliedPath = resolveWorktree(repository, suppliedWorktree);
    committed = committedPath ? realpathSync(committedPath) : null;
    supplied = suppliedPath ? realpathSync(suppliedPath) : null;
  } catch {
    committed = null;
    supplied = null;
  }
  if (!repository || !committed || !supplied || committed !== supplied
    || resolveWorktree(repository, committed) !== committed || resolveWorktree(repository, supplied) !== supplied) {
    throw new CliError(`integration worktree mismatch: committed '${run.worktree}' resolves to '${committed ?? "unobservable"}', supplied '${suppliedWorktree}' resolves to '${supplied ?? "unobservable"}'`);
  }
  const branch = git(committed, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const observedBranch = branch.ok && branch.stdout.trim() ? branch.stdout.trim() : "detached HEAD";
  if (observedBranch !== run.branch) {
    throw new CliError(`integration worktree must have branch '${run.branch}' checked out; observed ${observedBranch}`);
  }
  const head = git(committed, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tip = git(committed, ["rev-parse", "--verify", `refs/heads/${run.branch}^{commit}`]);
  const headSha = head.ok ? head.stdout.trim() : "";
  const tipSha = tip.ok ? tip.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/u.test(headSha) || !/^[0-9a-f]{40}$/u.test(tipSha) || headSha !== tipSha) {
    throw new CliError(`integration HEAD must equal the current recorded branch tip for '${run.branch}'`);
  }
  return { worktree: committed, head: headSha };
}

function readRepositoryConfig(worktree, { optional = false } = {}) {
  let bytes;
  try {
    bytes = readFileSync(join(worktree, ".factory.json"), "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new RepositoryConfigError("invalid .factory.json");
  }
  let config;
  try {
    config = JSON.parse(bytes);
  } catch {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  const requiredKeys = ["publish", "publishing_identity", "resolve", "verify"];
  const allowedKeys = [...requiredKeys, "pr_draft", "verify_timeout_ms", "bootstrap", "bootstrap_timeout_ms"];
  // False-green enforcement: config must not silently select a different repository proof.
  if (!config || typeof config !== "object" || Array.isArray(config)
    || Object.keys(config).some((keyName) => !allowedKeys.includes(keyName))) {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  if (Object.hasOwn(config, "pr_draft") && typeof config.pr_draft !== "boolean") {
    throw new RepositoryConfigError("invalid .factory.json: entry 'pr_draft' must be a boolean");
  }
  const hasBootstrap = Object.hasOwn(config, "bootstrap");
  const hasBootstrapTimeout = Object.hasOwn(config, "bootstrap_timeout_ms");
  if (hasBootstrap && (typeof config.bootstrap !== "string" || !config.bootstrap.trim())) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'bootstrap' must be a non-empty string");
  }
  if (!hasBootstrap && hasBootstrapTimeout) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'bootstrap_timeout_ms' requires a declared bootstrap command");
  }
  if (hasBootstrapTimeout && (!Number.isSafeInteger(config.bootstrap_timeout_ms) || config.bootstrap_timeout_ms <= 0)) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'bootstrap_timeout_ms' must be a positive integer");
  }
  if (Object.hasOwn(config, "verify_timeout_ms")
    && (!Number.isSafeInteger(config.verify_timeout_ms) || config.verify_timeout_ms <= 0)) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'verify_timeout_ms' must be a positive integer");
  }
  if (requiredKeys.some((keyName) => typeof config[keyName] !== "string" || !config[keyName].trim())) {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  const parsed = { command: config.verify, timeoutMs: config.verify_timeout_ms ?? DEFAULT_REPOSITORY_VERIFY_TIMEOUT_MS,
    prDraft: config.pr_draft ?? true };
  return hasBootstrap ? { ...parsed, bootstrapCommand: config.bootstrap,
    bootstrapTimeoutMs: config.bootstrap_timeout_ms ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS } : parsed;
}

function bootstrapOutcome(worktree, config, phase) {
  const exit = runBootstrap(worktree, config.bootstrapCommand, config.bootstrapTimeoutMs);
  const tracked = observeTrackedCleanliness(worktree);
  let refusal = null;
  if (!tracked.observed) refusal = `factory config entry 'bootstrap' could not observe tracked paths after ${phase}`;
  else if (tracked.entries.length) refusal = `factory config entry 'bootstrap' left tracked paths dirty after ${phase}: ${tracked.entries.map(JSON.stringify).join(", ")}`;
  else if (exit !== 0) refusal = exit === null
    ? `factory config entry 'bootstrap' failed during ${phase}; exit status unavailable`
    : `factory config entry 'bootstrap' failed during ${phase} with exit status ${exit}`;
  return { exit, refusal };
}

function branchPoint(run) {
  const base = run.slices.find((slice) => Array.isArray(slice.depends_on) && slice.depends_on.length === 0)?.base_ref;
  if (!/^[0-9a-f]{40}$/u.test(base ?? "")) throw new CliError("first seeded root slice has no immutable 40-character base_ref");
  return base;
}

async function writeObservedEvidence({ runDir, runId, subject, attempt, branch, baseRef, worktree, status, blockedReason, claim, testCommand, skipReason, shellCommand, testTimeoutMs }) {
  const evidence = buildEvidence({
    subject, attempt, branch, baseRef, worktree, status, blockedReason, claim, runId,
    testCommand, skipReason, shellCommand, testTimeoutMs,
  });
  const ancestry = observeAncestry(worktree, baseRef, "HEAD");
  if (ancestry !== "ancestor") {
    evidence.review_ready = false;
    evidence.blocked_reason = evidence.blocked_reason ?? `base ${baseRef} is ${ancestry} of HEAD`;
  }
  await writeProtectedJsonAtomic(runDir, evidenceRef(subject), evidence);
  return { evidence, ancestry };
}

function canonicalRepositoryVerifyEvidence(evidence, { runId, run, integration, verifyCommand }) {
  const baseRef = branchPoint(run);
  const keys = Object.keys(evidence).sort();
  const commandNames = [
    "git rev-parse HEAD",
    `git --literal-pathspecs diff --name-only -z ${baseRef}...HEAD`,
    `git diff --stat ${baseRef}...HEAD`,
  ];
  const commandsAreCanonical = Array.isArray(evidence.commands)
    && evidence.commands.length === commandNames.length
    && evidence.commands.every((command, index) => command && typeof command === "object" && !Array.isArray(command)
      && JSON.stringify(Object.keys(command).sort()) === JSON.stringify(["cmd", "exit", "summary"])
      && command.cmd === commandNames[index] && command.exit === 0 && typeof command.summary === "string");
  const tests = evidence.tests;
  const testsAreCanonical = tests && typeof tests === "object" && !Array.isArray(tests)
    && JSON.stringify(Object.keys(tests).sort()) === JSON.stringify(["cmd", "exit", "observed", "skipped_reason"])
    && tests.cmd === verifyCommand && typeof tests.observed === "boolean" && tests.skipped_reason === null
    && ((tests.observed === true && Number.isInteger(tests.exit))
      || (tests.observed === false && tests.exit === null));
  const reconciliation = evidence.claim_reconciliation;
  return JSON.stringify(keys) === JSON.stringify([...EVIDENCE_KEYS].sort())
    && evidence.subject === "test-verifier" && evidence.run_id === runId
    && Number.isSafeInteger(evidence.attempt) && evidence.attempt >= 1
    && evidence.branch === run.branch && evidence.base_ref === baseRef
    && evidence.worktree === integration.worktree && evidence.status === "completed"
    && typeof evidence.worktree_clean === "boolean"
    && ((evidence.worktree_clean && evidence.blocked_reason === null)
      || (!evidence.worktree_clean && typeof evidence.blocked_reason === "string" && Boolean(evidence.blocked_reason.trim())))
    && Array.isArray(evidence.files_changed) && evidence.files_changed.length > 0
    && evidence.files_changed.every((path) => typeof path === "string" && Boolean(path))
    && typeof evidence.diff_stat === "string" && evidence.diff_observed === true
    && commandsAreCanonical && testsAreCanonical && evidence.commit === integration.head
    && evidence.observed_by === "orchestrator"
    // The value, not the type. `readEvidence` above already refuses a record whose stored
    // review_ready disagrees with its contents, so no such record reaches here today; this
    // keeps the predicate that decides replay-eligibility from being correct only by virtue
    // of its caller.
    && evidence.review_ready === deriveReviewReady(evidence)
    && reconciliation && typeof reconciliation === "object" && !Array.isArray(reconciliation)
    && JSON.stringify(Object.keys(reconciliation).sort()) === JSON.stringify(["claimed", "mismatches"])
    && reconciliation.claimed === false && Array.isArray(reconciliation.mismatches)
    && reconciliation.mismatches.length === 0;
}

function classifyRepositoryVerifyEvidence(runDir, context) {
  let evidence;
  try {
    evidence = readEvidence(runDir, evidenceRef("test-verifier"), { runId: context.runId });
  } catch {
    return { kind: "unknown", evidence: null };
  }
  // False-green enforcement: only complete canonical evidence bound to this merge may be reused or retried.
  if (!canonicalRepositoryVerifyEvidence(evidence, context)) {
    return { kind: "unknown", evidence };
  }
  if (evidence.tests.observed === true && evidence.tests.exit === 0 && evidence.review_ready === true) {
    return { kind: "green", evidence };
  }
  if (evidence.tests.observed === true && Number.isInteger(evidence.tests.exit)) {
    return { kind: "failed", evidence };
  }
  if (evidence.tests.observed === false && evidence.tests.exit === null && evidence.tests.skipped_reason === null) {
    return { kind: "unavailable", evidence };
  }
  return { kind: "unknown", evidence };
}

function repositoryVerifyRefusal(mergeCommit, evidence) {
  if (evidence.tests?.observed === true && Number.isInteger(evidence.tests.exit) && evidence.tests.exit !== 0) {
    return `factory config entry 'verify' failed after recorded merge ${mergeCommit} with exit status ${evidence.tests.exit}; merged slice remains recorded; stop before advancing.`;
  }
  if (evidence.tests?.exit === null || evidence.tests?.observed !== true) {
    return `factory config entry 'verify' failed after recorded merge ${mergeCommit}; exit status unavailable; merged slice remains recorded; stop before advancing.`;
  }
  return `factory config entry 'verify' was not review_ready after recorded merge ${mergeCommit}: ${evidence.blocked_reason ?? "review readiness was not established"}; merged slice remains recorded; stop before advancing.`;
}

function mergedPayload(runId, sliceId, row) {
  return { run_id: runId, slice: sliceId, status: row.status, attempts: row.attempts, base_ref: row.base_ref, merge_commit: row.merge_commit };
}

function repositoryVerifyUnknownRefusal(mergeCommit) {
  return `post-merge verify outcome is unknown for recorded merge ${mergeCommit}; merged slice remains recorded; terminalize needs-human without re-executing factory config entry 'verify'.`;
}

function repositoryVerifyRetrySafety(repo, run, mergeCommit) {
  // False-green enforcement: retries may test only the unchanged, clean bytes recorded by the merge.
  let integration;
  try {
    integration = requireIntegrationWorktree(repo, run, run.worktree);
  } catch (error) {
    throw new CliError(`repository verification retry is unsafe after recorded merge ${mergeCommit}: ${error.message}; merged slice remains recorded; stop before advancing.`);
  }
  if (integration.head !== mergeCommit) {
    throw new CliError(`repository verification retry is unsafe after recorded merge ${mergeCommit}: integration HEAD moved to ${integration.head}; merged slice remains recorded; stop before advancing.`);
  }
  const cleanliness = observeCleanliness(integration.worktree);
  if (!cleanliness.clean) {
    throw new CliError(`repository verification retry is unsafe after recorded merge ${mergeCommit}: ${cleanliness.reason}; merged slice remains recorded; stop before advancing.`);
  }
  return integration;
}

async function runRepositoryVerifyAttempts({ repo, runDir, runId, run, mergeCommit, verify, integration }) {
  const baseRef = branchPoint(run);
  let attemptIntegration = integration;
  // False-green enforcement: one invocation gets at most two executions, never an unbounded recovery loop.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { evidence } = await writeObservedEvidence({
      runDir, runId, subject: "test-verifier", attempt, branch: run.branch,
      baseRef, worktree: attemptIntegration.worktree, status: "completed", blockedReason: null,
      claim: null, testCommand: verify.command, skipReason: null, shellCommand: true,
      testTimeoutMs: verify.timeoutMs,
    });
    const classified = classifyRepositoryVerifyEvidence(runDir, {
      runId, run, integration: attemptIntegration, verifyCommand: verify.command,
    });
    if (classified.kind === "green") return evidence;
    if (classified.kind === "failed") throw new CliError(repositoryVerifyRefusal(mergeCommit, classified.evidence));
    if (classified.kind === "unknown") throw new CliError(repositoryVerifyUnknownRefusal(mergeCommit));
    if (attempt === 2) throw new CliError(repositoryVerifyRefusal(mergeCommit, evidence));
    attemptIntegration = repositoryVerifyRetrySafety(repo, run, mergeCommit);
  }
  return null;
}

async function verifyRecordedMerge({ repo, runDir, runId, mergeCommit }) {
  const run = readRun(runDir);
  const integration = requireIntegrationWorktree(repo, run, run.worktree);
  if (integration.head !== mergeCommit) {
    throw new CliError(`integration HEAD must equal recorded merge ${mergeCommit} before repository verification`);
  }
  let verify;
  try {
    verify = readRepositoryConfig(integration.worktree, { optional: true });
  } catch (error) {
    if (error instanceof RepositoryConfigError) {
      throw new CliError(`factory config entry 'verify' unavailable after recorded merge ${mergeCommit}: ${error.message}; merged slice remains recorded; stop before advancing.`);
    }
    throw error;
  }
  if (verify === null) return null;
  return runRepositoryVerifyAttempts({ repo, runDir, runId, run, mergeCommit, verify, integration });
}

const HANDLERS = {
  "effective-push"(positional) {
    enforceEffectivePushTarget(positional);
    return null;
  },

  async validator([runId], flags) {
    if (!flags.report) throw new CliError("factory validator requires --report");
    const runDir = runDirFor(flags, runId);
    const run = assertRunNotParked(runDir, "validator");
    const repo = resolve(flags.repo ?? process.cwd());
    const at = stamp(flags);
    // Neither the verdict nor the head is an argument any more. Both come from the
    // validator's own record, which must name the integration head as observed right now —
    // otherwise a report about one commit could be recorded as a verdict on another.
    const head = integrationHead(repo, run);
    const review = readValidatorReview(runDir, head.commit);
    const next = await transition(runDir, {
      participants: [{ familyId: "verdict", mode: "record" }],
      apply: (state) => ({
        ...state,
        updated_at: at,
        validator: {
          verdict: review.verdict,
          report: flags.report,
          // Attack 4: the verdict names the head it judged, so a later consumer can
          // refuse it once that head moves.
          reviewed_head: review.reviewed_commit,
          loops: (state.validator?.loops ?? 0) + (state.validator ? 1 : 0),
        },
      }),
    });
    return emit(flags, { run_id: runId, verdict: next.validator.verdict, reviewed_head: next.validator.reviewed_head, loops: next.validator.loops });
  },

  async pr([runId], flags) {
    if (!flags.url) throw new CliError("factory pr requires --url");
    const runDir = runDirFor(flags, runId);
    assertRunNotParked(runDir, "pr");
    const repo = resolve(flags.repo ?? process.cwd());
    const run = readRun(runDir);
    const at = stamp(flags);

    // Re-asked rather than assumed from Gate 3's approval: between the two the head can
    // move, a slice can regress, and a gate can be re-opened, and `pr` is where the record
    // becomes permanent. The rules live in one place, including the requirement that all
    // three gates are approved *now* — this handler used to check pre_pr on its own, which
    // is how a re-opened Story gate went unnoticed.
    const reobservers = new Map();
    reobservers.set("verdict", async ({ nextState }) => {
      assertPublicationReady({
        runDir, state: nextState, runId,
        observeHead: () => integrationHead(repo, nextState).commit,
      });
    });

    const next = await transition(runDir, {
      participants: [{ familyId: "verdict", mode: "publish" }],
      reobservers,
      apply: (state) => {
        // Attacks 9 and 10: recording the same PR twice is the crash-replay path and
        // must be idempotent; recording a different one is a second PR and is refused
        // by the verdict contract.
        if (state.pr_url === flags.url) return { ...state, updated_at: at };
        return { ...state, updated_at: at, pr_url: flags.url };
      },
    });
    return emit(flags, { run_id: runId, pr_url: next.pr_url, idempotent: run.pr_url === flags.url });
  },

  async ["slices-seed"]([runId], flags) {
    const runDir = runDirFor(flags, runId);
    assertRunNotParked(runDir, "slices-seed");
    const from = flags.from ?? "plan/slices.json";
    let bytes;
    try {
      bytes = readFileSync(join(runDir, from));
    } catch (error) {
      throw new CliError(`could not read ${from}: ${error.message}`);
    }
    let plan;
    try {
      plan = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new CliError(`could not read ${from}: ${error.message}`);
    }
    if (!Array.isArray(plan?.slices)) throw new CliError(`${from} must have top-level shape { "slices": [...] }`);
    if (plan.slices.length === 0) throw new CliError(`${from} has no slices`);
    const at = stamp(flags);
    const next = await transition(runDir, {
      participants: [{ familyId: "slices", mode: "seed" }],
      apply: (state) => {
        if (state.slices.length > 0) throw new Error("slices are already seeded");
        // The gate approved bytes, not a filename. Without this the ordering fix is prose: a plan
        // revised after approval seeds unreviewed `paths` and `test_plan`, immutable from here, an
        // empty test_plan among them. Absent digest refuses rather than waves through - re-approving
        // the brief gate records one, and the gate may re-open while the plan is unseeded.
        // Guarded on approval so the gates contract keeps its own refusal when the gate is not
        // approved at all; this one answers "approved, but is this what was approved".
        if (state.gates.brief?.status === "approved") {
          if (!state.plan_digest) throw new Error("the brief gate approved no plan digest; re-approve it before seeding");
          if (state.plan_digest !== planDigest(bytes)) throw new Error(`${from} is not the plan the brief gate approved`);
        }
        if (state.gates.brief?.status !== "approved") throw new Error("slices-seed requires the Brief gate to be approved");
        const candidate = {
          ...state,
          updated_at: at,
          slices: plan.slices.map((slice) => ({
            id: slice.id,
            stack: slice.stack,
            depends_on: slice.depends_on ?? [],
            status: "pending",
            worktree: null,
            branch: null,
            attempts: 1,
            // The ratification point: the gate approved these paths and this test plan,
            // so they are the set every later merge is judged against and the decision
            // about whether this slice may ship without an observed test run.
            //
            // Stored with NO default. `test_plan ?? []` turned an omitted field into the
            // approved-empty exemption, so a plan that never mentioned tests silently
            // waived them - the CLI defeating the schema rule that was supposed to make
            // that impossible. The schema rejects a missing or non-array value.
            paths: slice.paths,
            path_amendments: [],
            test_plan: slice.test_plan,
            evidence_ref: null,
            review_ref: null,
            merge_commit: null,
          })),
        };
        assertExecutableTestPlan(candidate.slices, resolve(flags.repo ?? process.cwd()), true);
        validateRun(candidate);
        // Enforcement: refuse a ratified false green with no executable legal move.
        assertExecutableTestPlan(candidate.slices, resolve(flags.repo ?? process.cwd()));
        return candidate;
      },
    });
    return emit(flags, { run_id: runId, seeded: next.slices.length, slices: next.slices.map((slice) => slice.id) });
  },

  async ["amend-paths"](positional, flags) {
    if (positional.length !== 2) throw new CliError("factory amend-paths requires exactly <run-id> <slice-id>");
    const [runId, sliceId] = positional;
    if (!Array.isArray(flags.add) || flags.add.length === 0) throw new CliError("factory amend-paths requires at least one --add <path>");
    if (typeof flags.reason !== "string" || !flags.reason.trim()) throw new CliError("factory amend-paths requires nonblank --reason <text>");
    if (typeof flags.session !== "string" || !flags.session.trim()) throw new CliError("factory amend-paths requires nonblank --session <id>");
    const runDir = runDirFor(flags, runId);
    const current = readRun(runDir);
    if (current.status !== "needs-human") {
      throw new CliError(`factory amend-paths requires current status needs-human; found '${current.status}'`);
    }
    assertFreshSessionOwner(runDir, runId, flags.session, "amend-paths");
    const at = stamp(flags);
    const reobservers = new Map([["slices", async () => ({
      authorized_session: assertFreshSessionOwner(runDir, runId, flags.session, "amend-paths").session,
    })]]);
    const next = await transition(runDir, {
      participants: [{ familyId: "envelope", mode: "amend-paths" }, { familyId: "slices", mode: "amend-paths" }],
      reobservers,
      apply: (state) => {
        if (state.status !== "needs-human") throw new CliError(`factory amend-paths requires current status needs-human; found '${state.status}'`);
        const existing = state.slices.find((slice) => slice.id === sliceId);
        if (!existing) throw new CliError(`unknown slice '${sliceId}'`);
        if (existing.status === "merged") throw new CliError(`slice '${sliceId}' is already merged`);
        validatePathAdditions(existing, flags.add);
        const amendment = { added_paths: [...flags.add], reason: flags.reason, session: flags.session, at };
        const row = { ...existing, paths: [...existing.paths, ...flags.add], path_amendments: [...(existing.path_amendments ?? []), amendment] };
        return { ...state, updated_at: at, slices: state.slices.map((slice) => (slice.id === sliceId ? row : slice)) };
      },
    });
    const row = next.slices.find((slice) => slice.id === sliceId);
    return emit(flags, { run_id: runId, slice: sliceId, status: next.status,
      terminal_result: next.terminal_result, amendment: row.path_amendments.at(-1) });
  },

  async slice([runId, sliceId, status], flags) {
    if (!SLICE_STATUSES.includes(status)) throw new CliError(`status must be one of ${SLICE_STATUSES.join(" | ")}`);
    const runDir = runDirFor(flags, runId);
    assertRunNotParked(runDir, "slice");
    const repo = resolve(flags.repo ?? process.cwd());
    const at = stamp(flags);

    // The branch point is observed rather than supplied, so a stale or convenient base
    // cannot be passed in.
    //
    // A boundary re-observation was added here and reverted: it guarded the window
    // between this read and the commit, but only a second writer of the integration ref
    // can open that window, and there is one orchestrator issuing sequential commands.
    // The parallelism in a wave is between builders, not between writers of the control
    // plane. It bought a retry failure path on correct runs for a race the design does
    // not have. If concurrent orchestrators on one run ever become real, it comes back.
    let observedBase = null;
    if (status === "running") {
      const current = readRun(runDir);
      const head = integrationHead(repo, current);
      if (!head.commit) throw new CliError(`could not observe the head of '${current.branch}' to bind the slice base`);
      observedBase = head.commit;
    }
    if (status === "merged" && !flags.mergeCommit) throw new CliError("recording a merge requires --merge-commit");

    if (status === "merged") {
      const current = readRun(runDir);
      const existing = current.slices.find((slice) => slice.id === sliceId);
      if (!existing) throw new CliError(`unknown slice '${sliceId}'`);
      if (existing.status === "merged") {
        if (flags.mergeCommit !== existing.merge_commit) {
          throw new CliError(`slice '${sliceId}' is already recorded at immutable merge_commit ${existing.merge_commit}`);
        }
        const integration = requireIntegrationWorktree(repo, current, current.worktree);
        if (integration.head !== existing.merge_commit) {
          throw new CliError(`recorded merge ${existing.merge_commit} replay cannot reconcile the current integration head; do not re-execute factory config entry 'verify'.`);
        }
        let verify;
        try {
          verify = readRepositoryConfig(integration.worktree, { optional: true });
        } catch (error) {
          if (error instanceof RepositoryConfigError) {
            throw new CliError(`factory config entry 'verify' unavailable after recorded merge ${existing.merge_commit}: ${error.message}; merged slice remains recorded; stop before advancing.`);
          }
          throw error;
        }
        if (verify !== null) {
          const classified = classifyRepositoryVerifyEvidence(runDir, {
            runId, run: current, integration, verifyCommand: verify.command,
          });
          if (classified.kind === "failed") throw new CliError(repositoryVerifyRefusal(existing.merge_commit, classified.evidence));
          if (classified.kind === "unknown") {
            throw new CliError(repositoryVerifyUnknownRefusal(existing.merge_commit));
          }
          if (classified.kind === "unavailable") {
            const safeIntegration = repositoryVerifyRetrySafety(repo, current, existing.merge_commit);
            await runRepositoryVerifyAttempts({
              repo, runDir, runId, run: current, mergeCommit: existing.merge_commit, verify,
              integration: safeIntegration,
            });
          }
        }
        return emit(flags, mergedPayload(runId, sliceId, existing));
      }
    }

    // For a merge, the contract's reobserve hook demands freshly observed paths.
    // The observer is supplied here and runs inside the transition.
    const reobservers = new Map();
    if (status === "merged") {
      reobservers.set("slices", async (slice) => {
        const worktree = resolveWorktree(repo, slice.worktree ?? "");
        if (!worktree) return { diff_observed: false, unowned: [], privileged: [] };
        const run = readRun(runDir);
        // Observe the slice's own branch, not the worktree's current HEAD: recording
        // a merge legitimately happens with the integration branch checked out.
        if (!slice.branch) throw new Error(`slice '${slice.id}' cannot merge without a recorded branch`);
        // Diff from the slice's recorded branch point, not from the integration head:
        // by merge time the integration branch contains the slice, so that diff is
        // empty and ownership would pass vacuously.
        if (!slice.base_ref) throw new Error(`slice '${slice.id}' cannot merge without a recorded base_ref`);
        const observation = observeWorktree(worktree, slice.base_ref, { ref: slice.branch });

        // Attack 3: the approval must have judged the commit being merged. Read the
        // slice's own head from git rather than trusting anything recorded.
        // Finding 2: `observe` wrote evidence that nothing consumed, so a merge could
        // be recorded with no observed diff and no test run at all - the whole
        // observe-don't-trust mechanism was a write-only side effect. Evidence is now
        // required, must be review_ready, and must describe this slice at this attempt
        // against this base and this head.
        if (!slice.evidence_ref) throw new Error(`slice '${slice.id}' cannot merge without an evidence_ref`);
        const evidence = readEvidence(runDir, slice.evidence_ref, { runId });
        if (evidence.subject !== slice.id) {
          throw new Error(`evidence '${slice.evidence_ref}' describes '${evidence.subject}', not '${slice.id}'`);
        }
        if (evidence.review_ready !== true) {
          throw new Error(`slice '${slice.id}' evidence is not review_ready${evidence.blocked_reason ? `: ${evidence.blocked_reason}` : ""}`);
        }
        if (evidence.attempt !== slice.attempts) {
          throw new Error(`evidence '${slice.evidence_ref}' is for attempt ${evidence.attempt}, slice is at attempt ${slice.attempts}`);
        }
        if (evidence.base_ref !== slice.base_ref) {
          throw new Error(`evidence '${slice.evidence_ref}' observed base ${String(evidence.base_ref).slice(0, 12)}, slice base is ${String(slice.base_ref).slice(0, 12)}`);
        }
        if (!slice.review_ref) throw new Error(`slice '${slice.id}' cannot merge without a review_ref`);
        const review = readReview(runDir, slice.review_ref);
        assertReviewBinding({
          review, ref: slice.review_ref, observedHead: observation.commit,
          subject: slice.id, attempt: slice.attempts,
        });
        if (evidence.commit !== observation.commit) {
          throw new Error(`evidence '${slice.evidence_ref}' observed ${String(evidence.commit).slice(0, 12)} but the slice head is ${String(observation.commit).slice(0, 12)}`);
        }

        // Attack 2: the merge proof, observed in the integration worktree.
        //
        // Finding 1: the proof validated a caller-supplied object without checking it
        // landed on the integration branch, so a synthetic two-parent merge, or an older
        // valid merge after the branch advanced, both passed. An orchestrator that
        // captured the sha before merging, or reused a stale variable, produces exactly
        // that. The recorded merge must be the branch's current tip.
        const tip = integrationHead(repo, run);
        if (!tip.commit) throw new Error(`could not observe the head of '${run.branch}'`);
        if (tip.commit !== flags.mergeCommit) {
          throw new Error(`merge commit ${String(flags.mergeCommit).slice(0, 12)} is not the head of '${run.branch}' (${tip.commit.slice(0, 12)}); record the merge before advancing the branch`);
        }
        const proof = observeMergeProof(tip.worktree, {
          baseRef: slice.base_ref,
          reviewedCommit: review.reviewed_commit,
          mergeCommit: flags.mergeCommit,
        });
        if (!proof.proven) {
          throw new Error(`slice '${slice.id}' merge proof failed: ${proof.reason}`);
        }

        return {
          diff_observed: observation.diff_observed,
          unowned: unownedPaths(observation.files_changed, slice.paths),
          privileged: privilegedPaths(observation.files_changed),
        };
      });
    }

    const next = await transition(runDir, {
      participants: [{ familyId: "slices", mode: status === "merged" ? "merge" : "record" }],
      reobservers,
      apply: (state) => {
        const existing = state.slices.find((slice) => slice.id === sliceId);
        if (!existing) throw new Error(`unknown slice '${sliceId}'`);
        const row = {
          ...existing,
          status,
          attempts: flags.attempts === undefined ? existing.attempts : integer(flags.attempts, 1, "--attempts"),
          worktree: flags.worktree ?? existing.worktree,
          branch: flags.branch ?? existing.branch,
          base_ref: observedBase ?? existing.base_ref,
          evidence_ref: flags.evidenceRef ?? existing.evidence_ref,
          review_ref: flags.reviewRef ?? existing.review_ref,
          merge_commit: flags.mergeCommit ?? existing.merge_commit,
        };
        return { ...state, updated_at: at, slices: state.slices.map((slice) => (slice.id === sliceId ? row : slice)) };
      },
    });
    const row = next.slices.find((slice) => slice.id === sliceId);
    // base_ref is reported because this command is what establishes it, and the very next
    // step needs it: `observe --base` is compared for exact equality against this value at
    // merge time. The skill previously said to read it from `factory status`, which does not
    // expose it — so the documented path could not be followed at all.
    if (status === "merged") await verifyRecordedMerge({ repo, runDir, runId, mergeCommit: row.merge_commit });
    // Slice attempts are budgeted the same way, so their rejected verdicts vanish the same way.
    const sliceReviewArchive = await archiveReviewAttempt(runDir, row.review_ref);
    return emit(flags, { ...mergedPayload(runId, sliceId, row), review_archive: sliceReviewArchive });
  },

  async observe([runId, subject], flags) {
    if (!subject) throw new CliError("factory observe requires <subject>");
    if (!flags.worktree || !flags.base) throw new CliError("factory observe requires --worktree and --base");
    if (flags.repositoryVerify && flags.testCmd !== undefined) {
      throw new CliError("--repository-verify is mutually exclusive with --test-cmd");
    }
    if (flags.repositoryVerify && subject !== "test-verifier") {
      throw new CliError("--repository-verify is valid only for test-verifier");
    }
    const runDir = runDirFor(flags, runId);
    assertRunNotParked(runDir, "observe");
    const repo = resolve(flags.repo ?? process.cwd());
    const run = readRun(runDir);
    const integration = flags.repositoryVerify ? requireIntegrationWorktree(repo, run, flags.worktree) : null;
    const worktree = integration?.worktree ?? resolveWorktree(repo, flags.worktree);
    if (!worktree) throw new CliError(`worktree '${flags.worktree}' is not inside the repository`);

    let repositoryVerify = null;
    if (flags.repositoryVerify) {
      const expectedBase = branchPoint(run);
      if (flags.base !== expectedBase) throw new CliError(`--base must equal the first seeded root slice base_ref ${expectedBase}`);
      try {
        repositoryVerify = readRepositoryConfig(worktree);
      } catch (error) {
        if (error instanceof RepositoryConfigError) throw new CliError(error.message);
        throw error;
      }
    }

    let claim = null;
    if (flags.claim) {
      // Instruction at the moment of failure, not enforcement: an unreadable claim already refuses, so this
      // changes only what the operator is told. A driver that passed the builder's report inline got an
      // ENOENT whose "path" was the whole JSON document, which reads as a missing file rather than a wrong
      // argument -- and it discarded a slice that had already committed and observed green.
      if (/^\s*[{[]/u.test(flags.claim)) {
        throw new CliError("--claim expects a path to a JSON file holding the builder's report, not the report itself");
      }
      try {
        claim = JSON.parse(readFileSync(resolve(repo, flags.claim), "utf8"));
      } catch (error) {
        throw new CliError(`could not read --claim: ${error.message}`);
      }
    }

    // Whether this subject may be review-ready without an observed test run is read from
    // the ratified plan, not supplied. `--skip-tests-reason` was the flag this replaces:
    // it let the orchestrator write its own exemption at the moment of observation, and
    // any nonempty string was accepted, so "no tests needed" was a valid reason to ship
    // untested code. An empty test_plan is the same exemption, decided at Gate 2 by the
    // human who owns that call.
    //
    // A subject with no slice row - test-verifier, an agent step - has no ratified
    // waiver and so has none: its tests must be observed.
    const slice = run.slices.find((entry) => entry.id === subject);
    if (slice && flags.testCmd !== undefined
      && !slice.test_plan.some((entry) => entry === flags.testCmd)) {
      throw new CliError(
        `test command for slice '${subject}' must exactly match one ratified test_plan entry; `
        + `expected ${JSON.stringify(slice.test_plan)}; received ${JSON.stringify(flags.testCmd)}`,
      );
    }
    const skipReason = slice && slice.test_plan.length === 0
      ? `test_plan for '${subject}' was approved empty at slices-seed`
      : null;

    const { evidence, ancestry } = await writeObservedEvidence({
      runDir, runId, subject,
      attempt: flags.attempt === undefined ? 1 : integer(flags.attempt, 1, "--attempt"),
      branch: flags.repositoryVerify ? run.branch : flags.branch ?? null,
      baseRef: flags.base, worktree, status: flags.status ?? "completed",
      blockedReason: flags.blockedReason ?? null, claim,
      testCommand: flags.repositoryVerify ? repositoryVerify.command : flags.testCmd ? flags.testCmd.split(" ").filter(Boolean) : null,
      skipReason, shellCommand: flags.repositoryVerify === true,
      testTimeoutMs: flags.repositoryVerify ? repositoryVerify.timeoutMs : undefined,
    });
    return emit(flags, {
      run_id: runId, subject, evidence_ref: evidenceRef(subject),
      review_ready: evidence.review_ready, files_changed: evidence.files_changed.length,
      tests: evidence.tests.observed ? `exit ${evidence.tests.exit}` : `skipped: ${evidence.tests.skipped_reason}`,
      ancestry, mismatches: evidence.claim_reconciliation.mismatches.map((entry) => entry.field),
    });
  },
  async init(positional, flags) {
    return dispatchInit(positional, flags);
  },

  status([runId], flags) {
    const runDir = runDirFor(flags, runId);
    const observed = readRunUnchecked(runDir);
    if (!observed.ok) return emit(flags, { run_id: runId, valid: false, sandbox_path: resolve(flags.repo ?? process.cwd()), error: observed.error });
    let run;
    try {
      run = readRun(runDir);
    } catch (error) {
      // A record that exists but does not validate is reported, not hidden: the
      // operator needs to see the invalid state, not an absence.
      return emit(flags, { run_id: runId, valid: false, sandbox_path: resolve(flags.repo ?? process.cwd()), error: error.message });
    }
    const lock = inspectSessionLock(runDir);
    return emit(flags, {
      run_id: run.run_id,
      issue_key: run.issue_key ?? null,
      valid: true, sandbox_path: resolve(flags.repo ?? process.cwd()),
      status: run.status,
      mode: run.mode,
      branch: run.branch,
      pr_base: run.pr_base ?? null,
      pr_draft: run.pr_draft ?? true,
      lock: lock.state, dead_lock: run.status === "running" && lock.state === "stale",
      lock_session: lock.owner?.session ?? null,
      gates: Object.fromEntries(GATE_NAMES.filter((name) => run.gates[name]).map((name) => [name, run.gates[name].status])),
      steps: run.steps.map((step) => `${step.agent}:${step.status}(${step.attempts})`),
      slices: run.slices.map((slice) => `${slice.id}:${slice.status}(${slice.attempts})`),
      validator: run.validator?.verdict ?? null,
      pr_url: run.pr_url,
      terminal_result: run.terminal_result,
      next: nextAction(run),
    });
  },

  async lock([runId, action], flags) {
    const runDir = runDirFor(flags, runId);
    const ttlMs = flags.ttlMs === undefined ? undefined : integer(flags.ttlMs, undefined, "--ttl-ms");
    const now = flags.now ? Date.parse(flags.now) : undefined;
    try {
      if (action === "claim" || action === "steal") {
        const owner = await claimSessionLock(runDir, {
          session: flags.session, runId, branch: flags.branch, now, ttlMs, force: action === "steal",
        });
        return emit(flags, { run_id: runId, action, session: owner.session, stolen_from: owner.stolen_from?.session ?? null });
      }
      if (action === "release") {
        const released = await releaseSessionLock(runDir, { session: flags.session });
        return emit(flags, { run_id: runId, action, ...released });
      }
      // `inspect` was here and is gone: `factory status` already reports the lock state
      // and its owning session, so this was a second way to ask one question.
    } catch (error) {
      if (error instanceof SessionLockHeldError) {
        throw new CliError(`${error.message}\n  resume with --session ${error.owner.session}, or take it with 'lock ${runId} steal'`);
      }
      throw error;
    }
    throw new CliError("factory lock requires <claim|steal|release>");
  },

  async heartbeat([runId], flags) {
    const runDir = runDirFor(flags, runId);
    const owner = await refreshSessionLock(runDir, {
      session: flags.session,
      now: flags.now ? Date.parse(flags.now) : undefined,
    });
    return emit(flags, { run_id: runId, heartbeat_at: owner.heartbeat_at });
  },

  async gate([runId, name, decision], flags) {
    if (!GATE_NAMES.includes(name)) throw new CliError(`gate must be one of ${GATE_NAMES.join(" | ")}`);
    if (!GATE_STATUSES.includes(decision)) throw new CliError(`decision must be one of ${GATE_STATUSES.join(" | ")}`);
    const runDir = runDirFor(flags, runId);
    assertRunNotParked(runDir, "gate");
    const repo = resolve(flags.repo ?? process.cwd());
    const at = stamp(flags);

    // Gate 3's approval is what authorizes publication, and in the skill's flow it is the
    // last transition before the branch is pushed and the PR is created. Readiness was
    // checked only in `factory pr`, which runs after both of those effects - it could
    // report a bad publication but not prevent one. The gates contract refuses a pre_pr
    // approval that arrives with no observer registered, so this cannot go quiet.
    const reobservers = new Map();
    if (name === "pre_pr" && decision === "approved") {
      reobservers.set("gates", async ({ nextState }) => {
        assertPublicationReady({
          runDir, state: nextState, runId,
          observeHead: () => integrationHead(repo, nextState).commit,
        });
      });
    }

    const next = await transition(runDir, {
      participants: [{ familyId: "gates", mode: decision === "pending" ? "open" : "decide" }],
      reobservers,
      apply: (state) => ({
        ...state,
        updated_at: at,
        gates: {
          ...state.gates,
          [name]: {
            status: decision,
            at: decision === "pending" ? null : at,
            artifact: flags.artifact ?? state.gates[name]?.artifact ?? null,
          },
        },
        ...(name === "brief" ? { plan_digest: briefDigestFor(decision, state, runDir) } : {}),
      }),
    });
    return emit(flags, { run_id: runId, gate: name, status: next.gates[name].status, at: next.gates[name].at });
  },

  async step([runId, agent, status], flags) {
    if (!agent) throw new CliError("factory step requires <agent>");
    if (!STEP_STATUSES.includes(status)) throw new CliError(`status must be one of ${STEP_STATUSES.join(" | ")}`);
    const runDir = runDirFor(flags, runId);
    assertRunNotParked(runDir, "step");
    const at = stamp(flags);
    const next = await transition(runDir, {
      participants: [{ familyId: "steps", mode: "record" }],
      apply: (state) => {
        const existing = state.steps.find((step) => step.agent === agent);
        const attempts = flags.attempts === undefined
          ? existing?.attempts ?? 1
          : integer(flags.attempts, 1, "--attempts");
        const row = {
          agent,
          status,
          attempts,
          review_ref: flags.reviewRef ?? existing?.review_ref ?? null,
          evidence_ref: flags.evidenceRef ?? existing?.evidence_ref ?? null,
        };
        return {
          ...state,
          updated_at: at,
          steps: existing
            ? state.steps.map((step) => (step.agent === agent ? row : step))
            : [...state.steps, row],
        };
      },
    });
    const row = next.steps.find((step) => step.agent === agent);
    // Snapshot before the next attempt overwrites the record. Reported so a failed archive is
    // visible rather than silent -- null here means this verdict's reasoning was not kept.
    const reviewArchive = await archiveReviewAttempt(runDir, row.review_ref);
    return emit(flags, {
      run_id: runId, agent, status: row.status, attempts: row.attempts, review_archive: reviewArchive,
    });
  },

  async terminal([runId, status], flags) {
    if (!TERMINAL_STATUSES.includes(status)) throw new CliError(`status must be one of ${TERMINAL_STATUSES.join(" | ")}`);
    if (!flags.reason) throw new CliError("factory terminal requires --reason");
    const runDir = runDirFor(flags, runId);
    assertRunNotParked(runDir, "terminal");
    const at = stamp(flags);
    const next = await transition(runDir, {
      participants: [{ familyId: "envelope", mode: "terminalize" }],
      apply: (state) => ({
        ...state,
        updated_at: at,
        status,
        terminal_result: { status, reason: flags.reason },
      }),
    });
    return emit(flags, { run_id: runId, status: next.status, reason: next.terminal_result.reason });
  },

  async resume(positional, flags) {
    if (positional.length !== 1) throw new CliError("factory resume requires exactly one <run-id>");
    const [runId] = positional;
    const runDir = runDirFor(flags, runId);
    const boundRunBytes = readFileSync(join(runDir, "run.json"));
    const current = validateRun(JSON.parse(boundRunBytes.toString("utf8")));
    if (current.status !== "needs-human") {
      throw new CliError(`factory resume requires current status needs-human; found '${current.status}'`);
    }
    // Ownership is proven here and nowhere else in this command's family. Every other mutating
    // command advances a run whose driver already holds the lock; resume is the handoff itself --
    // the moment a new driver picks up a run nobody is driving. Two drivers resuming the same
    // parked run would both believe they own it, which is the single-writer invariant the lock
    // exists for. So the caller must already hold a fresh lock: claim, then verify, then resume.
    if (!flags.session) throw new CliError("factory resume requires --session <session-id>");
    const boundOwner = assertFreshSessionOwner(runDir, runId, flags.session, "resume");
    const at = stamp(flags);
    if (Date.parse(at) <= Date.parse(current.updated_at)) throw new CliError("resume-needs-human must move updated_at forwards");
    const repo = resolve(flags.repo ?? process.cwd());
    const config = readRepositoryConfig(repo, { optional: true });
    const outcome = config?.bootstrapCommand ? bootstrapOutcome(repo, config, "resume") : null;
    const currentBytes = outcome ? readFileSync(join(runDir, "run.json")) : boundRunBytes;
    if (outcome && !currentBytes.equals(boundRunBytes)) {
      try { validateRun(JSON.parse(currentBytes.toString("utf8"))); } catch {
        throw new CliError("factory resume bootstrap refused: current run state cannot be qualified because run.json bytes changed while bootstrap ran");
      }
      throw new CliError("factory resume bootstrap refused: run.json bytes changed while bootstrap ran; current state was preserved");
    }
    if (outcome && !sameSessionOwner(runDir, boundOwner)) {
      throw new CliError("factory resume bootstrap refused: factory.lock is absent, stale, or no longer names the same owner; current state and owner were preserved");
    }
    const success = outcome?.refusal == null;
    const assertBinding = ({ state }) => {
      if (!isDeepStrictEqual(state, current)) throw new CliError("factory resume bootstrap refused: run.json bytes changed while bootstrap ran; current state was preserved");
      if (!sameSessionOwner(runDir, boundOwner)) throw new CliError("factory resume bootstrap refused: factory.lock is absent, stale, or no longer names the same owner; current state and owner were preserved");
    };
    const next = await transition(runDir, {
      participants: [{ familyId: "envelope", mode: success ? "resume-needs-human" : "record-bootstrap" }],
      ...(outcome ? { reobservers: new Map([["envelope", assertBinding]]), finalGuard: ({ state }) => {
        if (!readFileSync(join(runDir, "run.json")).equals(boundRunBytes) || !isDeepStrictEqual(state, current)) {
          throw new CliError("factory resume bootstrap refused: run.json bytes changed while bootstrap ran; current state was preserved");
        }
        if (!sameSessionOwner(runDir, boundOwner)) throw new CliError("factory resume bootstrap refused: factory.lock is absent, stale, or no longer names the same owner; current state and owner were preserved");
      } } : {}),
      apply: (state) => ({ ...state, ...(success ? { status: "running" } : {}), updated_at: at,
        ...(outcome ? { bootstrap_command: config.bootstrapCommand, bootstrap_exit: outcome.exit } : {}) }),
    });
    if (outcome?.refusal) throw new CliError(`${outcome.refusal}; run remains needs-human and its historical terminal result is preserved`);
    return emit(flags, {
      run_id: runId, status: next.status, terminal_result: next.terminal_result, next: nextAction(next),
    });
  },
};


function exactOid(result) {
  return result?.status === 0 && /^[0-9a-f]{40}\n$/u.test(result.stdout) ? result.stdout.slice(0, -1) : null;
}

function checkBranchName(repository, value, runGit) {
  return runGit(repository, ["check-ref-format", "--branch", value])?.status === 0;
}

function exactRefState(repository, ref, runGit, description, retained = false) {
  const result = runGit(repository, ["show-ref", "--verify", "--quiet", ref]);
  if (result?.status === 0) return "present";
  if (result?.status === 1) return "absent";
  const aftermath = retained ? "; sandbox was retained; run.json is absent" : "";
  throw new CliError(`could not observe ${description} '${ref}' in repository '${repository}'${aftermath}`);
}

function resolveExplicitSeed(sandboxPath, base, runGit) {
  const local = `refs/heads/${base}`;
  const remote = `refs/remotes/origin/${base}`;
  // This is enforcement: classifying both qualified refs before either peel prevents a
  // successful local peel from hiding an observation failure on the remote candidate.
  const states = new Map([
    [local, exactRefState(sandboxPath, local, runGit, "PR base ref", true)],
    [remote, exactRefState(sandboxPath, remote, runGit, "PR base ref", true)],
  ]);
  const resolveRef = (ref) => {
    if (states.get(ref) === "absent") return null;
    const result = runGit(sandboxPath, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    if (!Number.isInteger(result?.status)) {
      throw new CliError(`could not observe commit for PR base ref '${ref}' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
    }
    const oid = exactOid(result);
    if (!oid) throw new CliError(`PR base ref '${ref}' could not be peeled to one commit in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
    return oid;
  };
  const localOid = resolveRef(local);
  const remoteOid = resolveRef(remote);
  const candidates = `'${local}' or '${remote}'`;
  if (!localOid && !remoteOid) throw new CliError(`PR base '${base}' could not be resolved from ${candidates} in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
  if (localOid && remoteOid && localOid !== remoteOid) throw new CliError(`PR base '${base}' resolves to different commits at '${local}' and '${remote}' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
  return localOid ?? remoteOid;
}

function proveInitBranch({ operatorRoot, sandboxPath, worktree, branch, seed, runGit, resolvePath }) {
  const ref = `refs/heads/${branch}`;
  if (exactRefState(operatorRoot, ref, runGit, "feature branch ref", true) === "present") {
    throw new CliError(`feature branch '${branch}' appeared at '${ref}' in operator repository '${operatorRoot}' while sandbox '${sandboxPath}' was initialized; sandbox was retained; run.json is absent`);
  }
  const symbolic = runGit(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic?.status !== 0 || symbolic.stdout !== `${branch}\n`) throw new CliError(`sandbox feature branch '${branch}' is not the exact symbolic HEAD in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
  const branchOid = exactOid(runGit(worktree, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]));
  const headOid = exactOid(runGit(worktree, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]));
  if (branchOid !== seed || headOid !== seed) throw new CliError(`sandbox feature branch '${branch}' or worktree HEAD moved from seed '${seed}' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
  const logResult = runGit(worktree, ["rev-parse", "--git-path", `logs/${ref}`]);
  if (logResult?.status !== 0 || !logResult.stdout.endsWith("\n") || logResult.stdout.slice(0, -1).includes("\n")) throw new CliError(`could not observe creation reflog for feature branch '${branch}' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
  let raw;
  try {
    raw = readFileSync(resolvePath(worktree, logResult.stdout.slice(0, -1)), "utf8");
  } catch {
    throw new CliError(`could not observe creation reflog for feature branch '${branch}' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
  }
  const match = raw.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) .+\tbranch: Created from ([0-9a-f]{40})\n$/u);
  if (!match || match[1] !== "0".repeat(40) || match[2] !== seed || match[3] !== seed) throw new CliError(`feature branch '${branch}' does not have exact one-line creation provenance from seed '${seed}' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
  const ancestry = runGit(worktree, ["merge-base", "--is-ancestor", seed, ref]);
  if (ancestry?.status !== 0) throw new CliError(`feature branch seed '${seed}' is not a proven ancestor of '${ref}' in sandbox '${sandboxPath}'; sandbox was retained; run.json is absent`);
}

export async function dispatchInit(positional, flags, operations = INIT_OPERATIONS) {
  const candidate = preflightInit(positional, flags);
  const {
    cwd, resolvePath, joinPath, realpath, lstat, mkdir, readdir,
    runGit, prove, publish,
  } = operations;
  const dispatchInitPublication = publish;
  const runId = candidate.run_id;
  const operatorInput = resolvePath(flags.repo ?? cwd());
  let operatorRoot;
  try {
    operatorRoot = realpath(operatorInput);
  } catch {
    const S = joinPath(operatorInput, ".factory-sandboxes", runId);
    throw new CliError(`operator repository is not observable; sandbox path '${S}' was not created`);
  }
  const C = joinPath(operatorRoot, ".factory-sandboxes");
  const S = joinPath(C, runId);
  const runDir = joinPath(S, CONTROL_PLANE, runId);
  const legacyManifest = joinPath(operatorRoot, CONTROL_PLANE, runId, "run.json");
  const sandboxManifest = joinPath(runDir, "run.json");

  let top;
  try {
    const observed = runGit(operatorRoot, ["rev-parse", "--show-toplevel"]);
    top = observed.ok && observed.stdout.trim() ? realpath(resolvePath(operatorRoot, observed.stdout.trim())) : null;
  } catch {
    top = null;
  }
  if (top !== operatorRoot) throw new CliError(`--repo must name the canonical operator repository root; sandbox path '${S}' was not created`);

  let legacyState;
  let containerState;
  let sandboxState = { kind: "absent" };
  let sandboxManifestState = "absent";
  try {
    legacyState = manifestPresence(legacyManifest, { lstat });
    containerState = directoryState(C, { lstat, realpath });
    if (containerState.kind === "directory") {
      sandboxState = directoryState(S, { lstat, realpath });
      if (sandboxState.kind === "directory") sandboxManifestState = manifestPresence(sandboxManifest, { lstat });
    }
  } catch (error) {
    throw new CliError(`could not inspect destination policy for sandbox '${S}'`, { cause: error });
  }
  if (legacyState === "present" && sandboxManifestState === "present") {
    throw new CliError(`ambiguous run '${runId}': manifests exist at '${legacyManifest}' and '${sandboxManifest}'; inspect status with --repo '${operatorRoot}' and --repo '${S}'`);
  }
  if (containerState.kind === "unsafe") {
    const legacy = legacyState === "present" ? `; run status/resume for '${legacyManifest}' with --repo '${operatorRoot}'` : "";
    throw new CliError(`sandbox container '${C}' is ${containerState.type}; sandbox path '${S}' was not changed${legacy}`);
  }
  if (sandboxState.kind === "unsafe") {
    const legacy = legacyState === "present" ? `; run status/resume for '${legacyManifest}' with --repo '${operatorRoot}'` : "";
    throw new CliError(`sandbox destination '${S}' is ${sandboxState.type}; it was not reused, changed, or deleted${legacy}`);
  }
  if (legacyState === "present") throw new CliError(`run '${runId}' already exists at '${legacyManifest}'; run status/resume with --repo '${operatorRoot}'; sandbox path '${S}' was not created`);
  if (sandboxManifestState === "present") throw new CliError(`run '${runId}' already exists at '${sandboxManifest}'; run status/resume with --repo '${S}'`);
  if (sandboxState.kind === "directory") {
    const detail = sandboxManifestState === "blocked" ? " with a manifest path blocked by a non-directory component" : " without a manifest";
    throw new CliError(`sandbox destination '${S}' already exists${detail}; it was not reused, changed, or deleted`);
  }

  if (!checkBranchName(operatorRoot, candidate.branch, runGit)) {
    throw new CliError(`feature branch '${candidate.branch}' is not a valid branch name; sandbox path '${S}' was not created`);
  }
  if (candidate.pr_base !== null && !checkBranchName(operatorRoot, candidate.pr_base, runGit)) {
    throw new CliError(`PR base '${candidate.pr_base}' is not a valid branch name; sandbox path '${S}' was not created`);
  }
  const featureRef = `refs/heads/${candidate.branch}`;
  if (exactRefState(operatorRoot, featureRef, runGit, "feature branch ref") === "present") {
    throw new CliError(`feature branch '${candidate.branch}' already exists at '${featureRef}' in operator repository '${operatorRoot}'; restore the operator checkout to 'main', remove the colliding '${candidate.branch}' ref, and retry; sandbox path '${S}' was not created`);
  }
  if (candidate.pr_base !== null) {
    const baseRef = `refs/heads/${candidate.pr_base}`;
    if (exactRefState(operatorRoot, baseRef, runGit, "PR base ref") === "absent") {
      throw new CliError(`PR base '${candidate.pr_base}' does not name local ref '${baseRef}' in operator repository '${operatorRoot}'; sandbox path '${S}' was not created`);
    }
  }

  try {
    const observedContainer = directoryState(C, { lstat, realpath });
    if (observedContainer.kind === "absent") mkdir(C);
    else if (observedContainer.kind !== "directory") throw new Error(`unsafe sandbox container '${C}'`);
    exactDirectory(C, { lstat, realpath });
    mkdir(S);
    exactDirectory(S, { lstat, realpath });
    if (readdir(S).length !== 0) throw new Error("reserved destination is not empty");
  } catch (error) {
    throw new CliError(`could not reserve empty sandbox '${S}'; existing state was preserved`, { cause: error });
  }

  const cloned = runGit(operatorRoot, ["clone", "--local", "--", operatorRoot, S]);
  if (!cloned.ok) {
    let manifest;
    try {
      const state = manifestPresence(sandboxManifest, { lstat });
      manifest = state === "present" ? "present" : state === "absent" ? "absent" : "unobservable";
    } catch {
      manifest = "unobservable";
    }
    throw new CliError(`git clone failed for sandbox '${S}'; run.json is ${manifest}; sandbox was retained`);
  }

  let proof;
  try {
    proof = prove({ operatorRoot, sandboxPath: S, runId, worktree: candidate.worktree });
  } catch (error) {
    throw new CliError(`physical containment could not be proved for sandbox '${S}'; sandbox was retained`, { cause: error });
  }

  let prBase = candidate.pr_base;
  let seed;
  if (prBase === null) {
    const observed = runGit(proof.configuredWorktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    prBase = observed.ok ? observed.stdout.trim() : "";
    if (!prBase) throw new CliError(`could not observe a symbolic branch in PR base worktree '${candidate.worktree}' for sandbox '${S}'; pass --pr-base <branch> explicitly; sandbox was retained`);
    seed = exactOid(runGit(proof.configuredWorktree, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]));
    if (!seed) throw new CliError(`could not observe sandbox HEAD seed in sandbox '${S}'; sandbox was retained; run.json is absent`);
  } else {
    seed = resolveExplicitSeed(S, prBase, runGit);
  }
  const switched = runGit(proof.configuredWorktree, ["switch", "--no-track", "-c", candidate.branch, seed]);
  if (switched?.status !== 0) throw new CliError(`could not create feature branch '${candidate.branch}' from seed '${seed}' in sandbox '${S}'; sandbox was retained; run.json is absent`);
  const proveBranch = () => proveInitBranch({ operatorRoot, sandboxPath: S, worktree: proof.configuredWorktree, branch: candidate.branch, seed, runGit, resolvePath });
  // False-green enforcement: bootstrap is an arbitrary repository-declared command, so the physical
  // proof must be repeated after it runs and again immediately before publication. Branch, ref and
  // reflog evidence is all readable through a `.git` that has been relocated or rebound outside the
  // sandbox, so logical provenance alone cannot see the escape -- and publishing `run.json` for a
  // repository whose Git administration left the sandbox is exactly the green this proof prevents.
  const proveContainedBranch = () => {
    try {
      prove({ operatorRoot, sandboxPath: S, runId, worktree: candidate.worktree });
    } catch (error) {
      throw new CliError(`physical containment could not be re-proved for sandbox '${S}'; sandbox was retained; run.json is absent`, { cause: error });
    }
    proveBranch();
  };
  proveBranch();
  const config = readRepositoryConfig(S, { optional: true });
  let bootstrapEvidence = {};
  if (config?.bootstrapCommand) {
    const outcome = bootstrapOutcome(S, config, "init");
    if (outcome.refusal) throw new CliError(`${outcome.refusal}; sandbox '${S}' was retained; run.json is absent`);
    bootstrapEvidence = { bootstrap_command: config.bootstrapCommand, bootstrap_exit: outcome.exit };
  }
  proveContainedBranch();
  let run;
  try {
    run = validateRun({ ...candidate, pr_base: prBase, pr_draft: config?.prDraft ?? true, ...bootstrapEvidence });
  } catch (error) {
    throw new CliError(`final manifest validation failed for sandbox '${S}'; sandbox was retained`, { cause: error });
  }
  const { observedRun } = await dispatchInitPublication({ runDir, sandboxPath: S, candidate: run, finalGuard: proveContainedBranch });
  return emit(flags, {
    run_id: observedRun.run_id, run_dir: runDir, sandbox_path: proof.sandboxPath,
    branch: observedRun.branch, worktree: observedRun.worktree, pr_base: observedRun.pr_base,
    status: observedRun.status, mode: observedRun.mode,
  });
}

function preflightInit(positional, flags) {
  const refusal = (message, cause) => new CliError(`${message}; no sandbox path was derived or created`, cause ? { cause } : undefined);
  if (positional.length !== 1) throw refusal("factory init requires exactly one <run-id>");
  if (flags.repo !== undefined && (typeof flags.repo !== "string" || !flags.repo.trim())) throw refusal("--repo must be a non-empty string");
  const runId = positional[0];
  try {
    const at = stamp(flags);
    return validateRun({
      version: SCHEMA_VERSION,
      run_id: runId,
      issue_key: flags.issue ?? null,
      branch: flags.branch ?? `feature/${runId}`,
      worktree: flags.worktree ?? ".",
      pr_base: flags.prBase ?? null,
      created_at: at,
      updated_at: at,
      status: "running",
      mode: flags.mode ?? "interactive",
      max_parallel_slices: integer(flags.maxParallelSlices, 3, "--max-parallel-slices"),
      max_retries: integer(flags.maxRetries, 3, "--max-retries"),
      gates: {},
      steps: [],
      slices: [],
      validator: null,
      terminal_result: null,
      pr_url: null,
      plan_digest: null,
    });
  } catch (error) {
    throw refusal(error.message, error);
  }
}

function manifestPresence(path, { lstat }) {
  try {
    lstat(path);
    return "present";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    if (error?.code === "ENOTDIR") return "blocked";
    throw error;
  }
}

function directoryState(path, { lstat, realpath }) {
  let stats;
  try {
    stats = lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (stats.isSymbolicLink()) return { kind: "unsafe", type: "a symbolic link" };
  if (!stats.isDirectory()) return { kind: "unsafe", type: stats.isFile() ? "a regular file" : "an unsafe filesystem entry" };
  if (realpath(path) !== path) return { kind: "unsafe", type: "a non-canonical directory" };
  return { kind: "directory" };
}

function exactDirectory(path, operations) {
  const state = directoryState(path, operations);
  if (state.kind !== "directory") throw new Error(`unsafe directory '${path}'`);
}

function integer(value, fallback, flag) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CliError(`${flag} must be a positive integer`);
  return parsed;
}

function stamp(flags) {
  const at = flags.now !== undefined ? Date.parse(flags.now) : Date.now();
  if (!Number.isFinite(at)) throw new CliError("--now must be an ISO timestamp");
  return new Date(at).toISOString();
}

function emit(flags, payload) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const [name, value] of Object.entries(payload)) {
      if (value === null || value === undefined) continue;
      process.stdout.write(`${name}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`);
    }
  }
  return payload;
}

function usage() {
  process.stdout.write(`factory — durable control plane for /feature runs

  factory init <run-id> [--branch B=feature/<run-id>] [--worktree W=.] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]
  factory status <run-id> [--json]
  factory amend-paths <run-id> <slice-id> --add PATH [--add PATH ...] --reason TEXT --session ID [--now ISO]
  factory resume <run-id> --session ID [--now ISO]
  factory lock <run-id> <claim|steal|release> --session ID [--ttl-ms N]
  factory heartbeat <run-id> --session ID
  factory gate <run-id> <${GATE_NAMES.join("|")}> <${GATE_STATUSES.join("|")}> [--artifact REF]
  factory step <run-id> <agent> <${STEP_STATUSES.join("|")}> [--attempts N] [--review-ref REF] [--evidence-ref REF]
  factory validator <run-id> --report REF   (verdict and head come from reviews/implementation-validator.json)
  factory terminal <run-id> <${TERMINAL_STATUSES.join("|")}> --reason TEXT
  factory effective-push <bootstrap|check> <operator-repository> <sandbox-repository>

State commands take [--repo PATH] and [--json]. effective-push accepts no options. Unknown options are errors.
`);
  return null;
}

// A refusal raised inside a transition reaches here wrapped by the atomic writer,
// whose own message is generic. Printing only `error.message` would report every
// refusal as "protected file commit failed" and hide the reason the operator needs,
// so the cause chain is printed. This was caught by an end-to-end test rather than
// by reading the code.
export function describeError(error, depth = 0) {
  const lines = [];
  let current = error;
  let indent = "";
  while (current && depth < 5) {
    const message = String(current.message ?? current);
    // The wrapper adds nothing once its cause is shown; skip it rather than lead
    // with it.
    if (!(indent === "" && current.cause && message === "protected file commit failed")) {
      lines.push(`${indent}${message}`);
      indent = `${indent}  `;
    }
    current = current.cause;
    depth += 1;
  }
  return lines.join("\n");
}

// Invoked as a program rather than imported. Compared through realpath and pathToFileURL, not by
// building a `file://` string by hand: `process.argv[1]` is the path as typed, while
// `import.meta.url` is resolved, so a symlink anywhere in it makes the two differ and the CLI exits
// 0 having done nothing. That is not exotic — on macOS every temp directory is /var -> /private/var,
// and npm bin shims are symlinks. It was invisible to the whole suite because every test invokes the
// CLI through an already-resolved absolute path; the packed-tarball test found it immediately.
const invokedAsProgram = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (invokedAsProgram()) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
