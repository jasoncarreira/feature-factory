import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants as FS_CONSTANTS, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { assertRunJsonWriterAllowed, hashRunState, hasInFlightHeartbeatWork, inspectApprovalHandoffReceipt, resolveGateAnswerTarget, transitionCostUsage, transitionGateDecision, transitionPostPrFailure, transitionPostPrState, transitionPostPrTerminal, transitionPrePrFenceCleared, transitionPrePrFenceEstablished, transitionRunStep, transitionSteeringAcknowledged, transitionSteeringActionAborted, transitionSteeringActionClosed, transitionSteeringActionStarted, transitionSteeringBoundaryCrossed, transitionSteeringBoundaryOpened, transitionSteeringConflict, transitionSteeringConsumed, transitionSteeringQueued, withRunJsonLock } from "./run-state.js";
import { publicCostAttributionSummary } from "./cost-attribution.js";
import { pendingProtectedGate, postPrConsistencyChecks, steeringConsistencyChecks, validateHeartbeatState, validateRun, validateRunDir, validateSlicesPlan } from "./validate.js";
import { collectEffectiveProvenance, collectRunDebugSnapshot } from "./env-snapshot.js";
import { diagnoseRunDir, diagnoseRunObject } from "./factory-diagnostics.js";
import { git, repoRoot } from "./git.js";
import { checkWorktreeIdentity, deriveExpectedWorktreePath, parseWorktreeListPorcelain } from "./worktrees.js";
import { isContainedPath, physicalPath, timestamp } from "./utils.js";
import { directFactoryRoot, factoryRepoFromRunDir, factoryRootsForLookup } from "./factory-paths.js";
import { prepareTelemetryEnv } from "./telemetry.js";
import { LAUNCH_CLAIM_REF, PROCESS_EVIDENCE_FILE, acquireLaunchClaim, acquireLaunchFence, assertDetachedProcessEvidenceWritable, cancelProcessFromEvidence, inspectLaunchClaim, inspectProcessEvidence, inspectProcessIdentity, readProcessEvidence, releaseLaunchClaim, releaseLaunchFence, transitionLaunchClaimPhase } from "./process-evidence.js";
import { encodeFeatureCommandPayload } from "./feature-command-payload.js";
import { createSanitizedLineWriter } from "./hardening/line-output.js";
import { projectFreeformData, renderErrorForTerminal } from "./hardening/output-policy.js";
import { publicLivenessBoolean, probeLegacyBooleanLiveness, probeProcessLiveness } from "./hardening/process-verification.js";
import { serializeTerminalJson } from "./hardening/terminal-encoding.js";
import { affectedPathsHash, buildFailureEvidenceInput, canonicalizePanelAffectedPaths, classifyOwnership, decideObservationSchedule, decideTransientSchedule, emitAffectedJson, fetchChangedFiles, inspectPanelRunnerReturn, isPollDue, normalizePullRequestResponse, normalizeRepositoryPath, queryPullRequest, requestReviewer, runBoundedProcess, runGitHubOperation, snapshotPanelAffectedValue, validateLane, PostPrCiError } from "./post-pr-ci.js";
import { hashValue } from "./refs.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TERMINAL_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);
const HEARTBEAT_FILE = "heartbeat.json";
const HEARTBEAT_SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const MIN_HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TICK_LOCK_TIMEOUT_MS = 1000;
const HEARTBEAT_TICK_LOCK_RETRIES = 3;
const DETACHED_READY_TIMEOUT_MS = 15000;
const DETACHED_ABORT_GRACE_MS = 1000;
const FAIL_CLOSED_DIAGNOSTIC_CONDITIONS = new Set(["invalid-run-state"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const SAFE_BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const CONTINUATION_PARENT_ARTIFACT_REFS = [
  { kind: "story", ref: "artifacts/story.md" },
  { kind: "research_map", ref: "artifacts/research-map.md" },
  { kind: "design_brief", ref: "artifacts/design-brief.md" },
  { kind: "technical_brief", ref: "artifacts/technical-brief.md" },
  { kind: "test_report", ref: "artifacts/test-report.md" },
  { kind: "validation_report", ref: "artifacts/validation-report.md" },
  { kind: "pr_body", ref: "artifacts/pr-body.md" },
];
// Planning artifacts the parent already had accepted. A blocked-run continuation
// reuses these verbatim instead of regenerating story/research/spec from scratch.
// Outcome artifacts (test-report, validation-report, pr-body) are intentionally
// NOT seeded — the child must produce its own.
const CONTINUATION_SEED_ARTIFACT_KINDS = new Set(["story", "research_map", "design_brief", "technical_brief"]);
const REPO_SEEDED_SKILL_FILES = ["SKILL.md", "SCHEMA.md"];
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PACKAGED_SEED_HASHES = {
  "SKILL.md": new Set([
    "0c17edd488d75547808af2021a5059de04220d092882391e57d42963d9da29b0",
    "22c12f49b06efd905c7e444519d14f096ba9ff0d744b3386d992bc21645d16c4",
    "252a80229a69089a58bc2762050d368074859b1c790e71a00aad332495a203aa",
    "3b7e1f956db2708b321a7a57155f907f83b84e3f4ff00c5e3590113ffd28718d",
    "684b651019b5cc75ae55451a7b63e268787906e085f8404986154b9d0c6a64a7",
    "720e2df21e629d65c347f1f2b5902a35c72f1c85930af67274a08a7ef7dcc657",
    "896eb046aff2af328d62dc05d847bad2c9dada7574171570ed384c87ca3df1c1",
    "90939efe1b954979b8423aade0a6f6670b516f3d67e058b1c5a8f0319cbd073f",
    "9877334428bab57df9f4cdc2aa4518f4d095786a5ca1651f794f9c6d00a65f4e",
    "9f3948ef2601aaeeb4293d6ec832f41c0c7cb958c3b4727f24272a0dd8373d6b",
    "a622a118c239cd2990893c22e61abb77cc8f7c590a50582fae8d22dfe06546b3",
    "ac371f1ff25bc971cb29af8d33f8f9e4c7d125fe1913bb4bc88b2a0ae23fa273",
    "b0e3bbbce7bda0ebd046144579fc3841e05cebc41e77552fa8a096e186b42a46",
    "bcd0b29cbe6fad88e6e1d9e034a807982fbafa9cd44e397366b79ac5c07e7e5b",
    "d939622ea2aaea5eb15e38d515a6b782b4169083c626cb62f325df7adada91e8",
    "e2eb954d0336a1d8733f99878636e8a06e3952704f27fcce88bdb1a0827e8d89",
    "ea21a5414569997ad5559f2cd2c567322943840978676aef91958bcaa83ab38a",
    "eb88d183aeb0def9baa61235eb6cb3ad23f291b0ffef80352a8601b296e8c144",
    "ee1e300b527602de1f4e64ebb947149fc047e91177245562085f90ced29f7867",
    "f524c6c8f28d0d2e2915df8eb9920c9dffe89389271beb04b425416aa58b7f7d",
    "ff6991cb4b7f3b510ab8602d95493738be41df66903a36f453fadadff260f881",
  ]),
  "SCHEMA.md": new Set([
    "0082c43c4f4f82e0e274eac2808d5631795e1473ab215572df1dbd21dfd8843d",
    "0564971a8faedb937507e8b9e4b01238534befa43b74bffc4aed36d3ad76cb35",
    "0c1997431d0c6db1b59fee2d59ca7bec2bd1d3944e2afc6e58e823576829c7e6",
    "1494f72ab398b1582e8e723e82e178388f181a43b24c30e48bc332e640086928",
    "1d965abebe23b81725b4f6155e51925847362db1f35f3f60dead08da4dc6b702",
    "34b82f5f9d4a8eb8bbcf861fe4d9533a5e9945df8a068f88b96f1e162df41893",
    "3c3dd8f078c5e1f2d488856022c9e8d212c4e5b228354b5d387464379d2bac29",
    "585e4de89b9361e1263aacab3fe5bc0a8d2215af2a31b66e9ab9a6e724b0e8e1",
    "623f3d3d4fb3be74c3dd86a499069f9cc0fad669568b238300de3fa1524b4fac",
    "74440b4cbe791686d77a51381fa9e02c4fe4f0a19e2895c9117cbd15c2f194b2",
    "7976502dc6cae98238232dfb507bb41eece62ac0313dcdbcd8422721c0058eed",
    "82f969ca7a19d2305c3b27b3c17f99bb3f5f9b40f63c9cc1b2c7e20621194496",
    "842f5e0dd17c69210c7eaac430122117da8d17bcc45edaebdea4a5787e68c898",
    "985e240f0928a154469659bb611c7fd376503b883c19c499e1a4e2cd1970a54f",
    "ba015daa7d57195af8f0c3099fca7f54fd7353caa952b8998d43fb98c36cb355",
    "d3ff2926643924237cbaacf1d4a4203572eb5927efc58d93f254fa17d920f209",
    "df9d3977545e3269f07cac0ebc526539a9d3d9c459493d9debfa4a12045e9fc8",
    "ec08675d7171e66241ec1732a20d5e9bcf896e073a1b719529c39ce830664bf2",
    "f4b5150ccfdb22fbe0f6424e231fa533e394b85163f0c51e0771b2477ac1d00b",
    "f921e5dbe4adab07c0e719a675223cc57a19cfe2f17aa4c3525a2dff786c33b6",
    "fe12fe525e1808b8da85f6e5b420826db7e918049f9a86a3c46b1beefe3d77e3",
  ]),
};
const activeHeartbeatLoops = new Map();
export const FACTORY_LAUNCH_CLAIM_ENV = "OPENCODE_FACTORY_LAUNCH_CLAIM";

const HANDOFF_ROWS = Object.freeze({
  "detached-shepherd-started": ["started", true, "Detached interactive shepherd started.", "watch"],
  "matching-detached-shepherd-live": ["already-running", true, "A matching detached interactive shepherd is already running.", "watch"],
  "run-mode-not-interactive": ["manual", false, "The durable run mode is not interactive; the external driver remains responsible for continuation.", "external-driver-continues"],
  "protected-gate-pending": ["paused-at-protected-gate", false, "The run is paused at a protected gate awaiting an explicit answer.", "answer-protected-gate"],
  "terminal-run": ["terminal", false, "The run is already terminal; inspect the durable terminal result.", "inspect-terminal-result"],
  "validated-cancelled": ["stopped", false, "Validated process evidence shows that the detached shepherd is cancelled.", "confirm-cancellation"],
  "cancel-pending": ["stopped", false, "Cancellation is pending for the validated detached shepherd.", "confirm-cancellation"],
  "approval-receipt-missing": ["recovery-required", false, "The accepted approval has no valid durable handoff receipt.", "run-resume-check"],
  "approval-snapshot-mismatch": ["recovery-required", false, "The accepted approval no longer matches its durable pending-gate snapshot.", "run-resume-check"],
  "steering-generation-mismatch": ["recovery-required", false, "The steering generation changed after the approval was accepted.", "run-resume-check"],
  "steering-state-not-clean": ["recovery-required", false, "Pending or uncheckpointed steering prevents automatic continuation.", "run-resume-check"],
  "resume-ineligible": ["recovery-required", false, "The run is not eligible for detached continuation.", "run-resume-check"],
  "launch-claim-invalid": ["recovery-required", false, "The preserved launch claim is invalid and requires manual ownership reconciliation.", "manual-ownership-reconciliation"],
  "launch-owner-indeterminate": ["recovery-required", false, "The preserved launch claim owner cannot be safely proven live or absent.", "manual-ownership-reconciliation"],
  "launch-claim-conflict": ["recovery-required", false, "Another launch claim conflicts with this execution and ownership is ambiguous.", "manual-ownership-reconciliation"],
  "process-evidence-invalid": ["recovery-required", false, "Detached process evidence is invalid; preserve it and reconcile ownership manually.", "manual-ownership-reconciliation"],
  "process-identity-mismatch": ["recovery-required", false, "Recorded detached process identity does not match live inspection; preserve the evidence and reconcile ownership manually.", "manual-ownership-reconciliation"],
  "prior-process-stopped": ["recovery-required", false, "Prior process evidence is stopped or failed-closed; automatic relaunch is forbidden until manual reconciliation.", "manual-ownership-reconciliation"],
  "claim-acquisition-failed": ["recovery-required", false, "The launch claim could not be acquired and no safe ownership decision was possible.", "manual-ownership-reconciliation"],
  "foreground-release-failed": ["recovery-required", false, "The foreground predecessor could not be durably released, so ownership remains ambiguous.", "manual-ownership-reconciliation"],
  "launch-spawn-failed": ["recovery-required", false, "Detached launch failed after predecessor release; process ownership is ambiguous.", "manual-ownership-reconciliation"],
  "launch-readiness-failed": ["recovery-required", false, "Detached launch did not produce matching readiness evidence within the bounded wait.", "manual-ownership-reconciliation"],
  "launch-evidence-mismatch": ["recovery-required", false, "Published detached process evidence does not match the launch claim execution.", "manual-ownership-reconciliation"],
});

export async function startFactory(args, opts = {}) {
  if (!args.length) throw new Error("factory start requires a feature prompt");
  const repo = repoRoot(opts.cwd || process.cwd());
  const resumeRunId = resumePromptRunId(args, opts);
  if (resumeRunId) assertPostPrCliOptions(opts, { command: "factory start resume", resume: true });
  const requestedRunId = normalizeRequestedStartRunId(opts.runId);
  assertPostPrCliOptions(opts, { command: "factory start" });
  if (resumeRunId && requestedRunId) throw new Error("factory start --run-id is only for new runs; use resume <run-id> to resume existing runs");
  if (requestedRunId) assertStartRunIdAvailable(repo, requestedRunId);
  const detachedRunId = opts.detached && !resumeRunId
    ? requestedRunId || allocateDetachedStartRunId(repo, opts)
    : null;
  let resumedRun = null;
  let resumedRunDir = null;
  if (resumeRunId) {
    const ownershipTarget = resolveRecoveryRunTarget(resumeRunId, { ...opts, cwd: repo, repoRoot: repo });
    if (!ownershipTarget.error) {
      const ownershipRead = readDurableRecoveryRun(repo, ownershipTarget.runDir, ownershipTarget.runFile);
      if (!ownershipRead.error) {
        const ownership = await existingRunOwnershipOutcome(ownershipTarget.runDir, ownershipRead.run, { ...opts, repo });
        if (ownership) return ownership;
      }
    }
    const activeHeartbeatPreflight = startResumeActiveHeartbeatPreflight(resumeRunId, { ...opts, cwd: repo, repoRoot: repo });
    if (activeHeartbeatPreflight) return activeHeartbeatPreflight;
    const recover = opts.recoverDisruptedRunFn || recoverDisruptedRun;
    const preflight = await recover(resumeRunId, { ...opts, cwd: repo });
    if (!preflight.ok) return preflight;
    const eligibility = startResumeEligibility(preflight, { ...opts, cwd: repo, repoRoot: repo });
    if (!eligibility.ok) return eligibility;
    resumedRunDir = preflight.run_dir;
    resumedRun = readRunFile(preflight.run_file || join(resumedRunDir, "run.json"));
  }
  const launchEnv = factoryLaunchEnv(opts);
  seedRepoSkill(repo);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(formatPrompt(args.join(" "), { ...opts, repo, requestedRunId: detachedRunId || requestedRunId }));
  if (resumedRun) {
    return coordinateExistingRunLaunch(resumedRunDir, resumedRun, {
      ...opts,
      repo,
      launchKind: opts.detached ? "start-resume-detached" : "start-resume-foreground",
      launch: ({ env, executionId }) => opts.detached
        ? (opts.detachedLaunchFn || startDetached)(repo, commandArgs, { ...detachedProcessOptions(repo, { ...opts, runId: resumedRun.run_id, runDir: resumedRunDir, executionId }), env })
        : (opts.foregroundLaunchFn || runForegroundFactory)(repo, commandArgs, { ...opts, env }),
    });
  }
  if (opts.detached) {
    const runDir = join(factoryRoot(repo), detachedRunId);
    return startDetached(repo, commandArgs, { ...detachedProcessOptions(repo, { ...opts, runId: detachedRunId, runDir }), env: launchEnv });
  }
  return runForegroundFactory(repo, commandArgs, { ...opts, env: launchEnv });
}

export async function recoverDisruptedRun(runId, opts = {}) {
  assertPostPrCliOptions(opts, { command: "factory resume-check", resume: true });
  const repo = repoRoot(opts.cwd || process.cwd());
  const target = resolveRecoveryRunTarget(runId, { ...opts, cwd: repo });
  if (target.error) return syntheticDisruptedTerminal(runId, target.runDir, target.runFile, target.error, opts);

  const readResult = readDurableRecoveryRun(repo, target.runDir, target.runFile);
  if (readResult.error) return syntheticDisruptedTerminal(target.runId, target.runDir, target.runFile, readResult.error, opts);

  const run = readResult.run;
  if (TERMINAL_STATUSES.has(run.status)) return recoveryEnvelope(run, {
    ok: false,
    durable: true,
    updated: false,
    recovered: false,
    runDir: target.runDir,
    reason: `run '${run.run_id}' is already terminal with status '${run.status}'`,
  });

  const ownership = inspectRecoveryOwnership(target.runDir, run, opts);
  if (ownership) return recoveryEnvelope(run, {
    ok: false,
    durable: true,
    updated: false,
    recovered: false,
    runDir: target.runDir,
    reason: ownership.reason,
    ownership,
  });

  const worktree = resolveRecoveryWorktree(repo, run);
  if (!worktree.ok) {
    return persistRecoveryTerminal(target.runDir, run, "needs-human", worktree.reason, opts);
  }

  const evidence = reconcileRecoveryGitEvidence(repo, run);
  if (!evidence.ok) {
    return persistRecoveryTerminal(target.runDir, run, "blocked", evidence.reason, opts);
  }

  const current = checkExistingRecoveryWorktree(repo, worktree.path, run.branch);
  if (current.status === "healthy") {
    const reconciliation = await reconcilePostPrCrash(target.runDir, { ...opts, cwd: repo });
    const reconciledRun = readRunFile(target.runFile);
    return recoveryEnvelope(reconciledRun, {
      ok: reconciledRun.status === "running",
      durable: true,
      updated: reconciliation.action !== "none",
      recovered: reconciliation.action !== "none",
      runDir: target.runDir,
      worktree: current.worktree,
      branchHead: evidence.branchHead,
      reason: reconciledRun.terminal_result?.reason,
    });
  }
  if (current.status === "unsafe") {
    return persistRecoveryTerminal(target.runDir, run, "needs-human", current.reason, opts);
  }

  const addResult = addRecoveryWorktree(repo, worktree.path, run.branch);
  if (!addResult.ok) {
    return persistRecoveryTerminal(target.runDir, run, "blocked", addResult.reason, opts);
  }

  const finalIdentity = checkWorktreeIdentity(repo, worktree.path, { branch: run.branch });
  if (!finalIdentity.ok) {
    return persistRecoveryTerminal(target.runDir, run, "blocked", `recovery created an invalid worktree identity: ${finalIdentity.reason}`, opts);
  }
  const finalBranchHead = branchHeadCommit(repo, run.branch);
  if (!finalBranchHead.ok) {
    return persistRecoveryTerminal(target.runDir, run, "blocked", finalBranchHead.reason, opts);
  }
  const worktreeHead = git(worktree.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!worktreeHead.ok || worktreeHead.stdout.trim() !== finalBranchHead.commit) {
    return persistRecoveryTerminal(target.runDir, run, "blocked", `recovered worktree HEAD does not match branch '${run.branch}' HEAD`, opts);
  }

  let updated = false;
  let nextRun = run;
  if (run.worktree !== worktree.path) {
    nextRun = await withRunJsonLock(target.runDir, async () => {
      const currentRun = readRunFile(target.runFile);
      assertRunJsonWriterAllowed(currentRun, "recovery worktree update");
      const next = validateRun({ ...currentRun, worktree: worktree.path });
      writeJsonAtomic(target.runFile, next);
      return next;
    }, opts);
    updated = true;
  }

  return recoveryEnvelope(nextRun, {
    ok: true,
    durable: true,
    updated,
    recovered: true,
    runDir: target.runDir,
    worktree: worktree.path,
    branchHead: finalBranchHead.commit,
  });
}

function resumePromptRunId(args, opts = {}) {
  if (!opts.headless && !opts.autonomous) return null;
  const prompt = args.join(" ").trim();
  const match = /^resume\s+([^\s]+)$/iu.exec(prompt);
  return match ? match[1] : null;
}

function normalizeRequestedStartRunId(value) {
  if (value === undefined || value === null) return null;
  if (!stringValue(value)) throw new Error("factory start --run-id must be a non-empty bare safe factory run id");
  const runId = String(value).trim();
  if (!SAFE_RUN_ID_PATTERN.test(runId) || runId === "." || runId === ".." || runId.includes("..") || runId.endsWith(".lock")) {
    throw new Error("factory start --run-id must be a bare safe factory run id");
  }
  return runId;
}

function assertStartRunIdAvailable(repo, runId) {
  for (const rootPath of factoryRootsForLookup(repo)) {
    const candidate = resolve(rootPath, runId);
    if (existsSync(candidate)) throw new Error(`factory start --run-id '${runId}' already exists at ${candidate}`);
  }
  // The run id becomes the feature branch and worktree name, so a leftover
  // branch or worktree collides mid-run even when no run dir exists.
  if (branchExists(repo, runId)) throw new Error(`factory start --run-id '${runId}' collides with existing branch '${runId}'`);
  const worktree = resolve(repo, ".opencode", "worktrees", runId);
  if (existsSync(worktree)) throw new Error(`factory start --run-id '${runId}' collides with existing worktree ${worktree}`);
}

function allocateDetachedStartRunId(repo, opts = {}) {
  const createRunId = typeof opts.createRunId === "function"
    ? opts.createRunId
    : () => `run-${new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z").toLowerCase()}-${randomUUID().slice(0, 8)}`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = normalizeRequestedStartRunId(createRunId());
    try {
      assertStartRunIdAvailable(repo, runId);
      return runId;
    } catch (error) {
      if (attempt === 7) throw error;
    }
  }
  throw new Error("unable to allocate a detached factory run id");
}

function startResumeEligibility(preflight, opts = {}) {
  const runDir = preflight.run_dir;
  const runFile = preflight.run_file || (runDir ? join(runDir, "run.json") : null);
  if (!runDir || !runFile) {
    return { ...preflight, ok: false, reason: "resume ineligible: missing recovered run metadata" };
  }
  const run = readRunFile(runFile);
  const eligibility = resumeEligibility(runDir, run, opts);
  if (eligibility.eligible) return { ...preflight, eligibility };
  return {
    ...preflight,
    ok: false,
    status: run.status,
    terminal_result: run.terminal_result || null,
    reason: `resume ineligible: ${eligibility.reasons.join(", ")}`,
    eligibility,
  };
}

function startResumeActiveHeartbeatPreflight(runId, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const target = resolveRecoveryRunTarget(runId, { ...opts, cwd: repo });
  if (target.error) return null;

  const readResult = readDurableRecoveryRun(repo, target.runDir, target.runFile);
  if (readResult.error) return null;

  const run = readResult.run;
  if (TERMINAL_STATUSES.has(run.status)) return null;

  const eligibility = resumeEligibility(target.runDir, run, { ...opts, cwd: repo, repoRoot: repo });
  if (!eligibility.reasons.includes("active-heartbeat")) return null;

  return {
    ...recoveryEnvelope(run, {
      ok: false,
      durable: true,
      updated: false,
      recovered: false,
      runDir: target.runDir,
      reason: `resume ineligible: ${eligibility.reasons.join(", ")}`,
    }),
    eligibility,
  };
}

function resolveRecoveryRunTarget(runId, opts = {}) {
  if (!stringValue(runId)) return { error: "resume-check requires a non-empty run id" };
  const value = String(runId).trim();
  const repo = repoRoot(opts.cwd || process.cwd());
  const roots = factoryRootsForLookup(repo);
  if (isExplicitRunPath(value)) {
    const runDir = resolve(opts.cwd || repo, value);
    const root = roots.find((candidate) => isLogicalContainedPath(candidate, runDir, { allowEqual: false }));
    const runFile = join(runDir, "run.json");
    if (!root) return { runId: basename(runDir), runDir, runFile, error: `run path must be inside .opencode/factory: ${runDir}` };
    return { runId: basename(runDir), runDir, runFile };
  }
  if (!SAFE_RUN_ID_PATTERN.test(value) || value === "." || value === ".." || value.includes("..") || value.endsWith(".lock")) {
    const runDir = resolve(directFactoryRoot(repo), value || "invalid-run-id");
    return { runId: value || null, runDir, runFile: join(runDir, "run.json"), error: "run id must be a bare safe factory run id" };
  }
  for (const rootPath of roots) {
    const candidate = resolve(rootPath, value);
    const file = join(candidate, "run.json");
    if (existsSync(file)) return { runId: value, runDir: candidate, runFile: file };
  }
  const runDir = resolve(directFactoryRoot(repo), value);
  return { runId: value, runDir, runFile: join(runDir, "run.json") };
}

function readDurableRecoveryRun(repo, runDir, runFile) {
  try {
    const entry = lstatPathNoSymlinks(repo, runFile, "factory recovery run.json must not contain symlinks").entry;
    if (!entry) return { error: `missing run.json at ${runFile}` };
    if (!entry.isFile()) return { error: `run.json is not a file at ${runFile}` };
    return { run: readRunFile(runFile) };
  } catch (error) {
    return { error: `inaccessible or invalid run.json at ${runFile}: ${error.message}` };
  }
}

function syntheticDisruptedTerminal(runId, runDir, runFile, detail, opts = {}) {
  const id = stringValue(runId) ? String(runId).trim() : fallbackRunId(runId, runDir || "unknown-run");
  const reason = `Factory run '${id}' is disrupted: ${detail}. No durable terminal_result can be written without forbidden re-scaffolding or overwriting missing/inaccessible/invalid durable state.`;
  return {
    ok: false,
    durable: false,
    updated: false,
    recovered: false,
    run_id: id,
    status: "blocked",
    run_dir: runDir || null,
    run_file: runFile || null,
    worktree: null,
    branch: null,
    checked_at: timestamp(opts.now),
    terminal_result: terminalResult(id, "blocked", reason),
  };
}

function recoveryEnvelope(run, details = {}) {
  return {
    ok: Boolean(details.ok),
    durable: details.durable !== false,
    updated: Boolean(details.updated),
    recovered: Boolean(details.recovered),
    run_id: run.run_id,
    status: run.status,
    run_dir: details.runDir || null,
    run_file: details.runDir ? join(details.runDir, "run.json") : null,
    worktree: details.worktree || run.worktree || null,
    branch: run.branch || null,
    branch_head: details.branchHead || null,
    terminal_result: run.terminal_result || null,
    reason: details.reason || run.terminal_result?.reason || null,
    recovery_required: Boolean(details.ownership),
    ownership: details.ownership || null,
  };
}

function inspectRecoveryOwnership(runDir, run, opts = {}) {
  let claim;
  let processState;
  try {
    claim = inspectLaunchClaim(runDir, { ...opts, runId: run.run_id });
    processState = inspectProcessEvidence(runDir, { ...opts, runId: run.run_id });
  } catch (error) {
    return { condition: "unsafe-ownership", reason_code: "process-evidence-invalid", reason: `Resume check found ownership evidence that could not be safely inspected: ${error.message}`, launch_claim_ref: null, process_ref: null };
  }
  if (claim.missing && processState.missing) return null;
  if (!claim.missing && !claim.ok) return { condition: "unsafe-ownership", reason_code: "launch-claim-invalid", reason: "Resume check preserved an invalid launch claim; reconcile ownership manually.", launch_claim_ref: LAUNCH_CLAIM_REF, process_ref: processState.missing ? null : PROCESS_EVIDENCE_FILE };
  if (!processState.missing && !processState.ok) return { condition: "unsafe-ownership", reason_code: "process-evidence-invalid", reason: "Resume check preserved invalid detached process evidence; reconcile ownership manually.", launch_claim_ref: claim.missing ? null : LAUNCH_CLAIM_REF, process_ref: PROCESS_EVIDENCE_FILE };
  if (!claim.missing && claim.owner_status !== "live") return { condition: "unsafe-ownership", reason_code: claim.owner_status === "indeterminate" ? "launch-owner-indeterminate" : "launch-claim-conflict", reason: "Resume check cannot safely prove the preserved launch claim owner.", launch_claim_ref: LAUNCH_CLAIM_REF, process_ref: processState.missing ? null : PROCESS_EVIDENCE_FILE };
  if (!processState.missing && processState.evidence.state === "running" && processState.verification?.status !== "live-and-matching") return { condition: "unsafe-ownership", reason_code: "process-identity-mismatch", reason: "Resume check cannot safely prove the recorded detached process identity.", launch_claim_ref: claim.missing ? null : LAUNCH_CLAIM_REF, process_ref: PROCESS_EVIDENCE_FILE };
  if (!claim.missing && !processState.missing && processState.evidence.execution_id !== claim.claim.execution_id) return { condition: "unsafe-ownership", reason_code: "launch-claim-conflict", reason: "Resume check found contradictory launch and process execution identities.", launch_claim_ref: LAUNCH_CLAIM_REF, process_ref: PROCESS_EVIDENCE_FILE };
  return { condition: "unsafe-ownership", reason_code: !processState.missing && processState.evidence.state === "running" ? "matching-detached-shepherd-live" : "launch-claim-conflict", reason: "Resume check preserved active or ambiguous run ownership; no recovery mutation was attempted.", launch_claim_ref: claim.missing ? null : LAUNCH_CLAIM_REF, process_ref: processState.missing ? null : PROCESS_EVIDENCE_FILE };
}

function resolveRecoveryWorktree(repo, run) {
  if (!stringValue(run.branch)) return { ok: false, reason: `run '${run.run_id}' has no branch, so disrupted worktree recovery needs human reconciliation` };
  const target = stringValue(run.worktree) ? resolve(repo, run.worktree) : deriveExpectedWorktreePath(repo, run.branch);
  const safety = verifyRecoveryWorktreePath(repo, target);
  if (!safety.ok) return safety;
  return { ok: true, path: target };
}

function verifyRecoveryWorktreePath(repo, target) {
  const rootPath = resolve(repo, ".opencode", "worktrees");
  const resolvedTarget = resolve(target);
  let pathToInspect = resolvedTarget;
  try {
    lstatPathNoSymlinks(repo, rootPath, "factory recovery worktree root must not contain symlinks");
  } catch (error) {
    return { ok: false, reason: `recorded recovery worktree path is inaccessible or unsafe: ${error.message}` };
  }
  if (!isLogicalContainedPath(rootPath, resolvedTarget, { allowEqual: false })) {
    const aliasTarget = normalizeDarwinPrivateVarAlias(rootPath, resolvedTarget);
    if (!aliasTarget || !isLogicalContainedPath(rootPath, aliasTarget, { allowEqual: false })) {
      return { ok: false, reason: `recorded recovery worktree path is unsafe because it is outside .opencode/worktrees: ${resolvedTarget}` };
    }
    pathToInspect = aliasTarget;
  }
  if (!isLogicalContainedPath(rootPath, pathToInspect, { allowEqual: false })) {
    return { ok: false, reason: `recorded recovery worktree path is unsafe because it is outside .opencode/worktrees: ${resolvedTarget}` };
  }
  try {
    lstatPathNoSymlinks(repo, pathToInspect, "factory recovery worktree path must not contain symlinks");
  } catch (error) {
    return { ok: false, reason: `recorded recovery worktree path is inaccessible or unsafe: ${error.message}` };
  }
  return { ok: true };
}

function normalizeDarwinPrivateVarAlias(rootPath, targetPath) {
  if (process.platform !== "darwin" || !rootPath.startsWith("/private/var/") || !targetPath.startsWith("/var/")) return null;
  return `/private${targetPath}`;
}

function reconcileRecoveryGitEvidence(repo, run) {
  if (!stringValue(run.branch)) return { ok: false, reason: `run '${run.run_id}' has no branch to recover` };
  if (!isSafeCleanupBranchName(run.branch)) return { ok: false, reason: `run '${run.run_id}' has unsafe branch name '${run.branch}'` };
  const branchHead = branchHeadCommit(repo, run.branch);
  if (!branchHead.ok) return branchHead;
  if (stringValue(run.base_commit) && !commitIsAncestor(repo, run.base_commit, branchHead.commit)) {
    return { ok: false, reason: `base_commit '${run.base_commit}' is not an ancestor of branch '${run.branch}' HEAD '${branchHead.commit}'` };
  }
  for (const mergeCommit of mergedSliceCommits(run)) {
    if (!commitIsAncestor(repo, mergeCommit, branchHead.commit)) {
      return { ok: false, reason: `merged slice merge_commit '${mergeCommit}' is not an ancestor of branch '${run.branch}' HEAD '${branchHead.commit}'` };
    }
  }
  return { ok: true, branchHead: branchHead.commit };
}

function branchHeadCommit(repo, branch) {
  const proc = git(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (!proc.ok) return { ok: false, reason: `branch '${branch}' does not exist or has no resolvable HEAD commit` };
  return { ok: true, commit: proc.stdout.trim() };
}

function commitIsAncestor(repo, ancestor, descendant) {
  return git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

function mergedSliceCommits(run) {
  return [...new Set((Array.isArray(run.slices) ? run.slices : [])
    .filter((slice) => slice?.status === "merged" && stringValue(slice.merge_commit))
    .map((slice) => String(slice.merge_commit).trim()))];
}

function checkExistingRecoveryWorktree(repo, worktree, branch) {
  let entry;
  try {
    entry = lstatSync(worktree);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unsafe", reason: `recorded worktree path is inaccessible: ${error.message}` };
  }
  if (!entry.isDirectory()) return { status: "unsafe", reason: `recorded worktree path exists but is not a directory: ${worktree}` };
  const identity = checkWorktreeIdentity(repo, worktree, { branch });
  if (!identity.ok) return { status: "unsafe", reason: `recorded worktree path exists but is not the expected worktree: ${identity.reason}` };
  return { status: "healthy", worktree: identity.worktree };
}

function addRecoveryWorktree(repo, worktree, branch) {
  const safety = verifyRecoveryWorktreePath(repo, worktree);
  if (!safety.ok) return safety;
  mkdirSync(resolve(repo, ".opencode", "worktrees"), { recursive: true });
  const postMkdirSafety = verifyRecoveryWorktreePath(repo, worktree);
  if (!postMkdirSafety.ok) return postMkdirSafety;
  const proc = git(repo, ["worktree", "add", worktree, branch], { timeout: 30000 });
  if (!proc.ok) return { ok: false, reason: `git worktree add failed for disrupted run recovery: ${(proc.stderr || proc.stdout || "unknown git error").trim()}` };
  return { ok: true };
}

async function persistRecoveryTerminal(runDir, priorRun, statusValue, reason, opts = {}) {
  return withRunJsonLock(runDir, async () => {
    const runPath = join(runDir, "run.json");
    const current = readRunFile(runPath);
    if (TERMINAL_STATUSES.has(current.status)) return recoveryEnvelope(current, {
      ok: false,
      durable: true,
      updated: false,
      recovered: false,
      runDir,
      reason: current.terminal_result?.reason || reason,
    });
    if (current.steering?.pending) throw new Error("recovery terminalization rejected: pending steering");
    if (current.steering?.uncheckpointed) throw new Error("recovery terminalization rejected: consumed steering acknowledgement is pending");
    if (current.steering?.action_claim) throw new Error("recovery terminalization rejected: action start acknowledgement is pending");
    if (current.steering?.pr_fence) throw new Error("recovery terminalization rejected: active pre-PR fence");
    bestEffortStopHeartbeatForTerminal(runDir, opts);
    const next = validateRun({
      ...current,
      status: statusValue,
      updated_at: timestamp(opts.now),
      terminal_result: terminalResult(current.run_id || priorRun.run_id, statusValue, reason),
    });
    writeJsonAtomic(runPath, next);
    return recoveryEnvelope(next, {
      ok: false,
      durable: true,
      updated: true,
      recovered: false,
      runDir,
      reason,
    });
  }, opts);
}

function terminalResult(runId, statusValue, reason) {
  return { status: statusValue, run_id: runId, pr_url: null, reason, summary: null, artifacts: {} };
}

function bestEffortStopHeartbeatForTerminal(runDir, opts = {}) {
  try {
    const file = heartbeatPath(runDir);
    const heartbeat = tryReadHeartbeatFile(file);
    if (heartbeat.error || !heartbeat.value) return;
    stopActiveHeartbeatLoop(runDir);
    writeHeartbeatFile(file, validateHeartbeatState({ ...heartbeat.value, pid: null, last_tick_at: timestamp(opts.now) }));
  } catch {
    // Recovery terminal writes are best-effort about heartbeat cleanup.
  }
}

export function continueFactory(parentRunId, opts = {}) {
  assertPostPrCliOptions(opts, { command: "factory continue" });
  const repo = repoRoot(opts.cwd || process.cwd());
  const continuation = buildContinuation(parentRunId, { ...opts, cwd: repo });
  const parentRunDir = resolveRunDir(continuation.parent.run_id, { ...opts, cwd: repo });

  const prompt = `Continue blocked feature-factory run '${continuation.parent.run_id}' as '${continuation.target.run_id}' using review '${continuation.review.ref}'.`;
  const payload = featureCommandPayload(prompt, { ...opts, repo, continuation });
  const launchEnv = factoryLaunchEnv(opts);
  if (opts.dryRun) return { status: "dry-run", payload, seed_plan: continuationSeedPlan(continuation) };

  seedRepoSkill(repo);
  // Seed the accepted parent planning artifacts into the child run up front so the
  // orchestrator reuses the approved brief/research/story instead of regenerating
  // them (the dominant wall-clock cost of a continuation).
  seedContinuationPlanningArtifacts(repo, parentRunDir, continuation);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(encodeFeatureCommandPayload(payload));
  if (opts.detached) return startDetached(repo, commandArgs, { ...detachedProcessOptions(repo, { ...opts, runId: continuation.target.run_id, runDir: join(factoryRoot(repo), continuation.target.run_id) }), env: launchEnv });
  return runForegroundFactory(repo, commandArgs, { ...opts, env: launchEnv });
}

export async function resumeFactory(runId, opts = {}) {
  assertPostPrCliOptions(opts, { command: "factory resume", resume: true });
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = resolveRunDir(runId, { ...opts, cwd: repo });
  await reconcilePostPrCrash(runDir, opts);
  const run = readRunFile(join(runDir, "run.json"));
  if (!opts.dryRun) {
    const ownership = await existingRunOwnershipOutcome(runDir, run, { ...opts, repo });
    if (ownership) return ownership;
  }
  const eligibility = resumeEligibility(runDir, run, { ...opts, cwd: repo, repoRoot: repo });
  if (!eligibility.eligible) throw new Error(`resume ineligible: ${eligibility.reasons.join(", ")}`);
  const payload = buildResumePayload(run, { ...opts, repo });
  const launchEnv = factoryLaunchEnv(opts);
  if (opts.dryRun) return { status: "dry-run", eligible: true, eligibility, payload };

  seedRepoSkill(repo);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(encodeFeatureCommandPayload(payload));
  return coordinateExistingRunLaunch(runDir, run, {
    ...opts,
    repo,
    launchKind: opts.detached ? "resume-detached" : "resume-foreground",
    launch: ({ env, executionId }) => opts.detached
      ? (opts.detachedLaunchFn || startDetached)(repo, commandArgs, { ...detachedProcessOptions(repo, { ...opts, runId: run.run_id, runDir, executionId }), env })
      : (opts.foregroundLaunchFn || runForegroundFactory)(repo, commandArgs, { ...opts, env }),
    launchEnv,
  });
}

async function existingRunOwnershipOutcome(runDir, run, opts = {}) {
  let processState;
  let claim;
  try {
    processState = inspectProcessEvidence(runDir, { ...opts, runId: run.run_id });
    claim = inspectLaunchClaim(runDir, { ...opts, runId: run.run_id });
  } catch (error) {
    return { status: "recovery-required", reason_code: "process-evidence-invalid", reason: error.message };
  }
  if (!processState.missing) {
    if (!processState.ok) return { status: "recovery-required", reason_code: "process-evidence-invalid", reason: processState.reason };
    if (processState.evidence.state === "running" && processState.verification?.status === "live-and-matching") {
      if (!claim.missing && (!claim.ok || claim.claim.execution_id !== processState.evidence.execution_id)) {
        return { status: "recovery-required", reason_code: "launch-claim-conflict", launch_claim_ref: LAUNCH_CLAIM_REF };
      }
      return { status: "already-running", pid: processState.evidence.pid, repo: opts.repo, log: join(runDir, processState.evidence.log_ref), execution_id: processState.evidence.execution_id };
    }
    return { status: "recovery-required", reason_code: processState.evidence.state === "running" ? "process-identity-mismatch" : "prior-process-stopped" };
  }
  if (claim.missing) return null;
  if (!claim.ok) return { status: "recovery-required", reason_code: "launch-claim-invalid", launch_claim_ref: LAUNCH_CLAIM_REF };
  if (claim.owner_status === "indeterminate") return { status: "recovery-required", reason_code: "launch-owner-indeterminate", launch_claim_ref: LAUNCH_CLAIM_REF };
  const matched = await waitForMatchingClaimEvidence(runDir, run.run_id, claim, opts);
  if (matched) return { status: "already-running", pid: matched.pid, repo: opts.repo, log: join(runDir, matched.log_ref), execution_id: matched.execution_id };
  return { status: "recovery-required", reason_code: "launch-claim-conflict", launch_claim_ref: LAUNCH_CLAIM_REF };
}

async function coordinateExistingRunLaunch(runDir, run, opts) {
  const ownership = await existingRunOwnershipOutcome(runDir, run, opts);
  if (ownership) return ownership;
  const claimFns = launchClaimFunctions(opts);
  const detached = opts.launchKind.endsWith("detached");
  const executionId = opts.executionId || randomUUID();
  let acquired;
  try {
    acquired = claimFns.acquire(runDir, {
      runId: run.run_id,
      executionId,
      launchKind: opts.launchKind,
      phase: detached ? "spawning" : "foreground-live",
      cwd: process.cwd(),
      pid: process.pid,
      approval: null,
      now: opts.now,
    }, opts);
  } catch (error) {
    return { status: "recovery-required", reason_code: "claim-acquisition-failed", reason: error.message };
  }
  if (!acquired.acquired) {
    if (!acquired.ok) return { status: "recovery-required", reason_code: "launch-claim-invalid", launch_claim_ref: LAUNCH_CLAIM_REF };
    const matched = await waitForMatchingClaimEvidence(runDir, run.run_id, acquired, opts);
    return matched
      ? { status: "already-running", pid: matched.pid, repo: opts.repo, log: join(runDir, matched.log_ref), execution_id: matched.execution_id }
      : { status: "recovery-required", reason_code: "launch-claim-conflict", launch_claim_ref: LAUNCH_CLAIM_REF };
  }
  const token = acquired.token;
  const env = { ...(opts.launchEnv || factoryLaunchEnv(opts)), [FACTORY_LAUNCH_CLAIM_ENV]: token };
  try {
    const result = await opts.launch({ env, executionId });
    if (detached) {
      const readiness = await waitForPublishedLaunchEvidence(runDir, run.run_id, executionId, result?.pid, opts);
      if (!readiness.evidence) return { status: "recovery-required", reason_code: readiness.reason_code, launch_claim_ref: LAUNCH_CLAIM_REF };
      try {
        if (!claimFns.release(runDir, token, { ...opts, expectedPhase: "spawning", runId: run.run_id })) return { status: "recovery-required", reason_code: "launch-evidence-mismatch", launch_claim_ref: LAUNCH_CLAIM_REF };
      } catch (error) {
        return { status: "recovery-required", reason_code: "launch-evidence-mismatch", reason: error.message, launch_claim_ref: LAUNCH_CLAIM_REF };
      }
    }
    return result;
  } catch (error) {
    if (detached) return { status: "recovery-required", reason_code: /readiness|timed out/iu.test(error.message) ? "launch-readiness-failed" : "launch-spawn-failed", reason: error.message, launch_claim_ref: LAUNCH_CLAIM_REF };
    throw error;
  } finally {
    if (!detached) {
      const current = claimFns.inspect(runDir, { ...opts, runId: run.run_id });
      if (current.ok && current.claim.nonce === token && current.claim.phase === "foreground-live") {
        if (!claimFns.release(runDir, token, { ...opts, expectedPhase: "foreground-live", runId: run.run_id })) throw new Error("foreground launch claim cleanup failed");
      }
    }
  }
}

export async function transitionGateDecisionAndHandoff(runIdOrDir, gateName, decision, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = isExplicitRunPath(String(runIdOrDir))
    ? resolve(String(runIdOrDir))
    : resolveRunDir(runIdOrDir, { ...opts, cwd: repo });
  let transition;
  try {
    transition = await transitionGateDecision(runDir, gateName, decision, opts);
  } catch (error) {
    if (!error?.handoffCode) throw error;
    const run = readRunFile(join(runDir, "run.json"));
    return {
      updated: false,
      reason: "redelivery-rejected",
      status: run.status,
      run,
      gate: gateName,
      gate_accepted: true,
      handoff: handoffEnvelope(run.run_id, gateName, error.handoffCode),
    };
  }
  if (decision.status !== "approved") return { ...transition, gate_accepted: false, handoff: null };
  const run = transition.run;
  let handoff;
  try {
    handoff = await handoffApprovedInteractiveRun(runDir, run, gateName, { ...opts, repo });
  } catch (error) {
    handoff = handoffEnvelope(run.run_id, gateName, error?.handoffCode || "claim-acquisition-failed", error?.preservedClaim ? { claim: true } : {});
  }
  return { ...transition, gate_accepted: true, handoff };
}

export async function handoffApprovedInteractiveRun(runDir, runInput, gateName, opts = {}) {
  let run;
  try { run = validateRun(runInput); } catch { return handoffEnvelope(runInput?.run_id || "unknown-run", gateName, "resume-ineligible"); }
  const runId = run.run_id;
  if (run.mode !== "interactive") return handoffEnvelope(runId, gateName, "run-mode-not-interactive");
  if (TERMINAL_STATUSES.has(run.status)) return handoffEnvelope(runId, gateName, "terminal-run");
  if (pendingProtectedGate(run)) return handoffEnvelope(runId, gateName, "protected-gate-pending");

  let processState;
  try { processState = inspectProcessForHandoff(runDir, runId, opts); } catch { return handoffEnvelope(runId, gateName, "process-evidence-invalid"); }
  if (processState) return handoffEnvelope(runId, gateName, processState.code, processState.live);

  let receipt;
  try { receipt = inspectApprovalHandoffReceipt(runDir, run, gateName); } catch { return handoffEnvelope(runId, gateName, "approval-snapshot-mismatch"); }
  if (!receipt.ok) return handoffEnvelope(runId, gateName, receipt.reason_code);
  let eligibility;
  try { eligibility = resumeEligibility(runDir, run, { ...opts, repoRoot: opts.repo || factoryRepoFromRunDir(runDir), ignoreLaunchOwnership: true }); } catch { return handoffEnvelope(runId, gateName, "resume-ineligible"); }
  if (!eligibility.eligible) return handoffEnvelope(runId, gateName, "resume-ineligible");

  const claimFunctions = launchClaimFunctions(opts);
  let claim;
  const inheritedToken = process.env[FACTORY_LAUNCH_CLAIM_ENV];
  if (stringValue(inheritedToken)) {
    let observed;
    try { observed = claimFunctions.inspect(runDir, { ...opts, runId }); } catch { return handoffEnvelope(runId, gateName, "launch-claim-invalid", { claim: true }); }
    if (!observed.ok) return handoffEnvelope(runId, gateName, observed.missing ? "launch-claim-conflict" : "launch-claim-invalid", { claim: true });
    if (observed.claim.nonce !== inheritedToken || observed.claim.run_id !== runId || observed.claim.phase !== "foreground-live") {
      return handoffEnvelope(runId, gateName, "launch-claim-conflict", { claim: true });
    }
    claim = { ...observed, acquired: false, token: inheritedToken };
  } else {
    let existing;
    try { existing = claimFunctions.inspect(runDir, { ...opts, runId }); } catch { return handoffEnvelope(runId, gateName, "launch-claim-invalid", { claim: true }); }
    if (!existing.missing) return await classifyClaimContention(runDir, runId, gateName, existing, opts);
    try {
      claim = claimFunctions.acquire(runDir, {
        runId,
        executionId: opts.executionId || randomUUID(),
        launchKind: "approval-handoff",
        phase: "predecessor-active",
        pid: process.pid,
        cwd: opts.repo || factoryRepoFromRunDir(runDir),
        approval: { gate: gateName, approval_fingerprint: receipt.receipt.approval_fingerprint },
        now: opts.now,
      }, opts);
    } catch {
      return handoffEnvelope(runId, gateName, "claim-acquisition-failed");
    }
    if (!claim.acquired) return await classifyClaimContention(runDir, runId, gateName, claim, opts);
  }

  const token = claim.token || claim.claim.nonce;
  try {
    if (claim.claim.phase === "foreground-live") {
      claim = claimFunctions.transition(runDir, token, "predecessor-active", {
        approval: { gate: gateName, approval_fingerprint: receipt.receipt.approval_fingerprint },
      }, { ...opts, expectedPhase: "foreground-live" });
    }
    await opts.handoffHooks?.beforeRelease?.({ runDir, claim: claim.claim });
    claim = claimFunctions.transition(runDir, token, "predecessor-released", {}, { ...opts, expectedPhase: "predecessor-active" });
    await opts.handoffHooks?.afterRelease?.({ runDir, claim: claim.claim });
  } catch {
    return handoffEnvelope(runId, gateName, "foreground-release-failed", { claim: true });
  }

  try {
    claim = claimFunctions.transition(runDir, token, "spawning", {}, { ...opts, expectedPhase: "predecessor-released" });
  } catch {
    return handoffEnvelope(runId, gateName, "foreground-release-failed", { claim: true });
  }

  let started;
  try {
    const payload = buildResumePayload(run, { ...opts, repo: opts.repo, headless: false, autonomous: false });
    const commandArgs = ["run", "--dir", opts.repo, "--command", "feature", "--agent", "feature-factory"];
    if (opts.model) commandArgs.push("--model", opts.model);
    commandArgs.push(encodeFeatureCommandPayload(payload));
    const launch = typeof opts.detachedLaunchFn === "function" ? opts.detachedLaunchFn : startDetached;
    started = await launch(opts.repo, commandArgs, {
      ...detachedProcessOptions(opts.repo, { ...opts, runId, runDir, executionId: claim.claim.execution_id }),
      env: factoryLaunchEnv(opts),
    });
  } catch (error) {
    const code = /readiness|timed out|disconnect|before readiness/iu.test(String(error?.message)) ? "launch-readiness-failed" : "launch-spawn-failed";
    return handoffEnvelope(runId, gateName, code, { claim: true });
  }

  const readiness = await waitForPublishedLaunchEvidence(runDir, runId, claim.claim.execution_id, started?.pid, opts);
  if (!readiness.evidence) return handoffEnvelope(runId, gateName, readiness.reason_code, { claim: true });
  const evidence = readiness.evidence;
  try {
    if (!claimFunctions.release(runDir, token, { ...opts, expectedPhase: "spawning", runId })) return handoffEnvelope(runId, gateName, "launch-evidence-mismatch", { claim: true });
  } catch {
    return handoffEnvelope(runId, gateName, "launch-evidence-mismatch", { claim: true });
  }
  return handoffEnvelope(runId, gateName, "detached-shepherd-started", { evidence });
}

async function waitForPublishedLaunchEvidence(runDir, runId, executionId, pid, opts = {}) {
  const timeoutMs = normalizePositiveInteger(opts.readyTimeoutMs, DETACHED_READY_TIMEOUT_MS, "readyTimeoutMs");
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const sleepFn = typeof opts.sleep === "function" ? opts.sleep : (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const started = clock();
  if (!Number.isFinite(started)) return { evidence: null, reason_code: "launch-readiness-failed" };
  const deadline = started + timeoutMs;
  const maximumPolls = Math.ceil(timeoutMs / 25) + 1;
  for (let count = 0; count < maximumPolls; count += 1) {
    let observed;
    try { observed = inspectProcessEvidence(runDir, { ...opts, runId }); } catch { return { evidence: null, reason_code: "launch-evidence-mismatch" }; }
    if (!observed.missing) {
      if (observed.ok && observed.evidence.execution_id === executionId && observed.evidence.pid === pid && observed.verification?.status === "live-and-matching") {
        return { evidence: observed.evidence, reason_code: null };
      }
      return { evidence: null, reason_code: "launch-evidence-mismatch" };
    }
    const now = clock();
    if (!Number.isFinite(now) || now >= deadline) break;
    try { await sleepFn(Math.min(25, deadline - now)); } catch { break; }
  }
  return { evidence: null, reason_code: "launch-readiness-failed" };
}

function inspectProcessForHandoff(runDir, runId, opts) {
  const state = inspectProcessEvidence(runDir, { ...opts, runId });
  if (state.missing) return null;
  if (!state.ok) return { code: "process-evidence-invalid" };
  const evidence = state.evidence;
  if (evidence.state === "cancelled") return { code: "validated-cancelled" };
  if (evidence.state === "running" && evidence.cancel?.result === "pending") return { code: "cancel-pending" };
  if (evidence.state === "exited" || evidence.state === "failed-closed") return { code: "prior-process-stopped" };
  if (state.verification?.status === "live-and-matching") return { code: "matching-detached-shepherd-live", live: { evidence } };
  return { code: "process-identity-mismatch" };
}

async function classifyClaimContention(runDir, runId, gateName, observed, opts = {}) {
  if (!observed.ok) return handoffEnvelope(runId, gateName, "launch-claim-invalid", { claim: true });
  if (observed.owner_status === "indeterminate") return handoffEnvelope(runId, gateName, "launch-owner-indeterminate", { claim: true });
  let evidence;
  try { evidence = await waitForMatchingClaimEvidence(runDir, runId, observed, opts); } catch { return handoffEnvelope(runId, gateName, "launch-claim-conflict", { claim: true }); }
  if (evidence) return handoffEnvelope(runId, gateName, "matching-detached-shepherd-live", { evidence });
  return handoffEnvelope(runId, gateName, "launch-claim-conflict", { claim: true });
}

async function waitForMatchingClaimEvidence(runDir, runId, observed, opts = {}) {
  if (!observed?.ok || observed.owner_status !== "live" || !["predecessor-active", "predecessor-released", "spawning"].includes(observed.claim.phase)) return null;
  const timeoutMs = normalizePositiveInteger(opts.readyTimeoutMs, DETACHED_READY_TIMEOUT_MS, "readyTimeoutMs");
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const sleepFn = typeof opts.sleep === "function" ? opts.sleep : (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const start = clock();
  const deadline = Number.isFinite(start) ? start + timeoutMs : null;
  for (let count = 0; count <= Math.ceil(timeoutMs / 25); count += 1) {
    let evidence;
    try { evidence = inspectProcessEvidence(runDir, { ...opts, runId }); } catch { return null; }
    if (evidence.ok && evidence.evidence.execution_id === observed.claim.execution_id && evidence.verification?.status === "live-and-matching") return evidence.evidence;
    const now = clock();
    if (deadline === null || !Number.isFinite(now) || now >= deadline) break;
    try { await sleepFn(Math.min(25, deadline - now)); } catch { return null; }
  }
  return null;
}

function launchClaimFunctions(opts = {}) {
  return {
    inspect: opts.inspectLaunchClaimFn || inspectLaunchClaim,
    acquire: opts.acquireLaunchClaimFn || acquireLaunchClaim,
    transition: opts.transitionLaunchClaimPhaseFn || transitionLaunchClaimPhase,
    release: opts.releaseLaunchClaimFn || releaseLaunchClaim,
  };
}

export function handoffEnvelope(runId, gate, reasonCode, details = {}) {
  const row = HANDOFF_ROWS[reasonCode];
  if (!row) throw new Error(`unknown handoff reason code: ${reasonCode}`);
  const [statusValue, automatic, reason, action] = row;
  const statusCommand = `feature-factory factory status ${runId} --json`;
  const watchCommand = `feature-factory factory watch ${runId}`;
  const resumeCheck = `feature-factory factory resume-check ${runId} --json`;
  const actionCommand = action === "watch" ? watchCommand
    : action === "inspect-terminal-result" || (action === "confirm-cancellation" && reasonCode === "validated-cancelled") ? statusCommand
      : action === "confirm-cancellation" ? `feature-factory factory cancel ${runId} --json`
        : action === "run-resume-check" ? resumeCheck
          : null;
  const evidence = details.evidence || null;
  return {
    automatic,
    status: statusValue,
    run_id: runId,
    gate,
    reason_code: reasonCode,
    reason,
    action,
    action_command: actionCommand,
    pid: evidence?.pid ?? null,
    process_ref: evidence ? PROCESS_EVIDENCE_FILE : null,
    launch_claim_ref: details.claim ? LAUNCH_CLAIM_REF : null,
    log: evidence?.log_ref ?? null,
    status_command: statusCommand,
    watch_command: watchCommand,
    recovery_command: action === "run-resume-check" ? resumeCheck : null,
  };
}

/** Perform at most one due verdict query (or one pending reviewer request). */
export async function postPrObserve(runId, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = resolveRunDir(runId, { ...opts, cwd: repo });
  const run = readRunFile(join(runDir, "run.json"));
  const postPr = run.post_pr;
  if (run.status !== "running" || postPr?.policy?.enabled !== true || postPr.phase !== "observing") {
    throw new Error("post-pr-observe requires a running enabled observing run");
  }
  assertPostPrExternalWorkReady(runDir, run, opts);
  const observation = postPr.observation;
  const now = timestamp(opts.now);
  if (!isPollDue(observation.next_poll_at, now)) {
    return { run_id: run.run_id, action: "not-due", next_poll_at: observation.next_poll_at, post_pr: postPrSummary(run) };
  }
  if (Date.parse(now) >= Date.parse(observation.deadline_at)) {
    return postPrTerminal(runDir, run, "blocked", "post-pr-observation-timeout", opts);
  }
  if (observation.review_request?.status === "pending") {
    let action;
    try {
      action = await claimPostPrAction(runDir, "post-pr-observe", opts);
      await requestReviewer(githubOperationInput(repo, run, opts, {
        repository: persistedPrIdentity(run).repository,
        prNumber: persistedPrIdentity(run).number,
        reviewerLogin: postPr.policy.review.reviewer_login,
      }));
      assertPostPrActionFresh(runDir, action);
    } catch (error) {
      return handleObserverError(runDir, run, error, { ...opts, expectedCurrentHash: action?.state_hash });
    }
    const next = cloneJson(postPr);
    next.observation.review_request = { status: "requested", attempts: observation.review_request.attempts + 1, requested_at: now };
    next.observation.next_poll_at = new Date(Date.parse(now) + postPr.policy.initial_poll_ms).toISOString();
    await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: action.state_hash });
    return { run_id: run.run_id, action: "reviewer-requested", next_poll_at: next.observation.next_poll_at, post_pr: postPrSummary({ ...run, post_pr: next }) };
  }

  let response;
  let action;
  try {
    action = await claimPostPrAction(runDir, "post-pr-observe", opts);
    response = await queryPullRequest(githubOperationInput(repo, run, opts, persistedPrIdentity(run)));
    assertPostPrActionFresh(runDir, action);
  } catch (error) {
    return handleObserverError(runDir, run, error, { ...opts, expectedCurrentHash: action?.state_hash });
  }
  const normalized = normalizePullRequestResponse(response, {
    startedAt: observation.started_at,
    now,
    checkStartGraceMs: postPr.policy.check_start_grace_ms,
    expectedHeadSha: observation.expected_head_sha,
    reviewerLogin: postPr.policy.review.reviewer_login,
    reviewRequired: postPr.policy.review.required,
  });
  const fingerprint = hashJson(normalized);
  const changed = fingerprint !== observation.last_fingerprint;
  const schedule = decideObservationSchedule({
    now, deadlineAt: observation.deadline_at, changed,
    initialPollMs: postPr.policy.initial_poll_ms, currentIntervalMs: observation.current_interval_ms,
    maxPollMs: postPr.policy.max_poll_ms, unchangedCount: observation.unchanged_count,
  });
  const next = cloneJson(postPr);
  Object.assign(next.observation, {
    poll_count: observation.poll_count + 1,
    unchanged_count: schedule.unchanged_count ?? observation.unchanged_count,
    current_interval_ms: schedule.interval_ms || observation.current_interval_ms,
    consecutive_transient_errors: 0,
    last_observed_at: now,
    last_fingerprint: fingerprint,
    last_check_verdict: normalized.checks.verdict,
    last_review_verdict: normalized.review.verdict,
    last_verdict: durableObservationVerdict(normalized.aggregate),
    last_error: null,
    next_poll_at: schedule.next_poll_at || observation.deadline_at,
    snapshot: sanitizedObservationSnapshot(normalized),
  });
  await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: action.state_hash });
  const current = readRunFile(join(runDir, "run.json"));
  return finishObservedVerdict(repo, runDir, current, normalized, { ...opts, expectedCurrentHash: hashRunState(current) });
}

export async function postPrRemediation(runId, attemptValue, event, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = resolveRunDir(runId, { ...opts, cwd: repo });
  const run = readRunFile(join(runDir, "run.json"));
  assertPostPrExternalWorkReady(runDir, run, opts);
  const attempt = Number(attemptValue);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt !== run.post_pr?.attempt || attempt !== run.post_pr?.remediation?.attempt) throw new Error("post-pr-remediation attempt must equal the current persisted attempt");
  if (event === "running") return markPostPrRemediationRunning(runDir, run, opts);
  if (event === "revalidating") return markPostPrRevalidating(runDir, run, opts);
  if (event === "complete") return completePostPrRemediation(repo, runDir, run, opts);
  if (event === "failed") return failPostPrRevalidation(runDir, run, opts);
  throw new Error("post-pr-remediation event must be running, revalidating, failed, or complete");
}

