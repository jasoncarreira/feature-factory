#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { cleanupRun, consumeSteering, continueFactory, heartbeatStatus, listRuns, persistFactoryRunCreatedEnv, persistFactoryRunResumeEnv, recoverDisruptedRun, resumeFactory, startFactory, startHeartbeat, status, stopHeartbeat, validateState, watchRun, writeGateAnswer, writeSteering } from "./factory.js";
import { runDoctor } from "./doctor.js";
import { collectEnv } from "./env-snapshot.js";
import { readJsoncConfig } from "./config.js";
import { canonicalizeGithubPrUrl, githubPrUrlParts } from "./refs.js";
import { normalizePrNumber as normalizeTransitionPrNumber, transitionGateDecision, transitionPrCreated, transitionRecoverOrphan, transitionRunJson, transitionRunSlice, transitionRunStep, transitionSliceMerged, transitionTerminalResult } from "./run-state.js";
import { HEARTBEAT_PROTECTED_GATES, validateRun, validateSlicesPlan } from "./validate.js";
import { isContainedPath } from "./utils.js";
import { factoryRepoFromRunDir, factoryRootsForLookup } from "./factory-paths.js";

const cliPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(cliPath));
const HEARTBEAT_PROTECTED_GATE_SET = new Set(HEARTBEAT_PROTECTED_GATES);
const HEARTBEAT_STEP_IN_FLIGHT_STATUSES = new Set(["running"]);
const HEARTBEAT_SLICE_IN_FLIGHT_STATUSES = new Set(["running", "review"]);
const HEARTBEAT_START_TIMEOUT_MS = 5000;
const HEARTBEAT_START_POLL_MS = 25;
const BOOLEAN_FLAGS = new Set(["--json", "--local", "--profiles", "--provider-smoke", "--autonomous", "--detached", "--all", "--headless", "--ready", "--force", "--dry-run", "--start", "--stop", "--status", "--foreground", "--draft", "--no-draft"]);
const VALUE_FLAGS = new Set(["--repo", "--gh-account", "--model", "--interval", "--phase", "--reviewer", "--review", "--run-id", "--from", "--artifact", "--question-ref", "--answer-ref", "--answer", "--approval-source", "--decision-note", "--answered-at", "--reason", "--merge-commit", "--pr-url", "--pr-number", "--repository", "--branch", "--worktree", "--attempts", "--evidence-ref", "--review-ref", "--artifact-ref", "--validator", "--security", "--report", "--message", "--ref", "--hash"]);

