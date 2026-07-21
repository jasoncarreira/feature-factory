#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, constants as FS_CONSTANTS, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { abortSteeringAction, acknowledgeSteering, acknowledgeSteeringActionStart, adoptContinuation, assertHeartbeatStartable, attachCheckpointCompletionRecovery, cancelFactoryRun, cleanupRun, clearPrePrFence, closeFactoryCheckpointRoute, consumeSteering, continueFactory, crossSteeringBoundary, establishPrePrFence, executeIntegrationAmendment, heartbeatStatus, listRuns, openSteeringBoundary, persistFactoryRunCreatedEnv, persistFactoryRunResumeEnv, postPrObserve, postPrRemediation, probeFactorySlices, recordCostUsage, recordFactoryCheckpointMerged, recordReviewDispatchProvenance, recordSteeringConflict, recoverDisruptedRun, resumeFactory, seedFactorySlices, startFactory, startFactoryCheckpoint, startHeartbeat, status, stopHeartbeat, transitionGateDecisionAndHandoff, validateState, watchRun, writeGateAnswer, writeSteering } from "./factory.js";
import { formatCostAttributionSummary, sanitizePublicCostText } from "./cost-attribution.js";
import { buildCostReport, formatCostReport } from "./cost-report.js";
import { runDoctor } from "./doctor.js";
import { collectEnv } from "./env-snapshot.js";
import { readJsoncConfig } from "./config.js";
import { transitionPanelVerdicts, transitionPrCreated, transitionRecoverOrphan, transitionMergedSliceRepair, transitionRunSlice, transitionRunStep, transitionSliceMerged, transitionTerminalResult } from "./run-state.js";
import { validateRun } from "./validate.js";
import { isContainedPath } from "./utils.js";
import { factoryRepoFromRunDir, factoryRootsForLookup } from "./factory-paths.js";
import { printCliResult, projectCliData, projectCostReport, renderCliPath } from "./cli-output.js";
import { freeformSegment, identitySegment, renderErrorForTerminal, renderTerminalSegments, StructuredOutputError, TRUSTED_SEGMENTS } from "./hardening/output-policy.js";
import { serializeTerminalJson } from "./hardening/terminal-encoding.js";
import { runCleanupSweepCommand } from "./cleanup-sweep-command.js";
import { renderCleanupSweepReport } from "./cleanup-sweep-output.js";
import { executeCleanupSweep, previewCleanupSweep } from "./cleanup-sweep.js";
import { executeCheckedTestExecution, executeCheckedVerificationArtifact } from "./test-execution.js";

const cliPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(cliPath));
const HEARTBEAT_START_TIMEOUT_MS = 5000;
const HEARTBEAT_START_POLL_MS = 25;
const BOOLEAN_FLAGS = new Set(["--json", "--local", "--profiles", "--provider-smoke", "--telemetry", "--autonomous", "--detached", "--all", "--headless", "--ready", "--force", "--dry-run", "--start", "--stop", "--status", "--foreground", "--draft", "--no-draft", "--clear", "--post-pr-ci", "--no-post-pr-ci", "--new-pr", "--carry-forward"]);
const VALUE_FLAGS = new Set(["--repo", "--gh-account", "--model", "--interval", "--phase", "--reviewer", "--review", "--run-id", "--from", "--artifact", "--question-ref", "--answer-ref", "--answer", "--approval-source", "--decision-note", "--answered-at", "--reason", "--merge-commit", "--commit", "--owner-slice", "--consumer-slice", "--defect-path", "--verification-ref", "--pr-url", "--pr-number", "--repository", "--head-sha", "--branch", "--worktree", "--attempts", "--evidence-ref", "--review-ref", "--artifact-ref", "--validator", "--security", "--report", "--message", "--ref", "--hash", "--boundary-token", "--action-token", "--fence-token", "--agent", "--subject", "--prompt-bytes", "--step", "--slice-id", "--provider", "--source", "--operation", "--request-id", "--input-tokens", "--output-tokens", "--total-tokens", "--cache-creation-input-tokens", "--cache-read-input-tokens", "--reasoning-tokens", "--cost-total", "--cost-input", "--cost-output", "--cost-cache-creation", "--cost-cache-read", "--currency", "--recorded-at", "--entry-id", "--parent-span-id", "--traceparent", "--tracestate", "--post-pr-wait-minutes", "--post-pr-poll-seconds", "--post-pr-max-poll-seconds", "--post-pr-check-start-grace-seconds", "--post-pr-max-transient-errors", "--remediation-evidence-ref", "--failure-evidence-ref", "--test-evidence-ref", "--validator-report-ref", "--validator-review-ref", "--security-review-ref"]);
const COST_REPORT_BOOLEAN_FLAGS = new Set(["--json", "--telemetry"]);
const COST_REPORT_VALUE_FLAGS = new Set(["--repo"]);
const COST_NUMERIC_FLAGS = new Map([
  ["--input-tokens", "inputTokens"],
  ["--output-tokens", "outputTokens"],
  ["--total-tokens", "totalTokens"],
  ["--cache-creation-input-tokens", "cacheCreationInputTokens"],
  ["--cache-read-input-tokens", "cacheReadInputTokens"],
  ["--reasoning-tokens", "reasoningTokens"],
  ["--cost-total", "costTotal"],
  ["--cost-input", "costInput"],
  ["--cost-output", "costOutput"],
  ["--cost-cache-creation", "costCacheCreation"],
  ["--cost-cache-read", "costCacheRead"],
]);
const SAFE_COST_REPORT_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