async function finishObservedVerdict(repo, runDir, run, normalized, opts) {
  const verdict = normalized.aggregate;
  if (verdict.reason === "external-merge") return postPrTerminal(runDir, run, "completed", "post-pr-external-merge", opts);
  if (verdict.reason === "external-state") return postPrTerminal(runDir, run, "blocked", "post-pr-pr-closed", opts);
  if (verdict.reason === "head-mismatch") return postPrTerminal(runDir, run, "needs-human", "post-pr-head-mismatch", opts);
  if (normalized.review.verdict === "red") return postPrTerminal(runDir, run, "needs-human", "post-pr-review-changes-requested", opts);
  if (verdict.verdict === "green") {
    return postPrTerminal(runDir, run, "completed", normalized.is_draft ? "post-pr-draft-ci-green" : "post-pr-ci-green", opts);
  }
  if (verdict.verdict !== "red") return { run_id: run.run_id, action: "scheduled", next_poll_at: run.post_pr.observation.next_poll_at, post_pr: postPrSummary(run) };

  const ownerAction = await claimPostPrAction(runDir, "post-pr-observe", { ...opts, expectedCurrentHash: opts.expectedCurrentHash });
  const failingChecks = normalized.checks.checks.filter((check) => check.verdict === "red");
  const plan = acceptedSlicesPlan(runDir, run);
  let changed = { paths: [], changes: [], complete: true };
  let ownership = classifyOwnership({ slices: plan.slices, failingCheckNames: failingChecks.map((check) => check.name), paths: [] });
  if (ownership.disposition !== "route" || ownership.owner?.kind === "integration") {
    try {
      changed = await fetchChangedFiles(githubOperationInput(repo, run, opts, persistedPrIdentity(run)));
      ownership = classifyOwnership({ slices: plan.slices, failingCheckNames: failingChecks.map((check) => check.name), ...changed });
    } catch (error) {
      ownership = { disposition: "needs-human", owner: null, route: null, lane: null, reason: "changed-files-incomplete" };
    }
  }
  assertPostPrActionFresh(runDir, ownerAction);
  const attempt = run.post_pr.attempt + 1;
  const built = buildFailureEvidenceInput({
    runId: run.run_id, attempt, observedAt: run.post_pr.observation.last_observed_at,
    repository: persistedPrIdentity(run).repository, prNumber: persistedPrIdentity(run).number, prUrl: run.pr_url,
    expectedHeadSha: run.post_pr.observation.expected_head_sha, observedHeadSha: normalized.head_sha,
    failingChecks, review: null, ownership, exitCode: 0,
  });
  const evidence = { ...built, source: "check-red", failed_head_sha: run.post_pr.observation.expected_head_sha };
  if (typeof opts.beforeEvidencePublish === "function") await opts.beforeEvidencePublish({ run_id: run.run_id, attempt, evidence: cloneJson(evidence) });
  assertPostPrActionFresh(runDir, ownerAction);
  const binding = publishRunJsonEvidence(runDir, `evidence/post-pr-ci.attempt-${attempt}.json`, evidence);
  assertPostPrActionFresh(runDir, ownerAction);
  if (ownership.disposition !== "route") {
    return postPrTerminal(runDir, run, "needs-human", ownership.reason === "changed-files-incomplete" ? "post-pr-metadata-unsafe" : "post-pr-owner-ambiguous", { ...opts, expectedCurrentHash: ownerAction.state_hash }, { latest_evidence: binding.ref });
  }
  const max = Number.isInteger(run.max_retries) ? run.max_retries : 3;
  if (run.post_pr.attempt >= max) return exhaustPostPr(runDir, run, { ...withoutExpectedHash(opts), expectedCurrentHash: ownerAction.state_hash }, binding);
  const remediation = newRemediation(run, attempt, evidence.failure_fingerprint, binding, ownership);
  await transitionPostPrFailure(runDir, { remediation }, { ...opts, expectedCurrentHash: ownerAction.state_hash });
  const reserved = readRunFile(join(runDir, "run.json"));
  const planned = cloneJson(reserved.post_pr);
  planned.phase = "remediation-planned";
  planned.remediation.stage = "planned";
  await transitionPostPrState(runDir, planned, { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(reserved) });
  return { run_id: run.run_id, action: "remediation-planned", attempt, route: ownership.route, owner: ownership.owner, evidence: binding, post_pr: postPrSummary({ ...run, post_pr: planned }) };
}

function newRemediation(run, attempt, fingerprint, binding, ownership) {
  const failedHead = run.post_pr.observation.expected_head_sha;
  return {
    schema_version: 1, attempt, reason_code: "check-red", failure_fingerprint: fingerprint,
    failed_head_sha: failedHead, failure_evidence_ref: binding.ref, failure_evidence_hash: binding.hash,
    owner: ownership.owner, route: ownership.route, lane: ownership.lane, stage: "planned", baseline_head_sha: failedHead,
    dispatch: { id: randomUUID(), status: "planned", role: ownership.route, subject: ownership.owner.kind === "slice" ? ownership.owner.slice_id : "integration", started_at: null, returned_at: null },
    changes: { paths: [], entries: [], tree_hash: null }, candidate_head_sha: null, remediation_evidence_ref: null, remediation_evidence_hash: null,
    revalidation: { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null, validator_review_ref: null, validator_review_hash: null, validator_verdict: null, security_review_ref: null, security_review_hash: null, security_verdict: null, jobs: {} },
    push: { status: "not-ready", remote_before_sha: null, local_head_sha: null, remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null, last_error: null },
  };
}