function usage(write = console.log) {
  write(`feature-factory

Commands:
  install [--local]             Add this package to ~/.config/opencode/opencode.jsonc
  doctor [--local] [--profiles] Check opencode/plugin/provider/tool prerequisites
  factory start [--repo PATH] [--gh-account ACCOUNT] [--headless|--autonomous|--detached] <prompt...>
  factory resume-check <run-id> [--json]  Recover/verify a disrupted resume without re-scaffolding
  factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> [--dry-run]
  factory steer <run-id> --message TEXT [--json]
  factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> [--json]
  factory resume <run-id> [--headless|--autonomous|--detached] [--dry-run] [--json]
  factory list                  List local factory runs
  factory status [run-id]       Read .opencode/factory state
  factory heartbeat <run-id> --start --phase <phase> [--interval MS] [--json]  Start detached liveness ticker
  factory heartbeat <run-id> --stop [--json]
  factory heartbeat <run-id> --status [--json]
  factory validate [run-id]     Validate run.json and plan/slices.json
  factory recover <run-id> [--reason TEXT]  Mark orphaned/stale running run as needs-human
  factory cleanup <run-id>      Remove terminal run state, worktrees, and branches
  factory answer [--repo PATH] [--json] <run> <gate> <approve|stop|changes: ...>
  factory gate-decision <run> <gate> <pending|approved|changes_requested|stopped> [--artifact REF] [--question-ref REF] [--answer-ref REF|--answer TEXT] [--approval-source SOURCE]
  factory slices-seed <run-id> --from plan/slices.json
  factory slice-status <run-id> <slice-id> <running|review|blocked> [--branch REF] [--worktree PATH] [--attempts N] [--evidence-ref REF] [--review-ref REF] [--reason TEXT]
  factory step <run-id> <agent> <running|accepted|rejected|blocked> [--artifact-ref REF] [--evidence-ref REF] [--review-ref REF] [--attempts N]
  factory verdicts <run-id> --validator GO|GO-WITH-NITS|NO-GO --report artifacts/validation-report.md --security PASS|BLOCK --review-ref reviews/security-reviewer.json
  factory terminal <run-id> <blocked|partial|needs-human> --reason TEXT
  factory slice-merged <run-id> <slice-id> --merge-commit SHA [--json]
  factory pr-created <run-id> --pr-url URL --pr-number N --repository OWNER/REPO [--draft|--no-draft] [--json]
  factory watch [run-id] [--all] Print status changes as JSON
  factory env                   Print detected versions, models, and capabilities
  factory provenance            Alias for factory env
`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return usage();
  if (cmd === "install") return install(rest);
  if (cmd === "doctor") return doctor(rest);
  if (cmd === "factory") return factory(rest);
  throw new Error(`unknown command: ${cmd}`);
}

function install(args) {
  const local = args.includes("--local");
  const home = homedir();
  const configPath = join(home, ".config", "opencode", "opencode.jsonc");
  mkdirSync(dirname(configPath), { recursive: true });
  const pluginSpec = local ? localPluginSpec() : "opencode-feature-factory";
  const cfg = readJsoncConfig(configPath);
  cfg.$schema ??= "https://opencode.ai/config.json";
  cfg.plugin ??= [];
  const oldSpec = local ? oldLocalPluginSpec() : null;
  const hit = cfg.plugin.findIndex((entry) => pluginEntrySpec(entry) === pluginSpec || (oldSpec && pluginEntrySpec(entry) === oldSpec));
  if (hit === -1) cfg.plugin.push(pluginSpec);
  if (hit !== -1 && Array.isArray(cfg.plugin[hit])) cfg.plugin[hit][0] = pluginSpec;
  if (hit !== -1 && !Array.isArray(cfg.plugin[hit])) cfg.plugin[hit] = pluginSpec;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`configured opencode plugin: ${pluginSpec}`);
  console.log(`updated: ${configPath}`);
  console.log("restart opencode for plugin changes to take effect");
  warnGlobalFeatureSkillConflicts(findGlobalFeatureSkillConflicts(home));
}

function findGlobalFeatureSkillConflicts(home) {
  return [
    join(home, ".config", "opencode", "skills", "feature", "SKILL.md"),
    join(home, ".config", "opencode", "skill", "feature", "SKILL.md"),
    join(home, ".claude", "skills", "feature", "SKILL.md"),
    join(home, ".agents", "skills", "feature", "SKILL.md"),
  ].filter((path) => existsSync(path));
}

function warnGlobalFeatureSkillConflicts(paths) {
  if (!paths.length) return;
  console.warn([
    "",
    "WARNING: existing global feature skill detected.",
    "These files are not installed or managed by opencode-feature-factory and can shadow or conflict with the plugin's current feature workflow:",
    ...paths.map((path) => `- ${path}`),
    "Remove stale files, or replace them with a delegator that reads the repo-seeded .opencode/skills/feature/SKILL.md before mutating factory state.",
    "Restart opencode after changing skill files.",
  ].join("\n"));
}

async function doctor(args) {
  const ok = await runDoctor(options(args));
  process.exitCode = ok ? 0 : 1;
}