function usage(write = console.log) {
  write(`feature-factory

Commands:
  install [--local]             Add this package to ~/.config/opencode/opencode.jsonc
  doctor [--local] [--profiles] [--telemetry] Check opencode/plugin/provider/tool prerequisites
  factory start [--repo PATH] [--run-id ID] [--gh-account ACCOUNT] [--post-pr-ci|--no-post-pr-ci] [--headless|--autonomous|--detached] [--draft|--ready|--no-draft] [--parent-span-id ID] [--traceparent VALUE] [--tracestate VALUE] <prompt...>
  factory checkpoint-start <parent-run-id> <checkpoint-id> --run-id <child-run-id> [start options]
  factory checkpoint-record-merged <parent-run-id> <checkpoint-id> [--json]
  factory checkpoint-close <parent-run-id> [--json]  Close the final checkpoint route after its canonical PR merge
  factory resume-check <run-id> [--json]  Recover/verify a disrupted resume without re-scaffolding
  factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id> [--carry-forward|--new-pr] [--post-pr-ci|--no-post-pr-ci] [--headless|--autonomous|--detached] [--draft|--ready|--no-draft] [--dry-run] [--parent-span-id ID] [--traceparent VALUE] [--tracestate VALUE]
  factory cancel <run-id> [--json]
  factory steer <run-id> --message TEXT [--json]
  factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> [--json]
  factory steer-ack <run-id> --ref steering/consumed-<file>.json --hash sha256:<hash> [--json]
  factory steer-conflict <run-id> --ref steering/<file>.json --hash sha256:<hash> [--reason TEXT] [--json]
  factory boundary-open <run-id> <gate|dispatch|remediation|terminal> [--json]
  factory boundary-cross <run-id> <dispatch|remediation> --boundary-token TOKEN [--json]
  factory action-started <run-id> <dispatch|remediation> --action-token TOKEN [--json]
  factory action-abort <run-id> <dispatch|remediation> --action-token TOKEN [--json]
  factory pr-fence <run-id> [--clear --fence-token TOKEN] [--json]
  factory cost-record <run-id> --agent AGENT [--step STEP] [--slice-id ID] [--provider PROVIDER] [--model MODEL] [--source SOURCE] [--operation OP] [--request-id ID] [--input-tokens N] [--output-tokens N] [--total-tokens N] [--cache-creation-input-tokens N] [--cache-read-input-tokens N] [--reasoning-tokens N] [--cost-total N] [--cost-input N] [--cost-output N] [--cost-cache-creation N] [--cost-cache-read N] [--currency CODE] [--recorded-at ISO] [--entry-id ID] [--json]
  factory cost-report <run-id> [--json] [--telemetry]
  factory resume <run-id> [--headless|--autonomous|--detached] [--dry-run] [--json] [--parent-span-id ID] [--traceparent VALUE] [--tracestate VALUE]
  factory list                  List local factory runs
  factory status [run-id]       Read .opencode/factory state
  factory heartbeat <run-id> --start --phase <phase> [--interval MS] [--json]  Start detached liveness ticker
  factory heartbeat <run-id> --stop [--json]
  factory heartbeat <run-id> --status [--json]
  factory validate [run-id]     Validate run.json and plan/slices.json
  factory recover <run-id> [--reason TEXT]  Mark orphaned/stale running run as needs-human
  factory test-execute <run-id> --json  Execute the exact accepted integration gate and publish its checked receipt
  factory artifact-execute <run-id> <slice-id> <artifact-id> --json  Execute one exact envelope verification artifact and publish its checked receipt
  factory amendment <run-id> report --owner-slice ID --consumer-slice ID --defect-path PATH --artifact-id ID --json
  factory amendment <run-id> build --attempt 1|2 --json
  factory amendment <run-id> <review|integrate|verify|merge> --json
  factory amendment <run-id> block --reason TEXT --json
  factory cleanup <run-id> [--dry-run] [--force] [--repo PATH] [--json]
  factory cleanup --all --dry-run [--repo PATH] [--json]
  factory cleanup --all --digest ff-cleanup-v1.<repository-sha256>.<envelope-sha256> [--repo PATH] [--json]
  factory answer [--repo PATH] [--json] <run> <gate> <approve|stop|changes: ...>
  factory gate-decision <run> <gate> <pending|approved|changes_requested|stopped> [--artifact REF] [--question-ref REF] [--answer-ref REF|--answer TEXT] [--approval-source SOURCE] [--boundary-token TOKEN]
  factory slices-probe <run-id> --from plan/slices.json [--json]
  factory slices-seed <run-id> --from plan/slices.json [--boundary-token TOKEN]
  factory slice-status <run-id> <slice-id> <running|review|blocked> [--branch REF] [--worktree PATH] [--attempts N] [--evidence-ref REF] [--review-ref REF] [--reason TEXT]
  factory repair <run-id> <reported|repairing|review|merged|blocked> [retained legacy: blocked, previously-attempted, or branch-only consumer]
  factory step <run-id> <agent> <running|accepted|rejected|blocked> [--artifact-ref REF] [--evidence-ref REF] [--review-ref REF] [--attempts N]
  factory verdicts <run-id> --validator GO|GO-WITH-NITS|NO-GO --report artifacts/validation-report.md --security PASS|BLOCK --review-ref reviews/security-reviewer.json
  factory terminal <run-id> <blocked|partial|needs-human> --reason TEXT --boundary-token TOKEN
  factory slice-merged <run-id> <slice-id> --merge-commit SHA [--json]
  factory pr-created <run-id> --fence-token TOKEN [--json]
  factory post-pr-observe <run-id> [--json]
  factory post-pr-remediation <run-id> <attempt> running [--json]
  factory post-pr-remediation <run-id> <attempt> revalidating --remediation-evidence-ref REF [--json]
  factory post-pr-remediation <run-id> <attempt> failed --failure-evidence-ref REF [--json]
  factory post-pr-remediation <run-id> <attempt> complete --head-sha SHA --test-evidence-ref REF --validator-report-ref REF --validator-review-ref REF --security-review-ref REF [--json]
  factory watch [run-id] [--all] Print status changes as JSON
  factory env                   Print detected versions, models, and capabilities
  factory provenance            Alias for factory env
  factory provenance review-dispatch <run-id> --agent AGENT --subject SUBJECT --attempts N --hash sha256:<hash> --prompt-bytes N [--json]
`);
}