async function handleObserverError(runDir, run, error, opts) {
  const classified = error instanceof PostPrCiError ? error : new PostPrCiError("command", "GitHub observer failed", { cause: error });
  const next = cloneJson(run.post_pr);
  const count = next.observation.consecutive_transient_errors + 1;
  if (classified.transient) {
    const schedule = decideTransientSchedule({ now: timestamp(opts.now), deadlineAt: next.observation.deadline_at, consecutiveErrors: count,
      maxTransientErrors: next.policy.max_transient_errors, retryAfterMs: classified.retryAfterMs, rateLimited: classified.rateLimited,
      unchangedCount: next.observation.unchanged_count });
    next.observation.consecutive_transient_errors = count;
    const errorClass = durableErrorClass(classified.errorClass);
    next.observation.last_error = { class: errorClass, exit_code: classified.exitCode, occurred_at: timestamp(opts.now), next_retry_at: schedule.next_poll_at };
    if (schedule.action === "schedule") {
      next.observation.next_poll_at = schedule.next_poll_at;
      await transitionPostPrState(runDir, next, opts);
      return { run_id: run.run_id, action: "transient-error", next_poll_at: schedule.next_poll_at, error_class: classified.errorClass };
    }
  }
  next.observation.last_verdict = "infrastructure";
  const errorClass = durableErrorClass(classified.errorClass);
  next.observation.last_error = { class: errorClass, exit_code: classified.exitCode, occurred_at: timestamp(opts.now), next_retry_at: null };
  await transitionPostPrState(runDir, next, opts);
  const current = readRunFile(join(runDir, "run.json"));
  if (classified.errorClass === "account-switch") {
    return postPrTerminal(runDir, current, "needs-human", "post-pr-account-switch-failed", opts, {}, { schema_version: 1, kind: "account-switch-failed", observed_at: next.observation.last_error.occurred_at, operation: "gh-auth-switch", github_account: run.github_account, error_class: errorClass, exit_code: classified.exitCode });
  }
  return postPrTerminal(runDir, current, "blocked", "post-pr-observer-infrastructure", opts);
}

async function postPrTerminal(runDir, run, statusValue, reason, opts, artifacts = {}, triggerFact, continuationReview) {
  const originKind = run.post_pr?.phase === "observing" || run.post_pr?.phase === "failure-recording" ? "post-pr-observe"
    : run.post_pr?.phase === "push-pending" ? "post-pr-push" : "remediation";
  if (stringValue(opts.expectedCurrentHash)) assertFactoryStateHash(runDir, opts.expectedCurrentHash);
  let current = readRunFile(join(runDir, "run.json"));
  let origin = current.steering?.last_action;
  if (!origin || origin.kind !== originKind || origin.outcome !== "started" || origin.generation !== (current.steering?.generation ?? 0)) {
    const claimed = await claimPostPrAction(runDir, originKind, { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(current) });
    current = readRunFile(join(runDir, "run.json")); origin = current.steering.last_action;
    if (origin.token !== claimed.token) throw new Error("post-PR origin claim identity changed");
  }
  const closed = await transitionSteeringActionClosed(runDir, originKind, origin.token, { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(current) });
  const opened = await transitionSteeringBoundaryOpened(runDir, "terminal", { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(closed.run) });
  const crossed = await transitionSteeringBoundaryCrossed(runDir, "terminal", opened.boundary.token, { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(opened.run) });
  const started = await transitionSteeringActionStarted(runDir, "terminal", crossed.action_claim.token, { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(crossed.run) });
  const transitionOpts = { ...withoutExpectedHash(opts), expectedCurrentHash: opts.terminalExpectedHashOverride || hashRunState(started.run),
    terminalActionToken: opts.terminalActionTokenOverride || started.action.token,
    terminalActionGeneration: opts.terminalActionGenerationOverride ?? started.action.generation };
  if (typeof opts.beforePostPrTerminal === "function") await opts.beforePostPrTerminal({ run: cloneJson(readRunFile(join(runDir, "run.json"))), status: statusValue, reason, trigger_fact: triggerFact ? cloneJson(triggerFact) : null });
  if (opts.terminalExpectedHashAfterHook === true) transitionOpts.expectedCurrentHash = hashRunState(readRunFile(join(runDir, "run.json")));
  await transitionPostPrTerminal(runDir, { status: statusValue, reason, artifacts, ...(triggerFact ? { trigger_fact: triggerFact } : {}), ...(continuationReview ? { continuation_review: continuationReview } : {}) }, transitionOpts);
  const terminalRun = readRunFile(join(runDir, "run.json"));
  return { run_id: run.run_id, action: "terminal", status: terminalRun.status, reason, terminal_result: terminalRun.terminal_result, post_pr: postPrSummary(terminalRun) };
}

async function markPostPrRemediationRunning(runDir, run, opts) {
  let next = cloneJson(run.post_pr);
  if (next.phase === "failure-recording") { next.phase = "remediation-planned"; await transitionPostPrState(runDir, next, opts); }
  const current = readRunFile(join(runDir, "run.json"));
  next = cloneJson(current.post_pr);
  if (next.phase === "remediation-running" && next.remediation.dispatch.status === "running") return { run_id: run.run_id, action: "remediation-running", post_pr: postPrSummary(current) };
  if (next.phase !== "remediation-planned") throw new Error("running remediation requires remediation-planned phase");
  next.phase = "remediation-running"; next.remediation.stage = "running"; next.remediation.dispatch.status = "running"; next.remediation.dispatch.started_at = timestamp(opts.now);
  const persisted = await transitionPostPrState(runDir, next, opts);
  const action = await claimPostPrAction(runDir, "remediation", { ...opts, expectedCurrentHash: hashRunState(persisted.run) });
  const dispatch = remediationDispatchEnvelope(persisted.run);
  if (typeof opts.dispatchRemediation !== "function") {
    return { run_id: run.run_id, action: "remediation-running", role: next.remediation.route, subject: next.remediation.dispatch.subject, dispatch, action_token: action.token, heartbeat_phase: "post-pr-remediation", post_pr: postPrSummary({ ...run, post_pr: next }) };
  }
  let heartbeatStarted = false;
  try {
    await startHeartbeat(run.run_id, { phase: "post-pr-remediation", intervalMs: opts.heartbeatIntervalMs }, { ...opts, cwd: factoryRepoFromRunDir(runDir) });
    heartbeatStarted = true;
    const returned = await opts.dispatchRemediation(dispatch);
    return { run_id: run.run_id, action: "remediation-returned", dispatch, returned };
  } finally {
    if (heartbeatStarted) await stopHeartbeat(run.run_id, {}, { ...opts, cwd: factoryRepoFromRunDir(runDir) });
  }
}

async function markPostPrRevalidating(runDir, run, opts) {
  const action = await claimPostPrAction(runDir, "remediation", opts);
  const ref = requiredStringOption(opts.remediationEvidenceRef, "--remediation-evidence-ref");
  const evidence = readBoundRunJson(runDir, ref, "evidence");
  const head = git(run.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.ok || head.stdout.trim() === run.post_pr.remediation.failed_head_sha) throw new Error("revalidating requires a new local candidate HEAD");
  const candidate = head.stdout.trim();
  const paths = validateRemediationEvidence(run, evidence, candidate);
  const actualDiff = committedChangedDiff(run.worktree, run.post_pr.remediation.baseline_head_sha, candidate);
  const actualPaths = actualDiff.paths;
  if (!sameStringArray(paths, actualPaths)) throw new Error("remediation evidence changed_paths must exactly match the committed baseline diff");
  if (!sameJsonValue(evidence.value.changes, actualDiff.changes) || evidence.value.diff_hash !== hashJson(actualDiff.changes)) throw new Error("remediation evidence changes/diff_hash must exactly bind the committed baseline diff");
  const plan = acceptedSlicesPlan(runDir, run);
  const slice = run.post_pr.remediation.owner.kind === "slice" ? plan.slices.find((item) => item.id === run.post_pr.remediation.owner.slice_id) : null;
  const lane = validateLane({ lane: run.post_pr.remediation.lane, slice, paths, changes: evidence.value.changes });
  assertPostPrActionFresh(runDir, action);
  if (!lane.ok) return terminalLaneViolation(runDir, run, { ...opts, expectedCurrentHash: action.state_hash }, lane.reason, paths);
  let next = cloneJson(run.post_pr);
  next.phase = "changes-observed"; next.remediation.stage = "changes-observed"; next.remediation.dispatch.status = "returned"; next.remediation.dispatch.returned_at = timestamp(opts.now);
  next.remediation.changes = { paths, entries: actualDiff.changes, tree_hash: hashJson(actualDiff.changes) }; next.remediation.candidate_head_sha = candidate; next.remediation.remediation_evidence_ref = ref; next.remediation.remediation_evidence_hash = evidence.hash;
  const observed = await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: action.state_hash });
  next.phase = "committed"; next.remediation.stage = "committed"; const committed = await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree, expectedCurrentHash: hashRunState(observed.run) });
  next.phase = "revalidating"; next.remediation.stage = "revalidating"; next.remediation.revalidation.jobs ||= {}; next.remediation.revalidation.jobs.canonical ||= newPostPrJob("canonical", next.remediation.attempt);
  await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree, expectedCurrentHash: hashRunState(committed.run) });
  return { run_id: run.run_id, action: "revalidating", candidate_head_sha: next.remediation.candidate_head_sha, route: next.remediation.route };
}

async function terminalLaneViolation(runDir, run, opts, reason, paths) {
  const path = paths[0] || "unknown";
  const next = cloneJson(run.post_pr);
  next.phase = "changes-observed"; next.remediation.stage = "changes-observed"; next.remediation.changes = { paths: paths.length ? paths : [path], tree_hash: null };
  const persisted = await transitionPostPrState(runDir, next, opts);
  const current = persisted.run;
  return postPrTerminal(runDir, current, "needs-human", "post-pr-path-lane-violation", { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(current) }, {}, { schema_version: 1, kind: "path-lane-violation", observed_at: timestamp(opts.now), attempt: current.post_pr.attempt, lane: current.post_pr.remediation.lane, source: "remediation-diff", violation: reason === "unsafe-change-kind" ? "unsafe-change-kind" : "outside-lane", path_b64url: Buffer.from(path).toString("base64url"), changes_hash: hashJson(current.post_pr.remediation.changes) });
}

async function completePostPrRemediation(repo, runDir, run, opts) {
  if (run.post_pr.phase === "remote-confirmed") return beginPostPrEpoch(runDir, run, opts);
  if (run.post_pr.phase === "push-pending") return reconcilePostPrPush(repo, runDir, run, opts);
  if (run.post_pr.phase === "validated") return enterAndReconcilePostPrPush(repo, runDir, run, opts);
  if (run.post_pr.phase !== "revalidating") throw new Error("complete remediation requires revalidating, validated, push-pending, or remote-confirmed phase");
  const action = await claimPostPrAction(runDir, "remediation", opts);
  const candidate = requiredStringOption(opts.headSha, "--head-sha");
  const canonical = readBoundRunJson(runDir, requiredStringOption(opts.testEvidenceRef, "--test-evidence-ref"), "evidence");
  const validatorReport = readBoundRunFile(runDir, requiredStringOption(opts.validatorReportRef, "--validator-report-ref"), "artifacts");
  const validator = readBoundRunJson(runDir, requiredStringOption(opts.validatorReviewRef, "--validator-review-ref"), "reviews");
  const security = readBoundRunJson(runDir, requiredStringOption(opts.securityReviewRef, "--security-review-ref"), "reviews");
  if (!/^[0-9a-f]{40}$/u.test(candidate) || candidate !== run.post_pr.remediation.candidate_head_sha) throw new Error("--head-sha must equal the new persisted candidate head");
  validateCanonicalEvidence(run, canonical, candidate);
  validatePanelReview(run, validator, candidate, "validator");
  validatePanelReview(run, security, candidate, "security");
  if (validator.value.report !== validatorReport.ref) throw new Error("validator review report must match --validator-report-ref");
  if (!["pass", "PASS"].includes(canonical.value.verdict) || !["GO", "GO-WITH-NITS"].includes(validator.value.verdict) || security.value.verdict !== "PASS") throw new Error("complete remediation requires canonical pass, validator GO|GO-WITH-NITS, and security PASS");
  assertPanelAffectedPathAttribution(runDir, run, validator.value.affected_paths, security.value.affected_paths);
  assertPostPrActionFresh(runDir, action);
  let next = cloneJson(run.post_pr);
  Object.assign(next.remediation.revalidation, { canonical_evidence_ref: canonical.ref, canonical_evidence_hash: canonical.hash, canonical_verdict: "pass", validator_review_ref: validator.ref, validator_review_hash: validator.hash, validator_verdict: validator.value.verdict, security_review_ref: security.ref, security_review_hash: security.hash, security_verdict: "PASS" });
  next.phase = "validated"; next.remediation.stage = "validated";
  await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree, expectedCurrentHash: action.state_hash });
  if (typeof opts.afterValidated === "function") await opts.afterValidated();
  return enterAndReconcilePostPrPush(repo, runDir, readRunFile(join(runDir, "run.json")), opts);
}

async function enterAndReconcilePostPrPush(repo, runDir, run, opts) {
  const next = cloneJson(run.post_pr);
  const candidate = next.remediation.candidate_head_sha;
  next.phase = "push-pending"; next.remediation.stage = "push-pending"; next.remediation.push = { ...next.remediation.push, status: "pending", remote_before_sha: next.remediation.baseline_head_sha, local_head_sha: candidate };
  const persisted = await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree });
  if (typeof opts.afterPushPending === "function") await opts.afterPushPending();
  return reconcilePostPrPush(repo, runDir, persisted.run, opts);
}

async function reconcilePostPrPush(repo, runDir, run, opts) {
  const next = cloneJson(run.post_pr);
  const candidate = next.remediation.candidate_head_sha;
  const push = next.remediation.push;
  const now = timestamp(opts.now);
  if (stringValue(push.next_retry_at) && Date.parse(now) < Date.parse(push.next_retry_at)) return { run_id: run.run_id, action: "push-not-due", next_retry_at: push.next_retry_at };
  if (push.consecutive_transient_errors >= next.policy.max_transient_errors && push.next_retry_at === null) return terminalPersistedPushFailure(runDir, run, opts);
  let action = await claimPostPrAction(runDir, "post-pr-push", { ...opts, expectedCurrentHash: hashRunState(run) });
  let remoteBefore;
  try {
    remoteBefore = await serializedRemoteBranchHead(repo, run, opts);
  } catch (error) {
    return persistPushFailure(runDir, run, action, "remote-head", error, opts);
  }
  assertPostPrActionFresh(runDir, action);
  let remoteAfter = remoteBefore;
  if (remoteBefore !== candidate) {
    if (remoteBefore !== next.remediation.baseline_head_sha) return postPrTerminal(runDir, readRunFile(join(runDir, "run.json")), "needs-human", "post-pr-remote-head-diverged", { ...opts, expectedCurrentHash: action.state_hash }, {}, { schema_version: 1, kind: "remote-head-diverged", observed_at: timestamp(opts.now), attempt: run.post_pr.attempt, expected_remote_sha: next.remediation.baseline_head_sha, observed_remote_sha: remoteBefore, candidate_head_sha: candidate });
    action = await claimPostPrAction(runDir, "post-pr-push", { ...opts, expectedCurrentHash: hashRunState(readRunFile(join(runDir, "run.json"))) });
    try {
      await serializedFastForwardPush(repo, run, candidate, opts);
    } catch (error) {
      return persistPushFailure(runDir, run, action, "fast-forward-push", error, opts);
    }
    if (typeof opts.afterExternalPush === "function") await opts.afterExternalPush();
    action = await claimPostPrAction(runDir, "post-pr-push", { ...opts, expectedCurrentHash: hashRunState(readRunFile(join(runDir, "run.json"))) });
    try {
      remoteAfter = await serializedRemoteBranchHead(repo, run, opts);
    } catch (error) {
      return persistPushFailure(runDir, run, action, "remote-confirmation", error, opts);
    }
    assertPostPrActionFresh(runDir, action);
  }
  if (remoteAfter !== candidate) throw new Error("post-PR push completed without confirming the candidate remote head");
  next.phase = "remote-confirmed"; next.remediation.stage = "remote-confirmed"; next.remediation.push = { ...next.remediation.push, status: "confirmed", remote_after_sha: candidate, pushed_at: timestamp(opts.now) };
  const confirmedResult = await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree, expectedCurrentHash: action.state_hash });
  if (typeof opts.afterRemoteConfirmed === "function") await opts.afterRemoteConfirmed();
  return beginPostPrEpoch(runDir, confirmedResult.run, opts);
}

async function persistPushFailure(runDir, run, action, operation, error, opts) {
  assertPostPrActionFresh(runDir, action);
  const classified = error instanceof PostPrCiError ? error : new PostPrCiError("command", "post-PR push operation failed", { cause: error });
  const next = cloneJson(run.post_pr);
  const count = next.remediation.push.consecutive_transient_errors + 1;
  const accountSwitch = classified.errorClass === "account-switch";
  const permanent = accountSwitch || !classified.transient || count >= next.policy.max_transient_errors;
  const delay = classified.rateLimited ? Math.max(600_000, classified.retryAfterMs || 0) : Math.max(classified.retryAfterMs || 0, Math.min(600_000, 60_000 * (2 ** Math.min(count - 1, 4))));
  next.remediation.push.consecutive_transient_errors = count;
  next.remediation.push.next_retry_at = permanent ? null : new Date(Date.parse(timestamp(opts.now)) + delay).toISOString();
  const errorClass = durablePushErrorClass(classified.errorClass);
  next.remediation.push.last_error = { operation, observed_at: timestamp(opts.now), error_class: errorClass, exit_code: classified.exitCode,
    classification: permanent ? accountSwitch || !classified.transient ? "permanent" : "exhausted" : "transient", error_count: count, error_limit: next.policy.max_transient_errors,
    expected_remote_sha: next.remediation.baseline_head_sha, candidate_head_sha: next.remediation.candidate_head_sha, next_retry_at: next.remediation.push.next_retry_at };
  const persisted = await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree, expectedCurrentHash: action.state_hash });
  if (permanent) return terminalPersistedPushFailure(runDir, persisted.run, opts, accountSwitch);
  return { run_id: run.run_id, action: permanent ? "push-needs-human" : "push-retry", error_class: classified.errorClass,
    error_count: persisted.run.post_pr.remediation.push.consecutive_transient_errors, next_retry_at: persisted.run.post_pr.remediation.push.next_retry_at };
}

function durablePushErrorClass(value) {
  if (value === "account-switch") return "account-auth";
  if (["timeout", "network", "rate-limit", "server", "account-auth", "permission", "not-found", "protocol", "command", "non-fast-forward"].includes(value)) return value;
  return "command";
}

async function terminalPersistedPushFailure(runDir, run, opts, accountSwitch = false) {
  const error = run.post_pr.remediation.push.last_error;
  if (!error) throw new Error("terminal push failure requires persisted last_error");
  const common = { schema_version: 1, observed_at: error.observed_at, attempt: run.post_pr.attempt, operation: error.operation, error_class: error.error_class, exit_code: error.exit_code,
    classification: error.classification, error_count: error.error_count, error_limit: error.error_limit, expected_remote_sha: error.expected_remote_sha, candidate_head_sha: error.candidate_head_sha, next_retry_at: null };
  return postPrTerminal(runDir, run, "needs-human", accountSwitch ? "post-pr-account-switch-failed" : "post-pr-push-failed", opts, {}, { ...common, kind: accountSwitch ? "account-switch-failed" : "push-failed" });
}

async function beginPostPrEpoch(runDir, run, opts) {
  const candidate = run.post_pr.remediation.candidate_head_sha;
  const next = cloneJson(run.post_pr);
  const confirmed = cloneJson(next); const startedAt = timestamp(opts.now);
  confirmed.phase = "observing"; confirmed.observation = { ...confirmed.observation, epoch: confirmed.observation.epoch + 1, expected_head_sha: candidate, started_at: startedAt, deadline_at: new Date(Date.parse(startedAt) + confirmed.policy.wait_ms).toISOString(), next_poll_at: startedAt, poll_count: 0, unchanged_count: 0, current_interval_ms: confirmed.policy.initial_poll_ms, consecutive_transient_errors: 0, last_observed_at: null, last_fingerprint: null, last_check_verdict: "not_started", last_review_verdict: confirmed.policy.review.required ? "pending" : "not_required", last_verdict: "pending", last_error: null, snapshot: null };
  const action = await claimPostPrAction(runDir, "post-pr-push", { ...opts, expectedCurrentHash: hashRunState(run) });
  await transitionPostPrState(runDir, confirmed, { ...opts, worktree: run.worktree, expectedCurrentHash: action.state_hash });
  return { run_id: run.run_id, action: "observing", epoch: confirmed.observation.epoch, expected_head_sha: candidate, repository: persistedPrIdentity(run).repository };
}

async function failPostPrRevalidation(runDir, run, opts) {
  if (run.post_pr.phase !== "revalidating") throw new Error("failed remediation requires revalidating phase");
  const action = await claimPostPrAction(runDir, "remediation", opts);
  const ref = requiredStringOption(opts.failureEvidenceRef, "--failure-evidence-ref");
  const binding = readBoundRunJson(runDir, ref, "evidence");
  const max = Number.isInteger(run.max_retries) ? run.max_retries : 3;
  const prior = run.post_pr.remediation;
  const attempt = run.post_pr.attempt + 1;
  if (binding.value.run_id !== run.run_id || binding.value.attempt !== attempt || binding.value.source !== "local-red" || binding.value.verdict !== "red"
    || binding.value.failed_head_sha !== prior.candidate_head_sha || !/^sha256:[a-f0-9]{64}$/u.test(binding.value.failure_fingerprint || "")) {
    throw new Error("local failure evidence must bind the next attempt, current candidate head, source local-red, and failure fingerprint");
  }
  assertPostPrActionFresh(runDir, action);
  if (run.post_pr.attempt >= max) return exhaustPostPr(runDir, run, { ...opts, expectedCurrentHash: action.state_hash }, binding);
  const attribution = reattributeFailure(runDir, run, binding.value);
  if (attribution.disposition !== "route") throw new Error("post-PR panel affected_paths require human ownership reconciliation");
  const remediation = newRemediation(run, attempt, binding.value.failure_fingerprint, binding, attribution);
  remediation.reason_code = "local-red";
  remediation.failed_head_sha = prior.candidate_head_sha;
  remediation.baseline_head_sha = prior.candidate_head_sha;
  await transitionPostPrFailure(runDir, { remediation }, { ...opts, expectedCurrentHash: action.state_hash });
  const current = readRunFile(join(runDir, "run.json"));
  const next = cloneJson(current.post_pr); next.phase = "remediation-planned";
  await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(current) });
  return { run_id: run.run_id, action: "remediation-planned", attempt, route: remediation.route, evidence: { ref: binding.ref, hash: binding.hash } };
}

export async function writeSteering(runId, message, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringQueued(runDir, message, opts);
  return { run_id: result.run.run_id, steering: result.steering };
}

export async function consumeSteering(runId, input, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringConsumed(runDir, input, opts);
  return { run_id: result.run.run_id, steering: result.steering };
}

export async function acknowledgeSteering(runId, input, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringAcknowledged(runDir, input, opts);
  return { run_id: result.run.run_id, steering: result.steering };
}

export async function openSteeringBoundary(runId, kind, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringBoundaryOpened(runDir, kind, opts);
  return { run_id: result.run.run_id, boundary: result.boundary };
}

export async function crossSteeringBoundary(runId, kind, token, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringBoundaryCrossed(runDir, kind, token, opts);
  return { run_id: result.run.run_id, action_claim: result.action_claim };
}

export async function acknowledgeSteeringActionStart(runId, kind, token, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringActionStarted(runDir, kind, token, opts);
  return { run_id: result.run.run_id, action: result.action };
}

export async function abortSteeringAction(runId, kind, token, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringActionAborted(runDir, kind, token, opts);
  return { run_id: result.run.run_id, action: result.action };
}

export async function establishPrePrFence(runId, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionPrePrFenceEstablished(runDir, opts);
  return { run_id: result.run.run_id, fence: result.fence };
}

export async function clearPrePrFence(runId, token, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionPrePrFenceCleared(runDir, token, opts);
  return { run_id: result.run.run_id, fence: result.fence };
}

export async function recordSteeringConflict(runId, input, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionSteeringConflict(runDir, input, opts);
  return {
    ok: result.ok,
    conflict: result.conflict,
    run_id: result.run_id,
    updated: result.updated,
    status: result.status,
    steering: result.steering,
    protected_state: result.protected_state,
    terminal_result: result.terminal_result,
  };
}

export async function cancelFactoryRun(runId, opts = {}) {
  if (!stringValue(runId)) throw new Error("factory cancel requires exactly one <run-id>");
  const target = resolveCancelRunDir(runId, opts);
  const result = await cancelProcessFromEvidence(target.runDir, { ...opts, runId: target.runId });
  if (result.status !== "cancelled") return result;
  try {
    const heartbeat = await stopHeartbeatInRunDir(target.runDir, opts);
    return { ...result, heartbeat_stopped: heartbeat?.pid === null };
  } catch (error) {
    return {
      ...result,
      ok: false,
      status: "failed-closed",
      reason: `main process is cancelled but heartbeat cleanup failed: ${renderErrorForTerminal(error)}`,
      heartbeat_stopped: false,
    };
  }
}

// A detached launch records process.json before the agent writes run.json, so
// cancel must be able to target a factory run dir that has process evidence
// but no manifest yet — otherwise a pre-manifest launch is uncancellable.
function resolveCancelRunDir(runId, opts = {}) {
  try {
    const runDir = resolveRunDir(runId, opts);
    const run = readRunFile(join(runDir, "run.json"));
    return { runDir, runId: run.run_id };
  } catch (error) {
    for (const rootPath of factoryRootsForLookup(opts.cwd || process.cwd())) {
      const candidate = resolve(rootPath, String(runId));
      if (isContainedPath(rootPath, candidate) && existsSync(join(candidate, PROCESS_EVIDENCE_FILE))) {
        return { runDir: candidate, runId: String(runId) };
      }
    }
    throw error;
  }
}

export async function recordCostUsage(runId, input, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const result = await transitionCostUsage(runDir, input, { ...opts, id: opts.entryId || opts.id });
  const entries = Array.isArray(result.cost_attribution?.entries) ? result.cost_attribution.entries : [];
  return {
    run_id: result.run.run_id,
    status: result.status,
    updated: result.updated,
    entry: entries[entries.length - 1] || null,
    cost_summary: publicCostSummaryOrNull(result.run),
  };
}

export function listRuns(opts = {}) {
  return allRunDirs(opts)
    .map((runDir) => {
      const repo = factoryRepoFromRunDir(runDir);
      const runId = basename(runDir);
      const file = join(runDir, "run.json");
      const run = tryReadPublicRun(file, { ...opts, repoRoot: repo });
      const diagnostics = run.error ? diagnoseRunDir(runDir, publicDiagnosticOptions(opts, repo)) : diagnoseRunObject(run.value, { ...publicDiagnosticOptions(opts, repo), runDir, runFile: file });
      if (run.error || diagnosticsFailClosed(diagnostics)) return invalidListRun(runId, file, diagnostics, run.error);
      return {
        run_id: run.value.run_id || runId,
        status: run.value.status || "unknown",
        gate: pendingGate(run.value),
        steering: steeringSummary(run.value),
        cost_summary: publicCostSummaryOrNull(run.value),
        review_tier: selectedReviewTier(run.value),
        post_pr: postPrSummary(run.value),
        updated_at: run.value.updated_at || null,
        path: file,
        diagnostics,
      };
    })
    .filter(Boolean)
    .sort(compareRunListItems);
}

function compareRunListItems(a, b) {
  return String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || String(b.run_id || "").localeCompare(String(a.run_id || ""));
}

export function status(runId, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const runFile = join(runDir, "run.json");
  const repo = factoryRepoFromRunDir(runDir);
  const runResult = tryReadPublicRun(runFile, { ...opts, repoRoot: repo });
  const diagnostics = runResult.error ? diagnoseRunDir(runDir, publicDiagnosticOptions(opts, repo)) : diagnoseRunObject(runResult.value, { ...publicDiagnosticOptions(opts, repo), runDir, runFile });
  if (diagnosticsFailClosed(diagnostics)) return invalidStatusEnvelope(runId, runDir, runFile, diagnostics);
  if (runResult.error) return invalidStatusEnvelope(runId, runDir, runFile, diagnostics);
  const run = runResult.value;
  return {
    run_id: run.run_id,
    schema_version: run.schema_version || run.version || null,
    mode: run.mode || null,
    status: run.status || "unknown",
    heartbeat_at: run.heartbeat_at || null,
    branch: run.branch || null,
    worktree: run.worktree || null,
    github_account: run.github_account || null,
    pending_gate: pendingGate(run),
    steering: steeringSummary(run),
    cost_summary: publicCostSummaryOrNull(run),
    gates: run.gates || {},
    pr_url: run.pr_url || null,
    review_tier: run.review_tier || null,
    post_pr: postPrSummary(run),
    terminal_result: run.terminal_result || null,
    updated_at: run.updated_at || null,
    diagnostics,
  };
}

export function heartbeatStatus(runId, opts = {}) {
  const file = heartbeatPath(resolveHeartbeatRunDir(runId, opts));
  if (!existsSync(file)) return null;
  return withHeartbeatLiveness(readHeartbeatFile(file), opts);
}

export async function startHeartbeat(runId, config = {}, opts = {}) {
  const runDir = resolveHeartbeatRunDir(runId, opts);
  const heartbeatFile = heartbeatPath(runDir);
  const phase = normalizeHeartbeatPhase(config.phase);
  const intervalMs = normalizeHeartbeatInterval(config.intervalMs);
  const startedAt = timestamp(opts.now);
  let heartbeat;

  await withRunJsonLock(runDir, async () => {
    const run = readRunFile(join(runDir, "run.json"));
    if (run.status !== "running") {
      throw new Error(`run '${run.run_id}' must be running to start a heartbeat`);
    }
    if (run.steering?.pending) throw new Error(`run '${run.run_id}' has pending steering; drain it before starting a heartbeat`);
    if (run.steering?.uncheckpointed) throw new Error(`run '${run.run_id}' has consumed steering awaiting acknowledgement`);
    if (run.steering?.action_claim) throw new Error(`run '${run.run_id}' has an action awaiting start acknowledgement`);
    if (run.steering?.pr_fence) throw new Error(`run '${run.run_id}' has an active pre-PR fence`);
    const protectedGate = pendingProtectedGate(run);
    if (protectedGate) {
      throw new Error(`run '${run.run_id}' is waiting at protected gate '${protectedGate}'`);
    }
    if (!hasInFlightHeartbeatWork(run)) {
      throw new Error(`run '${run.run_id}' has no in-flight factory work for heartbeat`);
    }
    const current = tryReadHeartbeatFile(heartbeatFile);
    if (current.error) throw new Error(`invalid heartbeat at ${heartbeatFile}: ${current.error}`);
    if (current.value && heartbeatBlocksReplacement(current.value, startedAt, opts)) {
      throw new Error(`heartbeat already active for run '${run.run_id}'`);
    }

    heartbeat = validateHeartbeatState({
      schema_version: HEARTBEAT_SCHEMA_VERSION,
      run_id: run.run_id,
      phase,
      pid: process.pid,
      identity: captureHeartbeatIdentity(process.pid, opts),
      last_tick_at: startedAt,
      interval_ms: intervalMs,
    });
    writeHeartbeatFile(heartbeatFile, heartbeat);
    writeJsonAtomic(join(runDir, "run.json"), validateRun({ ...run, heartbeat_at: startedAt }));
  }, opts);

  const runtime = createHeartbeatRuntime(runDir, heartbeat, opts);
  activeHeartbeatLoops.set(runDir, runtime);
  runtime.timer = setInterval(() => runHeartbeatTick(runtime), runtime.intervalMs);

  const current = heartbeatStatus(runId, opts);
  if (!current || current.pid !== process.pid || !current.fresh) {
    throw new Error(`heartbeat failed to start for run '${heartbeat.run_id}'`);
  }
  return current;
}

export async function stopHeartbeat(runId, config = {}, opts = {}) {
  const runDir = resolveHeartbeatRunDir(runId, opts);
  return stopHeartbeatInRunDir(runDir, opts);
}

export async function stopHeartbeatInRunDir(runDir, opts = {}) {
  const heartbeatFile = heartbeatPath(runDir);
  if (!existsSync(heartbeatFile)) return null;
  const stoppedAt = timestamp(opts.now);
  let stopped = null;

  await withRunJsonLock(runDir, async () => {
    const current = tryReadHeartbeatFile(heartbeatFile);
    if (current.error) throw new Error(`invalid heartbeat at ${heartbeatFile}: ${current.error}`);
    if (!current.value) {
      stopped = null;
      return;
    }

    const heartbeat = current.value;
    stopActiveHeartbeatLoop(runDir);
    if (heartbeat.pid && heartbeat.pid !== process.pid) {
      const ownership = heartbeatProcessOwnership(heartbeat, opts);
      if (ownership !== "live" && ownership !== "absent") {
        throw new Error(`heartbeat ownership is ${ownership}; refusing to clear foreign pid ${heartbeat.pid}`);
      }
      if (ownership === "live") (opts.signalFn || process.kill)(heartbeat.pid, "SIGTERM");
    }
    stopped = validateHeartbeatState({ ...heartbeat, pid: null, last_tick_at: stoppedAt });
    writeHeartbeatFile(heartbeatFile, stopped);
  });

  return stopped ? withHeartbeatLiveness(stopped, opts) : null;
}