async function factory(args) {
  const [sub, ...rest] = args;
  if (sub === "answer") return answer(rest);
  const opts = options(rest);
  const positional = positionals(rest);
  if (sub === "start") {
    const result = await startFactory(positional, opts);
    print(result, opts);
    if (result && typeof result === "object" && result.ok === false) process.exitCode = 1;
    return;
  }
  if (sub === "resume-check") {
    if (positional.length !== 1) throw new Error("factory resume-check requires exactly one <run-id>");
    const result = await recoverDisruptedRun(positional[0], opts);
    print(result, opts);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "continue") {
    if (positional.length !== 1) throw new Error("factory continue requires exactly one <blocked-run-id>");
    return print(continueFactory(positional[0], opts), opts);
  }
  if (sub === "steer") return steer(rest);
  if (sub === "steer-consume") return steerConsume(rest);
  if (sub === "resume") return resume(rest);
  if (sub === "list") return print(listRuns(opts), opts);
  if (sub === "status") return print(status(positional[0], opts), opts);
  if (sub === "heartbeat") return heartbeat(rest);
  if (sub === "cleanup") return print(await cleanupRun(positional[0], opts), opts);
  if (sub === "recover") return recover(rest);
  if (sub === "validate") {
    const result = validateState(positional[0], opts);
    print(result, { ...opts, json: true });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (sub === "env" || sub === "provenance") return env(rest);
  if (sub === "gate-decision") return gateDecision(rest);
  if (sub === "slices-seed") return slicesSeed(rest);
  if (sub === "slice-status") return sliceStatus(rest);
  if (sub === "step") return step(rest);
  if (sub === "verdicts") return verdicts(rest);
  if (sub === "terminal") return terminal(rest);
  if (sub === "slice-merged") return sliceMerged(rest);
  if (sub === "pr-created") return prCreated(rest);
  if (sub === "watch") {
    watchRun(positional[0], opts);
    return;
  }
  console.error(`unknown factory command: ${sub || ""}`.trim());
  usage(console.error);
  process.exitCode = 1;
}

function answer(args) {
  const { opts, runId, gate, answerText } = parseAnswerArgs(args);
  return print(writeGateAnswer(runId, gate, answerText, opts), opts);
}

async function steer(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory steer requires exactly one <run-id>");
  return print(await writeSteering(runId, requiredOption(opts.message, "--message", "factory steer"), opts), opts);
}

async function steerConsume(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory steer-consume requires exactly one <run-id>");
  const ref = requiredOption(opts.ref, "--ref", "factory steer-consume");
  const hash = requiredOption(opts.hash, "--hash", "factory steer-consume");
  return print(await consumeSteering(runId, { ref, hash }, opts), opts);
}

async function resume(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory resume requires exactly one <run-id>");
  return print(await resumeFactory(runId, opts), opts);
}

async function heartbeat(args) {
  const opts = options(args);
  const positional = positionals(args);
  if (positional.length !== 1) throw new Error("factory heartbeat requires exactly one <run-id>");

  const runId = normalizeHeartbeatRunId(positional[0]);
  const mode = heartbeatMode(opts);

  if (mode === "start") {
    return print(await startHeartbeatProcess(runId, opts), opts);
  }

  if (mode === "foreground") {
    return print(
      await startHeartbeat(runId, heartbeatStartConfig(opts), {
        cwd: opts.cwd,
      }),
      opts,
    );
  }

  if (mode === "stop") {
    return print(
      await stopHeartbeat(
        runId,
        {},
        opts,
      ),
      opts,
    );
  }

  if (mode === "status") {
    return print(publicHeartbeatStatus(runId, opts), opts);
  }

  throw new Error("factory heartbeat requires exactly one of --start, --stop, --status, or internal --foreground");
}

function options(args) {
  assertKnownOptions(args);
  const opts = {
    cwd: process.cwd(),
    json: args.includes("--json"),
    local: args.includes("--local"),
    profiles: args.includes("--profiles"),
    providerSmoke: args.includes("--provider-smoke"),
    autonomous: args.includes("--autonomous"),
    detached: args.includes("--detached"),
    all: args.includes("--all"),
    headless: args.includes("--headless") || args.includes("--detached"),
    ready: args.includes("--ready"),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    start: args.includes("--start"),
    stop: args.includes("--stop"),
    heartbeatStatus: args.includes("--status"),
    foreground: args.includes("--foreground"),
  };
  if (args.includes("--draft")) opts.draft = true;
  if (args.includes("--no-draft")) opts.noDraft = true;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repo") opts.cwd = resolve(args[++index]);
    if (args[index] === "--gh-account") opts.ghAccount = args[++index];
    if (args[index] === "--model") opts.model = args[++index];
    if (args[index] === "--interval") opts.intervalMs = Number(args[++index]);
    if (args[index] === "--phase") opts.phase = args[++index];
    if (args[index] === "--reviewer") opts.reviewer = args[++index];
    if (args[index] === "--review") opts.review = args[++index];
    if (args[index] === "--run-id") opts.runId = args[++index];
    if (args[index] === "--from") opts.from = args[++index];
    if (args[index] === "--artifact") opts.artifact = args[++index];
    if (args[index] === "--question-ref") opts.questionRef = args[++index];
    if (args[index] === "--answer-ref") opts.answerRef = args[++index];
    if (args[index] === "--answer") opts.answer = args[++index];
    if (args[index] === "--approval-source") opts.approvalSource = args[++index];
    if (args[index] === "--decision-note") opts.decisionNote = args[++index];
    if (args[index] === "--answered-at") opts.answeredAt = args[++index];
    if (args[index] === "--reason") opts.reason = args[++index];
    if (args[index] === "--merge-commit") opts.mergeCommit = args[++index];
    if (args[index] === "--pr-url") opts.prUrl = args[++index];
    if (args[index] === "--pr-number") opts.prNumber = args[++index];
    if (args[index] === "--repository") opts.repository = args[++index];
    if (args[index] === "--branch") opts.branch = args[++index];
    if (args[index] === "--worktree") opts.worktree = args[++index];
    if (args[index] === "--attempts") opts.attempts = Number(args[++index]);
    if (args[index] === "--evidence-ref") opts.evidenceRef = args[++index];
    if (args[index] === "--review-ref") opts.reviewRef = args[++index];
    if (args[index] === "--artifact-ref") opts.artifactRef = args[++index];
    if (args[index] === "--validator") opts.validator = args[++index];
    if (args[index] === "--security") opts.security = args[++index];
    if (args[index] === "--report") opts.report = args[++index];
    if (args[index] === "--message") opts.message = args[++index];
    if (args[index] === "--ref") opts.ref = args[++index];
    if (args[index] === "--hash") opts.hash = args[++index];
  }
  return opts;
}