export async function runCliCommand(argv, dependencies = {}) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return usage();
  if (cmd === "install") return install(rest);
  if (cmd === "doctor") return doctor(rest);
  if (cmd === "factory") return factory(rest, dependencies);
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
  const matchesSpec = (entry) => pluginEntrySpec(entry) === pluginSpec || (oldSpec && pluginEntrySpec(entry) === oldSpec);
  // Single-entry contract: keep exactly one registration. Prefer the first tuple
  // match so existing options survive, rewrite its spec, and drop every other
  // matching string/tuple duplicate (including stale legacy-local specs).
  const matchIndexes = cfg.plugin.map((entry, index) => (matchesSpec(entry) ? index : -1)).filter((index) => index >= 0);
  const hit = matchIndexes.find((index) => Array.isArray(cfg.plugin[index])) ?? matchIndexes[0] ?? -1;
  if (hit === -1) cfg.plugin.push(pluginSpec);
  if (hit !== -1 && Array.isArray(cfg.plugin[hit])) cfg.plugin[hit][0] = pluginSpec;
  if (hit !== -1 && !Array.isArray(cfg.plugin[hit])) cfg.plugin[hit] = pluginSpec;
  if (hit !== -1) cfg.plugin = cfg.plugin.filter((entry, index) => index === hit || !matchesSpec(entry));
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`configured opencode plugin: ${renderCliPath(pluginSpec)}`);
  console.log(`updated: ${renderCliPath(configPath)}`);
  console.log("restart opencode for plugin changes to take effect");
  warnGlobalFeatureSkillConflicts(findGlobalFeatureSkillConflicts(home));
  warnGlobalAgentConflicts(findGlobalAgentConflicts(home));
}

function findGlobalAgentConflicts(home) {
  const names = readdirSync(join(root, "assets", "agent")).filter((name) => name.endsWith(".md"));
  return names.flatMap((name) => [
    join(home, ".config", "opencode", "agent", name),
    join(home, ".config", "opencode", "agents", name),
  ]).filter((path) => existsSync(path));
}

function warnGlobalAgentConflicts(paths) {
  if (!paths.length) return;
  console.warn([
    "",
    "WARNING: existing global feature-factory agent definitions detected.",
    "These files are not managed by opencode-feature-factory and can shadow the plugin's current prompts:",
    ...paths.map((path) => `- ${renderCliPath(path)}`),
    "Remove stale files, or replace them with delegators that defer to the plugin-owned agents.",
    "Restart opencode after changing agent files.",
  ].join("\n"));
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
    ...paths.map((path) => `- ${renderCliPath(path)}`),
    "Remove stale files, or replace them with a delegator that reads the repo-seeded .opencode/skills/feature/SKILL.md before mutating factory state.",
    "Restart opencode after changing skill files.",
  ].join("\n"));
}

async function doctor(args) {
  const ok = await runDoctor(options(args));
  process.exitCode = ok ? 0 : 1;
}