export function writeGateAnswer(runId, gate, answer, opts = {}) {
  const gateName = requireSafeGateName(gate, "gate");
  if (!answer) throw new Error("answer is required: approve, changes: ..., or stop");
  const runDir = resolveGateAnswerRunDir(runId, opts);
  const run = readRunFile(join(runDir, "run.json"));
  const pending = pendingGate(run);
  if (pending && gateName !== pending) throw new Error(`gate '${gateName}' is not pending; current pending gate is '${pending}'`);
  if (!pending) throw new Error("run has no pending gate");
  const gateState = run.gates?.[gateName];
  const target = resolveGateAnswerTarget(runDir, gateName, gateState);
  const normalized = normalizeAnswer(answer);
  writeGateAnswerFileAtomically(target.gatesDir, target.answerPath, normalized + "\n");
  return { run_id: run.run_id, gate: gateName, answer: normalized, path: target.answerPath };
}

export async function persistFactoryRunCreatedEnv(runId, opts = {}) {
  return persistFactoryRunEnv(runId, "created", opts);
}

export async function persistFactoryRunResumeEnv(runId, opts = {}) {
  return persistFactoryRunEnv(runId, "resume", opts);
}

export async function recordReviewDispatchProvenance(runId, input, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const agent = String(input?.agent || "").trim();
  const subject = String(input?.subject || "").trim();
  const attempt = Number(input?.attempt);
  const promptHash = String(input?.promptHash || "").trim();
  const promptBytes = Number(input?.promptBytes);
  if (!new Set(["work-reviewer", "implementation-validator", "security-reviewer"]).has(agent)) throw new Error("review provenance requires a known review agent");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(subject) || subject.includes("..")) throw new Error("review provenance requires a bounded safe --subject");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("review provenance requires a positive --attempts value");
  if (!/^sha256:[a-f0-9]{64}$/u.test(promptHash)) throw new Error("review provenance requires --hash sha256:<64-lowercase-hex>");
  if (!Number.isInteger(promptBytes) || promptBytes < 0) throw new Error("review provenance requires non-negative --prompt-bytes");
  return withRunJsonLock(runDir, async () => {
    const runPath = join(runDir, "run.json");
    const current = readRunFile(runPath);
    assertRunJsonWriterAllowed(current, "provenance review-dispatch");
    const event = await collectEffectiveProvenance({
      repo: factoryRepoFromRunDir(runDir),
      gitCwd: provenanceGitCwd(factoryRepoFromRunDir(runDir), current.worktree),
      pluginOptions: opts.pluginOptions,
      event: "review-dispatch",
      agent,
      subject,
      attempt,
      promptHash,
      promptBytes,
      now: opts.now,
    });
    const existing = current.provenance && typeof current.provenance === "object" ? current.provenance : {};
    const reviewDispatches = Array.isArray(existing.review_dispatches) ? existing.review_dispatches : [];
    const next = validateRun({
      ...current,
      provenance: {
        schema_version: 1,
        created: existing.created || null,
        last_resumed: existing.last_resumed || null,
        resume_count: nonNegativeInteger(existing.resume_count),
        review_dispatches: [...reviewDispatches, event],
      },
    });
    writeJsonAtomic(runPath, next);
    return event;
  }, opts);
}

export function latestRunId(opts = {}) {
  const runs = listRuns(opts);
  return runs[0]?.run_id || null;
}

export function watchRun(runId, opts = {}) {
  const requestedInterval = Number(opts.intervalMs ?? 2000);
  const intervalMs = Number.isFinite(requestedInterval) && requestedInterval >= 100 ? Math.floor(requestedInterval) : 2000;
  let last = "";
  let timer = null;
  let stopped = false;
  const emit = (value) => {
    const current = serializeTerminalJson(projectFactoryWatchValue(value));
    if (current !== last) {
      last = current;
      console.log(current);
    }
  };
  const finish = (value) => {
    emit(value);
    stopped = true;
    if (timer) clearInterval(timer);
  };
  const print = () => {
    try {
      emit(typeof opts.watchValueFn === "function" ? opts.watchValueFn() : opts.all ? listRuns(opts) : status(runId, opts));
    } catch (error) {
      if (/run not found|no factory runs found/u.test(error.message)) {
        finish({ run_id: runId || null, status: "removed", error: error.message });
        return;
      }
      emit({ run_id: runId || null, status: "error", error: error.message });
    }
  };
  print();
  if (stopped) return null;
  timer = setInterval(print, intervalMs);
  setTimeout(() => {
    if (!stopped) print();
  }, 0);
  return timer;
}

export function validateState(runId, opts = {}) {
  const runDirs = runId ? [resolveRunDir(runId, opts)] : allRunDirs(opts);
  const runs = runDirs.map((dir) => {
    const repo = factoryRepoFromRunDir(dir);
    const diagnostics = diagnoseRunDir(dir, publicDiagnosticOptions(opts, repo));
    const validation = validateRunDir(dir, { ...opts, repoRoot: repo });
    return {
      run_dir: dir,
      ...validation,
      ok: validation.ok && diagnostics.status !== "error",
      diagnostics,
    };
  });
  return { ok: runs.every((item) => item.ok), runs };
}

function publicDiagnosticOptions(opts, repo) {
  return { ...opts, repoRoot: repo };
}

function publicCostSummaryOrNull(run) {
  if (!run?.cost_attribution) return null;
  try {
    const summary = publicCostAttributionSummary(run);
    return summary.entry_count > 0 ? summary : null;
  } catch {
    return null;
  }
}

// A failed detached launch must not strand a pre-manifest run dir: only remove
// it when it never gained a manifest or process evidence (nothing to recover).
function removeFailedDetachedLaunchDir(scopedRunDir) {
  if (!scopedRunDir) return;
  if (existsSync(join(scopedRunDir, "run.json")) || existsSync(join(scopedRunDir, PROCESS_EVIDENCE_FILE))) return;
  rmSync(scopedRunDir, { recursive: true, force: true });
}

// A detached launch can die before the agent writes run.json, leaving a run
// dir holding only process evidence and logs. Such dirs are invisible to the
// normal cleanup path (which requires a manifest); remove them here once their
// process is no longer recorded as running (factory cancel confirms that).
function cleanupPreManifestRunDir(runId, opts = {}) {
  for (const rootPath of factoryRootsForLookup(opts.cwd || process.cwd())) {
    const candidate = resolve(rootPath, String(runId));
    if (!isContainedPath(rootPath, candidate)) continue;
    if (existsSync(join(candidate, "run.json")) || !existsSync(join(candidate, PROCESS_EVIDENCE_FILE))) continue;
    const evidence = readProcessEvidence(candidate, { runId: String(runId) });
    if (evidence.ok && evidence.evidence.state === "running") {
      throw new Error(`pre-manifest run '${runId}' has running process evidence; run 'factory cancel ${runId}' first`);
    }
    // The pre-manifest exception is for a launch KNOWN dead: valid evidence in a
    // non-running state. Malformed, unreadable, or mismatched evidence does not
    // establish liveness either way, so fail closed instead of deleting a
    // directory whose process may still be alive; --force is the explicit
    // operator override.
    if (!evidence.ok && !opts.force) {
      throw new Error(`pre-manifest run '${runId}' has invalid process evidence (${evidence.reason}); liveness cannot be established — verify the process is dead, then rerun with --force`);
    }
    if (!opts.dryRun) rmSync(candidate, { recursive: true, force: true });
    return {
      run_id: String(runId),
      status: "pre-manifest",
      dry_run: Boolean(opts.dryRun),
      removed_worktrees: [],
      skipped_worktrees: [],
      deleted_branches: [],
      skipped_branches: [],
      removed_run_dir: !opts.dryRun,
      run_dir: candidate,
    };
  }
  return null;
}

function invalidListRun(runId, file, diagnostics, error) {
  return {
    run_id: runId,
    status: "invalid",
    gate: null,
    steering: null,
    cost_summary: null,
    review_tier: null,
    updated_at: null,
    path: file,
    error: error || diagnostics.summary || "run diagnostics failed closed",
    diagnostics,
  };
}

function invalidStatusEnvelope(runId, runDir, runFile, diagnostics) {
  return {
    run_id: fallbackRunId(runId, runDir),
    status: "invalid",
    path: runFile,
    cost_summary: null,
    error: diagnostics.summary || "run diagnostics failed closed",
    diagnostics,
  };
}

function diagnosticsFailClosed(diagnostics) {
  return Array.isArray(diagnostics?.items)
    && diagnostics.items.some((item) => FAIL_CLOSED_DIAGNOSTIC_CONDITIONS.has(item?.condition));
}

function fallbackRunId(runId, runDir) {
  if (typeof runId === "string" && runId.trim() && !isAbsolute(runId) && !runId.includes("/") && !runId.includes("\\")) return runId.trim();
  return basename(runDir);
}

export async function cleanupRun(runId, opts = {}) {
  let runDir;
  try {
    runDir = resolveRunDir(runId, opts);
  } catch (error) {
    const preManifest = cleanupPreManifestRunDir(runId, opts);
    if (preManifest) return preManifest;
    throw error;
  }
  const repo = factoryRepoFromRunDir(runDir);
  if (!insideFactoryRoot(repo, runDir)) {
    throw new Error(`cleanup run directory must be inside .opencode/factory: ${runDir}`);
  }
  return withRunJsonLock(runDir, async () => {
    const run = readRunFile(join(runDir, "run.json"));
    if (!TERMINAL_STATUSES.has(run.status) && !opts.force) {
      throw new Error(`run '${run.run_id}' is ${run.status}; cleanup requires terminal status or --force`);
    }
    const heartbeat = tryReadHeartbeatFile(heartbeatPath(runDir));
    if (heartbeat.error) throw new Error(`invalid heartbeat at ${heartbeatPath(runDir)}: ${heartbeat.error}`);
    if (heartbeat.value && heartbeatBlocksReplacement(heartbeat.value, timestamp(opts.now), opts) && !opts.force) {
      throw new Error(`run '${run.run_id}' has a fresh heartbeat; cleanup requires --force`);
    }
    if (opts.dryRun) return cleanupRunLocked(runDir, run, { ...opts, repo, mode: "single-run" });
    const acquireFence = opts.acquireLaunchFence || acquireLaunchFence;
    const fence = acquireFence(runDir, "cleanup", opts);
    if (!fence?.acquired) throw new Error(`run '${run.run_id}' has active launch coordination; cleanup refused`);
    try {
      const claim = (opts.inspectLaunchClaimFn || inspectLaunchClaim)(runDir, { ...opts, runId: run.run_id });
      if (!claim.missing) throw new Error(`run '${run.run_id}' has launch ownership evidence; cleanup refused`);
      if (heartbeat.value && opts.force) stopHeartbeatForCleanup(runDir, heartbeat.value, opts);
      return cleanupRunLocked(runDir, run, { ...opts, repo, mode: "single-run" });
    } finally {
      const releaseFenceFn = opts.releaseLaunchFence || releaseLaunchFence;
      if (!releaseFenceFn(fence)) throw new Error("cleanup launch fence release failed");
    }
  }, opts);
}

export function collectCleanupTargets(run) {
  return {
    worktrees: cleanupWorktrees(run),
    branches: cleanupBranches(run),
  };
}

// The caller owns the run-json lock. Public single-run cleanup uses the legacy
// result contract; sweep mode uses compare-and-delete and retains the run
// directory whenever a target operation fails.
export function cleanupRunLocked(runDir, run, opts = {}) {
  const repo = opts.repo || factoryRepoFromRunDir(runDir);
  if (!insideFactoryRoot(repo, runDir)) {
    throw new Error(`cleanup run directory must be inside .opencode/factory: ${runDir}`);
  }
  const targets = collectCleanupTargets(run);
  if (opts.mode !== "single-run") return cleanupSweepTargetsLocked(repo, runDir, targets, opts);

  const result = {
    run_id: run.run_id,
    status: run.status,
    dry_run: Boolean(opts.dryRun),
    removed_worktrees: [],
    skipped_worktrees: [],
    deleted_branches: [],
    skipped_branches: [],
    removed_run_dir: false,
    run_dir: runDir,
  };

  for (const worktree of targets.worktrees) removeWorktree(repo, worktree, result, opts);
  for (const branch of targets.branches) deleteBranch(repo, branch, result, opts);

  if (!opts.dryRun) rmSync(runDir, { recursive: true, force: true });
  result.removed_run_dir = !opts.dryRun;
  return result;
}

export class CleanupRunUnexpectedError extends Error {
  constructor(cause, cleanup) {
    super("unexpected failure after cleanup mutation began", { cause });
    this.name = "CleanupRunUnexpectedError";
    this.code = "FAILED_CLEANUP_UNEXPECTED";
    this.cleanup = cleanup;
  }
}

export class CleanupRunChangedError extends Error {
  constructor() {
    super("cleanup evidence changed before mutation began");
    this.name = "CleanupRunChangedError";
    this.code = "CLEANUP_EVIDENCE_CHANGED";
  }
}

function cleanupSweepTargetsLocked(repo, runDir, targets, opts) {
  if (opts.force || opts.dryRun) throw new Error("sweep cleanup must be lock-held execution without force or dry-run");
  try {
    assertExpectedRunHash(runDir, opts.expectedRunHash);
  } catch {
    throw new CleanupRunChangedError();
  }
  const expectedHeads = normalizeExpectedBranchHeads(opts.expectedBranchHeads);
  const baseRef = opts.fetchedBaseRef || opts.fetchedBase?.ref || null;
  const runDirRemover = opts.removeRunDir || ((path) => rmSync(path, { recursive: true, force: true }));
  const worktreeIdentity = opts.checkWorktreeIdentity || checkWorktreeIdentity;
  const resolvePhysicalPath = opts.physicalPath || physicalPath;
  const gitRunner = opts.gitRunner || git;
  const phaseHook = typeof opts.phaseHook === "function" ? opts.phaseHook : () => {};
  const assertMutationAuthorized = typeof opts.assertMutationAuthorized === "function" ? opts.assertMutationAuthorized : () => {};
  const quarantinePath = typeof opts.quarantinePath === "function" ? opts.quarantinePath : (path, kind) => join(dirname(path), `.${basename(path)}.cleanup-${kind}-${randomUUID()}`);
  const expectedWorktrees = normalizeExpectedWorktreeIdentities(opts.expectedWorktrees);
  const cleanup = {
    worktrees: [],
    branches: [],
    run_dir: { path: runDir, outcome: "retained", reason_code: null },
  };
  const failedWorktreeBranches = new Set();
  let mutationStarted = false;

  const changed = () => {
    if (!mutationStarted) throw new CleanupRunChangedError();
  };

  const unexpected = (error) => {
    if (!mutationStarted) throw error;
    cleanup.run_dir.outcome = "retained";
    cleanup.run_dir.reason_code = "RETAINED_AFTER_PARTIAL_FAILURE";
    throw new CleanupRunUnexpectedError(error, cleanup);
  };

  const worktrees = targets.worktrees
    .map((entry) => sweepWorktreeTarget(repo, entry, resolvePhysicalPath, opts.expectedWorktreeRoot, expectedWorktrees.get(String(entry.worktree))))
    .sort((a, b) => Buffer.from(a.physical_path || a.recorded_path).compare(Buffer.from(b.physical_path || b.recorded_path)));
  for (const target of worktrees) {
    const record = {
      recorded_path: target.recorded_path,
      physical_path: target.physical_path,
      branch: null,
      outcome: "failed",
      reason_code: "FAILED_CLEANUP_WORKTREE",
    };
    cleanup.worktrees.push(record);
    let quarantine = null;
    let movedToQuarantine = false;
    const restoreWorktree = () => {
      if (!movedToQuarantine) return;
      record.physical_path = restoreQuarantinedWorktree(repo, target, quarantine, {
        gitRunner,
      });
      movedToQuarantine = record.physical_path !== target.physical_path;
    };
    try {
      phaseHook("before-worktree-remove", { ...target });
      const expectedHead = expectedHeads.get(target.branch) || null;
      const revalidated = revalidateSweepWorktree(repo, target, expectedHead, {
        gitRunner,
        resolvePhysicalPath,
        worktreeIdentity,
        expectedWorktreeRoot: opts.expectedWorktreeRoot,
        expectedWorktree: target.expected_worktree,
      });
      if (!revalidated) {
        changed();
        if (target.branch) failedWorktreeBranches.add(target.branch);
        continue;
      }
      phaseHook("after-worktree-final-validation", { ...target });
      assertMutationAuthorized();
      quarantine = quarantinePath(target.physical_path, "worktree");
      let proc;
      const mutationWasStarted = mutationStarted;
      mutationStarted = true;
      try {
        proc = gitRunner(repo, ["worktree", "move", target.physical_path, quarantine]);
      } catch (error) {
        unexpected(error);
      }
      if (proc?.cleanupEvidenceChanged) { mutationStarted = mutationWasStarted; changed(); continue; }
      if (!proc.ok) {
        if (target.branch) failedWorktreeBranches.add(target.branch);
        continue;
      }
      movedToQuarantine = true;
      if (!matchesAuthorizedDirectoryAt(quarantine, target.expected_worktree)
        || !revalidateMovedSweepWorktree(repo, quarantine, target.branch, expectedHead, { gitRunner, worktreeIdentity, resolvePhysicalPath })) {
        restoreWorktree();
        if (target.branch) failedWorktreeBranches.add(target.branch);
        continue;
      }
      try {
        assertMutationAuthorized();
      } catch (error) {
        restoreWorktree();
        throw error;
      }
      try {
        proc = gitRunner(repo, ["worktree", "remove", "--force", quarantine]);
      } catch (error) {
        unexpected(error);
      }
      if (proc?.cleanupEvidenceChanged) unexpected(new CleanupRunChangedError());
      if (!proc.ok) {
        restoreWorktree();
        if (target.branch) failedWorktreeBranches.add(target.branch);
        continue;
      }
      movedToQuarantine = false;
      record.outcome = "removed";
      record.reason_code = null;
    } catch (error) {
      restoreWorktree();
      if (error instanceof CleanupRunUnexpectedError) throw error;
      unexpected(error);
    }
  }

  for (const branch of [...targets.branches].map((value) => String(value).trim()).filter(Boolean).sort(compareUtf8)) {
    const expectedHead = expectedHeads.get(branch) || null;
    const record = { name: branch, expected_head: expectedHead, outcome: "failed", reason_code: "FAILED_CLEANUP_BRANCH" };
    cleanup.branches.push(record);
    if (failedWorktreeBranches.has(branch)) {
      record.outcome = "not-attempted";
      continue;
    }
    if (!resolveCleanupBranchPermission(branch).allowed || !expectedHead || !baseRef) { changed(); continue; }
    try {
      const resolvedHead = gitRunner(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
      if (!resolvedHead.ok || resolvedHead.stdout.trim() !== expectedHead) { changed(); continue; }
      const ancestry = gitRunner(repo, ["merge-base", "--is-ancestor", expectedHead, baseRef]);
      if (!ancestry.ok) { changed(); continue; }
      phaseHook("before-branch-delete", { branch, expected_head: expectedHead, base_ref: baseRef });
      if (!revalidateSweepBranch(repo, branch, expectedHead, baseRef, gitRunner)) { changed(); continue; }
      phaseHook("after-branch-final-validation", { branch, expected_head: expectedHead, base_ref: baseRef });
      assertMutationAuthorized();
      let proc;
      const mutationWasStarted = mutationStarted;
      mutationStarted = true;
      try {
        proc = gitRunner(repo, ["update-ref", "-d", `refs/heads/${branch}`, expectedHead]);
      } catch (error) {
        unexpected(error);
      }
      if (proc?.cleanupEvidenceChanged) { mutationStarted = mutationWasStarted; changed(); continue; }
      if (!proc.ok) continue;
      record.outcome = "deleted";
      record.reason_code = null;
    } catch (error) {
      if (error instanceof CleanupRunUnexpectedError) throw error;
      unexpected(error);
    }
  }

  const targetFailed = cleanup.worktrees.some((item) => item.outcome === "failed")
    || cleanup.branches.some((item) => item.outcome !== "deleted");
  if (targetFailed) {
    cleanup.run_dir.reason_code = "RETAINED_AFTER_PARTIAL_FAILURE";
    return cleanup;
  }
  try {
    phaseHook("before-run-dir-remove", { path: runDir });
  } catch (error) {
    unexpected(error);
  }
  if (!revalidateSweepRunDirectory(runDir, opts.expectedRunHash, opts.expectedRunDirectory)) {
    changed();
    cleanup.run_dir.outcome = "failed";
    cleanup.run_dir.reason_code = "FAILED_CLEANUP_RUN_DIR";
    return cleanup;
  }
  phaseHook("after-run-dir-final-validation", { path: runDir });
  assertMutationAuthorized();
  const quarantine = quarantinePath(opts.expectedRunDirectory.physical_path, "run");
  let movedToQuarantine = false;
  try {
    renameSync(runDir, quarantine);
    movedToQuarantine = true;
    if (!matchesAuthorizedRunDirectoryAt(quarantine, opts.expectedRunHash, opts.expectedRunDirectory)) {
      try { renameSync(quarantine, runDir); movedToQuarantine = false; } catch (error) { mutationStarted = true; unexpected(error); }
      changed();
    }
    mutationStarted = true;
    runDirRemover(quarantine);
    movedToQuarantine = false;
    cleanup.run_dir.outcome = "removed";
  } catch {
    if (movedToQuarantine) {
      cleanup.run_dir.path = restoreQuarantinedRunDirectory(runDir, quarantine, opts.expectedRunDirectory);
    }
    cleanup.run_dir.outcome = "failed";
    cleanup.run_dir.reason_code = "FAILED_CLEANUP_RUN_DIR";
  }
  return cleanup;
}

function restoreQuarantinedWorktree(repo, target, quarantine, opts) {
  if (!stringValue(quarantine) || !matchesAuthorizedDirectoryAt(quarantine, target.expected_worktree)) return quarantine || target.physical_path;
  try {
    if (existsSync(target.physical_path)) return quarantine;
    const restored = opts.gitRunner(repo, ["worktree", "move", quarantine, target.physical_path]);
    if (!restored?.ok) return quarantine;
    return matchesAuthorizedDirectoryAt(target.physical_path, target.expected_worktree) ? target.physical_path : quarantine;
  } catch {
    return quarantine;
  }
}

function restoreQuarantinedRunDirectory(runDir, quarantine, expectedDirectory) {
  if (!matchesAuthorizedDirectoryAt(quarantine, expectedDirectory)) {
    return matchesAuthorizedOriginalRunDirectory(runDir, expectedDirectory) ? runDir : quarantine;
  }
  try {
    if (existsSync(runDir)) return quarantine;
    renameSync(quarantine, runDir);
    return matchesAuthorizedOriginalRunDirectory(runDir, expectedDirectory) ? runDir : quarantine;
  } catch {
    return quarantine;
  }
}

function matchesAuthorizedOriginalRunDirectory(runDir, expectedDirectory) {
  try {
    const entry = lstatSync(runDir);
    return !entry.isSymbolicLink() && entry.isDirectory()
      && realpathSync(runDir) === expectedDirectory.physical_path
      && String(entry.dev) === expectedDirectory.device
      && String(entry.ino) === expectedDirectory.inode;
  } catch {
    return false;
  }
}

function revalidateMovedSweepWorktree(repo, path, branch, expectedHead, opts) {
  const identity = opts.worktreeIdentity(repo, path, { branch, head: expectedHead });
  if (!identity.ok || identity.worktree !== path) return false;
  const registered = registeredWorktrees(repo, opts.gitRunner);
  if (!registered.ok) return false;
  return registered.entries.some((entry) => {
    try {
      return opts.resolvePhysicalPath(entry.path) === path && entry.branch === branch && entry.head === expectedHead && !entry.bare && !entry.detached;
    } catch {
      return false;
    }
  });
}

function matchesAuthorizedDirectoryAt(path, expected) {
  if (!expected || !stringValue(expected.device) || !stringValue(expected.inode)) return false;
  try {
    const entry = lstatSync(path);
    return !entry.isSymbolicLink() && entry.isDirectory() && realpathSync(path) === path
      && String(entry.dev) === expected.device && String(entry.ino) === expected.inode;
  } catch {
    return false;
  }
}

function matchesAuthorizedRunDirectoryAt(path, expectedRunHash, expectedDirectory) {
  return matchesAuthorizedDirectoryAt(path, expectedDirectory)
    && sha256File(join(path, "run.json")) === expectedRunHash;
}

function sweepWorktreeTarget(repo, entry, resolvePhysicalPath = physicalPath, expectedWorktreeRoot = null, expectedWorktree = null) {
  const recordedPath = String(entry.worktree);
  const resolved = resolve(repo, recordedPath);
  if (!validSweepWorktreeRoot(repo, expectedWorktreeRoot) || !insideWorktreeRoot(repo, resolved) || !existsSync(resolved)) {
    return { recorded_path: recordedPath, physical_path: resolved, branch: entry.branch || null, expected_worktree: expectedWorktree, valid: false };
  }
  try {
    const physical = resolvePhysicalPath(resolved);
    if (!insideDirectory(expectedWorktreeRoot.physical_path, physical)) return { recorded_path: recordedPath, physical_path: physical, branch: entry.branch || null, expected_worktree: expectedWorktree, valid: false };
    return { recorded_path: recordedPath, physical_path: physical, branch: entry.branch || null, expected_worktree: expectedWorktree, valid: true };
  } catch {
    return { recorded_path: recordedPath, physical_path: resolved, branch: entry.branch || null, expected_worktree: expectedWorktree, valid: false };
  }
}

function revalidateSweepWorktree(repo, authorized, expectedHead, opts) {
  if (!authorized.valid || !authorized.branch || !expectedHead) return false;
  const current = sweepWorktreeTarget(repo, { worktree: authorized.recorded_path, branch: authorized.branch }, opts.resolvePhysicalPath, opts.expectedWorktreeRoot, opts.expectedWorktree);
  if (!current.valid || current.physical_path !== authorized.physical_path) return false;
  if (!matchesAuthorizedWorktreeDirectory(current.physical_path, opts.expectedWorktree)) return false;
  const identity = opts.worktreeIdentity(repo, current.physical_path, { branch: authorized.branch, head: expectedHead });
  if (!identity.ok || identity.worktree !== current.physical_path) return false;
  const registered = registeredWorktrees(repo, opts.gitRunner);
  if (!registered.ok) return false;
  const entry = registered.entries.find((item) => {
    try {
      return opts.resolvePhysicalPath(item.path) === current.physical_path;
    } catch {
      return false;
    }
  });
  if (!entry || entry.branch !== authorized.branch || entry.head !== expectedHead || entry.bare || entry.detached) return false;
  const finalTarget = sweepWorktreeTarget(repo, { worktree: authorized.recorded_path, branch: authorized.branch }, opts.resolvePhysicalPath, opts.expectedWorktreeRoot, opts.expectedWorktree);
  return finalTarget.valid
    && finalTarget.physical_path === authorized.physical_path
    && matchesAuthorizedWorktreeDirectory(finalTarget.physical_path, opts.expectedWorktree);
}

function matchesAuthorizedWorktreeDirectory(path, expected) {
  if (!expected || expected.state !== "verified" || expected.physical_path !== path || !stringValue(expected.device) || !stringValue(expected.inode)) return false;
  try {
    const entry = lstatSync(path);
    return !entry.isSymbolicLink()
      && entry.isDirectory()
      && realpathSync(path) === expected.physical_path
      && String(entry.dev) === expected.device
      && String(entry.ino) === expected.inode;
  } catch {
    return false;
  }
}

function validSweepWorktreeRoot(repo, expected) {
  if (!expected || expected.state !== "valid") return false;
  const logical = resolve(repo, ".opencode", "worktrees");
  if (expected.logical_path !== logical) return false;
  try {
    const entry = lstatSync(logical);
    return !entry.isSymbolicLink() && entry.isDirectory()
      && realpathSync(logical) === expected.physical_path
      && String(entry.dev) === expected.device
      && String(entry.ino) === expected.inode;
  } catch {
    return false;
  }
}

function revalidateSweepBranch(repo, branch, expectedHead, baseRef, gitRunner) {
  const head = gitRunner(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (!head.ok || head.stdout.trim() !== expectedHead) return false;
  if (!gitRunner(repo, ["merge-base", "--is-ancestor", expectedHead, baseRef]).ok) return false;
  return !branchIsCheckedOut(repo, branch, gitRunner);
}

function revalidateSweepRunDirectory(runDir, expectedRunHash, expectedDirectory) {
  try {
    const entry = lstatSync(runDir);
    return expectedDirectory?.kind === "directory"
      && !entry.isSymbolicLink()
      && entry.isDirectory()
      && realpathSync(runDir) === expectedDirectory.physical_path
      && String(entry.dev) === expectedDirectory.device
      && String(entry.ino) === expectedDirectory.inode
      && sha256File(join(runDir, "run.json")) === expectedRunHash;
  } catch {
    return false;
  }
}

function branchIsCheckedOut(repo, branch, gitRunner) {
  const registered = registeredWorktrees(repo, gitRunner);
  if (!registered.ok) return true;
  return registered.entries.some((entry) => entry.branch === branch);
}

function registeredWorktrees(repo, gitRunner) {
  const result = gitRunner(repo, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return { ok: false, entries: [] };
  return { ok: true, entries: parseWorktreeListPorcelain(result.stdout) };
}

function assertExpectedRunHash(runDir, expectedRunHash) {
  if (!stringValue(expectedRunHash)) throw new Error("sweep cleanup requires an expected run hash");
  if (sha256File(join(runDir, "run.json")) !== expectedRunHash) throw new Error("run manifest changed before cleanup");
}

function normalizeExpectedBranchHeads(value) {
  if (value instanceof Map) return new Map(value);
  if (Array.isArray(value)) return new Map(value.map((entry) => [entry.name, entry.expected_head]));
  if (value && typeof value === "object") return new Map(Object.entries(value));
  return new Map();
}

function normalizeExpectedWorktreeIdentities(value) {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.map((entry) => [entry.recorded_path, entry]));
}

function compareUtf8(a, b) {
  return Buffer.from(a).compare(Buffer.from(b));
}

function stopHeartbeatForCleanup(runDir, heartbeat, opts = {}) {
  stopActiveHeartbeatLoop(runDir);
  if (heartbeat.pid && heartbeat.pid !== process.pid) {
    const liveness = heartbeatProcessLiveness(heartbeat.pid, opts);
    if (liveness === "indeterminate") throw new Error(`heartbeat ownership is ${liveness}; refusing to clear foreign pid ${heartbeat.pid}`);
    if (liveness === "live") process.kill(heartbeat.pid, "SIGTERM");
  }
  writeHeartbeatFile(heartbeatPath(runDir), validateHeartbeatState({ ...heartbeat, pid: null, last_tick_at: timestamp(opts.now) }));
}

function cleanupWorktrees(run) {
  const entries = [];
  if (run.worktree) entries.push({ worktree: run.worktree, branch: run.branch });
  if (Array.isArray(run.slices)) {
    for (const slice of run.slices) if (slice?.worktree) entries.push({ worktree: slice.worktree, branch: slice.branch, slice_id: slice.id });
  }
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.worktree)) return false;
    seen.add(entry.worktree);
    return true;
  });
}

function cleanupBranches(run) {
  return [...new Set([run.branch, ...(Array.isArray(run.slices) ? run.slices.map((slice) => slice?.branch) : [])].filter(Boolean))];
}

function removeWorktree(repo, worktreeEntry, result, opts) {
  const worktree = worktreeEntry.worktree;
  const resolved = resolve(repo, worktree);
  if (!insideWorktreeRoot(repo, resolved)) {
    result.skipped_worktrees.push({ worktree, reason: "outside .opencode/worktrees" });
    return;
  }
  if (!existsSync(resolved)) {
    result.skipped_worktrees.push({ worktree: resolved, reason: "missing" });
    return;
  }
  const physicalWorktree = physicalPath(resolved);
  const worktreePermission = resolveCleanupWorktreePermission(repo, physicalWorktree, worktreeEntry.branch);
  if (!worktreePermission.allowed) {
    result.skipped_worktrees.push({ worktree: physicalWorktree, reason: worktreePermission.reason });
    return;
  }
  if (!opts.dryRun) {
    const proc = git(repo, ["worktree", "remove", "--force", physicalWorktree]);
    if (!proc.ok) {
      result.skipped_worktrees.push({ worktree: physicalWorktree, reason: (proc.stderr || proc.stdout || "git worktree remove failed").trim() });
      return;
    }
  }
  result.removed_worktrees.push(physicalWorktree);
}

function deleteBranch(repo, branch, result, opts) {
  const name = String(branch).trim();
  if (!name) return;
  const branchPermission = resolveCleanupBranchPermission(name);
  if (!branchPermission.allowed) {
    result.skipped_branches.push({ branch: name, reason: branchPermission.reason });
    return;
  }
  const current = git(repo, ["branch", "--show-current"]).stdout.trim();
  if (current === name) {
    result.skipped_branches.push({ branch: name, reason: "current branch" });
    return;
  }
  const exists = git(repo, ["show-ref", "--verify", `refs/heads/${name}`]);
  if (!exists.ok) {
    result.skipped_branches.push({ branch: name, reason: "missing" });
    return;
  }
  const deleteFlag = opts.force ? "-D" : "-d";
  if (opts.dryRun && deleteFlag === "-d" && !branchMergedIntoHead(repo, name)) {
    result.skipped_branches.push({ branch: name, reason: "not merged; use --force to delete" });
    return;
  }
  if (!opts.dryRun) {
    const proc = git(repo, ["branch", deleteFlag, "--", name]);
    if (!proc.ok) {
      result.skipped_branches.push({ branch: name, reason: (proc.stderr || proc.stdout || "git branch delete failed").trim() });
      return;
    }
  }
  result.deleted_branches.push(name);
}

function branchMergedIntoHead(repo, branch) {
  return git(repo, ["merge-base", "--is-ancestor", branch, "HEAD"]).ok;
}

function insideFactoryRoot(repo, runDir) {
  return insideDirectory(resolve(repo, ".opencode", "factory"), runDir);
}