function assertKnownOptions(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) {
      if (index + 1 >= args.length || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
}

function positionals(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    output.push(arg);
  }
  return output;
}

function parseAnswerArgs(args) {
  const optionArgs = [];
  const positional = [];
  let index = 0;
  while (index < args.length && positional.length < 2) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg)) {
        optionArgs.push(arg);
        index += 1;
        continue;
      }
      if (VALUE_FLAGS.has(arg)) {
        if (index + 1 >= args.length || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
        optionArgs.push(arg, args[index + 1]);
        index += 2;
        continue;
      }
      throw new Error(`unknown option: ${arg}`);
    }
    positional.push(arg);
    index += 1;
  }
  if (positional.length !== 2 || index >= args.length) throw new Error("factory answer requires <run> <gate> <answer>");
  return { opts: options(optionArgs), runId: positional[0], gate: positional[1], answerText: args.slice(index).join(" ") };
}

async function env(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [action, runId] = positional;
  if (action === "record-created") {
    if (!stringValue(runId) || positional.length !== 2) throw new Error("factory env record-created requires <run-id>");
    return print(await persistFactoryRunCreatedEnv(runId, opts), { ...opts, json: true });
  }
  if (action === "record-resume") {
    if (!stringValue(runId) || positional.length !== 2) throw new Error("factory env record-resume requires <run-id>");
    return print(await persistFactoryRunResumeEnv(runId, opts), { ...opts, json: true });
  }
  if (positional.length > 0) throw new Error(`unknown factory env action: ${action}`);
  return print(await collectEnv({ cwd: opts.cwd }), { ...opts, json: true });
}