async function factory(args, dependencies = {}) {
  const [sub, ...rest] = args;
  if (sub === "answer") return answer(rest);
  if (sub === "test-execute") return testExecute(rest, dependencies);
  if (sub === "artifact-execute") return artifactExecute(rest, dependencies);
  if (sub === "amendment") return amendment(rest, dependencies);
  if (sub === "cost-report") return costReport(rest);
  if (sub === "cleanup" && rest.some((argument) => argument === "--all" || argument === "--digest" || argument.startsWith("--all=") || argument.startsWith("--digest="))) return cleanupSweep(rest);
  const opts = { ...options(rest), ...(dependencies.factoryOptions || {}) };
  const positional = positionals(rest);
  if (sub === "start") {
    if (opts.dryRun) throw new Error("factory start --dry-run is unsupported");
    const result = await startFactory(positional, opts);
    print(result, opts);
    if (result && typeof result === "object" && result.ok === false) process.exitCode = 1;
    return;
  }
  if (sub === "checkpoint-start") {
    if (positional.length !== 2) throw new Error("factory checkpoint-start requires exactly <parent-run-id> <checkpoint-id>");
    const result = await startFactoryCheckpoint(positional[0], positional[1], opts);
    print(result, opts);
    if (result && typeof result === "object" && result.ok === false) process.exitCode = 1;
    return;
  }
  if (sub === "checkpoint-record-merged") {
    assertOnlyCommandOptions(rest, new Set(["--json", "--repo"]), "factory checkpoint-record-merged");
    if (positional.length !== 2) throw new Error("factory checkpoint-record-merged requires exactly <parent-run-id> <checkpoint-id>");
    return print(await recordFactoryCheckpointMerged(positional[0], positional[1], opts), opts);
  }
  if (sub === "checkpoint-close") {
    if (positional.length !== 1) throw new Error("factory checkpoint-close requires exactly <parent-run-id>");
    return print(await closeFactoryCheckpointRoute(positional[0], opts), opts);
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
    return print(await continueFactory(positional[0], opts), opts);
  }
  if (sub === "adopt-continuation") {
    if (positional.length !== 1) throw new Error("factory adopt-continuation requires exactly one <child-run-id>");
    return print(await adoptContinuation(positional[0], opts), opts);
  }
  if (sub === "cancel") return cancel(rest);
  if (sub === "steer") return steer(rest);
  if (sub === "steer-consume") return steerConsume(rest);
  if (sub === "steer-ack") return steerAck(rest);
  if (sub === "steer-conflict") return steerConflict(rest);
  if (sub === "boundary-open") return boundaryOpen(rest);
  if (sub === "boundary-cross") return boundaryCross(rest);
  if (sub === "action-started") return actionStarted(rest);
  if (sub === "action-abort") return actionAbort(rest);
  if (sub === "pr-fence") return prFence(rest);
  if (sub === "cost-record") return costRecord(rest);
  if (sub === "resume") return resume(rest, dependencies);
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
  if (sub === "provenance" && positional[0] === "review-dispatch") return provenanceReviewDispatch(rest);
  if (sub === "env" || sub === "provenance") return env(rest);
  if (sub === "gate-decision") return gateDecision(rest, dependencies);
  if (sub === "slices-probe") return slicesProbe(rest);
  if (sub === "slices-seed") return slicesSeed(rest);
  if (sub === "slice-status") return sliceStatus(rest);
  if (sub === "repair") return repairStatus(rest);
  if (sub === "step") return step(rest);
  if (sub === "verdicts") return verdicts(rest);
  if (sub === "terminal") return terminal(rest);
  if (sub === "slice-merged") return sliceMerged(rest);
  if (sub === "pr-created") return prCreated(rest);
  if (sub === "post-pr-observe") {
    if (positional.length !== 1) throw new Error("factory post-pr-observe requires exactly one <run-id>");
    return print(await postPrObserve(positional[0], opts), opts);
  }
  if (sub === "post-pr-remediation") {
    if (positional.length !== 3) throw new Error("factory post-pr-remediation requires <run-id> <attempt> <running|revalidating|failed|complete>");
    return print(await postPrRemediation(positional[0], positional[1], positional[2], opts), opts);
  }
  if (sub === "watch") {
    watchRun(positional[0], opts);
    return;
  }
  console.error(renderTerminalSegments([
    freeformSegment("unknown factory command"),
    TRUSTED_SEGMENTS.COLON_SPACE,
    freeformSegment(sub || ""),
  ]).trim());
  usage(console.error);
  process.exitCode = 1;
}

async function testExecute(args, dependencies = {}) {
  try {
    if (args.length !== 2 || args.filter((value) => value === "--json").length !== 1) {
      throw staticCliError("factory test-execute requires exactly <run-id> --json");
    }
    const runId = args.find((value) => value !== "--json");
    if (!stringValue(runId) || String(runId).startsWith("--")) throw staticCliError("factory test-execute requires exactly <run-id> --json");
    const result = await executeCheckedTestExecution(resolveRunDir(runId), dependencies.testExecutionOptions || {});
    console.log(serializeTerminalJson(result, { space: 2 }));
    if (result.status !== "pass") process.exitCode = 1;
    return result;
  } catch (error) {
    const envelope = {
      ok: false,
      error: {
        code: typeof error?.code === "string" && error.code.length > 0 ? error.code : "TEST_EXECUTION_ERROR",
        message: renderErrorForTerminal(error),
      },
    };
    console.log(serializeTerminalJson(envelope, { space: 2 }));
    process.exitCode = 1;
    return envelope;
  }
}

async function artifactExecute(args, dependencies = {}) {
  try {
    if (args.length !== 4 || args.filter((value) => value === "--json").length !== 1) {
      throw staticCliError("factory artifact-execute requires exactly <run-id> <slice-id> <artifact-id> --json");
    }
    const [runId, sliceId, artifactId] = args.filter((value) => value !== "--json");
    if (![runId, sliceId, artifactId].every((value) => stringValue(value) && !String(value).startsWith("--"))) {
      throw staticCliError("factory artifact-execute requires exactly <run-id> <slice-id> <artifact-id> --json");
    }
    const result = await executeCheckedVerificationArtifact(resolveRunDir(runId), sliceId, artifactId, dependencies.artifactExecutionOptions || {});
    console.log(serializeTerminalJson(result, { space: 2 }));
    if (result.receipt?.status !== "pass") process.exitCode = 1;
    return result;
  } catch (error) {
    const envelope = {
      ok: false,
      error: {
        code: typeof error?.code === "string" && error.code.length > 0 ? error.code : "ARTIFACT_EXECUTION_ERROR",
        message: renderErrorForTerminal(error),
      },
    };
    console.log(serializeTerminalJson(envelope, { space: 2 }));
    process.exitCode = 1;
    return envelope;
  }
}