function insideWorktreeRoot(repo, worktree) {
  return insideDirectory(resolve(repo, ".opencode", "worktrees"), worktree);
}

function insideDirectory(parent, child) {
  return isContainedPath(parent, child, { allowEqual: false });
}

function readRunFile(file) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  return validateRun(run);
}

function tryReadRunFile(file) {
  try {
    return { value: readRunFile(file) };
  } catch (error) {
    return { error: error.message };
  }
}

function tryReadPublicRun(file, opts = {}) {
  try {
    return { value: readRunFile(file) };
  } catch (error) {
    return { error: error.message };
  }
}

function buildContinuation(parentRunId, opts = {}) {
  if (!stringValue(parentRunId)) throw new Error("factory continue requires exactly one <blocked-run-id>");
  const repo = opts.cwd || process.cwd();
  const parentRunDir = resolveRunDir(parentRunId, opts);
  const parentRunFile = join(parentRunDir, "run.json");
  lstatRequiredNoSymlinks(repo, parentRunFile, "parent run.json", "parent run.json must not contain symlinks");
  const parentRun = readRunFile(parentRunFile);
  if (parentRun.status !== "blocked") {
    throw new Error(`parent run '${parentRun.run_id}' must have status blocked`);
  }
  const postPrParent = stringValue(parentRun.pr_url);
  if (postPrParent && opts.newPr !== true) throw new Error("factory continue for a blocked parent with pr_url requires --new-pr");
  if (!postPrParent && opts.newPr === true) throw new Error("factory continue --new-pr is accepted only for a blocked parent with pr_url");
  if (postPrParent) assertPostPrContinuationParent(parentRun);
  if (!stringValue(parentRun.branch)) {
    throw new Error(`parent run '${parentRun.run_id}' must have a local branch`);
  }
  if (!branchExists(repo, parentRun.branch)) {
    throw new Error(`parent run '${parentRun.run_id}' requires existing branch '${parentRun.branch}'`);
  }

  const targetRunId = normalizeContinuationTargetRunId(opts.runId, parentRun.run_id);
  assertContinuationTargetAvailable(repo, targetRunId);
  const review = resolveContinuationReview(parentRunDir, requiredContinuationReview(opts.review));
  if (postPrParent) {
    if (review.ref !== parentRun.post_pr.continuation_review.ref) throw new Error("post-PR continuation must select run.post_pr.continuation_review.ref");
    if (sha256File(review.path) !== parentRun.post_pr.continuation_review.hash) throw new Error("post-PR continuation review hash mismatch");
    const failed = postPrConsistencyChecks(parentRunDir, parentRun).filter((check) => !check.ok);
    if (failed.length) throw new Error("post-PR continuation parent has invalid evidence/review bindings");
  }
  const reviewSource = resolveContinuationReviewSource(parentRun, review.ref);
  const reviewMetadata = validateContinuationReview(readReviewJson(review.path), review.ref, reviewSource, parentRunDir);
  const targetBaseRef = continuationBaseRef(parentRun);
  const targetBaseCommit = continuationBaseCommit(repo, parentRun, targetBaseRef);

  const continuation = {
    kind: "blocked-run-continuation",
    schema_version: 1,
    created_at: timestamp(opts.now),
    operator_summary: `Continue blocked run '${parentRun.run_id}' from ${review.ref}.`,
    parent: {
      run_id: parentRun.run_id,
      status: parentRun.status,
      run_ref: relativeRef(repo, parentRunFile),
      run_hash: sha256File(parentRunFile),
      branch: parentRun.branch,
      commit: branchCommit(repo, parentRun.branch),
      worktree: requiredParentWorktree(parentRun),
    },
    review: {
      kind: reviewSource.kind,
      ref: review.ref,
      hash: sha256File(review.path),
      ...reviewMetadata,
    },
    target: {
      run_id: targetRunId,
      branch: targetRunId,
      worktree: resolve(repo, ".opencode", "worktrees", targetRunId),
      base_ref: targetBaseRef,
      base_commit: targetBaseCommit,
    },
    parent_artifacts: collectContinuationParentArtifacts(parentRunDir),
    parent_evidence: collectContinuationParentEvidence(parentRunDir, parentRun),
    parent_reviews: collectContinuationParentReviews(parentRunDir, parentRun),
    planning_reuse: continuationPlanningReuse(parentRun, parentRunDir),
  };
  const draftSpecReuse = continuationDraftSpecReuse(parentRun, parentRunDir);
  if (draftSpecReuse) continuation.draft_spec_reuse = draftSpecReuse;
  if (postPrParent) continuation.post_pr = continuationPostPrBinding(parentRun, parentRunDir);
  return continuation;
}

function requiredParentWorktree(parentRun) {
  if (!stringValue(parentRun.worktree)) throw new Error(`parent run '${parentRun.run_id}' must have a recorded worktree`);
  return parentRun.worktree;
}

function continuationBaseRef(parentRun) {
  return stringValue(parentRun.base_ref) ? String(parentRun.base_ref).trim() : "main";
}

function continuationBaseCommit(repo, parentRun, baseRef) {
  // The parent-recorded base_commit is a claim. Resolving it proves only that
  // the object exists — an unrelated or orphan-branch commit would resolve too.
  // Require it to be an ancestor of the (separately validated) parent branch so
  // the continuation base genuinely belongs to the parent's history; fall back
  // to the base ref when no base_commit was recorded.
  if (stringValue(parentRun.base_commit)) {
    const baseCommit = refCommit(repo, String(parentRun.base_commit).trim(), "parent base commit");
    if (!commitIsAncestor(repo, baseCommit, parentRun.branch)) {
      throw new Error(`parent run base commit ${baseCommit} is not an ancestor of parent branch '${parentRun.branch}'`);
    }
    return baseCommit;
  }
  return refCommit(repo, baseRef, "target base ref");
}

function normalizeContinuationTargetRunId(runId, parentRunId) {
  if (!stringValue(runId)) throw new Error("factory continue requires --run-id");
  const value = String(runId).trim();
  if (!SAFE_RUN_ID_PATTERN.test(value) || value.includes("..") || value.endsWith(".lock")) {
    throw new Error("--run-id must be a bare safe factory run id");
  }
  if (value === parentRunId) throw new Error("--run-id must differ from the parent run id");
  return value;
}

function assertContinuationTargetAvailable(repo, targetRunId) {
  const targetRunFile = join(factoryRoot(repo), targetRunId, "run.json");
  if (existsSync(targetRunFile)) throw new Error(`target run already exists: ${targetRunId}`);
  if (branchExists(repo, targetRunId)) throw new Error(`target branch already exists: ${targetRunId}`);
  const targetWorktree = resolve(repo, ".opencode", "worktrees", targetRunId);
  if (existsSync(targetWorktree)) throw new Error(`target worktree already exists: ${targetWorktree}`);
}

function requiredContinuationReview(value) {
  if (!stringValue(value)) throw new Error("factory continue requires --review");
  return String(value).trim();
}

function resolveContinuationReview(parentRunDir, reviewRef) {
  if (isAbsolute(reviewRef) || reviewRef.includes("\\")) {
    throw new Error("--review must resolve under the parent run reviews/ directory");
  }
  const parentRun = resolve(parentRunDir);
  const parentReviewsDir = join(parentRun, "reviews");
  const reviewsDirEntry = lstatRequiredNoSymlinks(parentRun, parentReviewsDir, "--review", "--review must resolve under the parent run reviews/ directory without symlinks");
  if (!reviewsDirEntry.isDirectory()) throw new Error("reviews directory must be a directory");
  if (!isLogicalContainedPath(parentRun, parentReviewsDir, { allowEqual: false })) {
    throw new Error("--review must resolve under the parent run reviews/ directory");
  }
  const relativeReviewRef = reviewRef.startsWith("reviews/") ? reviewRef : `reviews/${reviewRef}`;
  const reviewPath = resolve(parentRun, relativeReviewRef);
  if (!isLogicalContainedPath(parentReviewsDir, reviewPath, { allowEqual: false })) {
    throw new Error("--review must resolve under the parent run reviews/ directory");
  }
  const reviewEntry = lstatRequiredNoSymlinks(parentRun, reviewPath, "--review", "--review must resolve under the parent run reviews/ directory without symlinks");
  if (!reviewEntry.isFile()) throw new Error(`--review must be a JSON file: ${relativeReviewRef}`);
  return { ref: relativeRef(parentRun, reviewPath), path: reviewPath };
}

function readReviewJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be a JSON object");
    return value;
  } catch (error) {
    throw new Error(`--review must parse as a JSON object: ${error.message}`);
  }
}

function validateContinuationReview(review, ref, source, parentRunDir) {
  if (!stringValue(review.subject)) throw new Error(`review '${ref}' must have non-empty subject`);
  const subject = String(review.subject).trim();
  if (!source.expected_subjects.has(subject)) {
    throw new Error(`review '${ref}' subject must match parent ${source.kind} source`);
  }
  validateContinuationReviewRefs(review, parentRunDir, ref);
  const summary = stringValue(review.summary) ? String(review.summary).trim() : null;
  const requiredFixes = normalizeRequiredFixes(review.required_fixes);
  const hasSummary = summary !== null;
  const hasRequiredFixes = requiredFixes.length > 0;
  if (!hasSummary && !hasRequiredFixes) {
    throw new Error(`review '${ref}' must have non-empty summary or required_fixes[]`);
  }
  const result = {
    subject,
    summary,
    required_fixes: requiredFixes,
  };
  if (stringValue(review.verdict)) result.verdict = String(review.verdict).trim();
  if (stringValue(source.source)) result.source = source.source;
  return result;
}

function validateContinuationReviewRefs(review, parentRunDir, reviewRef) {
  if (stringValue(review.evidence_ref)) hashParentRef(parentRunDir, review.evidence_ref, "evidence", "evidence");
  if (stringValue(review.artifact_ref)) hashParentRef(parentRunDir, review.artifact_ref, "artifacts", "artifact");
  if (stringValue(review.report)) hashParentRef(parentRunDir, review.report, "artifacts", "artifact");
  if (stringValue(review.review_ref) && review.review_ref !== reviewRef) hashParentRef(parentRunDir, review.review_ref, "reviews", "review");
}

function resolveContinuationReviewSource(parentRun, reviewRef) {
  const candidates = continuationReviewSources(parentRun).filter((candidate) => candidate.ref === reviewRef);
  if (!candidates.length) throw new Error(`review '${reviewRef}' must be referenced by parent run state`);
  return candidates[0];
}

function continuationReviewSources(parentRun) {
  const parentSubjects = new Set([parentRun.run_id, parentRun.branch, "feature-branch"].filter(stringValue).map((value) => String(value).trim()));
  const sources = [];
  if (stringValue(parentRun.post_pr?.continuation_review?.ref)) {
    sources.push({ kind: "post_pr", source: "run.post_pr.continuation_review.ref", ref: parentRun.post_pr.continuation_review.ref, expected_subjects: new Set([parentRun.run_id]) });
  }
  if (stringValue(parentRun.validator?.review_ref)) {
    sources.push({ kind: "validator", source: "run.validator.review_ref", ref: parentRun.validator.review_ref, expected_subjects: parentSubjects });
  }
  if (stringValue(parentRun.security_review?.review_ref)) {
    sources.push({ kind: "security_review", source: "run.security_review.review_ref", ref: parentRun.security_review.review_ref, expected_subjects: parentSubjects });
  }
  for (const step of Array.isArray(parentRun.steps) ? parentRun.steps : []) {
    if (!stringValue(step?.review_ref) || !stringValue(step?.agent)) continue;
    sources.push({ kind: "step", source: `run.steps.${step.agent}.review_ref`, ref: step.review_ref, expected_subjects: new Set([String(step.agent).trim()]) });
  }
  for (const slice of Array.isArray(parentRun.slices) ? parentRun.slices : []) {
    if (!stringValue(slice?.review_ref) || !stringValue(slice?.id)) continue;
    sources.push({ kind: "slice", source: `run.slices.${slice.id}.review_ref`, ref: slice.review_ref, expected_subjects: new Set([String(slice.id).trim()]) });
  }
  return sources.map((source) => ({ ...source, ref: normalizeParentRef(source.ref, "reviews") }));
}

function normalizeRequiredFixes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(stringValue).map((item) => String(item).trim());
}

// work-reviewer emits `APPROVE | REJECT`; accept the common approving synonyms so
// the gate is not brittle to a slightly different recorded verdict, but a REJECT
// (or any non-approving verdict) is never treated as acceptance.
const APPROVING_SPEC_VERDICTS = new Set(["APPROVE", "APPROVED", "ACCEPT", "ACCEPTED", "GO", "PASS"]);
const CHILD_SPEC_REVIEW_REF = "reviews/spec-writer.json";
const SHA256_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/iu;

// Decide whether the parent's planning output is reusable by DURABLE ACCEPTANCE,
// not mere file presence. A brief is reusable only when the parent has an accepted
// `spec-writer` step that references `artifacts/technical-brief.md` and whose
// review_ref resolves to an approving `spec-writer` review. A brief from a parent
// whose spec-writer step is rejected/blocked/absent — or whose review is not
// approving — is amendment input only and is never adopted as approved.
function continuationPlanningReuse(parentRun, parentRunDir) {
  const steps = Array.isArray(parentRun.steps) ? parentRun.steps : [];
  const step = steps.find((entry) => stringValue(entry?.agent) && String(entry.agent).trim() === "spec-writer");
  if (!step) return { eligible: false, reason: "parent has no spec-writer step; brief is amendment input only" };
  const status = String(step.status || "").trim();
  if (status !== "accepted") {
    return { eligible: false, reason: `parent spec-writer step is '${status || "unset"}', not accepted; brief is amendment input only` };
  }
  // Require a durable acceptance binding recorded at the accept transition, not an
  // inference from the parent's current (mutable) files. A legacy accepted step
  // that predates the binding fails closed and needs explicit re-acceptance.
  const acceptance = step.acceptance;
  if (!acceptance || typeof acceptance !== "object") {
    return { eligible: false, reason: "accepted spec-writer step has no durable acceptance binding (legacy/unbound); requires explicit re-acceptance" };
  }
  if (String(acceptance.artifact_ref || "").trim() !== "artifacts/technical-brief.md") {
    return { eligible: false, reason: "acceptance binding does not reference artifacts/technical-brief.md" };
  }
  if (!SHA256_HASH_PATTERN.test(String(acceptance.artifact_hash || "")) || !stringValue(acceptance.review_ref) || !SHA256_HASH_PATTERN.test(String(acceptance.review_hash || ""))) {
    return { eligible: false, reason: "acceptance binding is missing artifact/review hashes; requires explicit re-acceptance" };
  }
  const parentRoot = resolve(parentRunDir);
  // The bound artifact bytes must still be present and unchanged since acceptance.
  const artifactPath = resolve(parentRoot, "artifacts/technical-brief.md");
  const artifactEntry = lstatOptionalNoSymlinks(parentRoot, artifactPath, "spec-writer artifact 'artifacts/technical-brief.md'", "spec-writer artifact must not contain symlinks");
  if (!artifactEntry || !artifactEntry.isFile()) return { eligible: false, reason: "bound technical-brief.md is missing from the parent run" };
  if (sha256File(artifactPath) !== acceptance.artifact_hash) {
    return { eligible: false, reason: "technical-brief.md changed since acceptance (does not match acceptance binding); requires explicit re-acceptance" };
  }
  const reviewRef = normalizeParentRef(acceptance.review_ref, "reviews");
  const reviewPath = resolve(parentRoot, reviewRef);
  if (!isLogicalContainedPath(join(parentRoot, "reviews"), reviewPath, { allowEqual: false })) {
    return { eligible: false, reason: `spec-writer review_ref '${reviewRef}' escapes reviews/` };
  }
  const entry = lstatOptionalNoSymlinks(parentRoot, reviewPath, `spec-writer review '${reviewRef}'`, `spec-writer review '${reviewRef}' must not contain symlinks`);
  if (!entry || !entry.isFile()) return { eligible: false, reason: `spec-writer review_ref '${reviewRef}' does not resolve to a file` };
  if (sha256File(reviewPath) !== acceptance.review_hash) {
    return { eligible: false, reason: "spec-writer review changed since acceptance (does not match acceptance binding); requires explicit re-acceptance" };
  }
  let review;
  try {
    review = readReviewJson(reviewPath);
  } catch {
    return { eligible: false, reason: `spec-writer review '${reviewRef}' is not a valid JSON object` };
  }
  const subject = String(review?.subject || "").trim();
  if (subject !== "spec-writer") return { eligible: false, reason: `spec-writer review subject '${subject || "(none)"}' is not spec-writer` };
  const verdict = String(review?.verdict || "").trim().toUpperCase();
  if (!APPROVING_SPEC_VERDICTS.has(verdict)) {
    return { eligible: false, reason: `spec-writer review verdict '${verdict || "(none)"}' is not approving; brief is amendment input only` };
  }
  return {
    eligible: true,
    spec_review_ref: reviewRef,
    spec_review_hash: acceptance.review_hash,
    spec_artifact_ref: "artifacts/technical-brief.md",
    spec_artifact_hash: acceptance.artifact_hash,
    child_spec_review_ref: CHILD_SPEC_REVIEW_REF,
  };
}

function continuationDraftSpecReuse(parentRun, parentRunDir) {
  const step = (Array.isArray(parentRun.steps) ? parentRun.steps : [])
    .find((entry) => stringValue(entry?.agent) && String(entry.agent).trim() === "spec-writer");
  if (!step || !["rejected", "blocked"].includes(step.status)) return null;
  if (!Number.isInteger(step.attempts) || step.attempts < 0) return null;
  if (step.acceptance || step.inherited_acceptance) return null;
  if (String(step.artifact_ref || "").trim() !== "artifacts/technical-brief.md") return null;
  const maxRetries = Number.isInteger(parentRun.max_retries) ? parentRun.max_retries : 3;
  if (maxRetries < 1 || step.attempts >= maxRetries) {
    throw new Error(`parent spec-writer retry budget is exhausted (${step.attempts}/${maxRetries}); refusing to reset it in a continuation`);
  }
  const parentRoot = resolve(parentRunDir);
  const artifactPath = resolve(parentRoot, "artifacts/technical-brief.md");
  const entry = lstatOptionalNoSymlinks(parentRoot, artifactPath, "spec-writer draft 'artifacts/technical-brief.md'", "spec-writer draft must not contain symlinks");
  if (!entry || !entry.isFile()) return null;
  return {
    artifact_ref: "artifacts/technical-brief.md",
    artifact_hash: sha256File(artifactPath),
    parent_step_status: String(step.status),
    parent_step_attempts: step.attempts,
    max_retries: maxRetries,
    remaining_attempts: maxRetries - step.attempts,
  };
}

function continuationSeedPlan(continuation) {
  const reuse = continuation?.planning_reuse;
  if (!reuse || reuse.eligible !== true) {
    const draft = continuation?.draft_spec_reuse;
    if (draft) {
      return { eligible: true, draft: true, reason: null, artifacts: [draft.artifact_ref], spec_review_ref: null };
    }
    return { eligible: false, draft: false, reason: reuse?.reason || "no reusable parent planning acceptance", artifacts: [], spec_review_ref: null };
  }
  const artifacts = (Array.isArray(continuation.parent_artifacts) ? continuation.parent_artifacts : [])
    .filter((entry) => CONTINUATION_SEED_ARTIFACT_KINDS.has(entry.kind))
    .map((entry) => entry.ref)
    .sort((a, b) => a.localeCompare(b));
  return { eligible: true, draft: false, reason: null, artifacts, spec_review_ref: reuse.child_spec_review_ref || CHILD_SPEC_REVIEW_REF };
}

// Adopt the parent's DURABLY ACCEPTED planning output into the child run so a
// continuation reuses the approved story/research/design/brief instead of
// regenerating them, and carries the approving spec review into child state as
// resolvable acceptance provenance. Seeding is gated by `continuationPlanningReuse`
// (never adopts a rejected/unapproved brief) and is transactional/fail-closed:
// every source is validated (containment, no symlinks, is-file, hash) and read into
// memory BEFORE anything is written, so a missing source or a later hash mismatch
// aborts the whole seed with no partial child run directory left behind.
export function seedContinuationPlanningArtifacts(repo, parentRunDir, continuation, options = {}) {
  const reuse = continuation?.planning_reuse;
  const draft = continuation?.draft_spec_reuse;
  if ((!reuse || reuse.eligible !== true) && !draft) {
    return { eligible: false, draft: false, reason: reuse?.reason || "no reusable parent planning acceptance", artifacts: [], spec_review_ref: null };
  }
  const parentRoot = resolve(parentRunDir);
  const parentArtifactsDir = join(parentRoot, "artifacts");
  const parentReviewsDir = join(parentRoot, "reviews");
  const targetRunDir = join(factoryRoot(repo), continuation.target.run_id);
  const targetArtifactsDir = join(targetRunDir, "artifacts");
  const targetReviewsDir = join(targetRunDir, "reviews");

  const plan = reuse?.eligible === true
    ? (Array.isArray(continuation.parent_artifacts) ? continuation.parent_artifacts : [])
      .filter((entry) => CONTINUATION_SEED_ARTIFACT_KINDS.has(entry.kind))
      .map((entry) => ({ label: `parent artifact '${entry.ref}'`, srcRef: entry.ref, srcRoot: parentArtifactsDir, hash: entry.hash, destRef: entry.ref, destRoot: targetArtifactsDir, isArtifact: true }))
    : [{ label: `parent draft '${draft.artifact_ref}'`, srcRef: draft.artifact_ref, srcRoot: parentArtifactsDir, hash: draft.artifact_hash, destRef: draft.artifact_ref, destRoot: targetArtifactsDir, isArtifact: true }];
  if (reuse?.eligible === true) {
    // Carry the approving spec review into the child under a canonical ref so the
    // adopted spec-writer step's review_ref resolves in child state.
    plan.push({ label: `spec review '${reuse.spec_review_ref}'`, srcRef: reuse.spec_review_ref, srcRoot: parentReviewsDir, hash: reuse.spec_review_hash, destRef: CHILD_SPEC_REVIEW_REF, destRoot: targetReviewsDir, isArtifact: false });
  }

  // Phase 1 — validate and stage every entry before writing anything.
  const staged = [];
  for (const item of plan) {
    const src = resolve(parentRoot, item.srcRef);
    if (!isLogicalContainedPath(item.srcRoot, src, { allowEqual: false })) {
      throw new Error(`continuation seed source escapes its root: ${item.srcRef}`);
    }
    const entry = lstatOptionalNoSymlinks(parentRoot, src, item.label, `${item.label} must not contain symlinks`);
    if (!entry || !entry.isFile()) {
      throw new Error(`continuation ${item.label} is missing or not a regular file (seed aborted; nothing written)`);
    }
    const bytes = readFileSync(src);
    if (sha256Buffer(bytes) !== item.hash) {
      throw new Error(`continuation ${item.label} changed since payload build (hash mismatch)`);
    }
    const dest = resolve(targetRunDir, item.destRef);
    if (!isLogicalContainedPath(item.destRoot, dest, { allowEqual: false })) {
      throw new Error(`continuation seed dest escapes its root: ${item.destRef}`);
    }
    staged.push({ dest, bytes, destRef: item.destRef, isArtifact: item.isArtifact });
  }

  // Phase 2 — build the complete child seed as a sibling of the target, then make
  // it visible with one atomic directory rename. A crash before rename leaves no
  // partial child run; a crash after rename leaves the complete seed set. A
  // concurrent/non-empty target makes rename fail without clobbering its state.
  const stagingRoot = join(dirname(factoryRoot(repo)), `.continuation-seed-${continuation.target.run_id}-${randomUUID()}`);
  try {
    mkdirSync(stagingRoot, { recursive: false });
    for (const item of staged) {
      const stagedDest = resolve(stagingRoot, item.destRef);
      if (!isLogicalContainedPath(stagingRoot, stagedDest, { allowEqual: false })) {
        throw new Error(`continuation staged destination escapes staging root: ${item.destRef}`);
      }
      mkdirSync(dirname(stagedDest), { recursive: true });
      writeFileSync(stagedDest, item.bytes, { flag: "wx" });
    }
    if (options.beforePublish) options.beforePublish({ stagingRoot, targetRunDir });
    renameSync(stagingRoot, targetRunDir);
  } catch (error) {
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      // Preserve the publication failure; an orphan staging tree is never child state.
    }
    throw error;
  }
  return {
    eligible: true,
    draft: reuse?.eligible !== true,
    reason: null,
    artifacts: staged.filter((item) => item.isArtifact).map((item) => item.destRef).sort((a, b) => a.localeCompare(b)),
    spec_review_ref: reuse?.eligible === true ? CHILD_SPEC_REVIEW_REF : null,
    spec_artifact_ref: reuse?.spec_artifact_ref || draft?.artifact_ref || "artifacts/technical-brief.md",
  };
}

function sha256Buffer(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Checked continuation-adoption transition. Instead of a model-driven generic
// `factory step ... accepted`, this verifies the seeded child files against the
// parent's durable acceptance binding (carried in `continuation.planning_reuse`)
// and atomically records an inherited-acceptance provenance record on the child
// spec-writer step. Fails closed if the seeded brief/review are missing, altered,
// or the continuation is not reuse-eligible.
export async function adoptContinuation(childRunId, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const childRunDir = resolveRunDir(childRunId, { ...opts, cwd: repo });
  const run = readRunFile(join(childRunDir, "run.json"));
  const continuation = run?.continuation;
  if (!continuation || continuation.kind !== "blocked-run-continuation") {
    throw new Error(`run '${childRunId}' has no blocked-run-continuation metadata to adopt`);
  }
  const reuse = continuation.planning_reuse;
  if (!reuse || reuse.eligible !== true) {
    throw new Error(`continuation '${childRunId}' has no reuse-eligible parent acceptance to adopt${reuse?.reason ? ` (${reuse.reason})` : ""}`);
  }
  if (!SHA256_HASH_PATTERN.test(String(reuse.spec_artifact_hash || "")) || !SHA256_HASH_PATTERN.test(String(reuse.spec_review_hash || ""))) {
    throw new Error(`continuation '${childRunId}' planning_reuse is missing artifact/review acceptance hashes`);
  }
  const childRoot = resolve(childRunDir);
  verifySeededChildFile(childRoot, "artifacts", "artifacts/technical-brief.md", reuse.spec_artifact_hash);
  verifySeededChildFile(childRoot, "reviews", CHILD_SPEC_REVIEW_REF, reuse.spec_review_hash);

  const result = await transitionRunStep(childRunDir, "spec-writer", (step) => {
    step.status = "accepted";
    step.artifact_ref = "artifacts/technical-brief.md";
    step.review_ref = CHILD_SPEC_REVIEW_REF;
    if (!Number.isInteger(step.attempts)) step.attempts = 0;
    step.inherited_acceptance = {
      from_run_id: continuation.parent.run_id,
      parent_spec_review_ref: reuse.spec_review_ref,
      artifact_hash: reuse.spec_artifact_hash,
      review_hash: reuse.spec_review_hash,
    };
  }, { ...opts, mustExist: false });
  return { status: "adopted", run_id: childRunId, step: result.step };
}

function verifySeededChildFile(childRoot, root, ref, expectedHash) {
  const path = resolve(childRoot, ref);
  if (!isLogicalContainedPath(join(childRoot, root), path, { allowEqual: false })) {
    throw new Error(`continuation adoption ref escapes ${root}/: ${ref}`);
  }
  const entry = lstatOptionalNoSymlinks(childRoot, path, `seeded ${ref}`, `seeded ${ref} must not contain symlinks`);
  if (!entry || !entry.isFile()) {
    throw new Error(`continuation adoption requires seeded ${ref}; it is missing (run 'factory continue' first)`);
  }
  if (sha256File(path) !== expectedHash) {
    throw new Error(`continuation adoption: seeded ${ref} does not match the parent acceptance binding (altered or spoofed)`);
  }
}

function collectContinuationParentArtifacts(parentRunDir) {
  const parentRun = resolve(parentRunDir);
  const artifactsDir = join(parentRun, "artifacts");
  const artifactsDirEntry = lstatOptionalNoSymlinks(parentRun, artifactsDir, "parent artifacts", "parent artifacts/ directory must not contain symlinks");
  if (!artifactsDirEntry) return [];
  if (!artifactsDirEntry.isDirectory()) return [];
  return CONTINUATION_PARENT_ARTIFACT_REFS.flatMap(({ kind, ref }) => {
    const hashed = optionalHashParentRef(parentRunDir, ref, "artifacts", kind, `parent artifact '${ref}' must not contain symlinks`);
    return hashed ? [hashed] : [];
  }).sort((a, b) => a.ref.localeCompare(b.ref));
}

function collectContinuationParentEvidence(parentRunDir, parentRun) {
  const refs = [];
  for (const step of Array.isArray(parentRun.steps) ? parentRun.steps : []) if (stringValue(step?.evidence_ref)) refs.push(step.evidence_ref);
  for (const slice of Array.isArray(parentRun.slices) ? parentRun.slices : []) if (stringValue(slice?.evidence_ref)) refs.push(slice.evidence_ref);
  if (stringValue(parentRun.post_pr?.remediation?.failure_evidence_ref)) refs.push(parentRun.post_pr.remediation.failure_evidence_ref);
  for (const binding of Array.isArray(parentRun.post_pr?.evidence_refs) ? parentRun.post_pr.evidence_refs : []) if (stringValue(binding?.ref)) refs.push(binding.ref);
  return hashUniqueParentRefs(parentRunDir, refs, "evidence", "evidence");
}

function collectContinuationParentReviews(parentRunDir, parentRun) {
  return hashUniqueParentRefs(parentRunDir, continuationReviewSources(parentRun).map((source) => source.ref), "reviews", "review");
}

function hashUniqueParentRefs(parentRunDir, refs, rootName, kind) {
  return [...new Set(refs.filter(stringValue).map((ref) => normalizeParentRef(ref, rootName)))]
    .map((ref) => hashParentRef(parentRunDir, ref, rootName, kind))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

function optionalHashParentRef(parentRunDir, ref, rootName, kind, symlinkMessage) {
  const parentRun = resolve(parentRunDir);
  const normalizedRef = normalizeParentRef(ref, rootName);
  const path = resolve(parentRun, normalizedRef);
  const entry = lstatOptionalNoSymlinks(parentRun, path, `parent ${kind} '${normalizedRef}'`, symlinkMessage || `parent ${kind} '${normalizedRef}' must not contain symlinks`);
  if (!entry || !entry.isFile()) return null;
  if (!isLogicalContainedPath(join(parentRun, rootName), path, { allowEqual: false })) throw new Error(`parent ${kind} ref must stay under ${rootName}/: ${normalizedRef}`);
  return { kind, ref: normalizedRef, hash: sha256File(path) };
}

function hashParentRef(parentRunDir, ref, rootName, kind) {
  const hashed = optionalHashParentRef(parentRunDir, ref, rootName, kind);
  if (!hashed) throw new Error(`missing parent ${kind} ref: ${normalizeParentRef(ref, rootName)}`);
  return hashed;
}

function normalizeParentRef(ref, rootName) {
  if (!stringValue(ref)) throw new Error(`parent ${rootName} ref is required`);
  const value = String(ref).trim();
  if (isAbsolute(value) || value.includes("\\")) throw new Error(`parent ${rootName} ref must be relative`);
  return value.startsWith(`${rootName}/`) ? value : `${rootName}/${value}`;
}

function lstatRequiredNoSymlinks(rootDir, targetPath, label, symlinkMessage) {
  const result = lstatPathNoSymlinks(rootDir, targetPath, symlinkMessage);
  if (!result.entry) throw new Error(`${label} is unresolvable: ${targetPath}`);
  return result.entry;
}

function lstatOptionalNoSymlinks(rootDir, targetPath, label, symlinkMessage) {
  return lstatPathNoSymlinks(rootDir, targetPath, symlinkMessage || `${label} must not contain symlinks`).entry;
}

function lstatPathNoSymlinks(rootDir, targetPath, symlinkMessage) {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  if (!isLogicalContainedPath(root, target, { allowEqual: false })) return { entry: null };
  const segments = relative(root, target).split(/[\\/]+/u).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { entry: null };
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`${symlinkMessage}: ${relativeRef(root, current)}`);
    }
    if (index < segments.length - 1 && !entry.isDirectory()) return { entry: null };
    if (index === segments.length - 1) return { entry };
  }
  return { entry: null };
}

function isLogicalContainedPath(parent, child, options = {}) {
  const allowEqual = options.allowEqual !== false;
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return allowEqual;
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function branchExists(repo, branch) {
  return git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).ok;
}

function branchCommit(repo, branch) {
  return resolveGitCommit(repo, `refs/heads/${branch}^{commit}`, `parent branch '${branch}'`);
}

function refCommit(repo, ref, label) {
  return resolveGitCommit(repo, `${ref}^{commit}`, `${label} '${ref}'`);
}