async function recover(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory recover requires exactly one <run-id>");
  return print(await transitionRecoverOrphan(resolveRunDir(runId, opts), opts.reason || "recovered orphaned factory run", opts), opts);
}

async function gateDecision(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, gate, statusValue] = positional;
  if (!stringValue(runId) || !stringValue(gate) || !stringValue(statusValue)) {
    throw new Error("factory gate-decision requires <run> <gate> <pending|approved|changes_requested|stopped>");
  }

  const decision = { status: normalizeGateDecisionStatus(statusValue) };
  if (stringValue(opts.artifact)) decision.artifact = opts.artifact;
  if (stringValue(opts.questionRef)) decision.question_ref = opts.questionRef;
  if (stringValue(opts.answerRef)) decision.answer_ref = opts.answerRef;
  if (stringValue(opts.answer)) decision.answer = opts.answer;
  if (stringValue(opts.approvalSource)) decision.approval_source = opts.approvalSource;
  if (stringValue(opts.decisionNote)) decision.decision_note = opts.decisionNote;
  if (stringValue(opts.answeredAt)) decision.answered_at = opts.answeredAt;

  return print(await transitionGateDecision(resolveRunDir(runId, opts), gate, decision, opts), opts);
}

async function slicesSeed(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory slices-seed requires exactly one <run-id>");
  const from = requiredOption(opts.from, "--from", "factory slices-seed");
  const runDir = resolveRunDir(runId, opts);
  const plan = validateSlicesPlan(readJsonFile(resolve(opts.repoRoot || opts.cwd, from), "slices plan"));
  const slices = plan.slices.map((slice) => ({
    id: slice.id,
    stack: slice.stack,
    depends_on: Array.isArray(slice.depends_on) ? slice.depends_on : [],
    status: "pending",
    attempts: 0,
  }));
  return print(await transitionRunJson(runDir, (run) => {
    if (!opts.force && Array.isArray(run.slices) && run.slices.some((slice) => slice?.status && slice.status !== "pending")) {
      throw new Error("factory slices-seed refuses to replace non-pending slice progress without --force");
    }
    run.slices = slices;
  }, opts), opts);
}

async function sliceStatus(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, sliceId, statusValue] = positional;
  if (!stringValue(runId) || !stringValue(sliceId) || !stringValue(statusValue) || positional.length !== 3) {
    throw new Error("factory slice-status requires <run-id> <slice-id> <running|review|blocked>");
  }
  const statusValueNormalized = normalizeSliceStatus(statusValue);
  const update = { status: statusValueNormalized };
  if (statusValueNormalized === "blocked") update.blocked_reason = requiredOption(opts.reason, "--reason", "factory slice-status blocked");
  if (statusValueNormalized === "review") {
    update.evidence_ref = requiredOption(opts.evidenceRef, "--evidence-ref", "factory slice-status review");
    update.review_ref = requiredOption(opts.reviewRef, "--review-ref", "factory slice-status review");
  }
  if (stringValue(opts.branch)) update.branch = opts.branch;
  if (stringValue(opts.worktree)) update.worktree = opts.worktree;
  if (opts.attempts !== undefined) update.attempts = normalizeNonNegativeInteger(opts.attempts, "--attempts");
  return print(await transitionRunSlice(resolveRunDir(runId, opts), sliceId, update, { ...opts, mustExist: true }), opts);
}

async function step(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, agent, statusValue] = positional;
  if (!stringValue(runId) || !stringValue(agent) || !stringValue(statusValue) || positional.length !== 3) {
    throw new Error("factory step requires <run-id> <agent> <running|accepted|rejected|blocked>");
  }
  const update = { status: normalizeStepStatus(statusValue) };
  if (stringValue(opts.artifactRef)) update.artifact_ref = opts.artifactRef;
  if (stringValue(opts.evidenceRef)) update.evidence_ref = opts.evidenceRef;
  if (stringValue(opts.reviewRef)) update.review_ref = opts.reviewRef;
  if (opts.attempts !== undefined) update.attempts = normalizeNonNegativeInteger(opts.attempts, "--attempts");
  return print(await transitionRunStep(resolveRunDir(runId, opts), agent, update, { ...opts, mustExist: true }), opts);
}

