#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { cleanupRun, heartbeatStatus, listRuns, persistFactoryRunCreatedProvenance, persistFactoryRunResumeProvenance, startFactory, startHeartbeat, status, stopHeartbeat, validateState, watchRun, writeGateAnswer } from "./factory.js";
import { runDoctor } from "./doctor.js";
import { collectProvenance } from "./provenance.js";
import { readJsoncConfig } from "./config.js";
import { canonicalizeGithubPrUrl } from "./provenance-authority.js";
import { assertHeartbeatOwnerCapability, heartbeatOnce, transitionGateDecision, transitionPrCreated } from "./run-state.js";
import { HEARTBEAT_PHASES, HEARTBEAT_PROTECTED_GATES, validateRun } from "./validate.js";

const cliPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(cliPath));
const HEARTBEAT_PHASE_SET = new Set(HEARTBEAT_PHASES);
const HEARTBEAT_ACTIVE_STATUS_SET = new Set(["active", "running"]);
const HEARTBEAT_PROTECTED_GATE_SET = new Set(HEARTBEAT_PROTECTED_GATES);
const HEARTBEAT_STEP_IN_FLIGHT_STATUSES = new Set(["running"]);
const HEARTBEAT_SLICE_IN_FLIGHT_STATUSES = new Set(["running", "review"]);
const HEARTBEAT_START_TIMEOUT_MS = 5000;
const HEARTBEAT_START_POLL_MS = 25;
const HEARTBEAT_OWNER_ENV = "FEATURE_FACTORY_HEARTBEAT_OWNER";