function resolveGitCommit(repo, spec, label) {
  const proc = git(repo, ["rev-parse", "--verify", spec]);
  if (!proc.ok) throw new Error(`parent run requires resolvable ${label} commit`);
  return proc.stdout.trim();
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function relativeRef(from, to) {
  return relative(from, to).replace(/\\/gu, "/");
}

function resolveRunDir(runId, opts = {}) {
  const id = runId || latestRunId(opts);
  if (!id) throw new Error("no factory runs found");
  const value = String(id).trim();
  if (isExplicitRunPath(value)) {
    const asPath = resolve(opts.cwd || process.cwd(), value);
    const root = factoryRootsForLookup(opts.cwd || process.cwd()).find((candidate) => insideDirectory(candidate, asPath));
    if (!root) throw new Error(`run path must be inside .opencode/factory: ${asPath}`);
    if (!existsSync(join(asPath, "run.json"))) throw new Error(`run not found: ${id}`);
    return asPath;
  }
  if (!value || value === "." || value === "..") throw new Error("run id must be a bare factory run id");
  for (const root of factoryRootsForLookup(opts.cwd || process.cwd())) {
    const dir = resolve(root, value);
    if (!existsSync(join(dir, "run.json"))) continue;
    if (!insideDirectory(root, dir)) throw new Error(`run directory must be inside .opencode/factory: ${dir}`);
    return dir;
  }
  throw new Error(`run not found: ${id}`);
}

function isExplicitRunPath(value) {
  return isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function formatValidationChecks(checks) {
  const errors = checks.flatMap((check) => Array.isArray(check?.errors) ? check.errors : []);
  if (errors.length === 0) return "run validation failed";
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function resolveHeartbeatRunDir(runId, opts = {}) {
  const id = runId || latestRunId(opts);
  if (!id) throw new Error("no factory runs found");
  const normalized = normalizeHeartbeatRunId(id);
  for (const root of factoryRootsForLookup(opts.cwd || process.cwd())) {
    const dir = resolve(root, normalized);
    if (!existsSync(join(dir, "run.json"))) continue;
    if (!insideDirectory(root, dir)) throw new Error(`heartbeat run directory must be inside .opencode/factory: ${dir}`);
    return dir;
  }
  throw new Error(`run not found: ${id}`);
}

function factoryRoot(cwd) {
  return directFactoryRoot(cwd);
}

function allRunDirs(opts = {}) {
  const seen = new Set();
  const dirs = [];
  for (const root of factoryRootsForLookup(opts.cwd || process.cwd())) {
    if (!existsSync(root)) continue;
    for (const runId of readdirSync(root)) {
      const dir = join(root, runId);
      if (!existsSync(join(dir, "run.json")) || seen.has(dir)) continue;
      seen.add(dir);
      dirs.push(dir);
    }
  }
  return dirs;
}

function runForegroundFactory(repo, commandArgs, opts = {}) {
  const spawnProcess = typeof opts.spawnFn === "function" ? opts.spawnFn : spawn;
  return new Promise((resolveRun, rejectRun) => {
    let settled = false;
    const writer = createSanitizedLineWriter({
      write(stream, buffer) {
        const destination = stream === "stderr" ? process.stderr : process.stdout;
        return new Promise((resolveWrite, rejectWrite) => {
          destination.write(buffer, (error) => error ? rejectWrite(error) : resolveWrite());
        });
      },
    });
    let child;
    try {
      child = spawnProcess("opencode", commandArgs, {
        cwd: repo,
        env: opts.env || process.env,
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error) {
      rejectRun(new Error(`opencode failed to start: ${renderErrorForTerminal(error)}`));
      return;
    }
    child.stdout.pipe(writer.stdout);
    child.stderr.pipe(writer.stderr);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectRun(new Error(`opencode failed to start: ${renderErrorForTerminal(error)}`));
    });
    child.once("close", async (code) => {
      if (settled) return;
      try {
        await writer.finished();
        if (code !== 0) throw new Error(`opencode exited ${code ?? 1}`);
        settled = true;
        resolveRun(undefined);
      } catch (error) {
        settled = true;
        rejectRun(new Error(renderErrorForTerminal(error)));
      }
    });
  });
}

function startDetached(repo, commandArgs, opts = {}) {
  const env = opts.env || process.env;
  const scopedRunDir = opts.runDir || null;
  const recordsProcessEvidence = Boolean(scopedRunDir && opts.runId);
  if (recordsProcessEvidence) {
    assertDetachedProcessEvidenceWritable(scopedRunDir, {
      runId: opts.runId,
      inspectorFn: opts.inspectorFn || opts.processInspectorFn,
    });
  }
  const processes = scopedRunDir ? join(scopedRunDir, "processes") : join(factoryRoot(repo), "processes");
  mkdirSync(processes, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const executionId = opts.executionId || randomUUID();
  const log = join(processes, scopedRunDir ? `${stamp}-${executionId}.log` : `${stamp}.log`);
  const spawnProcess = typeof opts.supervisorSpawnFn === "function" ? opts.supervisorSpawnFn : spawn;
  const supervisorPath = fileURLToPath(new URL("./detached-log-supervisor.js", import.meta.url));
  const supervisor = spawnProcess(process.execPath, [supervisorPath], {
    cwd: repo,
    detached: true,
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return awaitDetachedReadiness(supervisor, {
    repo, commandArgs, env, scopedRunDir, recordsProcessEvidence, executionId, log,
    runId: opts.runId || null, now: opts.now, readyTimeoutMs: opts.readyTimeoutMs,
  });
}

function awaitDetachedReadiness(supervisor, init) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    let actualPid = null;
    const timeoutMs = normalizePositiveInteger(init.readyTimeoutMs, DETACHED_READY_TIMEOUT_MS, "readyTimeoutMs");
    const finishFailure = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { supervisor.send?.({ type: "abort" }); } catch { /* best effort */ }
      setTimeout(() => {
        try { process.kill(supervisor.pid, "SIGTERM"); } catch { /* already exited */ }
        if (init.scopedRunDir && !existsSync(join(init.scopedRunDir, "run.json")) && !existsSync(join(init.scopedRunDir, PROCESS_EVIDENCE_FILE))) removeFailedDetachedLaunchDir(init.scopedRunDir);
      }, DETACHED_ABORT_GRACE_MS).unref?.();
      rejectReady(new Error(`detached launch failed: ${renderErrorForTerminal(error)}`));
    };
    const timer = setTimeout(() => finishFailure(new Error("readiness timed out")), timeoutMs);
    supervisor.once("error", finishFailure);
    supervisor.once("disconnect", () => finishFailure(new Error("supervisor disconnected before readiness")));
    supervisor.once("exit", (code) => finishFailure(new Error(`supervisor exited ${code ?? 1} before readiness`)));
    supervisor.on("message", (message) => {
      if (message?.type === "spawned" && Number.isInteger(message.pid)) actualPid = message.pid;
      if (message?.type === "error") finishFailure(new Error(message.error || "supervisor failed safely"));
      if (message?.type !== "ready" || settled) return;
      if (!Number.isInteger(message.pid) || message.pid <= 0 || (actualPid && actualPid !== message.pid)) {
        finishFailure(new Error("supervisor returned invalid child pid evidence"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      supervisor.unref?.();
      supervisor.disconnect?.();
      resolveReady({ status: "started", run_id: init.runId, pid: message.pid, repo: init.repo, log: init.log });
    });
    supervisor.send({
      type: "init",
      repo: init.repo,
      commandArgs: init.commandArgs,
      env: init.env,
      runDir: init.scopedRunDir,
      runId: init.runId,
      executionId: init.executionId,
      log: init.log,
      logRef: init.scopedRunDir ? relativeRef(init.scopedRunDir, init.log) : null,
      recordEvidence: init.recordsProcessEvidence,
      now: init.now,
    }, (error) => { if (error) finishFailure(error); });
  });
}

function factoryLaunchEnv(opts = {}) {
  try {
    return prepareTelemetryEnv(process.env, {
      parentSpanId: opts.parentSpanId,
      traceparent: opts.traceparent,
      tracestate: opts.tracestate,
    });
  } catch (error) {
    throw new Error(`invalid trace context: ${error.message}`);
  }
}

function detachedProcessOptions(repo, opts = {}) {
  if (!opts.runDir) return { ...opts, runDir: null };
  if (!stringValue(opts.runId)) throw new Error("run-scoped detached process evidence requires a run id");
  const runId = String(opts.runId).trim();
  if (!SAFE_RUN_ID_PATTERN.test(runId) || runId.includes("..") || runId.endsWith(".lock")) throw new Error("run-scoped detached process evidence requires a bare safe run id");
  const runDir = resolve(opts.runDir);
  const rootDir = factoryRoot(repo);
  if (!isLogicalContainedPath(rootDir, runDir, { allowEqual: false })) {
    throw new Error(`run-scoped detached process evidence requires a run directory inside .opencode/factory: ${runDir}`);
  }
  if (basename(runDir) !== runId) {
    throw new Error("run-scoped detached process evidence run directory must match the run id");
  }
  return {
    ...opts,
    runId,
    runDir,
  };
}

function pendingGate(run) {
  for (const [name, gate] of Object.entries(run.gates || {})) {
    if (gate && gate.status === "pending") return name;
  }
  return null;
}

function selectedReviewTier(run) {
  return typeof run.review_tier === "string" ? run.review_tier : null;
}

function normalizeAnswer(answer) {
  const text = String(answer).trim();
  if (text === "approve" || text === "stop") return text;
  if (text.startsWith("changes:") && text.slice("changes:".length).trim().length > 0) return text;
  throw new Error("answer must be exactly approve, stop, or start with changes:");
}

function requireSafeGateName(value, label) {
  if (!stringValue(value)) throw new Error(`${label} is required`);
  const gateName = String(value).trim();
  if (!SAFE_GATE_NAME_PATTERN.test(gateName)) {
    throw new Error(`${label} must match safe gate name pattern [a-z0-9][a-z0-9_-]*[a-z0-9]`);
  }
  return gateName;
}

function resolveGateAnswerRunDir(runId, opts = {}) {
  return resolveExistingDirectory(resolveRunDir(runId, opts), "run directory");
}

function writeGateAnswerFileAtomically(gatesDir, answerPath, contents) {
  const temp = createGateAnswerTempFile(gatesDir);

  try {
    try {
      writeFileSync(temp.fd, contents, "utf8");
    } finally {
      closeSync(temp.fd);
    }
    renameSync(temp.path, answerPath);
  } finally {
    if (existsSync(temp.path)) rmSync(temp.path, { force: true });
  }
}

function createGateAnswerTempFile(gatesDir) {
  let lastError = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = join(gatesDir, `.gate-answer-${process.pid}-${randomUUID()}.tmp`);
    try {
      return {
        path: tempPath,
        fd: openSync(tempPath, gateAnswerTempOpenFlags(), 0o600),
      };
    } catch (error) {
      if (error?.code === "EEXIST") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error(`unable to create temporary gate answer in ${gatesDir}`);
}

function gateAnswerTempOpenFlags() {
  return exclusiveNoFollowWriteFlags();
}

function exclusiveNoFollowWriteFlags() {
  let flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL;
  if (typeof FS_CONSTANTS.O_NOFOLLOW === "number") flags |= FS_CONSTANTS.O_NOFOLLOW;
  return flags;
}

function resolveExistingDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  const physical = physicalPath(path, label, { mustExist: true });
  if (!statSync(physical).isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  return physical;
}

function normalizeHeartbeatRunId(runId) {
  if (!stringValue(runId)) throw new Error("factory heartbeat requires exactly one <run-id>");
  const value = String(runId).trim();
  if (isAbsolute(value) || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error("factory heartbeat requires a bare <run-id>, not a filesystem path");
  }
  return value;
}

export function assertFactoryRoot(repo) {
  const root = factoryRoot(repo);
  return existsSync(root) && statSync(root).isDirectory();
}

export function seedRepoSkill(repo, opts = {}) {
  const dest = ensureRepoSeedSkillDirectory(repo);
  const seedHashPath = join(dest, ".seed-hash");
  const recorded = readSeedHashes(repo, seedHashPath);
  const nextHashes = {};
  const skipped = [];
  const refreshed = [];
  for (const file of REPO_SEEDED_SKILL_FILES) {
    const source = join(root, "assets", "skills", "feature", file);
    const target = join(dest, file);
    const sourceText = readFileSync(source, "utf8");
    const sourceHash = sha256(sourceText);
    const currentText = readManagedSeedText(repo, target, `repo-seeded feature skill file '${file}'`);
    const currentHash = currentText === null ? null : sha256(currentText);
    const recordedHash = validSha256(recorded[file]);
    const packagedHash = currentHash !== null && knownSeedHashesFor(opts.knownSeedHashes, file).has(currentHash);
    const managedSeed = currentHash === null || currentHash === sourceHash || currentHash === recordedHash || packagedHash;
    const locallyEdited = currentHash !== null && currentHash !== sourceHash && !managedSeed;
    if (locallyEdited) {
      skipped.push(file);
      nextHashes[file] = sourceHash;
      continue;
    }
    if (currentHash !== sourceHash) {
      writeManagedSeedFileAtomic(repo, dest, target, sourceText);
      if (currentHash !== null) refreshed.push(file);
    }
    nextHashes[file] = sourceHash;
  }
  if (refreshed.length) console.warn(`feature-factory: refreshed stale repo-seeded feature skill file(s): ${refreshed.join(", ")}`);
  if (skipped.length) console.warn(`feature-factory: preserved locally edited seeded skill file(s): ${skipped.join(", ")}`);
  writeManagedSeedFileAtomic(repo, dest, seedHashPath, `${JSON.stringify(nextHashes, null, 2)}\n`);
  ensureGitInfoExclude(repo, ".opencode/skills/feature/");
  return dest;
}

function ensureRepoSeedSkillDirectory(repo) {
  const rootDir = resolve(repo);
  const dirs = [
    join(rootDir, ".opencode"),
    join(rootDir, ".opencode", "skills"),
    join(rootDir, ".opencode", "skills", "feature"),
  ];
  for (const dir of dirs) {
    const label = `repo-seeded feature skill directory '${relativeRef(rootDir, dir)}'`;
    const entry = lstatOptionalNoSymlinks(rootDir, dir, label, `${label} must not contain symlinks`);
    if (!entry) {
      mkdirSync(dir);
      const created = lstatRequiredNoSymlinks(rootDir, dir, label, `${label} must not contain symlinks`);
      if (!created.isDirectory()) throw new Error(`${label} must be a directory: ${dir}`);
      continue;
    }
    if (!entry.isDirectory()) throw new Error(`${label} must be a directory: ${dir}`);
  }
  return dirs[dirs.length - 1];
}

function readSeedHashes(repo, file) {
  const text = readManagedSeedText(repo, file, "repo-seeded feature skill metadata '.seed-hash'");
  if (text === null) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readManagedSeedText(repo, file, label) {
  const entry = lstatOptionalNoSymlinks(resolve(repo), file, label, `${label} must not contain symlinks`);
  if (!entry) return null;
  if (!entry.isFile()) throw new Error(`${label} must be a file: ${file}`);
  return readFileSync(file, "utf8");
}

function writeManagedSeedFileAtomic(repo, directory, target, contents) {
  const rootDir = resolve(repo);
  const directoryEntry = lstatRequiredNoSymlinks(rootDir, directory, "repo-seeded feature skill directory", "repo-seeded feature skill directory must not contain symlinks");
  if (!directoryEntry.isDirectory()) throw new Error(`repo-seeded feature skill directory must be a directory: ${directory}`);
  const targetEntry = lstatOptionalNoSymlinks(rootDir, target, `repo-seeded feature skill file '${basename(target)}'`, `repo-seeded feature skill file '${basename(target)}' must not contain symlinks`);
  if (targetEntry && !targetEntry.isFile()) throw new Error(`repo-seeded feature skill file '${basename(target)}' must be a file: ${target}`);

  const temp = createManagedSeedTempFile(directory);
  let closed = false;
  try {
    try {
      writeFileSync(temp.fd, contents, "utf8");
    } finally {
      closeSync(temp.fd);
      closed = true;
    }
    renameSync(temp.path, target);
  } finally {
    if (!closed) {
      try {
        closeSync(temp.fd);
      } catch {
        // Best-effort cleanup; the original write/rename error is more useful.
      }
    }
    if (existsSync(temp.path)) rmSync(temp.path, { force: true });
  }
}

function createManagedSeedTempFile(directory) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = join(directory, `.seed-${process.pid}-${randomUUID()}.tmp`);
    try {
      return {
        path: tempPath,
        fd: openSync(tempPath, exclusiveNoFollowWriteFlags(), 0o600),
      };
    } catch (error) {
      if (error?.code === "EEXIST") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error(`unable to create temporary repo-seeded feature skill file in ${directory}`);
}

function knownSeedHashesFor(knownSeedHashes, file) {
  const configured = knownSeedHashes || PACKAGED_SEED_HASHES;
  const hashes = configured[file];
  if (hashes instanceof Set) return hashes;
  return Array.isArray(hashes) ? new Set(hashes) : new Set();
}

function validSha256(value) {
  return typeof value === "string" && HASH_PATTERN.test(value) ? value : null;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ensureGitInfoExclude(repo, pattern) {
  const proc = git(repo, ["rev-parse", "--git-path", "info/exclude"]);
  if (!proc.ok) return;
  const excludePath = resolve(repo, proc.stdout.trim());
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (current.split(/\r?\n/).includes(pattern)) return;
  appendFileSync(excludePath, `${current.endsWith("\n") || !current ? "" : "\n"}${pattern}\n`);
}

function formatPrompt(prompt, opts) {
  return encodeFeatureCommandPayload(featureCommandPayload(prompt, opts));
}

export function validateSlices(plan) {
  return validateSlicesPlan(plan);
}

function buildResumePayload(run, opts) {
  const steering = {
    schema_version: 1,
    kind: "operator-steering-pointer",
    run_id: run.run_id,
    pending: null,
    uncheckpointed: null,
    consume: null,
    raw_message_included: false,
  };
  const pending = steeringPendingMetadata(run.steering?.pending);
  const uncheckpointed = steeringConsumedMetadata(run.steering?.uncheckpointed);
  const pointer = pending || uncheckpointed;
  if (pointer) {
    steering.pending = pending;
    steering.uncheckpointed = uncheckpointed;
    steering.consume = {
      command: "feature-factory",
      args: ["factory", "steer-consume", run.run_id, "--ref", pointer.ref, "--hash", pointer.hash, "--json"],
    };
  }
  return {
    operator_request: `resume ${run.run_id}`,
    driver: {
      mode: opts.autonomous ? "autonomous" : opts.headless ? "headless" : "interactive",
      ready: false,
      pr_mode: run.pr_mode || null,
      reviewer: null,
      github_account: resolveGithubAccount(opts),
    },
    resume: {
      schema_version: 1,
      kind: "existing-run-resume",
      run_id: run.run_id,
      ...(run.post_pr?.policy ? { post_pr_policy: cloneJson(run.post_pr.policy) } : {}),
    },
    steering,
  };
}

function resumeEligibility(runDir, run, opts = {}) {
  const reasons = [];
  if (run.status !== "running") reasons.push(TERMINAL_STATUSES.has(run.status) ? "terminal-run" : "run-not-running");
  const diagnostics = diagnoseRunObject(run, { ...publicDiagnosticOptions(opts, opts.repoRoot || factoryRepoFromRunDir(runDir)), runDir, runFile: join(runDir, "run.json") });
  if (diagnosticsFailClosed(diagnostics)) reasons.push("invalid-run-state");
  const steeringChecks = steeringConsistencyChecks(runDir, run);
  if (!steeringChecks.every((item) => item.ok)) reasons.push("invalid-run-state");
  if (Array.isArray(diagnostics.items) && diagnostics.items.some((item) => item?.condition === "missing-worktree")) reasons.push("missing-worktree");
  const heartbeat = tryReadHeartbeatFile(heartbeatPath(runDir));
  if (heartbeat.error) reasons.push("invalid-run-state");
  else if (heartbeat.value && heartbeatBlocksReplacement(heartbeat.value, timestamp(opts.now), opts)) reasons.push("active-heartbeat");
  if (run.steering?.action_claim) reasons.push("action-start-pending");
  if (run.steering?.pr_fence) reasons.push("pre-pr-fence-active");
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], diagnostics, steering_checks: steeringChecks, heartbeat: heartbeat.value ? withHeartbeatLiveness(heartbeat.value, opts) : null };
}

function assertResumeMutationAllowed(runDir, run, opts = {}) {
  const eligibility = resumeEligibility(runDir, run, opts);
  if (!eligibility.eligible) throw new Error(`record-resume requires resumable run: ${eligibility.reasons.join(", ")}`);
  return eligibility;
}

function steeringSummary(run) {
  const steering = run?.steering;
  if (!steering || typeof steering !== "object" || Array.isArray(steering)) return { pending: null, uncheckpointed: null, consumed_count: 0, latest_consumed: null, boundary: null, action_claim: null, last_action: null, pr_fence: null };
  const consumed = Array.isArray(steering.history) ? steering.history.filter((item) => item?.event === "consumed") : [];
  const latest = consumed[consumed.length - 1] || null;
  return {
    pending: steeringPendingMetadata(steering.pending),
    uncheckpointed: steeringConsumedMetadata(steering.uncheckpointed),
    consumed_count: consumed.length,
    latest_consumed: latest ? {
      id: latest.id,
      ref: latest.ref,
      hash: latest.hash,
      message_chars: latest.message_chars,
      created_at: latest.created_at,
      consumed_at: latest.consumed_at,
    } : null,
    boundary: steeringBoundaryMetadata(steering.boundary),
    action_claim: steeringActionMetadata(steering.action_claim),
    last_action: steeringActionMetadata(steering.last_action),
    pr_fence: steeringFenceMetadata(steering.pr_fence),
  };
}

function steeringPendingMetadata(pending) {
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) return null;
  return {
    id: pending.id,
    ref: pending.ref,
    hash: pending.hash,
    message_chars: pending.message_chars,
    created_at: pending.created_at,
  };
}

function steeringConsumedMetadata(consumed) {
  const metadata = steeringPendingMetadata(consumed);
  if (!metadata) return null;
  return { ...metadata, consumed_at: consumed.consumed_at };
}

function steeringBoundaryMetadata(boundary) {
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return null;
  return { kind: boundary.kind, token: boundary.token, generation: boundary.generation, state_hash: boundary.state_hash, created_at: boundary.created_at };
}

function steeringFenceMetadata(fence) {
  if (!fence || typeof fence !== "object" || Array.isArray(fence)) return null;
  return { token: fence.token, generation: fence.generation, state_hash: fence.state_hash, created_at: fence.created_at };
}

function steeringActionMetadata(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  return {
    kind: action.kind,
    token: action.token,
    generation: action.generation,
    claimed_at: action.claimed_at,
    outcome: action.outcome || null,
    resolved_at: action.resolved_at || null,
  };
}

function featureCommandPayload(prompt, opts) {
  const githubAccount = resolveGithubAccount(opts);
  const driver = {
    mode: opts.autonomous ? "autonomous" : opts.headless ? "headless" : "interactive",
    ready: Boolean(opts.ready),
    pr_mode: runPrModeOverride(opts),
    reviewer: stringValue(opts.reviewer) ? opts.reviewer : opts.continuation?.post_pr?.policy?.review?.reviewer_login || null,
    github_account: githubAccount,
  };
  const postPrPolicy = postPrDriverOverride(opts);
  if (postPrPolicy !== null) driver.post_pr_ci = postPrPolicy;
  else if (opts.continuation?.post_pr?.policy) driver.post_pr_ci = Object.fromEntries(Object.entries(cloneJson(opts.continuation.post_pr.policy)).filter(([key]) => key !== "review"));
  if (stringValue(opts.requestedRunId)) driver.run_id = opts.requestedRunId;
  const payload = {
    operator_request: String(prompt),
    driver,
  };
  if (opts.continuation !== undefined) payload.continuation = opts.continuation;
  return payload;
}

function runPrModeOverride(opts = {}) {
  if (opts.draft === true) return "draft";
  if (opts.noDraft === true || opts.ready === true) return "ready";
  return null;
}

function resolveGithubAccount(opts) {
  if (opts.ghAccount !== undefined && opts.ghAccount !== null) {
    const account = normalizeGithubAccount(opts.ghAccount);
    if (!account) throw new Error("--gh-account must be a valid GitHub account name");
    return account;
  }
  return detectGithubRemoteOwner(opts.repo || opts.cwd || process.cwd());
}

function detectGithubRemoteOwner(repo) {
  const proc = git(repo, ["config", "--get", "remote.origin.url"]);
  if (!proc.ok) return null;
  return githubOwnerFromRemote(proc.stdout.trim());
}

function githubOwnerFromRemote(remote) {
  const text = String(remote || "").trim();
  if (!text) return null;
  const match = text.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/.:]+)\//);
  return match ? normalizeGithubAccount(match[1]) : null;
}

function normalizeGithubAccount(value) {
  if (!stringValue(value)) return null;
  const account = String(value).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(account)) return null;
  return account;
}

function createHeartbeatRuntime(runDir, heartbeat, opts) {
  return {
    runDir,
    runId: heartbeat.run_id,
    intervalMs: heartbeat.interval_ms,
    tickTimeoutMs: normalizePositiveInteger(opts.tickTimeoutMs, HEARTBEAT_TICK_LOCK_TIMEOUT_MS, "tickTimeoutMs"),
    lockTimeouts: 0,
    timer: null,
    ticking: false,
    tickPromise: null,
    stopped: false,
  };
}

function runHeartbeatTick(runtime, lockOptions = {}) {
  if (runtime.stopped) return Promise.resolve({ continue: false, reason: "runtime-stopped" });
  if (runtime.tickPromise) return runtime.tickPromise;
  runtime.ticking = true;
  const tickPromise = (async () => {
    try {
      const next = await heartbeatTick(runtime, lockOptions);
      if (!next.continue) stopActiveHeartbeatLoop(runtime.runDir, runtime);
      return next;
    } catch (error) {
      stopActiveHeartbeatLoop(runtime.runDir, runtime);
      return { continue: false, reason: error.message };
    } finally {
      runtime.ticking = false;
      if (runtime.tickPromise === tickPromise) runtime.tickPromise = null;
    }
  })();
  runtime.tickPromise = tickPromise;
  return tickPromise;
}

async function heartbeatTick(runtime, lockOptions = {}) {
  const now = timestamp();
  try {
    return await withRunJsonLock(runtime.runDir, async () => {
      const heartbeat = tryReadHeartbeatFile(heartbeatPath(runtime.runDir));
      if (heartbeat.error || !heartbeat.value) return { continue: false, reason: heartbeat.error ? "invalid-heartbeat" : "missing-heartbeat" };
      if (heartbeat.value.pid !== process.pid) return { continue: false, reason: "heartbeat-not-owned" };

      const runPath = join(runtime.runDir, "run.json");
      const runResult = tryReadRunFile(runPath);
      if (runResult.error) {
        writeHeartbeatFile(heartbeatPath(runtime.runDir), validateHeartbeatState({ ...heartbeat.value, pid: null }));
        return { continue: false, reason: "missing-or-invalid-run" };
      }

      const run = runResult.value;
      if (run.steering?.pr_fence) return { continue: false, reason: "pre-pr-fence-active" };
      if (TERMINAL_STATUSES.has(run.status)) {
        writeHeartbeatFile(heartbeatPath(runtime.runDir), validateHeartbeatState({ ...heartbeat.value, pid: null }));
        return { continue: false, reason: "terminal-status" };
      }
      const protectedGate = pendingProtectedGate(run);
      if (protectedGate) {
        writeHeartbeatFile(heartbeatPath(runtime.runDir), validateHeartbeatState({ ...heartbeat.value, pid: null }));
        return { continue: false, reason: "protected-gate-pending" };
      }
      if (!hasInFlightHeartbeatWork(run)) {
        writeHeartbeatFile(heartbeatPath(runtime.runDir), validateHeartbeatState({ ...heartbeat.value, pid: null }));
        return { continue: false, reason: "no-in-flight-work" };
      }

      const nextHeartbeat = validateHeartbeatState({ ...heartbeat.value, pid: process.pid, last_tick_at: now });
      const nextRun = validateRun({ ...run, heartbeat_at: now });
      writeHeartbeatFile(heartbeatPath(runtime.runDir), nextHeartbeat);
      writeJsonAtomic(runPath, nextRun);
      runtime.lockTimeouts = 0;
      return { continue: true, reason: null };
    }, heartbeatTickLockOptions(runtime, lockOptions));
  } catch (error) {
    if (isRunJsonLockTimeout(error) && runtime.lockTimeouts < HEARTBEAT_TICK_LOCK_RETRIES) {
      runtime.lockTimeouts += 1;
      return { continue: true, reason: "lock-timeout" };
    }
    return { continue: false, reason: error.message };
  }
}

function heartbeatTickLockOptions(runtime, lockOptions = {}) {
  const allowed = ["lockHooks", "retryDelayMs", "staleLockMs", "missingOwnerStealMs", "processAliveFn"];
  const options = { timeoutMs: lockOptions.timeoutMs ?? runtime.tickTimeoutMs };
  for (const key of allowed) {
    if (lockOptions[key] !== undefined) options[key] = lockOptions[key];
  }
  return options;
}

export async function runActiveHeartbeatTickForTest(runId, opts = {}) {
  const runDir = resolveHeartbeatRunDir(runId, opts);
  const runtime = activeHeartbeatLoops.get(runDir);
  if (!runtime) throw new Error(`no active heartbeat runtime for run '${runId}'`);
  const inFlight = runtime.tickPromise;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  if (inFlight) {
    await inFlight;
    throw new Error(`controlled heartbeat tick did not run for '${runId}': tick already in progress`);
  }
  return runHeartbeatTick(runtime, opts);
}

function isRunJsonLockTimeout(error) {
  return /timed out waiting for run\.json lock/u.test(error?.message || "");
}

function stopActiveHeartbeatLoop(runDir, runtime = activeHeartbeatLoops.get(runDir)) {
  if (!runtime) return false;
  runtime.stopped = true;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  if (activeHeartbeatLoops.get(runDir) === runtime) activeHeartbeatLoops.delete(runDir);
  return true;
}

function heartbeatPath(runDir) {
  return join(runDir, HEARTBEAT_FILE);
}

function readHeartbeatFile(file) {
  return validateHeartbeatState(JSON.parse(readFileSync(file, "utf8")));
}

function tryReadHeartbeatFile(file) {
  if (!existsSync(file)) return { value: null, error: null };
  try {
    return { value: readHeartbeatFile(file), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function writeHeartbeatFile(file, heartbeat) {
  const next = validateHeartbeatState(heartbeat);
  writeJsonAtomic(file, next);
}

function withHeartbeatLiveness(heartbeat, opts = {}) {
  const now = timestamp(opts.now);
  const liveness = heartbeatLiveness(heartbeat, now, opts);
  return { ...heartbeat, ...liveness };
}

function heartbeatIsFresh(heartbeat, now, opts = {}) {
  return heartbeatLiveness(heartbeat, now, opts).fresh;
}

function heartbeatLiveness(heartbeat, now, opts = {}) {
  const nowMs = Date.parse(now);
  const lastTickMs = Date.parse(heartbeat.last_tick_at || "");
  const intervalMs = Number.isInteger(heartbeat.interval_ms) && heartbeat.interval_ms > 0 ? heartbeat.interval_ms : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleMs = Math.max(2 * intervalMs, 120000);
  const processStatus = heartbeatProcessLiveness(heartbeat.pid, opts);
  const processAlive = publicLivenessBoolean(processStatus);
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(lastTickMs) ? Math.max(0, nowMs - lastTickMs) : null;
  return {
    fresh: processAlive === true && ageMs !== null && ageMs <= staleMs,
    process_alive: processAlive,
    age_ms: ageMs,
    stale_after: Number.isFinite(lastTickMs) ? new Date(lastTickMs + staleMs).toISOString() : null,
  };
}

function assertPostPrCliOptions(opts, { command, resume = false } = {}) {
  if (opts.postPrCi && opts.noPostPrCi) throw new Error(`${command} accepts only one of --post-pr-ci or --no-post-pr-ci`);
  const timing = [opts.postPrWaitMinutes, opts.postPrPollSeconds, opts.postPrMaxPollSeconds, opts.postPrCheckStartGraceSeconds, opts.postPrMaxTransientErrors];
  if (resume && (opts.postPrCi || opts.noPostPrCi || timing.some((value) => value !== undefined))) throw new Error("factory resume rejects post-PR policy flags; the persisted policy is authoritative");
  if (!resume && timing.some((value) => value !== undefined) && !opts.postPrCi) throw new Error(`${command} post-PR timing flags require --post-pr-ci`);
  postPrDriverOverride(opts);
}

function postPrDriverOverride(opts = {}) {
  const hasTiming = [opts.postPrWaitMinutes, opts.postPrPollSeconds, opts.postPrMaxPollSeconds, opts.postPrCheckStartGraceSeconds, opts.postPrMaxTransientErrors].some((value) => value !== undefined);
  if (!opts.postPrCi && !opts.noPostPrCi && !hasTiming) return null;
  const policy = { enabled: Boolean(opts.postPrCi) };
  for (const [field, value, multiplier, min, max] of [
    ["wait_ms", opts.postPrWaitMinutes, 60_000, 30, 1440], ["initial_poll_ms", opts.postPrPollSeconds, 1000, 15, 300],
    ["max_poll_ms", opts.postPrMaxPollSeconds, 1000, 15, 600], ["check_start_grace_ms", opts.postPrCheckStartGraceSeconds, 1000, 60, 900],
    ["max_transient_errors", opts.postPrMaxTransientErrors, 1, 1, 50],
  ]) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
    policy[field] = value * multiplier;
  }
  if (policy.max_poll_ms !== undefined && policy.initial_poll_ms !== undefined && policy.max_poll_ms < policy.initial_poll_ms) throw new Error("post-PR maximum poll must be greater than or equal to initial poll");
  return policy;
}

function assertPostPrExternalWorkReady(runDir, run, opts = {}) {
  if (run.steering?.pending || run.steering?.uncheckpointed) throw new Error("post-PR work requires steering to be drained and acknowledged first");
  if (run.steering?.boundary || run.steering?.action_claim || run.steering?.pr_fence) throw new Error("post-PR work requires no open steering boundary, action claim, or PR fence");
  const heartbeat = tryReadHeartbeatFile(heartbeatPath(runDir));
  if (heartbeat.error) throw new Error(`post-PR work requires valid inactive heartbeat: ${heartbeat.error}`);
  if (heartbeat.value && heartbeatBlocksReplacement(heartbeat.value, timestamp(opts.now), opts)) throw new Error("post-PR work requires inactive heartbeat");
}

async function claimPostPrAction(runDir, kind, opts = {}) {
  const opened = await transitionSteeringBoundaryOpened(runDir, kind, opts);
  const crossed = await transitionSteeringBoundaryCrossed(runDir, kind, opened.boundary.token, { ...opts, expectedCurrentHash: hashRunState(opened.run) });
  const started = await transitionSteeringActionStarted(runDir, kind, crossed.action_claim.token, { ...opts, expectedCurrentHash: hashRunState(crossed.run) });
  return { kind, token: crossed.action_claim.token, generation: started.run.steering?.generation ?? crossed.action_claim.generation, state_hash: hashRunState(started.run) };
}

function assertPostPrActionFresh(runDir, action) {
  if (!action) throw new Error("post-PR action context is missing");
  const current = readRunFile(join(runDir, "run.json"));
  if (hashRunState(current) !== action.state_hash || current.steering?.generation !== action.generation || current.steering?.last_action?.token !== action.token || current.steering?.last_action?.outcome !== "started") {
    throw new Error("post-PR action became stale; discard external result");
  }
  return current;
}

function githubOperationInput(repo, run, opts, extra = {}) {
  return { repositoryRoot: repo, cwd: repo, account: run.github_account, executable: opts.ghExecutable, execute: opts.executeGithub, spawnImpl: opts.spawnImpl, lockOptions: opts.githubLockOptions, ...extra };
}

function remediationDispatchEnvelope(run) {
  const remediation = run.post_pr.remediation;
  return {
    schema_version: 1,
    kind: "post-pr-remediation-dispatch",
    run_id: run.run_id,
    attempt: remediation.attempt,
    dispatch_id: remediation.dispatch.id,
    role: remediation.route,
    subject: remediation.dispatch.subject,
    lane: remediation.lane,
    owner: cloneJson(remediation.owner),
    failed_head_sha: remediation.failed_head_sha,
    baseline_head_sha: remediation.baseline_head_sha,
    failure_evidence: { ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash },
  };
}

async function reconcilePostPrCrash(runDir, opts = {}) {
  const run = readRunFile(join(runDir, "run.json"));
  if (run.status !== "running" || run.post_pr?.policy?.enabled !== true) return { action: "none" };
  if (!opts.dryRun && run.post_pr.phase === "remote-confirmed") return beginPostPrEpoch(runDir, run, opts);
  if (!opts.dryRun && run.post_pr.phase === "push-pending") return reconcilePostPrPush(factoryRepoFromRunDir(runDir), runDir, run, opts);
  if (!opts.dryRun && run.post_pr.phase === "validated") return enterAndReconcilePostPrPush(factoryRepoFromRunDir(runDir), runDir, run, opts);
  if (run.post_pr.phase === "observing" && run.post_pr.observation?.last_check_verdict === "red" && !run.post_pr.remediation) {
    const adopted = await adoptUnboundFailureEvidence(runDir, run, opts);
    if (adopted) return adopted;
  }
  if (run.post_pr.phase === "revalidating") return reconcilePostPrRevalidation(runDir, run, opts);
  if (run.post_pr.phase === "failure-recording" && run.post_pr.remediation) {
    const action = await claimPostPrAction(runDir, "post-pr-observe", { ...opts, expectedCurrentHash: hashRunState(run) });
    const evidencePath = join(runDir, run.post_pr.remediation.failure_evidence_ref);
    if (!existsSync(evidencePath)) {
      let regenerated;
      try { regenerated = await reconstructFailureEvidence(factoryRepoFromRunDir(runDir), runDir, run, run.post_pr.remediation.attempt, opts); }
      catch { return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts, { unsafe_regenerated_evidence: run.post_pr.remediation.failure_evidence_ref }); }
      if (regenerated.failure_fingerprint !== run.post_pr.remediation.failure_fingerprint || !sameJsonValue(regenerated.ownership.owner, run.post_pr.remediation.owner)) return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts, { unsafe_regenerated_evidence: run.post_pr.remediation.failure_evidence_ref });
      const binding = publishRunJsonEvidence(runDir, run.post_pr.remediation.failure_evidence_ref, regenerated);
      assertPostPrActionFresh(runDir, action);
      if (binding.hash !== run.post_pr.remediation.failure_evidence_hash) {
        rmSync(evidencePath, { force: true });
        return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts, { conflicting_regenerated_evidence: run.post_pr.remediation.failure_evidence_ref });
      }
    } else if (sha256File(evidencePath) !== run.post_pr.remediation.failure_evidence_hash) {
      return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts, { conflicting_evidence: run.post_pr.remediation.failure_evidence_ref });
    }
    const next = cloneJson(run.post_pr); next.phase = "remediation-planned";
    await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: action.state_hash });
    return { action: "adopted-failure-evidence" };
  }
  if (run.post_pr.phase !== "remediation-running" || run.post_pr.remediation?.dispatch?.status !== "running") return { action: "none" };
  if (run.steering?.pending || run.steering?.uncheckpointed || run.steering?.action_claim) return { action: "steering-pending" };
  const heartbeat = tryReadHeartbeatFile(heartbeatPath(runDir));
  if (heartbeat.error || heartbeat.value && heartbeatBlocksReplacement(heartbeat.value, timestamp(opts.now), opts)) return { action: "heartbeat-active" };
  const remediation = run.post_pr.remediation;
  if (!stringValue(run.worktree)) return terminalDispatchUnknown(runDir, run, opts);
  const statusResult = git(run.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!statusResult.ok) return terminalDispatchUnknown(runDir, run, opts);
  let snapshot;
  try { snapshot = parseGitStatusChanges(statusResult.stdout); } catch { return terminalDispatchUnknown(runDir, run, opts); }
  if (snapshot.paths.length) {
    const repeated = git(run.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let repeatedSnapshot;
    try { repeatedSnapshot = repeated.ok ? parseGitStatusChanges(repeated.stdout) : null; } catch { repeatedSnapshot = null; }
    if (!repeatedSnapshot || !sameJsonValue(snapshot, repeatedSnapshot)) return terminalDispatchUnknown(runDir, run, opts);
    const { paths, entries } = snapshot;
    const plan = acceptedSlicesPlan(runDir, run);
    const slice = remediation.owner.kind === "slice" ? plan.slices.find((item) => item.id === remediation.owner.slice_id) : null;
    const lane = validateLane({ lane: remediation.lane, slice, paths, changes: entries, hasSymlink: gitChangesHaveUnsafeMode(run.worktree, entries) });
    if (!lane.ok) return terminalLaneViolation(runDir, run, opts, lane.reason, paths);
    const next = cloneJson(run.post_pr);
    next.phase = "changes-observed"; next.remediation.stage = "changes-observed"; next.remediation.dispatch.status = "returned";
    next.remediation.dispatch.returned_at = timestamp(opts.now); next.remediation.changes = { paths, entries, tree_hash: hashJson(entries) };
    await transitionPostPrState(runDir, next, opts);
    return { action: "adopted-dirty-diff", paths };
  }
  const headResult = git(run.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const head = headResult.ok ? headResult.stdout.trim() : null;
  if (head && head !== remediation.baseline_head_sha && git(run.worktree, ["merge-base", "--is-ancestor", remediation.baseline_head_sha, head]).ok) {
    let diff;
    try { diff = committedChangedDiff(run.worktree, remediation.baseline_head_sha, head); } catch { return terminalDispatchUnknown(runDir, run, opts); }
    if (!diff.paths.length) return terminalDispatchUnknown(runDir, run, opts);
    const plan = acceptedSlicesPlan(runDir, run); const slice = remediation.owner.kind === "slice" ? plan.slices.find((item) => item.id === remediation.owner.slice_id) : null;
    const lane = validateLane({ lane: remediation.lane, slice, paths: diff.paths, changes: diff.changes, hasSymlink: gitChangesHaveUnsafeMode(run.worktree, diff.changes) });
    if (!lane.ok) return terminalLaneViolation(runDir, run, opts, lane.reason, diff.paths);
    const next = cloneJson(run.post_pr);
    next.phase = "changes-observed"; next.remediation.stage = "changes-observed"; next.remediation.dispatch.status = "returned"; next.remediation.dispatch.returned_at = timestamp(opts.now);
    next.remediation.changes = { paths: diff.paths, entries: diff.changes, tree_hash: hashJson(diff.changes) }; next.remediation.candidate_head_sha = head;
    await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree });
    next.phase = "committed"; next.remediation.stage = "committed";
    await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree });
    return { action: "adopted-descendant", head_sha: head };
  }
  return terminalDispatchUnknown(runDir, run, opts);
}