async function verdicts(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory verdicts requires exactly one <run-id>");
  const validator = normalizeValidatorVerdict(requiredOption(opts.validator, "--validator", "factory verdicts"));
  const security = normalizeSecurityVerdict(requiredOption(opts.security, "--security", "factory verdicts"));
  const report = assertRefUnder(requiredOption(opts.report, "--report", "factory verdicts"), "artifacts/", "--report");
  const reviewRef = assertRefUnder(requiredOption(opts.reviewRef, "--review-ref", "factory verdicts"), "reviews/", "--review-ref");
  return print(await transitionRunJson(resolveRunDir(runId, opts), (run) => {
    run.validator = { verdict: validator, report, review_ref: "reviews/implementation-validator.json" };
    run.security_review = { verdict: security, review_ref: reviewRef };
  }, opts), opts);
}

async function terminal(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, statusValue] = positional;
  if (!stringValue(runId) || !stringValue(statusValue) || positional.length !== 2) {
    throw new Error("factory terminal requires <run-id> <blocked|partial|needs-human>");
  }
  const statusValueNormalized = normalizeTerminalStatus(statusValue);
  const reason = requiredOption(opts.reason, "--reason", "factory terminal");
  return print(await transitionTerminalResult(resolveRunDir(runId, opts), { status: statusValueNormalized, reason }, opts), opts);
}

async function prCreated(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) {
    throw new Error("factory pr-created requires exactly one <run-id>");
  }
  if (opts.draft === true && opts.noDraft === true) throw new Error("factory pr-created accepts only one of --draft or --no-draft");

  const request = {
    pr_url: canonicalizeGithubPrUrl(requiredOption(opts.prUrl, "--pr-url")),
    pr_number: normalizeCliPrNumber(requiredOption(opts.prNumber, "--pr-number")),
    repository: requiredOption(opts.repository, "--repository"),
    draft: opts.noDraft === true ? false : true,
  };
  const runDir = resolveRunDir(runId, opts);
  verifyContinuationPrIsDraft(readHeartbeatStartRun(runDir), request, opts);
  return print(await transitionPrCreated(runDir, request, opts), opts);
}

function verifyContinuationPrIsDraft(run, request, opts = {}) {
  if (run.continuation?.kind !== "blocked-run-continuation") return;
  if (request.draft !== true) throw new Error("pr-created requires draft PR for blocked-run-continuation runs");
  const state = githubPrDraftState(request, opts);
  if (state !== true) throw new Error("pr-created requires GitHub PR isDraft=true for blocked-run-continuation runs");
}

function githubPrDraftState(request, opts = {}) {
  const pr = githubPrUrlParts(request.pr_url);
  const proc = spawnSync("gh", ["pr", "view", String(pr.number), "--repo", pr.repository, "--json", "isDraft"], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (proc.status !== 0) {
    const detail = String(proc.stderr || proc.stdout || "").trim();
    throw new Error(`pr-created could not verify GitHub PR draft state${detail ? `: ${detail}` : ""}`);
  }
  try {
    const value = JSON.parse(proc.stdout || "{}");
    if (typeof value.isDraft !== "boolean") throw new Error("missing boolean isDraft");
    return value.isDraft;
  } catch (error) {
    throw new Error(`pr-created could not parse GitHub PR draft state: ${error.message}`);
  }
}

async function sliceMerged(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, sliceId] = positional;
  if (!stringValue(runId) || !stringValue(sliceId) || positional.length !== 2) {
    throw new Error("factory slice-merged requires <run-id> <slice-id>");
  }
  const request = { merge_commit: requiredOption(opts.mergeCommit, "--merge-commit", "factory slice-merged") };
  return print(await transitionSliceMerged(resolveRunDir(runId, opts), sliceId, request, opts), opts);
}

