import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants as FS_CONSTANTS, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { hasInFlightHeartbeatWork, resolveGateAnswerTarget, withRunJsonLock } from "./run-state.js";
import { pendingProtectedGate, validateHeartbeatState, validateRun, validateRunDir, validateSlicesPlan } from "./validate.js";
import { collectRunDebugSnapshot } from "./env-snapshot.js";
import { diagnoseRunDir, diagnoseRunObject } from "./factory-diagnostics.js";
import { git, repoRoot } from "./git.js";
import { checkWorktreeIdentity } from "./worktrees.js";
import { isContainedPath, physicalPath, timestamp } from "./utils.js";
import { directFactoryRoot, factoryRepoFromRunDir, factoryRootsForLookup } from "./factory-paths.js";

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
const SAFE_BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
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
  const runDir = resolveRunDir(runId, opts);
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

export function seedRepoSkill(repo, opts = {}) {
  const dest = join(repo, ".opencode", "skills", "feature");
  mkdirSync(dest, { recursive: true });
  const seedHashPath = join(dest, ".seed-hash");
  const recorded = readSeedHashes(seedHashPath);
  const nextHashes = { ...recorded };
  const skipped = [];
  const refreshed = [];
  for (const file of REPO_SEEDED_SKILL_FILES) {
    const source = join(root, "assets", "skills", "feature", file);
    const target = join(dest, file);
    const sourceText = readFileSync(source, "utf8");
    const sourceHash = sha256(sourceText);
    const currentText = existsSync(target) ? readFileSync(target, "utf8") : null;
    const currentHash = currentText === null ? null : sha256(currentText);
    const recordedHash = validSha256(recorded[file]);
    const packagedHash = currentHash !== null && knownSeedHashesFor(opts.knownSeedHashes, file).has(currentHash);
    const managedSeed = currentHash === null || currentHash === sourceHash || currentHash === recordedHash || packagedHash;
    const locallyEdited = currentHash !== null && currentHash !== sourceHash && !managedSeed;
    if (locallyEdited) {
      skipped.push(file);
      continue;
    }
    if (currentHash !== sourceHash) {
      copyFileSync(source, target);
      if (currentHash !== null) refreshed.push(file);
    }
    nextHashes[file] = sourceHash;
  }
  if (refreshed.length) console.warn(`feature-factory: refreshed stale repo-seeded feature skill file(s): ${refreshed.join(", ")}`);
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
  return JSON.stringify(featureCommandPayload(prompt, opts), null, 2);
}

export function validateSlices(plan) {
  return validateSlicesPlan(plan);
}

function featureCommandPayload(prompt, opts) {
  const githubAccount = resolveGithubAccount(opts);
  return {
    operator_request: String(prompt),
    driver: {
      mode: opts.autonomous ? "autonomous" : opts.headless ? "headless" : "interactive",
      ready: Boolean(opts.ready),
      reviewer: stringValue(opts.reviewer) ? opts.reviewer : null,
      github_account: githubAccount,
    },
  };
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
    cwd: factoryRepoFromRunDir(runDir),
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