async function amendment(args, dependencies = {}) {
  const [runId, action] = args;
  if (!stringValue(runId) || String(runId).startsWith("--") || !stringValue(action)) throw staticCliError("factory amendment requires <run-id> <action> with the exact documented --json grammar");
  let request;
  if (action === "report") {
    if (args.length !== 11 || args[2] !== "--owner-slice" || args[4] !== "--consumer-slice" || args[6] !== "--defect-path" || args[8] !== "--artifact-id" || args[10] !== "--json"
      || ![args[3], args[5], args[7], args[9]].every((value) => stringValue(value) && !value.startsWith("--"))) {
      throw staticCliError("factory amendment report requires exactly <run-id> report --owner-slice ID --consumer-slice ID --defect-path PATH --artifact-id ID --json");
    }
    request = { action, owner_slice_id: args[3], consumer_slice_id: args[5], defect_path: args[7], verification_artifact_id: args[9] };
  } else if (action === "build") {
    if (args.length !== 5 || args[2] !== "--attempt" || !["1", "2"].includes(args[3]) || args[4] !== "--json") {
      throw staticCliError("factory amendment build requires exactly <run-id> build --attempt 1|2 --json");
    }
    request = { action, attempt: Number(args[3]) };
  } else if (["review", "integrate", "verify", "merge"].includes(action)) {
    if (args.length !== 3 || args[2] !== "--json") throw staticCliError(`factory amendment ${action} requires exactly <run-id> ${action} --json`);
    request = { action };
  } else if (action === "block") {
    if (args.length !== 5 || args[2] !== "--reason" || !stringValue(args[3]) || args[3].startsWith("--") || args[4] !== "--json") {
      throw staticCliError("factory amendment block requires exactly <run-id> block --reason TEXT --json");
    }
    request = { action, reason: args[3] };
  } else throw staticCliError(`unknown factory amendment action: ${action}`);
  const result = await executeIntegrationAmendment(resolveRunDir(runId), request, dependencies.amendmentOptions || {});
  console.log(serializeTerminalJson(result, { space: 2 }));
  return result;
}

async function cleanupSweep(args) {
  process.exitCode = await runCleanupSweepCli(args);
}

export async function runCleanupSweepCli(args, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? runCleanupSweepCommand;
  const render = dependencies.render ?? renderCleanupSweepReport;
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    const result = await runCommand(args, {
      preview: dependencies.preview ?? previewCleanupSweep,
      execute: dependencies.execute ?? executeCleanupSweep,
    });
    stdout(render(result.report, { json: args.includes("--json") }));
    return result.exitCode;
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error;
    stderr(`error: ${renderErrorForTerminal(error)}`);
    return 1;
  }
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

async function steerAck(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory steer-ack requires exactly one <run-id>");
  const ref = requiredOption(opts.ref, "--ref", "factory steer-ack");
  const hash = requiredOption(opts.hash, "--hash", "factory steer-ack");
  return print(await acknowledgeSteering(runId, { ref, hash }, opts), opts);
}

async function boundaryOpen(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, kind] = positional;
  if (!stringValue(runId) || !stringValue(kind) || positional.length !== 2) throw new Error("factory boundary-open requires <run-id> <gate|dispatch|remediation|terminal>");
  return print(await openSteeringBoundary(runId, kind, opts), opts);
}

async function boundaryCross(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, kind] = positional;
  if (!stringValue(runId) || !stringValue(kind) || positional.length !== 2) throw new Error("factory boundary-cross requires <run-id> <dispatch|remediation>");
  return print(await crossSteeringBoundary(runId, kind, requiredOption(opts.boundaryToken, "--boundary-token", "factory boundary-cross"), opts), opts);
}

async function actionStarted(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, kind] = positional;
  if (!stringValue(runId) || !stringValue(kind) || positional.length !== 2) throw new Error("factory action-started requires <run-id> <dispatch|remediation>");
  return print(await acknowledgeSteeringActionStart(runId, kind, requiredOption(opts.actionToken, "--action-token", "factory action-started"), opts), opts);
}

async function actionAbort(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, kind] = positional;
  if (!stringValue(runId) || !stringValue(kind) || positional.length !== 2) throw new Error("factory action-abort requires <run-id> <dispatch|remediation>");
  return print(await abortSteeringAction(runId, kind, requiredOption(opts.actionToken, "--action-token", "factory action-abort"), opts), opts);
}

async function prFence(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory pr-fence requires exactly one <run-id>");
  if (opts.clear) {
    const result = await clearPrePrFence(runId, requiredOption(opts.fenceToken, "--fence-token", "factory pr-fence --clear"), opts);
    print(result, opts);
    if (result?.ok === false) process.exitCode = 1;
    return;
  }
  if (opts.fenceToken) throw staticCliError("factory pr-fence accepts --fence-token only with --clear");
  return print(await establishPrePrFence(runId, opts), opts);
}