function normalizeCliPrNumber(value) {
  try {
    return normalizeTransitionPrNumber(value);
  } catch {
    throw new Error("factory pr-created requires --pr-number to be a positive integer");
  }
}

function requiredOption(value, flag, command = "factory pr-created") {
  if (!stringValue(value)) throw new Error(`${command} requires ${flag}`);
  return value;
}

function normalizeGateDecisionStatus(value) {
  const status = String(value).trim();
  if (["pending", "approved", "changes_requested", "stopped"].includes(status)) return status;
  if (status === "approve") return "approved";
  if (status === "changes") return "changes_requested";
  if (status === "stop") return "stopped";
  throw new Error("gate decision status must be pending, approved, changes_requested, or stopped");
}

function normalizeSliceStatus(value) {
  const statusValue = String(value).trim();
  if (["running", "review", "blocked"].includes(statusValue)) return statusValue;
  throw new Error("slice status must be running, review, or blocked");
}

function normalizeStepStatus(value) {
  const statusValue = String(value).trim();
  if (["running", "accepted", "rejected", "blocked"].includes(statusValue)) return statusValue;
  throw new Error("step status must be running, accepted, rejected, or blocked");
}

function normalizeTerminalStatus(value) {
  const statusValue = String(value).trim();
  if (["blocked", "partial", "needs-human"].includes(statusValue)) return statusValue;
  throw new Error("terminal status must be blocked, partial, or needs-human");
}

function normalizeValidatorVerdict(value) {
  const verdict = String(value).trim();
  if (["GO", "GO-WITH-NITS", "NO-GO"].includes(verdict)) return verdict;
  throw new Error("validator verdict must be GO, GO-WITH-NITS, or NO-GO");
}

function normalizeSecurityVerdict(value) {
  const verdict = String(value).trim();
  if (["PASS", "BLOCK"].includes(verdict)) return verdict;
  throw new Error("security verdict must be PASS or BLOCK");
}

function normalizeNonNegativeInteger(value, flag) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`);
  return value;
}

function assertRefUnder(value, prefix, flag) {
  const ref = String(value).trim();
  if (!ref.startsWith(prefix)) throw new Error(`${flag} must be under ${prefix}`);
  return ref;
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function print(value, opts) {
  if (value === undefined) return;
  if (value === null || opts.json || typeof value !== "object") {
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) console.log(`${item.run_id}\t${item.status}\t${item.gate || "-"}\t${item.updated_at || "-"}\t${formatDiagnosticColumn(item.diagnostics)}`);
    return;
  }
  for (const [key, val] of Object.entries(value)) console.log(`${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
}

function formatDiagnosticColumn(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return "-";
  if (diagnostics.status === "ok") return "ok";
  const prefix = [diagnostics.classification, diagnostics.status].filter(stringValue).join("/") || "diagnostic";
  const summary = cleanDiagnosticText(diagnostics.summary || "check diagnostics");
  return `${prefix}:${summary}`;
}