function usage() {
  console.log(`feature-factory

Commands:
  install [--local]             Add this package to ~/.config/opencode/opencode.jsonc
  doctor [--local] [--profiles] Check opencode/plugin/provider/tool prerequisites
  factory start [--repo PATH] [--gh-account ACCOUNT] [--headless|--autonomous|--detached] <prompt...>
  factory list                  List local factory runs
  factory status [run-id]       Read .opencode/factory state
  factory heartbeat <run-id> --once --token <token> [--json]  Internal owner-bound single tick
  factory heartbeat <run-id> --start --phase <phase> [--interval MS] [--max-duration MS] [--json]  Internal owner-bound detached helper
  factory heartbeat <run-id> --stop --token <token> [--wait-ms MS] [--force] [--json]
  factory heartbeat <run-id> --status [--json]
  factory validate [run-id]     Validate run.json and plan/slices.json
  factory cleanup <run-id>      Remove terminal run state, worktrees, and branches
  factory answer <run> <gate> <approve|stop|changes: ...>
  factory gate-decision <run> <gate> <pending|approved|changes_requested|stopped> [--artifact REF] [--question-ref REF] [--answer-ref REF|--answer TEXT] [--approval-source SOURCE]
  factory pr-created <run-id> --pr-url URL --pr-number N --pr-body-ref REF --provider github --repository OWNER/REPO --remote origin --github-account ACCOUNT --head-branch BRANCH --head-commit SHA --base-ref REF --base-commit SHA [--draft|--no-draft] [--json]
  factory watch [run-id] [--all] Print status changes as JSON
  factory provenance            Print detected versions, models, and capabilities
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
  const opts = options(rest);
  const positional = positionals(rest);
  if (sub === "start") return print(startFactory(positional, opts), opts);
  if (sub === "list") return print(listRuns(opts), opts);
  if (sub === "status") return print(status(positional[0], opts), opts);
  if (sub === "heartbeat") return heartbeat(rest);
  if (sub === "cleanup") return print(cleanupRun(positional[0], opts), opts);
  if (sub === "validate") {
    const result = validateState(positional[0], opts);
    print(result, { ...opts, json: true });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (sub === "provenance") return provenance(rest);
  if (sub === "answer") {
    const [runId, gate, ...answerParts] = positional;
    return print(writeGateAnswer(runId, gate, answerParts.join(" "), opts), opts);
  }
  if (sub === "gate-decision") return gateDecision(rest);
  if (sub === "pr-created") return prCreated(rest);
  if (sub === "watch") {
    watchRun(positional[0], opts);
    return;
  }
  return usage();
}

async function heartbeat(args) {
  const opts = options(args);
  const positional = positionals(args);
  if (positional.length !== 1) throw new Error("factory heartbeat requires exactly one <run-id>");

  const runId = normalizeHeartbeatRunId(positional[0]);
  const mode = heartbeatMode(opts);

  if (mode === "once") {
    return print(
      await heartbeatOnce(resolveRunDir(runId, opts), {
        token: requiredHeartbeatToken(opts, "heartbeat --once"),
        ownerPid: process.pid,
        ownerCapability: requiredHeartbeatOwnerCapability(opts, "heartbeat --once"),
      }),
      opts,
    );
  }

  if (mode === "start") {
    return print(await startHeartbeatProcess(runId, opts), opts);
  }

  if (mode === "foreground") {
    return print(
      await startHeartbeat(runId, heartbeatStartConfig(opts), {
        cwd: opts.cwd,
        token: requiredHeartbeatToken(opts, "heartbeat --foreground"),
        ownerCapability: requiredHeartbeatOwnerCapability(opts, "heartbeat --foreground"),
      }),
      opts,
    );
  }

  if (mode === "stop") {
    return print(
      await stopHeartbeat(
        runId,
        {
          token: requiredHeartbeatToken(opts, "heartbeat --stop"),
          waitMs: normalizeHeartbeatWait(opts.waitMs),
          force: opts.force,
        },
        opts,
      ),
      opts,
    );
  }

  if (mode === "status") {
    return print(publicHeartbeatStatus(runId, opts), opts);
  }

  throw new Error("factory heartbeat requires exactly one of --once, --start, --stop, --status, or internal --foreground");
}

function options(args) {
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
    once: args.includes("--once"),
    start: args.includes("--start"),
    stop: args.includes("--stop"),
    heartbeatStatus: args.includes("--status"),
    foreground: args.includes("--foreground"),
    ownerCapability: process.env[HEARTBEAT_OWNER_ENV],
  };
  if (args.includes("--draft")) opts.draft = true;
  if (args.includes("--no-draft")) opts.noDraft = true;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repo") opts.cwd = resolve(args[++index]);
    if (args[index] === "--gh-account") opts.ghAccount = args[++index];
    if (args[index] === "--model") opts.model = args[++index];
    if (args[index] === "--interval") opts.intervalMs = Number(args[++index]);
    if (args[index] === "--max-duration") opts.maxDurationMs = Number(args[++index]);
    if (args[index] === "--wait-ms") opts.waitMs = Number(args[++index]);
    if (args[index] === "--phase") opts.phase = args[++index];
    if (args[index] === "--token") opts.token = args[++index];
    if (args[index] === "--reviewer") opts.reviewer = args[++index];
    if (args[index] === "--artifact") opts.artifact = args[++index];
    if (args[index] === "--question-ref") opts.questionRef = args[++index];
    if (args[index] === "--answer-ref") opts.answerRef = args[++index];
    if (args[index] === "--answer") opts.answer = args[++index];
    if (args[index] === "--approval-source") opts.approvalSource = args[++index];
    if (args[index] === "--decision-note") opts.decisionNote = args[++index];
    if (args[index] === "--answered-at") opts.answeredAt = args[++index];
    if (args[index] === "--pr-url") opts.prUrl = args[++index];
    if (args[index] === "--pr-number") opts.prNumber = args[++index];
    if (args[index] === "--pr-body-ref") opts.prBodyRef = args[++index];
    if (args[index] === "--provider") opts.provider = args[++index];
    if (args[index] === "--repository") opts.repository = args[++index];
    if (args[index] === "--remote") opts.remote = args[++index];
    if (args[index] === "--github-account") opts.githubAccount = args[++index];
    if (args[index] === "--head-branch") opts.headBranch = args[++index];
    if (args[index] === "--head-commit") opts.headCommit = args[++index];
    if (args[index] === "--base-ref") opts.baseRef = args[++index];
    if (args[index] === "--base-commit") opts.baseCommit = args[++index];
  }
  return opts;
}

function positionals(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--repo", "--gh-account", "--model", "--interval", "--max-duration", "--wait-ms", "--phase", "--token", "--reviewer", "--artifact", "--question-ref", "--answer-ref", "--answer", "--approval-source", "--decision-note", "--answered-at", "--pr-url", "--pr-number", "--pr-body-ref", "--provider", "--repository", "--remote", "--github-account", "--head-branch", "--head-commit", "--base-ref", "--base-commit"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    output.push(arg);
  }
  return output;
}

async function provenance(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [action, runId] = positional;
  if (action === "record-created") {
    if (!stringValue(runId) || positional.length !== 2) throw new Error("factory provenance record-created requires <run-id>");
    return print(await persistFactoryRunCreatedProvenance(runId, opts), { ...opts, json: true });
  }
  if (action === "record-resume") {
    if (!stringValue(runId) || positional.length !== 2) throw new Error("factory provenance record-resume requires <run-id>");
    return print(await persistFactoryRunResumeProvenance(runId, opts), { ...opts, json: true });
  }
  if (positional.length > 0) throw new Error(`unknown factory provenance action: ${action}`);
  return print(await collectProvenance({ cwd: opts.cwd }), { ...opts, json: true });
}

async function gateDecision(args) {
  const opts = options(args);
  const positional = positionals(args);
  const [runId, gate, statusValue] = positional;
  if (!stringValue(runId) || !stringValue(gate) || !stringValue(statusValue)) {
    throw new Error("factory gate-decision requires <run> <gate> <pending|approved|changes_requested|stopped>");
  }

  const decision = { status: normalizeGateDecisionStatus(statusValue) };
  assertPublicGateDecisionAllowed(decision.status, opts);
  if (stringValue(opts.artifact)) decision.artifact = opts.artifact;
  if (stringValue(opts.questionRef)) decision.question_ref = opts.questionRef;
  if (stringValue(opts.answerRef)) decision.answer_ref = opts.answerRef;
  if (stringValue(opts.answer)) decision.answer = opts.answer;
  if (stringValue(opts.approvalSource)) decision.approval_source = opts.approvalSource;
  if (stringValue(opts.decisionNote)) decision.decision_note = opts.decisionNote;
  if (stringValue(opts.answeredAt)) decision.answered_at = opts.answeredAt;

  return print(await transitionGateDecision(resolveRunDir(runId, opts), gate, decision, publicGateDecisionOptions(decision.status, opts)), opts);
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
    provider: requiredOption(opts.provider, "--provider"),
    repository: requiredOption(opts.repository, "--repository"),
    remote: requiredOption(opts.remote, "--remote"),
    github_account: requiredOption(opts.githubAccount, "--github-account"),
    draft: opts.draft === true ? true : false,
    pr_body_ref: requiredOption(opts.prBodyRef, "--pr-body-ref"),
  };
  const supplied = {
    ...request,
    head_branch: requiredOption(opts.headBranch, "--head-branch"),
    head_commit: requiredOption(opts.headCommit, "--head-commit"),
    base_ref: requiredOption(opts.baseRef, "--base-ref"),
    base_commit: requiredOption(opts.baseCommit, "--base-commit"),
  };
  const runDir = resolveRunDir(runId, opts);
  const remoteObservation = observePrRemote(opts, supplied, runDir);

  return print(await transitionPrCreated(runDir, { ...request, remote_observation: remoteObservation }, opts), opts);
}

function assertPublicGateDecisionAllowed(statusValue, opts) {
  if (statusValue !== "approved") return;
  if (stringValue(opts.answer)) throw new Error("factory gate-decision approved requires --answer-ref; inline --answer is not accepted by the public CLI");
  if (!stringValue(opts.answerRef)) throw new Error("factory gate-decision approved requires --answer-ref from an external driver");
  if (stringValue(opts.approvalSource)) throw new Error("factory gate-decision approved does not accept --approval-source; approval_source is derived as external-driver");
}

function publicGateDecisionOptions(statusValue, opts) {
  if (statusValue !== "approved") return opts;
  return { ...opts, publicExternalDriverApproval: true };
}

function observePrRemote(opts, supplied, runDir) {
  if (supplied.provider !== "github") throw new Error("factory pr-created currently supports --provider github only");
  const localCwd = prCreatedLocalCwd(runDir, opts.cwd);
  const observed = observeGithubPr(opts.cwd, supplied.pr_url);
  const observedRepository = repositoryFromGithubPrUrl(observed.pr_url);
  const remoteRepository = repositoryFromGitRemote(localCwd, supplied.remote);
  const account = observeGithubAccount();
  const local = observeLocalGitFacts(localCwd, supplied.remote, observed.base_commit, observed.head_commit);

  const remoteObservation = {
    pr_url: observed.pr_url,
    pr_number: observed.pr_number,
    provider: "github",
    repository: observedRepository,
    remote: local.remote,
    github_account: account,
    head_branch: observed.head_branch,
    head_commit: observed.head_commit,
    head_tree: gitTreeForCommit(localCwd, observed.head_commit, "observed PR head commit"),
    base_ref: observed.base_ref,
    base_commit: observed.base_commit,
    base_tree: gitTreeForCommit(localCwd, observed.base_commit, "observed PR base commit"),
    draft: observed.draft,
  };

  const comparisons = [
    ["pr_url", supplied.pr_url, remoteObservation.pr_url],
    ["pr_number", supplied.pr_number, remoteObservation.pr_number],
    ["provider", supplied.provider, remoteObservation.provider],
    ["repository", supplied.repository, remoteObservation.repository],
    ["remote", supplied.remote, remoteObservation.remote],
    ["github_account", supplied.github_account, remoteObservation.github_account],
    ["head_branch", supplied.head_branch, remoteObservation.head_branch],
    ["head_commit", supplied.head_commit, remoteObservation.head_commit],
    ["base_ref", supplied.base_ref, remoteObservation.base_ref],
    ["base_commit", supplied.base_commit, remoteObservation.base_commit],
    ["draft", supplied.draft, remoteObservation.draft],
    ["remote_repository", supplied.repository, remoteRepository],
    ["local_branch", supplied.head_branch, local.branch],
    ["local_head", supplied.head_commit, local.head_commit],
  ];
  const mismatch = comparisons.find(([, expected, actual]) => expected !== actual);
  if (mismatch) {
    const [field, expected, actual] = mismatch;
    throw new Error(`factory pr-created ${field} observed ${String(actual)}, expected ${String(expected)}`);
  }
  return remoteObservation;
}

function prCreatedLocalCwd(runDir, fallbackCwd) {
  try {
    const runBase = JSON.parse(readFileSync(join(runDir, "attestations", "run-base.json"), "utf8"));
    if (stringValue(runBase?.bindings?.feature_worktree)) return runBase.bindings.feature_worktree;
  } catch {
    // Fall back to the command cwd; transitionPrCreated will report missing authority.
  }
  return fallbackCwd;
}

function observeGithubPr(cwd, prUrl) {
  const proc = spawnSync("gh", ["pr", "view", prUrl, "--json", "url,number,isDraft,headRefName,headRefOid,baseRefName,baseRefOid"], {
    cwd: resolve(cwd || process.cwd()),
    encoding: "utf8",
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) throw new Error(`factory pr-created could not observe PR with gh pr view: ${(proc.stderr || proc.stdout).trim()}`);
  let view;
  try {
    view = JSON.parse(proc.stdout);
  } catch (error) {
    throw new Error(`factory pr-created could not parse gh pr view JSON: ${error.message}`);
  }
  return {
    pr_url: canonicalizeGithubPrUrl(requiredGhField(view.url, "url")),
    pr_number: normalizeCliPrNumber(requiredGhField(view.number, "number")),
    head_branch: requiredGhField(view.headRefName, "headRefName"),
    head_commit: requiredGhField(view.headRefOid, "headRefOid"),
    base_ref: requiredGhField(view.baseRefName, "baseRefName"),
    base_commit: requiredGhField(view.baseRefOid, "baseRefOid"),
    draft: normalizeGhBoolean(view.isDraft, "isDraft"),
  };
}

function observeGithubAccount() {
  const proc = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) throw new Error(`factory pr-created could not observe GitHub account with gh api user: ${(proc.stderr || proc.stdout).trim()}`);
  const account = proc.stdout.trim();
  if (!stringValue(account)) throw new Error("factory pr-created gh api user returned an empty account");
  return account;
}

function observeLocalGitFacts(cwd, remote, baseCommit, headCommit) {
  const branch = gitStdout(cwd, ["symbolic-ref", "--short", "HEAD"], "current branch");
  const localHead = gitStdout(cwd, ["rev-parse", "--verify", "HEAD"], "HEAD");
  gitStdout(cwd, ["rev-parse", "--verify", `${baseCommit}^{commit}`], "observed base commit");
  gitStdout(cwd, ["rev-parse", "--verify", `${headCommit}^{commit}`], "observed head commit");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", baseCommit, headCommit], { cwd: resolve(cwd || process.cwd()), encoding: "utf8" });
  if (ancestor.status !== 0) throw new Error(`factory pr-created observed base commit is not an ancestor of head commit: ${(ancestor.stderr || ancestor.stdout).trim()}`);
  return { remote, branch, head_commit: localHead };
}

function repositoryFromGitRemote(cwd, remote) {
  const url = gitStdout(cwd, ["remote", "get-url", remote], `remote ${remote}`);
  const repository = parseGithubRemoteRepository(url);
  if (!repository) throw new Error(`factory pr-created remote ${remote} does not point at github.com`);
  return repository;
}

function repositoryFromGithubPrUrl(prUrl) {
  const parsed = new URL(canonicalizeGithubPrUrl(prUrl));
  const segments = parsed.pathname.split("/").filter(Boolean);
  return `${segments[0]}/${segments[1]}`;
}

function parseGithubRemoteRepository(url) {
  const text = String(url || "").trim();
  let match = text.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (match) return `${match[1]}/${match[2]}`;
  try {
    const parsed = new URL(text);
    if ((parsed.protocol === "https:" || parsed.protocol === "ssh:") && parsed.hostname === "github.com") {
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length >= 2) return `${segments[0]}/${segments[1].replace(/\.git$/u, "")}`;
    }
  } catch {
    return null;
  }
  return null;
}

function requiredGhField(value, field) {
  if (typeof value === "number") return value;
  if (!stringValue(value)) throw new Error(`factory pr-created gh pr view missing ${field}`);
  return value;
}

function normalizeGhBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`factory pr-created gh pr view missing boolean ${field}`);
  return value;
}

function normalizeCliPrNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(number) || number < 1 || String(number) !== String(value).trim()) {
    throw new Error("factory pr-created requires --pr-number to be a positive integer");
  }
  return number;
}

function requiredOption(value, flag) {
  if (!stringValue(value)) throw new Error(`factory pr-created requires ${flag}`);
  return value;
}

function gitStdout(cwd, args, label) {
  const proc = spawnSync("git", args, { cwd: resolve(cwd || process.cwd()), encoding: "utf8" });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) throw new Error(`factory pr-created could not observe ${label}: ${(proc.stderr || proc.stdout).trim()}`);
  return proc.stdout.trim();
}

function gitTreeForCommit(cwd, commit, flag) {
  const value = requiredOption(commit, flag);
  const proc = spawnSync("git", ["rev-parse", `${value}^{tree}`], { cwd: resolve(cwd || process.cwd()), encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`factory pr-created could not resolve ${flag} tree: ${(proc.stderr || proc.stdout).trim()}`);
  return proc.stdout.trim();
}

function normalizeGateDecisionStatus(value) {
  const status = String(value).trim();
  if (["pending", "approved", "changes_requested", "stopped"].includes(status)) return status;
  if (status === "approve") return "approved";
  if (status === "changes") return "changes_requested";
  if (status === "stop") return "stopped";
  throw new Error("gate decision status must be pending, approved, changes_requested, or stopped");
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
    ["once", opts.once],
    ["start", opts.start],
    ["stop", opts.stop],
    ["status", opts.heartbeatStatus],
    ["foreground", opts.foreground],
  ].filter(([, enabled]) => enabled);
  if (modes.length !== 1) {
    throw new Error("factory heartbeat requires exactly one of --once, --start, --stop, --status, or internal --foreground");
  }
  return modes[0][0];
}

async function startHeartbeatProcess(runId, opts) {
  const config = heartbeatStartConfig(opts);
  const runDir = resolveRunDir(runId, opts);
  const run = readHeartbeatStartRun(runDir);
  const current = status(runId, opts);
  const ownerCapability = requiredHeartbeatOwnerCapability(opts, "heartbeat --start");
  assertHeartbeatOwnerCapability(runDir, run.run_id, ownerCapability, "heartbeat --start");
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
  const token = stringValue(opts.token) ? opts.token : randomUUID();
  const childArgs = [cliPath, "factory", "heartbeat", runId, "--foreground", "--token", token, "--phase", config.phase];
  if (config.intervalMs !== undefined) childArgs.push("--interval", String(config.intervalMs));
  if (config.maxDurationMs !== undefined) childArgs.push("--max-duration", String(config.maxDurationMs));

  const child = spawn(process.execPath, childArgs, {
    cwd: opts.cwd,
    detached: true,
    env: { ...process.env, [HEARTBEAT_OWNER_ENV]: ownerCapability },
    stdio: "ignore",
  });
  child.unref();

  return waitForHeartbeatStart(runId, token, { cwd: opts.cwd, pid: child.pid });
}

async function waitForHeartbeatStart(runId, token, opts = {}) {
  const deadline = Date.now() + HEARTBEAT_START_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const current = heartbeatStatus(runId, { cwd: opts.cwd });
    if (current?.token === token && HEARTBEAT_ACTIVE_STATUS_SET.has(current.status)) return current;
    if (opts.pid && !isProcessAlive(opts.pid)) break;
    await sleep(HEARTBEAT_START_POLL_MS);
  }
  throw new Error(`heartbeat failed to start for run '${runId}'`);
}

function heartbeatStartConfig(opts) {
  return {
    phase: normalizeHeartbeatPhase(opts.phase),
    intervalMs: normalizePositiveInteger(opts.intervalMs, "intervalMs"),
    maxDurationMs: normalizePositiveInteger(opts.maxDurationMs, "maxDurationMs"),
  };
}

function normalizeHeartbeatPhase(phase) {
  if (!stringValue(phase) || !HEARTBEAT_PHASE_SET.has(phase)) {
    throw new Error(`heartbeat phase must be one of ${HEARTBEAT_PHASES.join(", ")}`);
  }
  return phase;
}

function normalizePositiveInteger(value, name) {
  if (value === undefined || value === null) return undefined;
  const next = Number(value);
  if (!Number.isInteger(next) || next <= 0) throw new Error(`${name} must be a positive integer`);
  return next;
}

function normalizeHeartbeatWait(value) {
  if (value === undefined || value === null) return undefined;
  const next = Number(value);
  if (!Number.isInteger(next) || next < 0) throw new Error("waitMs must be a non-negative integer");
  return next;
}

function requiredHeartbeatToken(opts, command) {
  if (!stringValue(opts.token)) throw new Error(`${command} requires --token <token>`);
  return opts.token;
}

function requiredHeartbeatOwnerCapability(opts, command) {
  if (!stringValue(opts.ownerCapability)) throw new Error(`${command} requires trusted heartbeat owner capability from factory.lock`);
  return opts.ownerCapability.trim();
}

function resolveRunDir(runId, opts = {}) {
  const root = factoryRoot(opts.cwd || process.cwd());
  const dir = resolve(root, normalizeHeartbeatRunId(runId));
  if (!existsSync(join(dir, "run.json"))) throw new Error(`run not found: ${runId}`);
  if (!insideDirectory(root, dir)) {
    throw new Error(`heartbeat run directory must be inside .opencode/factory: ${dir}`);
  }
  return dir;
}

function publicHeartbeatStatus(runId, opts = {}) {
  const current = heartbeatStatus(runId, opts);
  if (!current) return null;
  return { ...current, token: null };
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

function factoryRoot(cwd) {
  return join(repoRoot(cwd), ".opencode", "factory");
}

function repoRoot(cwd) {
  const proc = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(cwd), encoding: "utf8" });
  return proc.status === 0 ? proc.stdout.trim() : resolve(cwd);
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
  const rel = relative(physicalPath(parent), physicalPath(child));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function physicalPath(path) {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return error?.code === "EPERM";
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