async function cancel(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory cancel requires exactly one <run-id>");
  const result = await cancelFactoryRun(runId, opts);
  print(result, opts);
  if (!result.ok) process.exitCode = 1;
}

async function steerConflict(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory steer-conflict requires exactly one <run-id>");
  const ref = requiredOption(opts.ref, "--ref", "factory steer-conflict");
  const hash = requiredOption(opts.hash, "--hash", "factory steer-conflict");
  const result = await recordSteeringConflict(runId, { ref, hash, reason: opts.reason }, opts);
  print(result, opts);
  if (!result.ok) process.exitCode = 1;
}

async function costRecord(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory cost-record requires exactly one <run-id>");
  return print(await recordCostUsage(runId, costRecordInput(opts), opts), opts);
}

function costReport(args) {
  try {
    assertCostReportOptions(args);
    const opts = options(args);
    const positional = positionals(args);
    if (positional.length !== 1) throw new Error("factory cost-report requires exactly one <run-id>");

    const requestedRunId = normalizeCostReportRunId(positional[0]);
    const runDir = resolveRunDir(requestedRunId, opts);
    const run = readCostReportRunJson(runDir);
    if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("run.json must contain an object");

    const report = projectCostReport(buildCostReport(basename(runDir), run.cost_attribution, { telemetry: opts.telemetry }));
    console.log(opts.json ? serializeTerminalJson(report, { space: 2 }) : formatCostReport(report));
  } catch (error) {
    throw structuredCostReportError(error);
  }
}

function structuredCostReportError(error) {
  const message = typeof error?.message === "string" ? error.message : "cost-report failed";
  const jsonPrefix = "run.json must be valid JSON:";
  if (message.startsWith(jsonPrefix)) {
    return new StructuredOutputError(message, [
      identitySegment(jsonPrefix),
      freeformSegment(message.slice(jsonPrefix.length)),
    ]);
  }
  if (/^cost attribution aggregate overflow for [a-z_]+$/u.test(message)) {
    return new StructuredOutputError(message, [identitySegment(message)]);
  }
  return error;
}

async function resume(args, dependencies = {}) {
  const opts = { ...options(args), ...(dependencies.factoryOptions || {}) };
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
    telemetry: args.includes("--telemetry"),
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
    clear: args.includes("--clear"),
    postPrCi: args.includes("--post-pr-ci"),
    noPostPrCi: args.includes("--no-post-pr-ci"),
    newPr: args.includes("--new-pr"),
    carryForward: args.includes("--carry-forward"),
    modeFlags: ["--interactive", "--headless", "--autonomous", "--detached"].filter((flag) => args.includes(flag)),
    ghAccountOccurrences: args.filter((argument) => argument === "--gh-account").length,
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
    if (args[index] === "--owner-slice") opts.ownerSlice = args[++index];
    if (args[index] === "--consumer-slice") opts.consumerSlice = args[++index];
    if (args[index] === "--defect-path") opts.defectPath = args[++index];
    if (args[index] === "--verification-ref") opts.verificationRef = args[++index];
    if (args[index] === "--pr-url") opts.prUrl = args[++index];
    if (args[index] === "--pr-number") opts.prNumber = args[++index];
    if (args[index] === "--repository") opts.repository = args[++index];
    if (args[index] === "--head-sha") opts.headSha = args[++index];
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
    if (args[index] === "--boundary-token") opts.boundaryToken = args[++index];
    if (args[index] === "--action-token") opts.actionToken = args[++index];
    if (args[index] === "--fence-token") opts.fenceToken = args[++index];
    if (args[index] === "--agent") opts.agent = args[++index];
    if (args[index] === "--subject") opts.subject = args[++index];
    if (args[index] === "--prompt-bytes") opts.promptBytes = Number(args[++index]);
    if (args[index] === "--step") opts.step = args[++index];
    if (args[index] === "--slice-id") opts.sliceId = args[++index];
    if (args[index] === "--provider") opts.provider = args[++index];
    if (args[index] === "--source") opts.source = args[++index];
    if (args[index] === "--operation") opts.operation = args[++index];
    if (args[index] === "--request-id") opts.requestId = args[++index];
    if (args[index] === "--currency") opts.currency = args[++index];
    if (args[index] === "--recorded-at") opts.recordedAt = args[++index];
    if (args[index] === "--entry-id") opts.entryId = args[++index];
    if (args[index] === "--parent-span-id") opts.parentSpanId = args[++index];
    if (args[index] === "--traceparent") opts.traceparent = args[++index];
    if (args[index] === "--tracestate") opts.tracestate = args[++index];
    if (args[index] === "--post-pr-wait-minutes") opts.postPrWaitMinutes = Number(args[++index]);
    if (args[index] === "--post-pr-poll-seconds") opts.postPrPollSeconds = Number(args[++index]);
    if (args[index] === "--post-pr-max-poll-seconds") opts.postPrMaxPollSeconds = Number(args[++index]);
    if (args[index] === "--post-pr-check-start-grace-seconds") opts.postPrCheckStartGraceSeconds = Number(args[++index]);
    if (args[index] === "--post-pr-max-transient-errors") opts.postPrMaxTransientErrors = Number(args[++index]);
    if (args[index] === "--remediation-evidence-ref") opts.remediationEvidenceRef = args[++index];
    if (args[index] === "--failure-evidence-ref") opts.failureEvidenceRef = args[++index];
    if (args[index] === "--test-evidence-ref") opts.testEvidenceRef = args[++index];
    if (args[index] === "--validator-report-ref") opts.validatorReportRef = args[++index];
    if (args[index] === "--validator-review-ref") opts.validatorReviewRef = args[++index];
    if (args[index] === "--security-review-ref") opts.securityReviewRef = args[++index];
    if (COST_NUMERIC_FLAGS.has(args[index])) opts[COST_NUMERIC_FLAGS.get(args[index])] = parseCostNumericOption(args[index], args[++index]);
  }
  return opts;
}