function cleanDiagnosticText(value) {
  const text = String(value).replace(/[\t\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function heartbeatMode(opts) {
  const modes = [
    ["start", opts.start],
    ["stop", opts.stop],
    ["status", opts.heartbeatStatus],
    ["foreground", opts.foreground],
  ].filter(([, enabled]) => enabled);
  if (modes.length !== 1) {
    throw new Error("factory heartbeat requires exactly one of --start, --stop, --status, or internal --foreground");
  }
  return modes[0][0];
}

async function startHeartbeatProcess(runId, opts) {
  const config = heartbeatStartConfig(opts);
  const runDir = resolveRunDir(runId, opts);
  const run = readHeartbeatStartRun(runDir);
  let current = status(runId, opts);
  if (current.status === "invalid") {
    throw new Error(current.error || "run diagnostics failed closed");
  }
  if (current.status !== "running") {
    throw new Error(`run '${current.run_id}' must be running to start a heartbeat`);
  }
  if (HEARTBEAT_PROTECTED_GATE_SET.has(current.pending_gate)) {
    throw new Error(`run '${current.run_id}' is waiting at protected gate '${current.pending_gate}'`);
  }
  if (!hasInFlightHeartbeatWork(run)) {
    throw new Error(`run '${current.run_id}' has no in-flight factory work for heartbeat`);
  }
  const childArgs = [cliPath, "factory", "heartbeat", runId, "--foreground", "--phase", config.phase];
  if (config.intervalMs !== undefined) childArgs.push("--interval", String(config.intervalMs));

  const child = spawn(process.execPath, childArgs, {
    cwd: opts.cwd,
    detached: true,
    env: { ...process.env },
    stdio: "ignore",
  });
  child.unref();

  return waitForHeartbeatStart(runId, { cwd: opts.cwd, pid: child.pid });
}

async function waitForHeartbeatStart(runId, opts = {}) {
  const deadline = Date.now() + HEARTBEAT_START_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const current = heartbeatStatus(runId, { cwd: opts.cwd });
    if (current?.pid === opts.pid && current.fresh) return current;
    if (opts.pid && !isProcessAlive(opts.pid)) break;
    await sleep(HEARTBEAT_START_POLL_MS);
  }
  throw new Error(`heartbeat failed to start for run '${runId}'`);
}

function heartbeatStartConfig(opts) {
  return {
    phase: normalizeHeartbeatPhase(opts.phase),
    intervalMs: normalizePositiveInteger(opts.intervalMs, "intervalMs"),
  };
}

function normalizeHeartbeatPhase(phase) {
  if (!stringValue(phase)) throw new Error("heartbeat phase must be a non-empty string");
  return phase.trim();
}

function normalizePositiveInteger(value, name) {
  if (value === undefined || value === null) return undefined;
  const next = Number(value);
  if (!Number.isInteger(next) || next <= 0) throw new Error(`${name} must be a positive integer`);
  return next;
}

function resolveRunDir(runId, opts = {}) {
  const normalized = normalizeHeartbeatRunId(runId);
  for (const root of factoryRootsForLookup(opts.cwd || process.cwd())) {
    const dir = resolve(root, normalized);
    if (!existsSync(join(dir, "run.json"))) continue;
    if (!insideDirectory(root, dir)) throw new Error(`heartbeat run directory must be inside .opencode/factory: ${dir}`);
    return rememberFactoryRepo(opts, dir);
  }
  throw new Error(`run not found: ${runId}`);
}

function rememberFactoryRepo(opts, runDir) {
  if (opts && typeof opts === "object") opts.repoRoot = factoryRepoFromRunDir(runDir);
  return runDir;
}

function publicHeartbeatStatus(runId, opts = {}) {
  const current = heartbeatStatus(runId, opts);
  if (!current) return null;
  return current;
}

function readHeartbeatStartRun(runDir) {
  return validateRun(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
}

function hasInFlightHeartbeatWork(run) {
  if (Array.isArray(run.steps) && run.steps.some((step) => HEARTBEAT_STEP_IN_FLIGHT_STATUSES.has(step?.status))) {
    return true;
  }
  if (Array.isArray(run.slices) && run.slices.some((slice) => HEARTBEAT_SLICE_IN_FLIGHT_STATUSES.has(slice?.status))) {
    return true;
  }
  return false;
}

function normalizeHeartbeatRunId(runId) {
  if (!stringValue(runId)) throw new Error("factory heartbeat requires exactly one <run-id>");
  const value = String(runId).trim();
  if (isAbsolute(value) || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error("factory heartbeat requires a bare <run-id>, not a filesystem path");
  }
  return value;
}

function insideDirectory(parent, child) {
  return isContainedPath(parent, child, { allowEqual: false });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return false;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sleep(ms) {
  return new Promise((nextResolve) => setTimeout(nextResolve, ms));
}

function localPluginSpec() {
  return pathToFileURL(root).href;
}

function oldLocalPluginSpec() {
  return pathToFileURL(join(root, "src", "plugin.js")).href;
}

function pluginEntrySpec(entry) {
  return Array.isArray(entry) ? entry[0] : entry;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
