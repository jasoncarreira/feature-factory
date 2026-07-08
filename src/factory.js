import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants as FS_CONSTANTS, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { hasInFlightHeartbeatWork, resolveGateAnswerTarget, withRunJsonLock } from "./run-state.js";
import { pendingProtectedGate, validateHeartbeatState, validateRun, validateRunDir, validateSlicesPlan } from "./validate.js";
import { collectRunDebugSnapshot } from "./env-snapshot.js";
import { diagnoseRunDir, diagnoseRunObject } from "./factory-diagnostics.js";
import { git, repoRoot } from "./git.js";
import { checkWorktreeIdentity } from "./worktrees.js";
import { isContainedPath, physicalPath, timestamp } from "./utils.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TERMINAL_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);
const HEARTBEAT_FILE = "heartbeat.json";
const HEARTBEAT_SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const MIN_HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TICK_LOCK_TIMEOUT_MS = 1000;
const HEARTBEAT_TICK_LOCK_RETRIES = 3;
const FAIL_CLOSED_DIAGNOSTIC_CONDITIONS = new Set(["invalid-run-state"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const SAFE_BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const activeHeartbeatLoops = new Map();

export function startFactory(args, opts = {}) {
  if (!args.length) throw new Error("factory start requires a feature prompt");
  const repo = repoRoot(opts.cwd || process.cwd());
  seedRepoSkill(repo);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(formatPrompt(args.join(" "), { ...opts, repo }));
  if (opts.detached) return startDetached(repo, commandArgs);
  try {
    execFileSync("opencode", commandArgs, { cwd: repo, stdio: "inherit" });
  } catch (error) {
    throw new Error(`opencode exited ${error.status ?? 1}`);
  }
}

export function continueFactory(parentRunId, opts = {}) {
  if (opts.ready) throw new Error("factory continue does not accept --ready");
  if (opts.noDraft) throw new Error("factory continue does not accept --no-draft");
  const repo = repoRoot(opts.cwd || process.cwd());
  const continuation = buildContinuation(parentRunId, { ...opts, cwd: repo });

  const prompt = `Continue blocked feature-factory run '${continuation.parent.run_id}' as '${continuation.target.run_id}' using review '${continuation.review.ref}'.`;
  const payload = featureCommandPayload(prompt, { ...opts, repo, ready: false, continuation });
  if (opts.dryRun) return { status: "dry-run", payload };

  seedRepoSkill(repo);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(JSON.stringify(payload, null, 2));
  if (opts.detached) return startDetached(repo, commandArgs);
  try {
    execFileSync("opencode", commandArgs, { cwd: repo, stdio: "inherit" });
  } catch (error) {
    throw new Error(`opencode exited ${error.status ?? 1}`);
  }
}

export function listRuns(opts = {}) {
  const root = factoryRoot(opts.cwd || process.cwd());
  const repo = repoRoot(opts.cwd || process.cwd());
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((runId) => {
      const runDir = join(root, runId);
      const file = join(runDir, "run.json");
      if (!existsSync(file)) return null;
      const run = tryReadPublicRun(file, { ...opts, repoRoot: repo });
      const diagnostics = run.error ? diagnoseRunDir(runDir, publicDiagnosticOptions(opts, repo)) : diagnoseRunObject(run.value, { ...publicDiagnosticOptions(opts, repo), runDir, runFile: file });
      if (run.error || diagnosticsFailClosed(diagnostics)) return invalidListRun(runId, file, diagnostics, run.error);
      return {
        run_id: run.value.run_id || runId,
        status: run.value.status || "unknown",
        gate: pendingGate(run.value),
        review_tier: selectedReviewTier(run.value),
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
  const repo = repoRoot(opts.cwd || process.cwd());
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
    gates: run.gates || {},
    pr_url: run.pr_url || null,
    review_tier: run.review_tier || null,
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
    const protectedGate = pendingProtectedGate(run);
    if (protectedGate) {
      throw new Error(`run '${run.run_id}' is waiting at protected gate '${protectedGate}'`);
    }
    if (!hasInFlightHeartbeatWork(run)) {
      throw new Error(`run '${run.run_id}' has no in-flight factory work for heartbeat`);
    }
    const current = tryReadHeartbeatFile(heartbeatFile);
    if (current.error) throw new Error(`invalid heartbeat at ${heartbeatFile}: ${current.error}`);
    if (current.value && heartbeatIsFresh(current.value, startedAt, opts)) {
      throw new Error(`heartbeat already active for run '${run.run_id}'`);
    }

    heartbeat = validateHeartbeatState({
      schema_version: HEARTBEAT_SCHEMA_VERSION,
      run_id: run.run_id,
      phase,
      pid: process.pid,
      last_tick_at: startedAt,
      interval_ms: intervalMs,
    });
    writeHeartbeatFile(heartbeatFile, heartbeat);
    writeJsonAtomic(join(runDir, "run.json"), validateRun({ ...run, heartbeat_at: startedAt }));
  });

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
  const heartbeatFile = heartbeatPath(runDir);
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
    if (heartbeat.pid && heartbeat.pid !== process.pid && isProcessAlive(heartbeat.pid)) {
      try {
        process.kill(heartbeat.pid, "SIGTERM");
      } catch {
        // Best-effort stop; the liveness rule handles dead or inaccessible processes.
      }
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

export function latestRunId(opts = {}) {
  const runs = listRuns(opts);
  return runs[0]?.run_id || null;
}

export function watchRun(runId, opts = {}) {
  const intervalMs = Number(opts.intervalMs || 2000);
  let last = "";
  let timer = null;
  let stopped = false;
  const emit = (value) => {
    const current = JSON.stringify(value);
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
      emit(opts.all ? listRuns(opts) : status(runId, opts));
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
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDirs = runId ? [resolveRunDir(runId, opts)] : allRunDirs(opts);
  const runs = runDirs.map((dir) => {
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

function invalidListRun(runId, file, diagnostics, error) {
  return {
    run_id: runId,
    status: "invalid",
    gate: null,
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
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = resolveRunDir(runId, { ...opts, cwd: repo });
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
    if (heartbeat.value && heartbeatIsFresh(heartbeat.value, timestamp(opts.now), opts) && !opts.force) {
      throw new Error(`run '${run.run_id}' has a fresh heartbeat; cleanup requires --force`);
    }
    if (heartbeat.value && opts.force && !opts.dryRun) stopHeartbeatForCleanup(runDir, heartbeat.value, opts);

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

    for (const worktree of cleanupWorktrees(run)) removeWorktree(repo, worktree, result, opts);
    for (const branch of cleanupBranches(run)) deleteBranch(repo, branch, result, opts);

    if (!opts.dryRun) rmSync(runDir, { recursive: true, force: true });
    result.removed_run_dir = !opts.dryRun;
    return result;
  }, opts);
}

function stopHeartbeatForCleanup(runDir, heartbeat, opts = {}) {
  stopActiveHeartbeatLoop(runDir);
  if (heartbeat.pid && heartbeat.pid !== process.pid && isProcessAlive(heartbeat.pid, opts)) {
    try {
      process.kill(heartbeat.pid, "SIGTERM");
    } catch {
      // Best-effort cleanup stop.
    }
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
  const parentRun = readRunFile(parentRunFile);
  if (parentRun.status !== "blocked") {
    throw new Error(`parent run '${parentRun.run_id}' must have status blocked`);
  }
  if (!stringValue(parentRun.branch)) {
    throw new Error(`parent run '${parentRun.run_id}' must have a local branch`);
  }
  if (!branchExists(repo, parentRun.branch)) {
    throw new Error(`parent run '${parentRun.run_id}' requires existing branch '${parentRun.branch}'`);
  }

  const targetRunId = normalizeContinuationTargetRunId(opts.runId, parentRun.run_id);
  assertContinuationTargetAvailable(repo, targetRunId);
  const review = resolveContinuationReview(parentRunDir, requiredContinuationReview(opts.review));
  const reviewMetadata = validateContinuationReview(readReviewJson(review.path), review.ref);

  return {
    kind: "blocked-run-continuation",
    schema: "feature-factory.continuation.v1",
    schema_version: 1,
    parent: {
      run_id: parentRun.run_id,
      status: parentRun.status,
      ref: relativeRef(repo, parentRunFile),
      hash: sha256File(parentRunFile),
      branch: parentRun.branch,
      commit: branchCommit(repo, parentRun.branch),
      artifact_refs: collectHashedRefs(join(parentRunDir, "artifacts"), "artifacts"),
    },
    review: {
      ref: review.ref,
      hash: sha256File(review.path),
      ...reviewMetadata,
    },
    target: {
      run_id: targetRunId,
      branch: targetRunId,
      worktree: resolve(repo, ".opencode", "worktrees", targetRunId),
    },
  };
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
  const parentRunPhysical = physicalPath(parentRunDir, "parent run directory", { mustExist: true });
  const parentReviewsDir = resolveExistingDirectory(join(parentRunDir, "reviews"), "reviews directory");
  if (!isContainedPath(parentRunPhysical, parentReviewsDir, { allowEqual: false })) {
    throw new Error("--review must resolve under the parent run reviews/ directory");
  }
  const relativeReviewRef = reviewRef.startsWith("reviews/") ? reviewRef : `reviews/${reviewRef}`;
  const reviewPath = resolve(parentRunPhysical, relativeReviewRef);
  const reviewPhysical = physicalPath(reviewPath, "review", { mustExist: true });
  if (!isContainedPath(parentReviewsDir, reviewPhysical, { allowEqual: false })) {
    throw new Error("--review must resolve under the parent run reviews/ directory");
  }
  if (!statSync(reviewPhysical).isFile()) throw new Error(`--review must be a JSON file: ${relativeReviewRef}`);
  return { ref: relativeRef(parentRunPhysical, reviewPhysical), path: reviewPhysical };
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

function validateContinuationReview(review, ref) {
  if (!stringValue(review.subject)) throw new Error(`review '${ref}' must have non-empty subject`);
  const summary = stringValue(review.summary) ? String(review.summary).trim() : null;
  const requiredFixes = normalizeRequiredFixes(review.required_fixes);
  const hasSummary = summary !== null;
  const hasRequiredFixes = requiredFixes.length > 0;
  if (!hasSummary && !hasRequiredFixes) {
    throw new Error(`review '${ref}' must have non-empty summary or required_fixes[]`);
  }
  return {
    subject: String(review.subject).trim(),
    summary,
    required_fixes: requiredFixes,
  };
}

function normalizeRequiredFixes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(stringValue).map((item) => String(item).trim());
}

function collectHashedRefs(dir, refPrefix) {
  if (!existsSync(dir)) return [];
  const physicalDir = physicalPath(dir, `${refPrefix} directory`, { mustExist: true });
  if (!statSync(physicalDir).isDirectory()) return [];
  return readdirSync(physicalDir, { withFileTypes: true })
    .flatMap((entry) => collectHashedRefsEntry(physicalDir, refPrefix, entry.name))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

function collectHashedRefsEntry(baseDir, refPrefix, name) {
  const path = join(baseDir, name);
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => collectHashedRefsEntry(baseDir, refPrefix, join(name, entry.name)));
  }
  if (!stat.isFile()) return [];
  return [{ ref: `${refPrefix}/${relativeRef(baseDir, path)}`, hash: sha256File(path) }];
}

function branchExists(repo, branch) {
  return git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).ok;
}

function branchCommit(repo, branch) {
  const proc = git(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (!proc.ok) throw new Error(`parent run requires resolvable branch commit for '${branch}'`);
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
  const root = factoryRoot(opts.cwd || process.cwd());
  const value = String(id).trim();
  if (isExplicitRunPath(value)) {
    const asPath = resolve(opts.cwd || process.cwd(), value);
    if (!insideDirectory(root, asPath)) throw new Error(`run path must be inside .opencode/factory: ${asPath}`);
    if (!existsSync(join(asPath, "run.json"))) throw new Error(`run not found: ${id}`);
    return asPath;
  }
  if (!value || value === "." || value === "..") throw new Error("run id must be a bare factory run id");
  const dir = resolve(root, value);
  if (!existsSync(join(dir, "run.json"))) throw new Error(`run not found: ${id}`);
  if (!insideDirectory(root, dir)) throw new Error(`run directory must be inside .opencode/factory: ${dir}`);
  return dir;
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
  const root = factoryRoot(opts.cwd || process.cwd());
  const normalized = normalizeHeartbeatRunId(id);
  const dir = resolve(root, normalized);
  if (!existsSync(join(dir, "run.json"))) throw new Error(`run not found: ${id}`);
  if (!insideDirectory(root, dir)) {
    throw new Error(`heartbeat run directory must be inside .opencode/factory: ${dir}`);
  }
  return dir;
}

function factoryRoot(cwd) {
  return join(repoRoot(cwd), ".opencode", "factory");
}

function allRunDirs(opts = {}) {
  const root = factoryRoot(opts.cwd || process.cwd());
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((runId) => join(root, runId))
    .filter((dir) => existsSync(join(dir, "run.json")));
}

function startDetached(repo, commandArgs) {
  const processes = join(factoryRoot(repo), "processes");
  mkdirSync(processes, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = join(processes, `${stamp}.log`);
  const out = openSync(log, "a");
  const child = spawn("opencode", commandArgs, {
    cwd: repo,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.on("error", (error) => appendFileSync(log, `\n[feature-factory] failed to start opencode: ${error.message}\n`));
  child.unref();
  closeSync(out);
  return {
    status: "started",
    pid: child.pid,
    repo,
    log,
    command: ["opencode", ...commandArgs].join(" "),
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

export function seedRepoSkill(repo) {
  const dest = join(repo, ".opencode", "skills", "feature");
  mkdirSync(dest, { recursive: true });
  const seedHashPath = join(dest, ".seed-hash");
  const recorded = readSeedHashes(seedHashPath);
  const nextHashes = { ...recorded };
  const skipped = [];
  for (const file of ["SKILL.md", "SCHEMA.md"]) {
    const source = join(root, "assets", "skills", "feature", file);
    const target = join(dest, file);
    const sourceText = readFileSync(source, "utf8");
    const sourceHash = sha256(sourceText);
    const currentText = existsSync(target) ? readFileSync(target, "utf8") : null;
    const currentHash = currentText === null ? null : sha256(currentText);
    const locallyEdited = currentHash !== null && currentHash !== sourceHash && (!recorded[file] || currentHash !== recorded[file]);
    if (locallyEdited) {
      skipped.push(file);
      continue;
    }
    if (currentHash !== sourceHash) copyFileSync(source, target);
    nextHashes[file] = sourceHash;
  }
  if (skipped.length) console.warn(`feature-factory: preserved locally edited seeded skill file(s): ${skipped.join(", ")}`);
  writeFileSync(seedHashPath, `${JSON.stringify(nextHashes, null, 2)}\n`, "utf8");
  ensureGitInfoExclude(repo, ".opencode/skills/feature/");
  return dest;
}

function readSeedHashes(file) {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
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
  return JSON.stringify(featureCommandPayload(prompt, opts), null, 2);
}

export function validateSlices(plan) {
  return validateSlicesPlan(plan);
}

function featureCommandPayload(prompt, opts) {
  const githubAccount = resolveGithubAccount(opts);
  const payload = {
    operator_request: String(prompt),
    driver: {
      mode: opts.autonomous ? "autonomous" : opts.headless ? "headless" : "interactive",
      ready: Boolean(opts.ready),
      reviewer: stringValue(opts.reviewer) ? opts.reviewer : null,
      github_account: githubAccount,
    },
  };
  if (opts.continuation !== undefined) payload.continuation = opts.continuation;
  return payload;
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
    stopped: false,
  };
}

function runHeartbeatTick(runtime) {
  if (runtime.stopped || runtime.ticking) return;
  runtime.ticking = true;
  heartbeatTick(runtime)
    .then((next) => {
      if (!next.continue) stopActiveHeartbeatLoop(runtime.runDir, runtime);
    })
    .catch(() => stopActiveHeartbeatLoop(runtime.runDir, runtime))
    .finally(() => {
      runtime.ticking = false;
    });
}

async function heartbeatTick(runtime) {
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
    }, { timeoutMs: runtime.tickTimeoutMs });
  } catch (error) {
    if (isRunJsonLockTimeout(error) && runtime.lockTimeouts < HEARTBEAT_TICK_LOCK_RETRIES) {
      runtime.lockTimeouts += 1;
      return { continue: true, reason: "lock-timeout" };
    }
    return { continue: false, reason: error.message };
  }
}

function isRunJsonLockTimeout(error) {
  return /timed out waiting for run\.json lock/u.test(error?.message || "");
}

function stopActiveHeartbeatLoop(runDir, runtime = activeHeartbeatLoops.get(runDir)) {
  if (!runtime) return false;
  runtime.stopped = true;
  if (runtime.timer) clearInterval(runtime.timer);
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
  const processAlive = isProcessAlive(heartbeat.pid, opts);
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(lastTickMs) ? Math.max(0, nowMs - lastTickMs) : null;
  return {
    fresh: Boolean(processAlive && ageMs !== null && ageMs <= staleMs),
    process_alive: processAlive,
    age_ms: ageMs,
    stale_after: Number.isFinite(lastTickMs) ? new Date(lastTickMs + staleMs).toISOString() : null,
  };
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
  const runPath = join(runDir, "run.json");
  const current = readRunFile(runPath);
  const snapshot = await collectRunDebugSnapshot({
    cwd: opts.cwd || process.cwd(),
    driverKind: opts.driverKind,
    pluginSpec: opts.pluginSpec,
    pluginOptions: opts.pluginOptions,
    event: opts.event || (eventKind === "resume" ? "run-resumed" : "run-created"),
    now: opts.now,
  });
  const next = validateRun({
    ...current,
    debug_snapshot: nextDebugSnapshot(current.debug_snapshot, snapshot, eventKind),
  });
  writeJsonAtomic(runPath, next);
  return next.debug_snapshot;
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

function isProcessAlive(pid, opts = {}) {
  if (typeof opts.processAliveFn === "function") return Boolean(opts.processAliveFn(pid));
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