function newPostPrJob(activity, attempt) {
  return { dispatch_id: `${activity}-${attempt}-${randomUUID()}`, status: "planned", action_token: null, steering_generation: null, started_at: null, returned_at: null,
    result_ref: null, result_hash: null, verdict: null, transient_error_count: 0, next_retry_at: null, last_error: null };
}

async function reconcilePostPrRevalidation(runDir, initialRun, opts) {
  let run = initialRun;
  let jobs = run.post_pr.remediation.revalidation.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    const next = cloneJson(run.post_pr);
    next.remediation.revalidation.jobs = {};
    const revalidation = next.remediation.revalidation;
    if (revalidation.canonical_evidence_ref) next.remediation.revalidation.jobs.canonical = boundLegacyJob("canonical", run.post_pr.attempt, revalidation.canonical_evidence_ref, revalidation.canonical_evidence_hash, revalidation.canonical_verdict);
    else next.remediation.revalidation.jobs.canonical = newPostPrJob("canonical", run.post_pr.attempt);
    if (revalidation.validator_review_ref) next.remediation.revalidation.jobs.validator = boundLegacyJob("validator", run.post_pr.attempt, revalidation.validator_review_ref, revalidation.validator_review_hash, revalidation.validator_verdict);
    if (revalidation.security_review_ref) next.remediation.revalidation.jobs.security = boundLegacyJob("security", run.post_pr.attempt, revalidation.security_review_ref, revalidation.security_review_hash, revalidation.security_verdict);
    const persisted = await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree, expectedCurrentHash: hashRunState(run) });
    run = persisted.run; jobs = run.post_pr.remediation.revalidation.jobs;
  }
  const canonical = jobs.canonical;
  if (!canonical) {
    const next = cloneJson(run.post_pr); next.remediation.revalidation.jobs.canonical = newPostPrJob("canonical", run.post_pr.attempt);
    await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(run) });
    return { action: "canonical-planned" };
  }
  if (canonical.status !== "bound") return dispatchPostPrRecoveryJob(runDir, run, "canonical", opts);
  const validator = jobs.validator;
  if (!validator) {
    const next = cloneJson(run.post_pr); next.remediation.revalidation.jobs.validator = newPostPrJob("validator", run.post_pr.attempt);
    await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(run) });
    return { action: "validator-planned" };
  }
  if (validator.status !== "bound") return dispatchPostPrRecoveryJob(runDir, run, "validator", opts);
  const security = jobs.security;
  if (!security) {
    const next = cloneJson(run.post_pr); next.remediation.revalidation.jobs.security = newPostPrJob("security", run.post_pr.attempt);
    await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(run) });
    return { action: "security-planned" };
  }
  if (security.status !== "bound") return dispatchPostPrRecoveryJob(runDir, run, "security", opts);
  return evaluateBoundPostPrPanels(runDir, run, opts);
}

function boundLegacyJob(activity, attempt, ref, hash, verdict) {
  return { ...newPostPrJob(activity, attempt), dispatch_id: `legacy-${activity}-${attempt}`, status: "bound", returned_at: "1970-01-01T00:00:00.000Z", result_ref: ref, result_hash: hash, verdict };
}

async function dispatchPostPrRecoveryJob(runDir, initialRun, activity, opts) {
  let run = initialRun;
  let job = run.post_pr.remediation.revalidation.jobs[activity];
  if (job.status === "running") {
    const fixed = fixedPostPrJobRefs(run.post_pr.attempt, activity);
    const presence = fixed.map((ref) => existsSync(join(runDir, ref)));
    const present = presence.every(Boolean);
    if (present) return bindPublishedPostPrJob(runDir, run, activity, opts);
    if (presence.some(Boolean)) return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts);
    return terminalRevalidationDispatchUnknown(runDir, run, activity, opts);
  }
  if (job.status === "retry-wait" && Date.parse(timestamp(opts.now)) < Date.parse(job.next_retry_at || "")) return { action: `${activity}-retry-not-due`, next_retry_at: job.next_retry_at };
  if (job.status !== "planned" && job.status !== "retry-wait") return { action: `${activity}-${job.status}` };
  const action = await claimPostPrAction(runDir, "remediation", { ...opts, expectedCurrentHash: hashRunState(run) });
  run = readRunFile(join(runDir, "run.json"));
  const next = cloneJson(run.post_pr);
  job = next.remediation.revalidation.jobs[activity];
  Object.assign(job, { status: "running", action_token: action.token, steering_generation: action.generation, started_at: timestamp(opts.now), returned_at: null, next_retry_at: null, last_error: null });
  const persisted = await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: action.state_hash });
  run = persisted.run;
  const envelope = postPrRecoveryEnvelope(runDir, run, activity);
  let heartbeatStarted = false;
  let returned;
  try {
    await startHeartbeat(run.run_id, { phase: `post-pr-${activity}`, intervalMs: opts.heartbeatIntervalMs }, { ...opts, cwd: factoryRepoFromRunDir(runDir) });
    heartbeatStarted = true;
    if (typeof opts.executePostPrRecoveryJob === "function") returned = await opts.executePostPrRecoveryJob(cloneJson(envelope));
    else if (activity === "canonical") {
      const result = await runBoundedProcess({ executable: "npm", args: ["run", "check"], cwd: run.worktree, timeoutMs: 1_800_000, stdoutCap: 4 * 1024 * 1024, stderrCap: 4 * 1024 * 1024, spawnImpl: opts.spawnImpl });
      returned = { started: true, exit_code: result.exitCode, signal: result.signal, result: result.exitCode === 0 ? { verdict: "pass" } : { verdict: "red" } };
    } else return { action: `${activity}-running`, envelope };
  } finally {
    if (heartbeatStarted) await stopHeartbeat(run.run_id, {}, { ...opts, cwd: factoryRepoFromRunDir(runDir) });
  }
  const current = readRunFile(join(runDir, "run.json"));
  if (activity === "canonical") {
    if (!canonicalRecoveryTransport(returned)) return terminalRevalidationDispatchUnknown(runDir, current, activity, opts);
    return publishCanonicalRecoveryResult(runDir, current, returned, opts);
  }
  const inspected = inspectPanelRunnerReturn(returned, activity);
  if (inspected.disposition === "transport-unknown" || inspected.disposition === "absent") return terminalRevalidationDispatchUnknown(runDir, current, activity, opts);
  if (inspected.disposition === "malformed") return terminalMalformedPanelResult(runDir, current, activity, inspected.issue, opts);
  return publishPanelRecoveryResult(runDir, current, activity, inspected, opts);
}

function canonicalRecoveryTransport(value) {
  if (!value || typeof value !== "object") return false;
  try {
    const started = Object.getOwnPropertyDescriptor(value, "started"); const exitCode = Object.getOwnPropertyDescriptor(value, "exit_code"); const signal = Object.getOwnPropertyDescriptor(value, "signal"); const result = Object.getOwnPropertyDescriptor(value, "result");
    return started && "value" in started && started.value === true && exitCode && "value" in exitCode && Number.isInteger(exitCode.value) && exitCode.value >= 0 && ![126, 127].includes(exitCode.value)
      && signal && "value" in signal && signal.value === null && result && "value" in result && result.value !== undefined;
  } catch { return false; }
}

function fixedPostPrJobRefs(attempt, activity) {
  if (activity === "canonical") return [`evidence/post-pr-canonical.attempt-${attempt}.json`];
  if (activity === "validator") return [`artifacts/post-pr-validator.attempt-${attempt}.md`, `reviews/post-pr-validator.attempt-${attempt}.json`];
  return [`reviews/post-pr-security.attempt-${attempt}.json`];
}

function postPrRecoveryEnvelope(runDir, run, activity) {
  const remediation = run.post_pr.remediation;
  const common = { schema_version: 1, kind: "post-pr-revalidation-dispatch", activity, run_id: run.run_id, attempt: run.post_pr.attempt,
    dispatch_id: remediation.revalidation.jobs[activity].dispatch_id, role: activity === "canonical" ? "test-verifier" : activity === "validator" ? "implementation-validator" : "security-reviewer",
    subject: activity, head_sha: remediation.candidate_head_sha };
  if (activity === "canonical") return { ...common, command: { program: "npm", args: ["run", "check"], cwd: run.worktree, shell: false }, remediation_evidence: { ref: remediation.remediation_evidence_ref, hash: remediation.remediation_evidence_hash }, output_ref: fixedPostPrJobRefs(run.post_pr.attempt, activity)[0] };
  const planRef = "plan/slices.json";
  const planHash = sha256File(join(runDir, planRef));
  const panel = { ...common, accepted_plan: { ref: planRef, hash: planHash }, remediation_evidence: { ref: remediation.remediation_evidence_ref, hash: remediation.remediation_evidence_hash },
    canonical_evidence: { ref: remediation.revalidation.canonical_evidence_ref, hash: remediation.revalidation.canonical_evidence_hash } };
  return activity === "validator" ? { ...panel, report_ref: fixedPostPrJobRefs(run.post_pr.attempt, activity)[0], review_ref: fixedPostPrJobRefs(run.post_pr.attempt, activity)[1] }
    : { ...panel, output_ref: fixedPostPrJobRefs(run.post_pr.attempt, activity)[0] };
}

async function terminalMalformedPanelResult(runDir, run, activity, issue, opts) {
  const job = run.post_pr.remediation.revalidation.jobs[activity];
  return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts, {}, { schema_version: 1, kind: "panel-runner-result-malformed", observed_at: timestamp(opts.now),
    attempt: run.post_pr.attempt, activity, dispatch_id: job.dispatch_id, candidate_head_sha: run.post_pr.remediation.candidate_head_sha, issue });
}

async function terminalRevalidationDispatchUnknown(runDir, run, activity, opts) {
  const job = run.post_pr.remediation.revalidation.jobs[activity];
  return postPrTerminal(runDir, run, "needs-human", "post-pr-dispatch-start-unknown", opts, {}, { schema_version: 1, kind: "dispatch-start-unknown", observed_at: timestamp(opts.now),
    attempt: run.post_pr.attempt, activity, dispatch_id: job.dispatch_id, dispatch_started_at: job.started_at, candidate_head_sha: run.post_pr.remediation.candidate_head_sha, outcome: "return-unknown" });
}

async function publishCanonicalRecoveryResult(runDir, run, returned, opts) {
  const job = run.post_pr.remediation.revalidation.jobs.canonical;
  const resultDescriptor = Object.getOwnPropertyDescriptor(returned, "result");
  const exitDescriptor = Object.getOwnPropertyDescriptor(returned, "exit_code");
  const verdict = exitDescriptor.value === 0 && resultDescriptor && "value" in resultDescriptor && resultDescriptor.value?.verdict === "pass" ? "pass" : "red";
  const ref = fixedPostPrJobRefs(run.post_pr.attempt, "canonical")[0];
  const value = { schema_version: 1, kind: "post-pr-canonical", activity: "canonical", run_id: run.run_id, attempt: run.post_pr.attempt, dispatch_id: job.dispatch_id,
    head_sha: run.post_pr.remediation.candidate_head_sha, fresh: true, command: { program: "npm", args: ["run", "check"], cwd: run.worktree, shell: false },
    remediation: { ref: run.post_pr.remediation.remediation_evidence_ref, hash: run.post_pr.remediation.remediation_evidence_hash }, verdict, exit_code: exitDescriptor.value,
    started_at: job.started_at, completed_at: timestamp(opts.now) };
  const binding = publishRunJsonEvidence(runDir, ref, value);
  const next = cloneJson(run.post_pr); const bound = next.remediation.revalidation.jobs.canonical;
  Object.assign(bound, { status: "bound", returned_at: value.completed_at, result_ref: binding.ref, result_hash: binding.hash, verdict });
  Object.assign(next.remediation.revalidation, { canonical_evidence_ref: binding.ref, canonical_evidence_hash: binding.hash, canonical_verdict: verdict });
  if (verdict === "pass") next.remediation.revalidation.jobs.validator ||= newPostPrJob("validator", run.post_pr.attempt);
  await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(run) });
  return { action: `canonical-${verdict}`, evidence: binding };
}

async function publishPanelRecoveryResult(runDir, run, activity, inspected, opts) {
  const remediation = run.post_pr.remediation;
  const job = remediation.revalidation.jobs[activity];
  const snapshot = snapshotPanelAffectedValue(inspected.affectedDescriptor);
  const completedAt = timestamp(opts.now);
  const identity = { schema_version: 1, activity, run_id: run.run_id, attempt: run.post_pr.attempt, dispatch_id: job.dispatch_id, head_sha: remediation.candidate_head_sha, fresh: true, verdict: inspected.verdict,
    ...(snapshot.ok ? { affected_paths: snapshot.value } : {}) };
  let binding;
  if (activity === "validator") {
    const reportPayload = { schema_version: 1, kind: "post-pr-validator-report", ...Object.fromEntries(Object.entries(identity).filter(([key]) => key !== "schema_version")), started_at: job.started_at, completed_at: completedAt };
    const reportRef = fixedPostPrJobRefs(run.post_pr.attempt, activity)[0];
    const reportBytes = `# Post-PR validator report\n\n\`\`\`json\n${emitAffectedJson(reportPayload, { pretty: true, byteLimit: 2_097_152 })}\n\`\`\`\n`;
    const report = publishRunBytes(runDir, reportRef, reportBytes);
    const reviewRef = fixedPostPrJobRefs(run.post_pr.attempt, activity)[1];
    const reviewValue = { schema_version: 1, kind: "post-pr-validator-review", ...Object.fromEntries(Object.entries(identity).filter(([key]) => key !== "schema_version")), report, started_at: job.started_at, completed_at: completedAt };
    binding = publishRunBytes(runDir, reviewRef, `${emitAffectedJson(reviewValue, { pretty: true, byteLimit: 2_097_152 })}\n`);
  } else {
    const securityValue = { schema_version: 1, kind: "post-pr-security-review", ...Object.fromEntries(Object.entries(identity).filter(([key]) => key !== "schema_version")), started_at: job.started_at, completed_at: completedAt };
    binding = publishRunBytes(runDir, fixedPostPrJobRefs(run.post_pr.attempt, activity)[0], `${emitAffectedJson(securityValue, { pretty: true, byteLimit: 2_097_152 })}\n`);
  }
  const attribution = snapshot.ok ? canonicalizePanelAffectedPaths(snapshot.value, run.worktree) : { ok: false, category: "missing-paths", paths: [], hash: affectedPathsHash([]) };
  if (!attribution.ok) return terminalPanelAttribution(runDir, run, activity, attribution, opts);
  const owner = classifyPanelOwner(runDir, run, attribution.paths, activity, inspected.verdict);
  if (!owner.ok) return terminalPanelAttribution(runDir, run, activity, { ...owner, hash: attribution.hash }, opts);
  if (activity === "security" && remediation.revalidation.validator_review_ref) {
    try {
      const validator = readBoundRunJson(runDir, remediation.revalidation.validator_review_ref, "reviews");
      const validatorPaths = canonicalizePanelAffectedPaths(validator.value.affected_paths, run.worktree);
      const validatorOwner = validatorPaths.ok ? classifyPanelOwner(runDir, run, validatorPaths.paths, "validator", validator.value.verdict) : validatorPaths;
      if (!validatorOwner.ok || validatorOwner.identity !== owner.identity) return terminalPanelAttribution(runDir, run, "combined", { category: "owner-conflict", hash: affectedPathsHash([...new Set([...(validatorPaths.paths || []), ...attribution.paths])].sort(byteSort)) }, opts);
    } catch { return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts); }
  }
  const next = cloneJson(run.post_pr); const bound = next.remediation.revalidation.jobs[activity];
  Object.assign(bound, { status: "bound", returned_at: completedAt, result_ref: binding.ref, result_hash: binding.hash, verdict: inspected.verdict });
  if (activity === "validator") {
    Object.assign(next.remediation.revalidation, { validator_review_ref: binding.ref, validator_review_hash: binding.hash, validator_verdict: inspected.verdict });
    next.remediation.revalidation.jobs.security ||= newPostPrJob("security", run.post_pr.attempt);
  } else Object.assign(next.remediation.revalidation, { security_review_ref: binding.ref, security_review_hash: binding.hash, security_verdict: inspected.verdict });
  await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(run) });
  return { action: `${activity}-bound`, review: binding };
}

function publishRunBytes(runDir, ref, bytes) {
  const path = resolve(runDir, ref); const rootDir = join(runDir, ref.split("/")[0]);
  if (!isLogicalContainedPath(rootDir, path, { allowEqual: false })) throw new Error("post-PR publication ref escapes run directory");
  const rootEntry = lstatOptionalNoSymlinks(runDir, rootDir, rootDir, "post-PR publication root must not contain symlinks");
  if (!rootEntry) mkdirSync(rootDir, { recursive: false }); else if (!rootEntry.isDirectory()) throw new Error("post-PR publication root must be a directory");
  if (existsSync(path)) { const entry = lstatRequiredNoSymlinks(runDir, path, ref, "post-PR publication must not contain symlinks"); if (!entry.isFile() || readFileSync(path, "utf8") !== bytes) throw new Error(`conflicting post-PR publication replay: ${ref}`); }
  else writeFileSync(path, bytes, { flag: "wx" });
  return { ref, hash: sha256File(path) };
}

function classifyPanelOwner(runDir, run, paths, activity, verdict) {
  const slices = acceptedSlicesPlan(runDir, run).slices;
  const identities = [];
  for (const path of paths) {
    const matches = slices.filter((slice) => slice.paths.some((accepted) => accepted === path || accepted.endsWith("/**") && path.startsWith(accepted.slice(0, -2))));
    if (matches.length > 1) return { ok: false, category: "mixed-owner", paths };
    if (matches.length === 1) identities.push(`slice:${matches[0].id}`);
    else if (path.startsWith("test/") || path.startsWith(".github/workflows/")) identities.push("integration:test-verifier");
    else return { ok: false, category: "unowned-path", paths };
  }
  const unique = [...new Set(identities)];
  if (unique.length !== 1) return { ok: false, category: "mixed-owner", paths };
  if (activity === "security" && verdict === "BLOCK" && unique[0] === "integration:test-verifier") return { ok: false, category: "security-block-without-slice-owner", paths };
  return { ok: true, identity: unique[0], paths };
}

async function terminalPanelAttribution(runDir, run, panel, attribution, opts) {
  return postPrTerminal(runDir, run, "needs-human", "post-pr-panel-attribution-unsafe", opts, {}, { schema_version: 1, kind: "panel-attribution-unsafe", observed_at: timestamp(opts.now),
    attempt: run.post_pr.attempt, candidate_head_sha: run.post_pr.remediation.candidate_head_sha, panel, category: attribution.category, affected_paths_hash: attribution.hash || affectedPathsHash([]) });
}

async function bindPublishedPostPrJob(runDir, run, activity, opts) {
  // Complete fixed-ref publication is authoritative; never redispatch a durable
  // running job. Re-opening and exact identity validation is delegated to the
  // same validators used by normal binding.
  try {
    if (activity === "canonical") {
      const ref = fixedPostPrJobRefs(run.post_pr.attempt, activity)[0]; const binding = readBoundRunJson(runDir, ref, "evidence"); validateCanonicalEvidence(run, binding, run.post_pr.remediation.candidate_head_sha);
      const verdict = binding.value.verdict === "pass" ? "pass" : binding.value.verdict === "red" ? "red" : null; if (!verdict) throw new Error("invalid canonical verdict");
      const next = cloneJson(run.post_pr); Object.assign(next.remediation.revalidation.jobs.canonical, { status: "bound", returned_at: binding.value.completed_at || timestamp(opts.now), result_ref: binding.ref, result_hash: binding.hash, verdict });
      Object.assign(next.remediation.revalidation, { canonical_evidence_ref: binding.ref, canonical_evidence_hash: binding.hash, canonical_verdict: verdict });
      if (verdict === "pass") next.remediation.revalidation.jobs.validator ||= newPostPrJob("validator", run.post_pr.attempt);
      await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(run) });
      return { action: "canonical-published-bound" };
    } else {
      const ref = fixedPostPrJobRefs(run.post_pr.attempt, activity).at(-1); const binding = readBoundRunJson(runDir, ref, activity === "validator" ? "reviews" : "reviews"); validateRecoveryPanelArtifact(run, binding, activity);
      const classified = classifyPersistedPanelArtifact(binding.value, activity); if (!classified.ok) throw new Error("invalid panel artifact shape");
      if (activity === "validator") {
        const report = binding.value.report; if (!report || report.ref !== fixedPostPrJobRefs(run.post_pr.attempt, activity)[0]) throw new Error("invalid validator report binding");
        const reportFile = readBoundRunFile(runDir, report.ref, "artifacts"); if (report.hash !== reportFile.hash) throw new Error("validator report hash mismatch");
      }
      const attribution = canonicalizePanelAffectedPaths(binding.value.affected_paths, run.worktree);
      if (!attribution.ok) return terminalPanelAttribution(runDir, run, activity, attribution, opts);
      const owner = classifyPanelOwner(runDir, run, attribution.paths, activity, classified.verdict); if (!owner.ok) return terminalPanelAttribution(runDir, run, activity, { ...owner, hash: attribution.hash }, opts);
      const next = cloneJson(run.post_pr); Object.assign(next.remediation.revalidation.jobs[activity], { status: "bound", returned_at: binding.value.completed_at, result_ref: binding.ref, result_hash: binding.hash, verdict: classified.verdict });
      if (activity === "validator") { Object.assign(next.remediation.revalidation, { validator_review_ref: binding.ref, validator_review_hash: binding.hash, validator_verdict: classified.verdict }); next.remediation.revalidation.jobs.security ||= newPostPrJob("security", run.post_pr.attempt); }
      else Object.assign(next.remediation.revalidation, { security_review_ref: binding.ref, security_review_hash: binding.hash, security_verdict: classified.verdict });
      await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(run) });
      return { action: `${activity}-published-bound` };
    }
  } catch { return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts); }
}

function classifyPersistedPanelArtifact(value, activity) {
  const allowed = activity === "validator" ? new Set(["schema_version", "kind", "activity", "run_id", "attempt", "dispatch_id", "head_sha", "fresh", "verdict", "affected_paths", "report", "started_at", "completed_at"])
    : new Set(["schema_version", "kind", "activity", "run_id", "attempt", "dispatch_id", "head_sha", "fresh", "verdict", "affected_paths", "started_at", "completed_at"]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) return { ok: false };
  const vocabulary = activity === "validator" ? ["GO", "GO-WITH-NITS", "NO-GO"] : ["PASS", "BLOCK"];
  return vocabulary.includes(value.verdict) ? { ok: true, verdict: value.verdict } : { ok: false };
}

function validateRecoveryPanelArtifact(run, binding, activity) {
  const value = binding.value; const job = run.post_pr.remediation.revalidation.jobs[activity];
  if (value.kind !== (activity === "validator" ? "post-pr-validator-review" : "post-pr-security-review") || value.run_id !== run.run_id || value.attempt !== run.post_pr.attempt || value.dispatch_id !== job.dispatch_id
    || value.head_sha !== run.post_pr.remediation.candidate_head_sha || value.fresh !== true) throw new Error("stale panel artifact");
}

async function evaluateBoundPostPrPanels(runDir, run, opts) {
  const revalidation = run.post_pr.remediation.revalidation;
  if (revalidation.canonical_verdict === "pass" && ["GO", "GO-WITH-NITS"].includes(revalidation.validator_verdict) && revalidation.security_verdict === "PASS") {
    const next = cloneJson(run.post_pr); next.phase = "validated"; next.remediation.stage = "validated";
    await transitionPostPrState(runDir, next, { ...opts, worktree: run.worktree, expectedCurrentHash: hashRunState(run) });
    return { action: "validated" };
  }
  let validator; let security; let paths;
  try {
    validator = readBoundRunJson(runDir, revalidation.validator_review_ref, "reviews"); security = readBoundRunJson(runDir, revalidation.security_review_ref, "reviews");
    validateRecoveryPanelArtifact(run, validator, "validator"); validateRecoveryPanelArtifact(run, security, "security");
    const validatorPaths = canonicalizePanelAffectedPaths(validator.value.affected_paths, run.worktree); const securityPaths = canonicalizePanelAffectedPaths(security.value.affected_paths, run.worktree);
    if (!validatorPaths.ok || !securityPaths.ok) return terminalPanelAttribution(runDir, run, !validatorPaths.ok ? "validator" : "security", !validatorPaths.ok ? validatorPaths : securityPaths, opts);
    const validatorOwner = classifyPanelOwner(runDir, run, validatorPaths.paths, "validator", validator.value.verdict); const securityOwner = classifyPanelOwner(runDir, run, securityPaths.paths, "security", security.value.verdict);
    if (!validatorOwner.ok || !securityOwner.ok) return terminalPanelAttribution(runDir, run, !validatorOwner.ok ? "validator" : "security", !validatorOwner.ok ? { ...validatorOwner, hash: validatorPaths.hash } : { ...securityOwner, hash: securityPaths.hash }, opts);
    paths = [...new Set([...validatorPaths.paths, ...securityPaths.paths])].sort(byteSort);
    if (validatorOwner.identity !== securityOwner.identity) return terminalPanelAttribution(runDir, run, "combined", { category: "owner-conflict", hash: affectedPathsHash(paths) }, opts);
  } catch { return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts); }
  const redPanels = [revalidation.validator_verdict === "NO-GO" ? "validator" : null, revalidation.security_verdict === "BLOCK" ? "security" : null].filter(Boolean);
  if (!redPanels.length) return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts);
  const attempt = run.post_pr.attempt + 1;
  const owner = panelIdentityAttribution(runDir, run, paths);
  const evidenceCore = { run_id: run.run_id, attempt, source: "local-red", verdict: "red", failed_head_sha: run.post_pr.remediation.candidate_head_sha, affected_paths: paths,
    panel: redPanels.length === 2 ? "combined" : redPanels[0], validator_verdict: revalidation.validator_verdict, security_verdict: revalidation.security_verdict };
  const evidence = { ...evidenceCore, failure_fingerprint: hashJson(evidenceCore) };
  const binding = publishRunJsonEvidence(runDir, `evidence/post-pr-local-failure.attempt-${attempt}.json`, evidence);
  const max = Number.isInteger(run.max_retries) ? run.max_retries : 3;
  if (run.post_pr.attempt >= max) return exhaustPostPr(runDir, run, opts, binding);
  const remediation = newRemediation(run, attempt, evidence.failure_fingerprint, binding, owner); remediation.reason_code = "local-red"; remediation.failed_head_sha = evidence.failed_head_sha; remediation.baseline_head_sha = evidence.failed_head_sha;
  await transitionPostPrFailure(runDir, { remediation }, { ...opts, expectedCurrentHash: hashRunState(run) });
  const current = readRunFile(join(runDir, "run.json")); const next = cloneJson(current.post_pr); next.phase = "remediation-planned";
  await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(current) });
  return { action: "remediation-planned", attempt, route: remediation.route, evidence: binding };
}