function parseCostNumericOption(flag, raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw costNumericOptionError(flag);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw costNumericOptionError(flag);
  return value;
}

function costNumericOptionError(flag) {
  return new StructuredOutputError(`${flag} must be a finite non-negative number`, [
    identitySegment(flag),
    identitySegment(" must be a finite non-negative number"),
  ]);
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

function assertCostReportOptions(args) {
  assertKnownOptions(args);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    if (COST_REPORT_BOOLEAN_FLAGS.has(arg)) continue;
    if (COST_REPORT_VALUE_FLAGS.has(arg)) {
      if (index + 1 >= args.length || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      continue;
    }
    throw new Error(`factory cost-report does not support ${arg}`);
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

async function provenanceReviewDispatch(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [, runId] = positional;
  if (!stringValue(runId) || positional.length !== 2) throw new Error("factory provenance review-dispatch requires exactly one <run-id>");
  return print(await recordReviewDispatchProvenance(runId, {
    agent: opts.agent,
    subject: opts.subject,
    attempt: opts.attempts,
    promptHash: opts.hash,
    promptBytes: opts.promptBytes,
  }, opts), { ...opts, json: true });
}

async function recover(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory recover requires exactly one <run-id>");
  return print(await transitionRecoverOrphan(resolveRunDir(runId, opts), opts.reason || "recovered orphaned factory run", opts), opts);
}

async function gateDecision(args, dependencies = {}) {
  const opts = { ...options(args), ...(dependencies.gateDecisionOptions || {}) };
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

  const result = await transitionGateDecisionAndHandoff(resolveRunDir(runId, opts), gate, decision, opts);
  if (opts.json && result.handoff) {
    const projected = projectCliData(result);
    if (typeof result.handoff.log === "string" && /^processes\/[A-Za-z0-9._-]+\.log$/u.test(result.handoff.log)) projected.handoff.log = result.handoff.log;
    if (result.handoff.launch_claim_ref === "process-launch.lock/owner.json") projected.handoff.launch_claim_ref = result.handoff.launch_claim_ref;
    console.log(serializeTerminalJson(projected, { space: 2 }));
  } else {
    print(result, opts);
  }
  if (result.handoff?.status === "recovery-required") process.exitCode = 2;
}

async function slicesSeed(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory slices-seed requires exactly one <run-id>");
  const from = requiredOption(opts.from, "--from", "factory slices-seed");
  if (from !== "plan/slices.json") throw new Error("factory slices-seed --from must be exactly plan/slices.json");
  return print(await seedFactorySlices(runId, { ...opts, from }), opts);
}

async function slicesProbe(args) {
  assertOnlyCommandOptions(args, new Set(["--from", "--repo", "--json"]), "factory slices-probe");
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) throw new Error("factory slices-probe requires exactly one <run-id>");
  const from = requiredOption(opts.from, "--from", "factory slices-probe");
  if (from !== "plan/slices.json") throw new Error("factory slices-probe --from must be exactly plan/slices.json");
  const result = probeFactorySlices(runId, { ...opts, from });
  print(result, opts);
  if (result.status === "invalid") process.exitCode = 1;
  return result;
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

async function repairStatus(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, statusValue] = positional;
  if (!stringValue(runId) || !stringValue(statusValue) || positional.length !== 2) {
    throw new Error("factory repair requires <run-id> <reported|repairing|review|merged|blocked>");
  }
  const input = { status: String(statusValue).trim() };
  if (input.status === "reported") {
    input.owner_slice_id = requiredOption(opts.ownerSlice, "--owner-slice", "factory repair reported");
    input.consumer_slice_id = requiredOption(opts.consumerSlice, "--consumer-slice", "factory repair reported");
    input.defect_path = requiredOption(opts.defectPath, "--defect-path", "factory repair reported");
    input.evidence_ref = requiredOption(opts.evidenceRef, "--evidence-ref", "factory repair reported");
  }
  if (input.status === "repairing") {
    input.attempts = normalizeNonNegativeInteger(requiredOption(opts.attempts, "--attempts", "factory repair repairing"), "--attempts");
    if (stringValue(opts.branch)) input.branch = opts.branch;
    if (stringValue(opts.worktree)) input.worktree = opts.worktree;
  }
  if (input.status === "review") {
    input.review_ref = requiredOption(opts.reviewRef, "--review-ref", "factory repair review");
    input.repair_evidence_ref = requiredOption(opts.evidenceRef, "--evidence-ref", "factory repair review");
    input.reviewed_commit = requiredOption(opts.commit, "--commit", "factory repair review");
  }
  if (input.status === "merged") {
    input.merge_commit = requiredOption(opts.mergeCommit, "--merge-commit", "factory repair merged");
    input.verification_ref = requiredOption(opts.verificationRef, "--verification-ref", "factory repair merged");
  }
  if (input.status === "blocked") input.reason = requiredOption(opts.reason, "--reason", "factory repair blocked");
  return print(await transitionMergedSliceRepair(resolveRunDir(runId, opts), input, opts), opts);
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
  return print(await transitionPanelVerdicts(resolveRunDir(runId, opts), {
    validator: { verdict: validator, report, review_ref: "reviews/implementation-validator.json" },
    security_review: { verdict: security, review_ref: reviewRef },
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
  opts.boundaryToken = requiredOption(opts.boundaryToken, "--boundary-token", "factory terminal");
  return print(await transitionTerminalResult(resolveRunDir(runId, opts), { status: statusValueNormalized, reason }, opts), opts);
}

async function prCreated(args) {
  assertOnlyCommandOptions(args, new Set(["--fence-token", "--json"]), "factory pr-created");
  const opts = options(args);
  const positional = positionals(args);
  const [runId] = positional;
  if (!stringValue(runId) || positional.length !== 1) {
    throw new Error("factory pr-created requires exactly one <run-id>");
  }
  opts.fenceToken = requiredOption(opts.fenceToken, "--fence-token", "factory pr-created");
  const result = await transitionPrCreated(resolveRunDir(runId, opts), {}, opts);
  const completed = await attachCheckpointCompletionRecovery(result, result?.run, opts);
  print(completed, opts);
  if (completed?.ok === false) process.exitCode = 1;
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

function assertOnlyCommandOptions(args, allowed, command) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    if (!allowed.has(arg)) throw staticCliError(`${command} does not support ${arg}`);
    if (VALUE_FLAGS.has(arg)) index += 1;
  }
}

function costRecordInput(opts) {
  const input = {};
  for (const [key, field] of [
    ["agent", "agent"],
    ["step", "step"],
    ["sliceId", "slice_id"],
    ["provider", "provider"],
    ["model", "model"],
    ["source", "source"],
    ["operation", "operation"],
    ["requestId", "request_id"],
    ["currency", "cost_currency"],
    ["recordedAt", "recorded_at"],
  ]) {
    if (stringValue(opts[key])) input[field] = opts[key];
  }
  for (const [key, field] of [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["totalTokens", "total_tokens"],
    ["cacheCreationInputTokens", "cache_creation_input_tokens"],
    ["cacheReadInputTokens", "cache_read_input_tokens"],
    ["reasoningTokens", "reasoning_tokens"],
    ["costTotal", "cost_total"],
    ["costInput", "cost_input"],
    ["costOutput", "cost_output"],
    ["costCacheCreation", "cost_cache_creation"],
    ["costCacheRead", "cost_cache_read"],
  ]) {
    if (opts[key] !== undefined) input[field] = opts[key];
  }
  return input;
}

function requiredOption(value, flag, command = "factory pr-created") {
  if (!stringValue(value)) throw staticCliError(`${command} requires ${flag}`);
  return value;
}

function staticCliError(message) {
  return new StructuredOutputError(message, [identitySegment(message)]);
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

function readCostReportRunJson(runDir) {
  const file = join(runDir, "run.json");
  if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") throw new Error("run.json cannot be read safely on this platform");

  let descriptor;
  let text;
  try {
    descriptor = openSync(file, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) throw new Error("not a regular file");
    text = readFileSync(descriptor, "utf8");
  } catch (error) {
    throw new Error(`run.json must be a regular file inside the run directory: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`run.json must be valid JSON: ${error.message}`);
  }
}

function print(value, opts) {
  return printCliResult(value, opts, { formatListCostColumn, cleanDiagnosticText });
}

function formatListCostColumn(item) {
  if (!item?.cost_summary) return "-";
  return cleanDiagnosticText(formatCostAttributionSummary({ totals: item.cost_summary, updated_at: item.cost_summary.updated_at }));
}

function cleanDiagnosticText(value) {
  const text = sanitizePublicCostText(value);
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
  // Advisory only; the foreground child repeats this assertion under run-json.lock.
  assertHeartbeatStartable(run);
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

function normalizeHeartbeatRunId(runId) {
  if (!stringValue(runId)) throw new Error("factory heartbeat requires exactly one <run-id>");
  const value = String(runId).trim();
  if (isAbsolute(value) || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error("factory heartbeat requires a bare <run-id>, not a filesystem path");
  }
  return value;
}

function normalizeCostReportRunId(runId) {
  const value = String(runId);
  if (isAbsolute(value) || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error("factory cost-report requires a bare <run-id>, not a filesystem path");
  }
  if (!SAFE_COST_REPORT_RUN_ID_PATTERN.test(value) || value.includes("..") || value.endsWith(".lock")) {
    throw new Error('factory cost-report requires a safe <run-id> using letters, digits, ".", "_", or "-"');
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

if (isDirectCliExecution()) {
  runCliCommand(process.argv.slice(2)).catch((error) => {
    console.error(`error: ${renderErrorForTerminal(error)}`);
    process.exitCode = 1;
  });
}

function isDirectCliExecution() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(cliPath); }
  catch { return resolve(process.argv[1]) === cliPath; }
}