function panelIdentityAttribution(runDir, run, paths) {
  const classified = classifyOwnership({ slices: acceptedSlicesPlan(runDir, run).slices, paths, failingCheckNames: [], complete: true });
  if (classified.disposition !== "route") throw new Error("panel owner became unsafe");
  return classified;
}

async function adoptUnboundFailureEvidence(runDir, run, opts) {
  const attempt = run.post_pr.attempt + 1;
  const ref = `evidence/post-pr-ci.attempt-${attempt}.json`;
  const path = join(runDir, ref);
  if (!existsSync(path)) return null;
  let binding; let expected;
  try {
    const action = await claimPostPrAction(runDir, "post-pr-observe", { ...opts, expectedCurrentHash: hashRunState(run) });
    binding = readBoundRunJson(runDir, ref, "evidence");
    expected = await reconstructFailureEvidence(factoryRepoFromRunDir(runDir), runDir, run, attempt, opts);
    assertPostPrActionFresh(runDir, action);
    const expectedBytes = `${JSON.stringify(expected, null, 2)}\n`;
    if (readFileSync(binding.path || join(runDir, ref), "utf8") !== expectedBytes || binding.hash !== `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`) throw new Error("unbound evidence bytes differ");
  } catch {
    return postPrTerminal(runDir, run, "needs-human", "post-pr-metadata-unsafe", opts, { conflicting_unbound_evidence: ref });
  }
  const ownership = expected.ownership;
  const remediation = newRemediation(run, attempt, expected.failure_fingerprint, binding, ownership);
  await transitionPostPrFailure(runDir, { remediation }, opts);
  const reserved = readRunFile(join(runDir, "run.json"));
  const next = cloneJson(reserved.post_pr); next.phase = "remediation-planned";
  await transitionPostPrState(runDir, next, { ...opts, expectedCurrentHash: hashRunState(reserved) });
  return { action: "adopted-unbound-failure", attempt };
}

async function reconstructFailureEvidence(repo, runDir, run, attempt, opts) {
  const observation = run.post_pr.observation; const snapshot = observation?.snapshot;
  if (observation?.last_check_verdict !== "red" || snapshot?.head_sha !== observation.expected_head_sha || !Array.isArray(snapshot?.checks?.checks)) throw new Error("authoritative red snapshot is unavailable");
  const failingChecks = snapshot.checks.checks.filter((check) => check.verdict === "red");
  const plan = acceptedSlicesPlan(runDir, run);
  let changed = { paths: [], changes: [], complete: true };
  let ownership = classifyOwnership({ slices: plan.slices, failingCheckNames: failingChecks.map((check) => check.name), paths: [] });
  if (ownership.disposition !== "route" || ownership.owner?.kind === "integration") {
    changed = await fetchChangedFiles(githubOperationInput(repo, run, opts, persistedPrIdentity(run)));
    if (changed.complete !== true) throw new Error("changed files are incomplete");
    ownership = classifyOwnership({ slices: plan.slices, failingCheckNames: failingChecks.map((check) => check.name), ...changed });
  }
  if (ownership.disposition !== "route") throw new Error("failure ownership is unsafe");
  const identity = persistedPrIdentity(run);
  const built = buildFailureEvidenceInput({ runId: run.run_id, attempt, observedAt: observation.last_observed_at, repository: identity.repository, prNumber: identity.number, prUrl: run.pr_url,
    expectedHeadSha: observation.expected_head_sha, observedHeadSha: snapshot.head_sha, failingChecks, review: null, ownership, exitCode: 0 });
  return { ...built, source: "check-red", failed_head_sha: observation.expected_head_sha };
}

function regenerateFailureEvidence(run) {
  const remediation = run.post_pr.remediation;
  const observation = run.post_pr.observation;
  const snapshot = observation?.snapshot;
  if (remediation.reason_code !== "check-red" || !snapshot?.checks || snapshot.head_sha !== remediation.failed_head_sha) throw new Error("failure evidence cannot be deterministically regenerated from persisted snapshot");
  const identity = persistedPrIdentity(run);
  const ownership = { disposition: "route", owner: cloneJson(remediation.owner), route: remediation.route, lane: remediation.lane, reason: remediation.owner.method === "integration" ? "integration-fallback" : remediation.owner.method };
  const built = buildFailureEvidenceInput({ runId: run.run_id, attempt: remediation.attempt, observedAt: observation.last_observed_at,
    repository: identity.repository, prNumber: identity.number, prUrl: run.pr_url, expectedHeadSha: observation.expected_head_sha, observedHeadSha: snapshot.head_sha,
    failingChecks: snapshot.checks.checks.filter((check) => check.verdict === "red"), review: snapshot.review?.verdict === "red" ? snapshot.review.review : null, ownership, exitCode: 0 });
  if (built.failure_fingerprint !== remediation.failure_fingerprint) throw new Error("persisted failure fingerprint does not match deterministic snapshot regeneration");
  return { ...built, source: "check-red", failed_head_sha: remediation.failed_head_sha };
}

function parseGitStatusChanges(output) {
  if (typeof output !== "string" || output && !output.endsWith("\0")) throw new Error("truncated porcelain status");
  if (!output) return { paths: [], entries: [] };
  const fields = output.slice(0, -1).split("\0"); const entries = []; const endpoints = new Set();
  const statusNames = new Map([[" M", "modified"], ["M ", "modified"], ["MM", "modified"], ["A ", "added"], ["AM", "added"], [" D", "deleted"], ["D ", "deleted"], ["R ", "renamed"], ["RM", "renamed"], [" R", "renamed"], ["C ", "copied"], ["CM", "copied"], [" C", "copied"], ["??", "untracked"]]);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]; if (field.length < 4 || field[2] !== " ") throw new Error("malformed porcelain record");
    const xy = field.slice(0, 2); const status = statusNames.get(xy); if (!status) throw new Error("unsafe porcelain status");
    const path = strictGitPath(field.slice(3)); let previous = null;
    if (status === "renamed" || status === "copied") { if (++index >= fields.length) throw new Error("truncated rename/copy"); previous = strictGitPath(fields[index]); }
    for (const endpoint of [path, previous].filter(Boolean)) { if (endpoints.has(endpoint)) throw new Error("duplicate/conflicting path"); endpoints.add(endpoint); }
    entries.push({ source: "worktree", status, index_status: xy[0], worktree_status: xy[1], path, previous_path: previous, old_mode: null, new_mode: null });
  }
  entries.sort(compareChangeEntries); return { paths: [...endpoints].sort(byteSort), entries };
}

function strictGitPath(value) {
  const path = normalizeRepositoryPath(value);
  if (path.normalize("NFC") !== path) throw new Error("non-NFC git path");
  return path;
}

function compareChangeEntries(left, right) {
  const tuple = (entry) => [entry.source, entry.status, entry.path, entry.previous_path || "", entry.index_status || "", entry.worktree_status || "", entry.old_mode || "", entry.new_mode || ""];
  const a = tuple(left); const b = tuple(right);
  for (let index = 0; index < a.length; index += 1) { const compared = byteSort(a[index], b[index]); if (compared) return compared; }
  return 0;
}

function gitChangesHaveUnsafeMode(worktree, entries) {
  const paths = [...new Set(entries.flatMap((entry) => [entry.path, entry.previous_path].filter(Boolean)))];
  for (const path of paths) {
    const absolute = join(worktree, path);
    if (existsSync(absolute)) {
      let stat; try { stat = lstatSync(absolute); } catch { return true; }
      if (stat.isSymbolicLink() || !stat.isFile()) return true;
    }
  }
  if (!paths.length) return false;
  const indexed = git(worktree, ["ls-files", "-s", "-z", "--", ...paths]);
  if (!indexed.ok || indexed.stdout && !indexed.stdout.endsWith("\0")) return true;
  for (const record of indexed.stdout ? indexed.stdout.slice(0, -1).split("\0") : []) {
    const match = /^(\d{6}) [0-9a-f]{40,64} (\d+)\t(.+)$/u.exec(record);
    if (!match || !["100644", "100755"].includes(match[1]) || match[2] !== "0") return true;
    try { strictGitPath(match[3]); } catch { return true; }
  }
  return false;
}

async function terminalDispatchUnknown(runDir, run, opts) {
  const dispatch = run.post_pr.remediation.dispatch;
  return postPrTerminal(runDir, run, "needs-human", "post-pr-dispatch-start-unknown", opts, {}, {
    schema_version: 1, kind: "dispatch-start-unknown", observed_at: timestamp(opts.now), attempt: run.post_pr.attempt,
    dispatch_id: dispatch.id, dispatch_started_at: dispatch.started_at, outcome: "return-unknown",
  });
}

function persistedPrIdentity(run) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/u.exec(run.pr_url || "");
  if (!match) throw new Error("post-PR observation requires canonical persisted PR identity");
  return { repository: match[1], number: Number(match[2]), prNumber: Number(match[2]) };
}

function durableObservationVerdict(aggregate) {
  if (aggregate.reason === "external-merge") return "external-merge";
  if (aggregate.reason === "external-state") return "closed";
  if (aggregate.reason === "head-mismatch") return "head-mismatch";
  return aggregate.verdict === "green" ? "green" : aggregate.verdict === "red" || aggregate.verdict === "needs-human" ? "red" : "pending";
}

function sanitizedObservationSnapshot(normalized) {
  return { head_sha: normalized.head_sha, state: normalized.state, is_draft: normalized.is_draft, checks: normalized.checks, review: normalized.review, aggregate: normalized.aggregate };
}

function durableErrorClass(value) {
  if (value === "http-transient") return "server";
  if (value === "account-switch" || value === "lock-timeout" || value === "lock-identity") return "command";
  return ["timeout", "network", "rate-limit", "server", "account-auth", "permission", "not-found", "protocol", "command"].includes(value) ? value : "command";
}

function acceptedSlicesPlan(runDir, run) {
  const file = join(runDir, "plan", "slices.json");
  if (existsSync(file)) return validateSlicesPlan(JSON.parse(readFileSync(file, "utf8")));
  const slices = (Array.isArray(run.slices) ? run.slices : []).filter((slice) => stringValue(slice?.id) && Array.isArray(slice.paths)).map((slice) => ({ id: slice.id, stack: slice.stack, paths: slice.paths }));
  return { slices };
}

function publishRunJsonEvidence(runDir, ref, value) {
  const path = resolve(runDir, ref);
  const rootDir = join(runDir, ref.split("/")[0]);
  if (!isLogicalContainedPath(rootDir, path, { allowEqual: false })) throw new Error("post-PR evidence ref escapes run directory");
  const rootEntry = lstatOptionalNoSymlinks(runDir, rootDir, rootDir, "post-PR evidence root must not contain symlinks");
  if (rootEntry && !rootEntry.isDirectory()) throw new Error("post-PR evidence root must be a directory");
  if (!rootEntry) mkdirSync(rootDir, { recursive: false });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const entry = lstatRequiredNoSymlinks(runDir, path, ref, "post-PR evidence file must not contain symlinks");
    if (!entry.isFile()) throw new Error("post-PR evidence destination must be a regular file");
    if (readFileSync(path, "utf8") !== bytes) throw new Error(`conflicting post-PR evidence replay: ${ref}`);
  } else writeFileSync(path, bytes, { flag: "wx" });
  return { ref, hash: sha256File(path) };
}

function readBoundRunJson(runDir, ref, rootName) {
  const bound = readBoundRunFile(runDir, ref, rootName);
  const value = readReviewJson(bound.path);
  return { ref: bound.ref, hash: bound.hash, value };
}

function readBoundRunFile(runDir, ref, rootName) {
  if (!stringValue(ref) || isAbsolute(ref) || ref.includes("\\") || !ref.startsWith(`${rootName}/`)) throw new Error(`ref must be under ${rootName}/`);
  const path = resolve(runDir, ref);
  const entry = lstatRequiredNoSymlinks(runDir, path, ref, `${ref} must not contain symlinks`);
  if (!entry.isFile()) throw new Error(`${ref} must be a regular file`);
  return { ref, path, hash: sha256File(path) };
}

function validateRemediationEvidence(run, binding, candidate) {
  const value = binding.value;
  const remediation = run.post_pr.remediation;
  for (const [key, expected] of Object.entries({ kind: "post-pr-remediation", run_id: run.run_id, attempt: remediation.attempt, dispatch_id: remediation.dispatch.id,
    baseline_head_sha: remediation.baseline_head_sha, candidate_head_sha: candidate, route: remediation.route })) {
    if (value[key] !== expected) throw new Error(`remediation evidence ${key} mismatch`);
  }
  if (value.review_ready !== true) throw new Error("remediation evidence must record review_ready true");
  const dispatchHash = hashJson(remediationDispatchEnvelope(run));
  if (value.dispatch_hash !== dispatchHash || value.failure_evidence_ref !== remediation.failure_evidence_ref || value.failure_evidence_hash !== remediation.failure_evidence_hash
    || !sameJsonValue(value.owner, remediation.owner) || value.lane !== remediation.lane) throw new Error("remediation evidence must bind exact dispatch/failure/owner/lane identity");
  if (!Array.isArray(value.commands) || !value.commands.length || value.commands.some((command) => !command || typeof command !== "object" || typeof command.program !== "string" || !Array.isArray(command.args) || command.shell === true || command.exit_code !== 0 || command.head_sha !== candidate)) {
    throw new Error("remediation evidence requires structured commands");
  }
  if (value.commit !== candidate) throw new Error("remediation evidence commit must equal candidate head");
  return normalizedAffectedPaths(value.changed_paths, "remediation evidence changed_paths");
}

function committedChangedDiff(worktree, baseline, candidate) {
  const dirty = git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!dirty.ok || dirty.stdout.length) throw new Error("remediation candidate worktree must be clean before revalidation");
  const diff = git(worktree, ["diff", "--name-status", "-z", "--find-renames", "--find-copies", `${baseline}..${candidate}`]);
  if (!diff.ok) throw new Error("could not inspect remediation candidate diff");
  if (diff.stdout && !diff.stdout.endsWith("\0")) throw new Error("committed remediation diff is truncated");
  const fields = diff.stdout ? diff.stdout.slice(0, -1).split("\0") : [];
  const changes = []; const paths = []; const endpoints = new Set();
  for (let index = 0; index < fields.length;) {
    const statusToken = fields[index++];
    const status = statusToken[0];
    if (!/[ACDMR]/u.test(status) || (status === "R" || status === "C") && !/^[RC](?:100|[0-9]{1,2})$/u.test(statusToken) || !["R", "C"].includes(status) && statusToken.length !== 1) throw new Error("committed remediation diff has unknown status");
    if (status === "R" || status === "C") {
      if (index + 1 >= fields.length) throw new Error("committed remediation rename/copy is truncated");
      const previous_path = strictGitPath(fields[index++]); const path = strictGitPath(fields[index++]);
      changes.push({ source: "commit", status: status === "R" ? "renamed" : "copied", index_status: null, worktree_status: null, path, previous_path, old_mode: null, new_mode: null }); paths.push(previous_path, path);
    } else {
      if (index >= fields.length) throw new Error("committed remediation diff is truncated");
      const path = strictGitPath(fields[index++]);
      const names = { A: "added", D: "deleted", M: "modified" };
      changes.push({ source: "commit", status: names[status], index_status: null, worktree_status: null, path, previous_path: null, old_mode: null, new_mode: null }); paths.push(path);
    }
  }
  for (const path of paths) { if (endpoints.has(path)) throw new Error("duplicate/conflicting committed path"); endpoints.add(path); }
  changes.sort(compareChangeEntries);
  return { paths: [...endpoints].sort(byteSort), changes };
}

function validateCanonicalEvidence(run, binding, candidate) {
  const value = binding.value;
  for (const [key, expected] of Object.entries({ kind: "post-pr-canonical", run_id: run.run_id, attempt: run.post_pr.attempt, head_sha: candidate })) {
    if (value[key] !== expected) throw new Error(`canonical evidence ${key} mismatch`);
  }
  if (value.command?.program !== "npm" || !sameStringArray(value.command?.args, ["run", "check"])) throw new Error("canonical evidence must bind exact command npm run check");
}

function validatePanelReview(run, binding, candidate, kind) {
  const value = binding.value;
  const expectedKind = kind === "validator" ? "implementation-validator" : "security-reviewer";
  if (value.kind !== expectedKind || value.run_id !== run.run_id || value.attempt !== run.post_pr.attempt || value.head_sha !== candidate || value.fresh !== true) {
    throw new Error(`${kind} review must bind kind/run/attempt/head and fresh=true`);
  }
  normalizedAffectedPaths(value.affected_paths, `${kind} affected_paths`);
}

function assertPanelAffectedPathAttribution(runDir, run, validatorPaths, securityPaths) {
  const paths = [...new Set([...normalizedAffectedPaths(validatorPaths, "validator affected_paths"), ...normalizedAffectedPaths(securityPaths, "security affected_paths")])].sort(byteSort);
  if (!paths.length) return;
  const attribution = classifyOwnership({ slices: acceptedSlicesPlan(runDir, run).slices, paths, failingCheckNames: [], complete: true });
  if (attribution.disposition !== "route") throw new Error("panel affected_paths are mixed, unsafe, or ambiguously owned");
}

function reattributeFailure(runDir, run, evidence) {
  const paths = normalizedAffectedPaths(evidence.affected_paths, "failure affected_paths");
  const attribution = classifyOwnership({ slices: acceptedSlicesPlan(runDir, run).slices, paths, failingCheckNames: [], complete: true });
  if ((evidence.panel === "security" || evidence.finding_source === "security") && evidence.verdict === "red" && attribution.owner?.kind !== "slice") return { disposition: "needs-human" };
  return attribution;
}

function normalizedAffectedPaths(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return [...new Set(value.map(normalizeRepositoryPath))].sort(byteSort);
}

function sameStringArray(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]); }
function sameJsonValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function byteSort(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

function requiredStringOption(value, flag) { if (!stringValue(value)) throw new Error(`post-pr-remediation requires ${flag}`); return String(value).trim(); }
function withoutExpectedHash(opts = {}) { const next = { ...opts }; delete next.expectedCurrentHash; return next; }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function hashJson(value) { return hashValue(value); }

function postPrSummary(run) {
  const value = run?.post_pr;
  if (!value) return null;
  return { enabled: value.policy?.enabled === true, phase: value.phase, attempt: value.attempt, max_retries: Number.isInteger(run.max_retries) ? run.max_retries : 3,
    deadline_at: value.observation?.deadline_at || null, next_poll_at: value.observation?.next_poll_at || null, last_verdict: value.observation?.last_verdict || null,
    error_class: value.observation?.last_error?.class || null, owner: value.remediation?.owner || null, route: value.remediation?.route || null,
    latest_evidence: value.evidence_refs?.at(-1) || null };
}

async function serializedRemoteBranchHead(repo, run, opts = {}) {
  const result = await serializedGitHubGitOperation(repo, run, "remote-head", opts, () => git(repo, ["ls-remote", "--heads", "origin", `refs/heads/${run.branch}`], { timeout: 30000 }));
  const value = result.stdout.trim().split(/\s+/u)[0];
  if (!/^[0-9a-f]{40}$/u.test(value || "")) throw new Error("remote branch head is missing or malformed");
  return value;
}

async function serializedFastForwardPush(repo, run, candidate, opts = {}) {
  const result = await serializedGitHubGitOperation(repo, run, "fast-forward-push", opts, () => git(run.worktree, ["push", "origin", `${candidate}:refs/heads/${run.branch}`], { timeout: 30000 }));
  if (result.exitCode !== 0) throw new Error("normal fast-forward post-PR push failed");
}

async function serializedGitHubGitOperation(repo, run, operation, opts, gitOperation) {
  return runGitHubOperation({
    repositoryRoot: repo, cwd: repo, account: run.github_account, executable: opts.ghExecutable,
    args: ["factory-internal-git-operation", operation], lockOptions: opts.githubLockOptions,
    execute: async (input) => {
      if (input.args[0] === "auth") return typeof opts.executeGithub === "function" ? opts.executeGithub(input) : runBoundedProcess(input);
      const proc = typeof opts.executeGitOperation === "function" ? await opts.executeGitOperation({ operation, run: cloneJson(run) }) : gitOperation();
      return { exitCode: proc.ok === false ? 1 : Number.isInteger(proc.exitCode) ? proc.exitCode : 0, stdout: proc.stdout || "", stderr: proc.stderr || "", signal: null };
    },
  });
}

function assertPostPrContinuationParent(run) {
  if (run.post_pr?.phase !== "blocked" || run.terminal_result?.reason !== "post-pr-retry-exhausted" || !run.post_pr?.continuation_review?.ref) throw new Error("--new-pr requires a retry-exhausted blocked post-PR parent with continuation review");
}

function continuationPostPrBinding(run, runDir) {
  const remediation = run.post_pr.remediation;
  const latestEvidence = latestPostPrFailure(runDir, run);
  const continuationReview = readBoundRunJson(runDir, run.post_pr.continuation_review.ref, "reviews");
  if (continuationReview.hash !== run.post_pr.continuation_review.hash || continuationReview.value.head_sha !== latestEvidence.failedHeadSha) throw new Error("post-PR continuation review does not bind the latest failed head");
  const postPrForHash = cloneJson(run.post_pr); delete postPrForHash.continuation_review;
  const identity = persistedPrIdentity(run);
  return { pr_url: run.pr_url, repository: identity.repository, pr_number: identity.number,
    head_sha: latestEvidence.failedHeadSha, disposition: "leave-unchanged",
    policy: cloneJson(run.post_pr.policy), post_pr_hash: hashJson(postPrForHash), evidence_ref: latestEvidence.binding.ref, evidence_hash: latestEvidence.binding.hash,
    continuation_review_ref: run.post_pr.continuation_review.ref, continuation_review_hash: run.post_pr.continuation_review.hash };
}

function latestPostPrFailure(runDir, run) {
  const remediation = run.post_pr.remediation;
  const expected = run.post_pr.evidence_refs?.at(-1) || { ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash };
  const binding = readBoundRunJson(runDir, expected.ref, "evidence");
  if (binding.hash !== expected.hash || !/^[0-9a-f]{40}$/u.test(binding.value.failed_head_sha || "")) throw new Error("latest post-PR failure evidence is invalid");
  return { binding, failedHeadSha: binding.value.failed_head_sha };
}

async function exhaustPostPr(runDir, run, opts, latestFailure) {
  let transitionOpts = opts;
  if (latestFailure && !(run.post_pr.evidence_refs || []).some((item) => item.ref === latestFailure.ref)) {
    const next = cloneJson(run.post_pr);
    next.evidence_refs.push({ ref: latestFailure.ref, hash: latestFailure.hash });
    const persisted = await transitionPostPrState(runDir, next, opts);
    run = persisted.run;
    transitionOpts = { ...withoutExpectedHash(opts), expectedCurrentHash: hashRunState(run) };
  }
  const remediation = run.post_pr.remediation;
  const latest = latestPostPrFailure(runDir, run);
  const postPrForHash = cloneJson(run.post_pr); delete postPrForHash.continuation_review;
  const identity = persistedPrIdentity(run);
  const review = { kind: "post-pr-continuation", subject: run.run_id, verdict: "BLOCKED", attempt: run.post_pr.attempt, reason: "post-pr-retry-exhausted", route: remediation.route,
    evidence_ref: remediation.failure_evidence_ref, evidence_hash: remediation.failure_evidence_hash, post_pr_hash: hashJson(postPrForHash), pr_url: run.pr_url,
    repository: identity.repository, pr_number: identity.number, head_sha: latest.failedHeadSha,
    latest_failure_ref: latest.binding.ref, latest_failure_hash: latest.binding.hash,
    pr_disposition: "leave-unchanged", summary: "Post-PR remediation retry budget exhausted.", required_fixes: ["Resolve the recorded failing checks on a fresh continuation PR."] };
  assertFactoryStateHash(runDir, transitionOpts.expectedCurrentHash);
  const binding = publishRunJsonEvidence(runDir, `reviews/post-pr-ci.attempt-${run.post_pr.attempt}.json`, review);
  assertFactoryStateHash(runDir, transitionOpts.expectedCurrentHash);
  const artifacts = Object.fromEntries([
    ["latest_failure", latest.binding.ref], ["latest_failure_hash", latest.binding.hash],
    ["failure_evidence", remediation.failure_evidence_ref], ["failure_evidence_hash", remediation.failure_evidence_hash],
    ["remediation_evidence", remediation.remediation_evidence_ref], ["remediation_evidence_hash", remediation.remediation_evidence_hash],
    ["canonical_evidence", remediation.revalidation?.canonical_evidence_ref], ["canonical_evidence_hash", remediation.revalidation?.canonical_evidence_hash],
    ["validator_review", remediation.revalidation?.validator_review_ref], ["validator_review_hash", remediation.revalidation?.validator_review_hash],
    ["security_review", remediation.revalidation?.security_review_ref], ["security_review_hash", remediation.revalidation?.security_review_hash],
    ["continuation_review", binding.ref], ["continuation_review_hash", binding.hash],
  ].filter(([, value]) => stringValue(value)));
  return postPrTerminal(runDir, run, "blocked", "post-pr-retry-exhausted", transitionOpts, artifacts, undefined, binding);
}

function assertFactoryStateHash(runDir, expected) {
  if (!stringValue(expected) || hashRunState(readRunFile(join(runDir, "run.json"))) !== expected) throw new Error("post-PR state changed during evidence publication");
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

async function persistFactoryRunEnv(runId, eventKind, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const snapshot = await collectRunDebugSnapshot({
    cwd: factoryRepoFromRunDir(runDir),
    driverKind: opts.driverKind,
    pluginSpec: opts.pluginSpec,
    pluginOptions: opts.pluginOptions,
    event: opts.event || (eventKind === "resume" ? "run-resumed" : "run-created"),
    now: opts.now,
  });
  return withRunJsonLock(runDir, async () => {
    const runPath = join(runDir, "run.json");
    const current = readRunFile(runPath);
    assertRunJsonWriterAllowed(current, `env ${eventKind}`, { allowUncheckpointed: eventKind === "resume" });
    if (eventKind === "resume") assertResumeMutationAllowed(runDir, current, opts);
    const provenance = await collectEffectiveProvenance({
      repo: factoryRepoFromRunDir(runDir),
      gitCwd: provenanceGitCwd(factoryRepoFromRunDir(runDir), current.worktree),
      pluginOptions: opts.pluginOptions,
      event: eventKind === "resume" ? "resumed" : "created",
      now: opts.now,
    });
    const next = validateRun({
      ...current,
      debug_snapshot: nextDebugSnapshot(current.debug_snapshot, snapshot, eventKind),
      provenance: nextProvenance(current.provenance, provenance, eventKind),
    });
    writeJsonAtomic(runPath, next);
    return next.debug_snapshot;
  }, opts);
}

function nextProvenance(current, event, eventKind) {
  const existing = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  if (eventKind === "resume") {
    return {
      schema_version: 1,
      created: existing.created || null,
      last_resumed: event,
      resume_count: nonNegativeInteger(existing.resume_count) + 1,
      review_dispatches: Array.isArray(existing.review_dispatches) ? existing.review_dispatches : [],
    };
  }
  return {
    schema_version: 1,
    created: existing.created || event,
    last_resumed: existing.last_resumed || null,
    resume_count: nonNegativeInteger(existing.resume_count),
    review_dispatches: Array.isArray(existing.review_dispatches) ? existing.review_dispatches : [],
  };
}

function provenanceGitCwd(repo, worktree) {
  if (!stringValue(worktree)) return repo;
  return isAbsolute(worktree) ? worktree : resolve(repo, worktree);
}

function nextDebugSnapshot(current, snapshot, eventKind) {
  const existing = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  if (eventKind === "resume") {
    return {
      created_with: existing.created_with || snapshot,
      last_resumed_with: snapshot,
      resume_count: nonNegativeInteger(existing.resume_count) + 1,
    };
  }
  return {
    created_with: existing.created_with || snapshot,
    last_resumed_with: existing.last_resumed_with ?? null,
    resume_count: nonNegativeInteger(existing.resume_count),
  };
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeHeartbeatPhase(phase) {
  if (!stringValue(phase)) throw new Error("heartbeat phase must be a non-empty string");
  return String(phase).trim();
}

function normalizeHeartbeatInterval(value) {
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, normalizePositiveInteger(value, DEFAULT_HEARTBEAT_INTERVAL_MS, "intervalMs"));
}

function normalizePositiveInteger(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const next = Number(value);
  if (!Number.isInteger(next) || next <= 0) throw new Error(`${name} must be a positive integer`);
  return next;
}

function heartbeatBlocksReplacement(heartbeat, now, opts = {}) {
  if (heartbeat.pid === null) return false;
  const liveness = heartbeatLiveness(heartbeat, now, opts);
  return liveness.process_alive === null || liveness.fresh;
}

function heartbeatProcessLiveness(pid, opts = {}) {
  if (pid === null) return "absent";
  if (typeof opts.processAliveFn === "function") return probeLegacyBooleanLiveness(opts.processAliveFn, pid);
  return probeProcessLiveness(pid, opts).status;
}

function captureHeartbeatIdentity(pid, opts = {}) {
  const inspect = typeof opts.heartbeatInspectorFn === "function" ? opts.heartbeatInspectorFn : inspectProcessIdentity;
  const observed = inspect(pid, opts);
  if (observed?.ok !== true || !stringValue(observed.inspector) || !stringValue(observed.start_marker)
    || !stringValue(observed.command_name) || !stringValue(observed.cwd)) {
    throw new Error("heartbeat requires verifiable process identity");
  }
  return {
    inspector: observed.inspector,
    start_marker: observed.start_marker,
    command_name: basename(observed.command_name),
    cwd: resolve(observed.cwd),
  };
}

function heartbeatProcessOwnership(heartbeat, opts = {}) {
  const liveness = heartbeatProcessLiveness(heartbeat.pid, opts);
  if (liveness !== "live") return liveness;
  const expected = heartbeat.identity;
  if (!expected || typeof expected !== "object") return "indeterminate";
  const inspect = typeof opts.heartbeatInspectorFn === "function" ? opts.heartbeatInspectorFn : inspectProcessIdentity;
  const observed = inspect(heartbeat.pid, opts);
  if (observed?.ok !== true) return "indeterminate";
  if (observed.inspector !== expected.inspector
    || observed.start_marker !== expected.start_marker
    || basename(String(observed.command_name || "")) !== basename(expected.command_name)
    || resolve(String(observed.cwd || "")) !== resolve(expected.cwd)) return "mismatched";
  return "live";
}

function projectFactoryWatchValue(value, path = []) {
  if (Array.isArray(value)) return value.map((item) => projectFactoryWatchValue(item, path));
  if (!value || typeof value !== "object") return factoryWatchPathIsFreeform(path) ? projectFreeformData(value) : value;
  const projected = {};
  for (const [key, item] of Object.entries(value)) projected[key] = projectFactoryWatchValue(item, [...path, key]);
  return projected;
}

function factoryWatchPathIsFreeform(path) {
  if (path.length === 1 && path[0] === "error") return true;
  if (path.length === 3 && path[0] === "gates" && (path[2] === "answer" || path[2] === "decision_note")) return true;
  if (path.length === 2 && path[0] === "terminal_result" && (path[1] === "reason" || path[1] === "summary")) return true;
  const diagnosticIndex = path.indexOf("diagnostics");
  return diagnosticIndex >= 0 && path.length > diagnosticIndex + 1
    && ["error", "message", "reason", "detail", "summary", "action"].includes(path.at(-1));
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveCleanupBranchPermission(branch) {
  if (!isSafeCleanupBranchName(branch)) {
    return { allowed: false, reason: "unsafe branch name" };
  }
  return { allowed: true };
}

function resolveCleanupWorktreePermission(repo, worktree, expectedBranch) {
  if (!stringValue(expectedBranch)) return { allowed: false, reason: "missing expected branch" };
  const identity = checkWorktreeIdentity(repo, worktree, { branch: expectedBranch });
  if (!identity.ok) return { allowed: false, reason: identity.reason };
  return { allowed: true };
}

function isSafeCleanupBranchName(branch) {
  return SAFE_BRANCH_NAME_PATTERN.test(branch)
    && !branch.startsWith("refs/")
    && !branch.endsWith("/")
    && !branch.endsWith(".lock")
    && !branch.includes("..")
    && !branch.includes("//")
    && !branch.includes("@{")
    && !/[\\~^:?*\[\]\s]/u.test(branch);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
