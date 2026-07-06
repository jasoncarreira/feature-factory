import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assertHeartbeatOwnerCapability, hasInFlightHeartbeatWork, heartbeatOnce, withRunJsonLock } from "./run-state.js";
import { HEARTBEAT_PHASES, pendingProtectedGate, validateHeartbeatState, validateRun, validateRunAuthority, validateRunDir, validateSlicesPlan } from "./validate.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TERMINAL_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);
const HEARTBEAT_FILE = "heartbeat.json";
const HEARTBEAT_SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const MIN_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_HEARTBEAT_MAX_DURATION_MS = 7200000;
const DEFAULT_HEARTBEAT_STOP_WAIT_MS = 5000;
const DEFAULT_HEARTBEAT_POLL_MS = 25;
const HEARTBEAT_TICK_LOCK_TIMEOUT_MS = 1000;
const HEARTBEAT_ACTIVE_STATUSES = new Set(["active", "running"]);
const HEARTBEAT_TERMINAL_STATUSES = new Set(["stopped", "error"]);
const HEARTBEAT_PHASE_SET = new Set(HEARTBEAT_PHASES);
const HEARTBEAT_OWNER_ENV = "FEATURE_FACTORY_HEARTBEAT_OWNER";
const activeHeartbeatLoops = new Map();

export function startFactory(args, opts = {}) {
  if (!args.length) throw new Error("factory start requires a feature prompt");
  const repo = repoRoot(opts.cwd || process.cwd());
  seedRepoSkill(repo);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(formatPrompt(args.join(" "), { ...opts, repo }));
  if (opts.detached) return startDetached(repo, commandArgs);
  const proc = spawnSync("opencode", commandArgs, { cwd: repo, stdio: "inherit" });
  if (proc.status !== 0) throw new Error(`opencode exited ${proc.status ?? 1}`);
}

export function listRuns(opts = {}) {
  const root = factoryRoot(opts.cwd || process.cwd());
  const repo = repoRoot(opts.cwd || process.cwd());
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((runId) => {
      const file = join(root, runId, "run.json");
      if (!existsSync(file)) return null;
      const run = tryReadPublicRun(file, { ...opts, repoRoot: repo });
      if (run.error) {
        return {
          run_id: runId,
          status: "invalid",
          gate: null,
          review_tier: null,
          updated_at: null,
          path: file,
          error: run.error,
        };
      }
      return {
        run_id: run.value.run_id || runId,
        status: run.value.status || "unknown",
        gate: pendingGate(run.value),
        review_tier: selectedReviewTier(run.value),
        updated_at: run.value.updated_at || null,
        path: file,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

export function status(runId, opts = {}) {
  const run = loadPublicRun(runId, opts);
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
  };
}

export function heartbeatStatus(runId, opts = {}) {
  const file = heartbeatPath(resolveHeartbeatRunDir(runId, opts));
  if (!existsSync(file)) return null;
  return readHeartbeatFile(file);
}

export async function startHeartbeat(runId, config = {}, opts = {}) {
  const runDir = resolveHeartbeatRunDir(runId, opts);
  const heartbeatFile = heartbeatPath(runDir);
  const phase = normalizeHeartbeatPhase(config.phase);
  const intervalMs = normalizeHeartbeatInterval(config.intervalMs);
  const maxDurationMs = normalizeHeartbeatDuration(config.maxDurationMs);
  const startedAt = timestamp(opts.now);
  const token = String(opts.token || randomUUID());
  const ownerCapability = resolveHeartbeatOwnerCapability(opts, "startHeartbeat");
  let lease;

  await withRunJsonLock(runDir, async () => {
    const run = readRunFile(join(runDir, "run.json"));
    assertHeartbeatOwnerCapability(runDir, run.run_id, ownerCapability, "startHeartbeat");
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
    if (current.error) throw new Error(`invalid heartbeat lease at ${heartbeatFile}: ${current.error}`);
    if (current.value && !heartbeatLeaseReplaceable(current.value, startedAt)) {
      throw new Error(`heartbeat already active for run '${run.run_id}'`);
    }

    lease = validateHeartbeatState({
      schema_version: HEARTBEAT_SCHEMA_VERSION,
      run_id: run.run_id,
      token,
      phase,
      status: "running",
      pid: process.pid,
      started_at: startedAt,
      last_tick_at: startedAt,
      stop_requested_at: null,
      stopped_at: null,
      interval_ms: intervalMs,
      deadline_at: new Date(Date.parse(startedAt) + maxDurationMs).toISOString(),
      stop_reason: null,
    });
    writeHeartbeatFile(heartbeatFile, lease);
  });

  const runtime = createHeartbeatRuntime(runDir, lease, { ...opts, ownerCapability });
  activeHeartbeatLoops.set(runDir, runtime);
  runtime.loopPromise = runHeartbeatLoop(runtime);

  await runtime.firstTick.promise;
  const current = heartbeatStatus(runId, opts);
  if (!current || current.token !== token || !HEARTBEAT_ACTIVE_STATUSES.has(current.status)) {
    throw new Error(`heartbeat failed to start for run '${lease.run_id}'`);
  }
  return current;
}

export async function stopHeartbeat(runId, config = {}, opts = {}) {
  const runDir = resolveHeartbeatRunDir(runId, opts);
  const heartbeatFile = heartbeatPath(runDir);
  const waitMs = normalizeHeartbeatWait(config.waitMs);
  const force = Boolean(config.force);
  const requestedToken = stringValue(config.token) ? String(config.token) : null;
  const stopRequestedAt = timestamp(opts.now);
  let currentLease = null;

  await withRunJsonLock(runDir, async () => {
    const current = tryReadHeartbeatFile(heartbeatFile);
    if (current.error) throw new Error(`invalid heartbeat lease at ${heartbeatFile}: ${current.error}`);
    if (!current.value) {
      currentLease = null;
      return;
    }

    const lease = current.value;
    if (!requestedToken) {
      throw new Error(`heartbeat token required for run '${lease.run_id}'`);
    }
    if (lease.token !== requestedToken) {
      throw new Error(`heartbeat token mismatch for run '${lease.run_id}'`);
    }
    if (HEARTBEAT_TERMINAL_STATUSES.has(lease.status)) {
      currentLease = lease;
      return;
    }

    currentLease = validateHeartbeatState({
      ...lease,
      status: "stopping",
      stop_requested_at: lease.stop_requested_at || stopRequestedAt,
      stop_reason: lease.stop_reason || "stop-requested",
    });
    writeHeartbeatFile(heartbeatFile, currentLease);
  });

  if (!currentLease) return null;
  if (HEARTBEAT_TERMINAL_STATUSES.has(currentLease.status)) return currentLease;

  signalHeartbeatLoop(runDir, currentLease.token);

  const stopped = await waitForHeartbeatStop(runDir, currentLease.token, waitMs);
  if (stopped) return stopped;

  if (!isProcessAlive(currentLease.pid)) {
    return (
      (await finalizeHeartbeatStop(runDir, currentLease.token, {
        now: timestamp(),
        reason: currentLease.stop_reason || "process-exited",
        stopRequestedAt: currentLease.stop_requested_at || stopRequestedAt,
      })) || heartbeatStatus(runId, opts)
    );
  }

  if (force) {
    signalHeartbeatLoop(runDir, currentLease.token);
    return (
      (await finalizeHeartbeatStop(runDir, currentLease.token, {
        now: timestamp(),
        reason: "force-stop",
        stopRequestedAt: currentLease.stop_requested_at || stopRequestedAt,
      })) || heartbeatStatus(runId, opts)
    );
  }

  throw new Error(`timed out waiting for heartbeat '${currentLease.run_id}' to stop`);
}

export function writeGateAnswer(runId, gate, answer, opts = {}) {
  if (!gate) throw new Error("gate is required");
  if (!answer) throw new Error("answer is required: approve, changes: ..., or stop");
  const runDir = resolveRunDir(runId, opts);
  const run = readRunFile(join(runDir, "run.json"));
  const pending = pendingGate(run);
  if (pending && gate !== pending) throw new Error(`gate '${gate}' is not pending; current pending gate is '${pending}'`);
  if (!pending) throw new Error("run has no pending gate");
  const gatesDir = join(runDir, "gates");
  if (!existsSync(gatesDir)) throw new Error(`missing gates directory: ${gatesDir}`);
  const normalized = normalizeAnswer(answer);
  const answerPath = join(gatesDir, `${gate}.answer`);
  writeFileSync(answerPath, normalized + "\n");
  return { run_id: runId, gate, answer: normalized, path: answerPath };
}

export function latestRunId(opts = {}) {
  const runs = listRuns(opts);
  return runs[0]?.run_id || null;
}

export function watchRun(runId, opts = {}) {
  const intervalMs = Number(opts.intervalMs || 2000);
  let last = "";
  const print = () => {
    const current = JSON.stringify(opts.all ? listRuns(opts) : status(runId, opts));
    if (current !== last) {
      last = current;
      console.log(current);
    }
  };
  print();
  return setInterval(print, intervalMs);
}

export function validateState(runId, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDirs = runId ? [resolveRunDir(runId, opts)] : allRunDirs(opts);
  const runs = runDirs.map((dir) => ({ run_dir: dir, ...validateRunDir(dir, { ...opts, repoRoot: repo }) }));
  return { ok: runs.every((item) => item.ok), runs };
}

export function cleanupRun(runId, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = resolveRunDir(runId, { ...opts, cwd: repo });
  if (!insideFactoryRoot(repo, runDir)) {
    throw new Error(`cleanup run directory must be inside .opencode/factory: ${runDir}`);
  }
  const run = readRunFile(join(runDir, "run.json"));
  if (!TERMINAL_STATUSES.has(run.status) && !opts.force) {
    throw new Error(`run '${run.run_id}' is ${run.status}; cleanup requires terminal status or --force`);
  }

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
  for (const branch of cleanupBranches(run)) deleteBranch(repo, branch, result, opts, run.status);

  if (!opts.dryRun) rmSync(runDir, { recursive: true, force: true });
  result.removed_run_dir = !opts.dryRun;
  return result;
}

function cleanupWorktrees(run) {
  return [...new Set([run.worktree, ...(Array.isArray(run.slices) ? run.slices.map((slice) => slice?.worktree) : [])].filter(Boolean))];
}

function cleanupBranches(run) {
  return [...new Set([run.branch, ...(Array.isArray(run.slices) ? run.slices.map((slice) => slice?.branch) : [])].filter(Boolean))];
}

function removeWorktree(repo, worktree, result, opts) {
  const resolved = resolve(repo, worktree);
  if (!insideWorktreeRoot(repo, resolved)) {
    result.skipped_worktrees.push({ worktree, reason: "outside .opencode/worktrees" });
    return;
  }
  if (!existsSync(resolved)) {
    result.skipped_worktrees.push({ worktree: resolved, reason: "missing" });
    return;
  }
  if (!opts.dryRun) {
    const proc = spawnSync("git", ["worktree", "remove", "--force", resolved], { cwd: repo, encoding: "utf8" });
    if (proc.status !== 0) {
      result.skipped_worktrees.push({ worktree: resolved, reason: (proc.stderr || proc.stdout || "git worktree remove failed").trim() });
      return;
    }
  }
  result.removed_worktrees.push(resolved);
}

function deleteBranch(repo, branch, result, opts, runStatus) {
  const name = String(branch).trim();
  if (!name) return;
  const current = spawnSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).stdout?.trim();
  if (current === name) {
    result.skipped_branches.push({ branch: name, reason: "current branch" });
    return;
  }
  const exists = spawnSync("git", ["show-ref", "--verify", `refs/heads/${name}`], { cwd: repo, encoding: "utf8" });
  if (exists.status !== 0) {
    result.skipped_branches.push({ branch: name, reason: "missing" });
    return;
  }
  const deleteFlag = runStatus === "completed" || opts.force ? "-D" : "-d";
  if (opts.dryRun && deleteFlag === "-d" && !branchMergedIntoHead(repo, name)) {
    result.skipped_branches.push({ branch: name, reason: "not merged; use --force to delete" });
    return;
  }
  if (!opts.dryRun) {
    const proc = spawnSync("git", ["branch", deleteFlag, name], { cwd: repo, encoding: "utf8" });
    if (proc.status !== 0) {
      result.skipped_branches.push({ branch: name, reason: (proc.stderr || proc.stdout || "git branch delete failed").trim() });
      return;
    }
  }
  result.deleted_branches.push(name);
}

function branchMergedIntoHead(repo, branch) {
  return spawnSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], { cwd: repo, encoding: "utf8" }).status === 0;
}

function insideFactoryRoot(repo, runDir) {
  return insideDirectory(resolve(repo, ".opencode", "factory"), runDir);
}

function insideWorktreeRoot(repo, worktree) {
  return insideDirectory(resolve(repo, ".opencode", "worktrees"), worktree);
}

function insideDirectory(parent, child) {
  const rel = relative(physicalPath(parent), physicalPath(child));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function physicalPath(path) {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

function loadRun(runId, opts = {}) {
  return readRunFile(join(resolveRunDir(runId, opts), "run.json"));
}

function loadPublicRun(runId, opts = {}) {
  const runDir = resolveRunDir(runId, opts);
  const run = readRunFile(join(runDir, "run.json"));
  if (shouldSkipAuthorityValidation()) return run;
  const authority = validateRunAuthority(runDir, run, { ...opts, repoRoot: repoRoot(opts.cwd || process.cwd()) });
  if (!authority.ok) throw new Error(formatValidationChecks(authority.checks));
  return run;
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
    const runDir = dirname(file);
    const run = readRunFile(file);
    if (shouldSkipAuthorityValidation()) return { value: run };
    const authority = validateRunAuthority(runDir, run, opts);
    if (!authority.ok) return { error: formatValidationChecks(authority.checks) };
    return { value: run };
  } catch (error) {
    return { error: error.message };
  }
}

function resolveRunDir(runId, opts = {}) {
  const id = runId || latestRunId(opts);
  if (!id) throw new Error("no factory runs found");
  // Trusted operator escape hatch: callers may pass an explicit run directory.
  const asPath = resolve(String(id));
  if (existsSync(join(asPath, "run.json"))) return asPath;
  const dir = join(factoryRoot(opts.cwd || process.cwd()), String(id));
  if (!existsSync(join(dir, "run.json"))) throw new Error(`run not found: ${id}`);
  return dir;
}

function formatValidationChecks(checks) {
  const errors = checks.flatMap((check) => Array.isArray(check?.errors) ? check.errors : []);
  if (errors.length === 0) return "run validation failed";
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function shouldSkipAuthorityValidation() {
  const argv = process.argv.slice(2);
  return argv[0] === "factory" && argv[1] === "heartbeat";
}

function resolveHeartbeatRunDir(runId, opts = {}) {
  const id = runId || latestRunId(opts);
  if (!id) throw new Error("no factory runs found");
  const root = factoryRoot(opts.cwd || process.cwd());
  const normalized = normalizeHeartbeatRunId(id);
  const dir = resolve(root, normalized);
  if (!insideDirectory(root, dir)) {
    throw new Error(`heartbeat run directory must be inside .opencode/factory: ${dir}`);
  }
  if (!existsSync(join(dir, "run.json"))) throw new Error(`run not found: ${id}`);
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
  return typeof run.review_tier?.selected === "string" ? run.review_tier.selected : null;
}

function normalizeAnswer(answer) {
  const text = String(answer).trim();
  if (text === "approve" || text === "stop" || text.startsWith("changes:")) return text;
  throw new Error("answer must be exactly approve, stop, or start with changes:");
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
  for (const file of ["SKILL.md", "SCHEMA.md"]) {
    copyFileSync(join(root, "assets", "skills", "feature", file), join(dest, file));
  }
  ensureGitInfoExclude(repo, ".opencode/skills/feature/");
  return dest;
}

function ensureGitInfoExclude(repo, pattern) {
  const proc = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repo, encoding: "utf8" });
  if (proc.status !== 0) return;
  const excludePath = resolve(repo, proc.stdout.trim());
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (current.split(/\r?\n/).includes(pattern)) return;
  appendFileSync(excludePath, `${current.endsWith("\n") || !current ? "" : "\n"}${pattern}\n`);
}

function repoRoot(cwd) {
  const proc = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(cwd), encoding: "utf8" });
  return proc.status === 0 ? proc.stdout.trim() : resolve(cwd);
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
  const proc = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: repo, encoding: "utf8" });
  if (proc.status !== 0) return null;
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

function resolveHeartbeatOwnerCapability(opts = {}, command = "heartbeat") {
  const ownerCapability = stringValue(opts.ownerCapability) ? opts.ownerCapability : process.env[HEARTBEAT_OWNER_ENV];
  if (!stringValue(ownerCapability)) {
    throw new Error(`${command} requires trusted heartbeat owner capability from factory.lock`);
  }
  return ownerCapability.trim();
}

function createHeartbeatRuntime(runDir, lease, opts) {
  return {
    runDir,
    runId: lease.run_id,
    token: lease.token,
    ownerPid: lease.pid,
    ownerCapability: opts.ownerCapability,
    intervalMs: lease.interval_ms,
    tickTimeoutMs: normalizePositiveInteger(opts.tickTimeoutMs, HEARTBEAT_TICK_LOCK_TIMEOUT_MS, "tickTimeoutMs"),
    firstTick: deferred(),
    pendingWake: false,
    waiter: null,
    loopPromise: null,
  };
}

async function runHeartbeatLoop(runtime) {
  try {
    const first = await heartbeatTick(runtime);
    runtime.firstTick.resolve(first);
    if (!first.continue) return first;

    while (true) {
      await waitForHeartbeatInterval(runtime, runtime.intervalMs);
      const next = await heartbeatTick(runtime);
      if (!next.continue) return next;
    }
  } catch (error) {
    runtime.firstTick.resolve({ continue: false, reason: error.message });
    await markHeartbeatError(runtime.runDir, runtime.token, timestamp(), error.message);
    return { continue: false, reason: error.message };
  } finally {
    clearHeartbeatWaiter(runtime);
    if (activeHeartbeatLoops.get(runtime.runDir)?.token === runtime.token) activeHeartbeatLoops.delete(runtime.runDir);
  }
}

async function heartbeatTick(runtime) {
  const now = timestamp();
  const current = currentHeartbeatLease(runtime.runDir, runtime.runId, runtime.token, now);
  if (!current.active) {
    if (current.reason === "heartbeat-lease-stopping") {
      await finalizeHeartbeatStop(runtime.runDir, runtime.token, {
        now,
        reason: current.lease?.stop_reason || "stop-requested",
        stopRequestedAt: current.lease?.stop_requested_at || now,
      });
    } else if (current.reason === "heartbeat-lease-expired") {
      await finalizeHeartbeatStop(runtime.runDir, runtime.token, { now, reason: "max-duration-exceeded" });
    }
    return { continue: false, reason: current.reason };
  }

  const run = readRunFile(join(runtime.runDir, "run.json"));
  if (TERMINAL_STATUSES.has(run.status)) {
    await finalizeHeartbeatStop(runtime.runDir, runtime.token, { now, reason: `run-${run.status}` });
    return { continue: false, reason: "terminal-status" };
  }
  const protectedGate = pendingProtectedGate(run);
  if (protectedGate) {
    await finalizeHeartbeatStop(runtime.runDir, runtime.token, { now, reason: `pending-gate-${protectedGate}` });
    return { continue: false, reason: "protected-gate-pending" };
  }

  let result;
  try {
    result = await heartbeatOnce(
      runtime.runDir,
      { token: runtime.token, ownerPid: runtime.ownerPid, ownerCapability: runtime.ownerCapability, now },
      { timeoutMs: runtime.tickTimeoutMs },
    );
  } catch (error) {
    if (isRunJsonLockTimeout(error)) {
      return await stopHeartbeatLoopForError(runtime, now, error.message);
    }
    throw error;
  }

  if (!result.updated) {
    if (result.reason === "terminal-status") {
      await finalizeHeartbeatStop(runtime.runDir, runtime.token, { now, reason: `run-${result.status}` });
    } else if (result.reason === "protected-gate-pending") {
      await finalizeHeartbeatStop(runtime.runDir, runtime.token, {
        now,
        reason: result.gate ? `pending-gate-${result.gate}` : "protected-gate-pending",
      });
    } else if (result.reason === "no-in-flight-work") {
      await finalizeHeartbeatStop(runtime.runDir, runtime.token, { now, reason: "no-in-flight-work" });
    } else if (result.reason === "heartbeat-lease-stopping") {
      await finalizeHeartbeatStop(runtime.runDir, runtime.token, {
        now,
        reason: current.lease?.stop_reason || "stop-requested",
        stopRequestedAt: current.lease?.stop_requested_at || now,
      });
    } else if (result.reason === "heartbeat-lease-expired") {
      await finalizeHeartbeatStop(runtime.runDir, runtime.token, { now, reason: "max-duration-exceeded" });
    }
    return { continue: false, reason: result.reason };
  }

  const synced = await syncHeartbeatAfterTick(runtime.runDir, runtime.runId, runtime.token, now);
  return { continue: synced.continue, reason: synced.reason };
}

async function stopHeartbeatLoopForError(runtime, now, message) {
  await markHeartbeatError(runtime.runDir, runtime.token, now, message);
  return { continue: false, reason: message };
}

function currentHeartbeatLease(runDir, runId, token, now) {
  const current = tryReadHeartbeatFile(heartbeatPath(runDir));
  if (current.error) return { active: false, reason: "invalid-heartbeat-lease" };
  if (!current.value) return { active: false, reason: "missing-heartbeat-lease" };
  return inspectHeartbeatLease(current.value, runId, token, now);
}

function inspectHeartbeatLease(lease, runId, token, now) {
  if (lease.run_id !== runId) return { active: false, reason: "heartbeat-run-id-mismatch", lease };
  if (lease.token !== token) return { active: false, reason: "heartbeat-token-mismatch", lease };
  if (HEARTBEAT_TERMINAL_STATUSES.has(lease.status) || stringValue(lease.stopped_at)) {
    return { active: false, reason: "heartbeat-lease-stopped", lease };
  }
  if (lease.status === "stopping" || stringValue(lease.stop_requested_at)) {
    return { active: false, reason: "heartbeat-lease-stopping", lease };
  }
  const deadlineMs = Date.parse(lease.deadline_at);
  const nowMs = Date.parse(now);
  if (Number.isNaN(deadlineMs) || Number.isNaN(nowMs)) {
    return { active: false, reason: "invalid-heartbeat-lease", lease };
  }
  if (nowMs >= deadlineMs) {
    return { active: false, reason: "heartbeat-lease-expired", lease };
  }
  return { active: true, lease };
}

async function syncHeartbeatAfterTick(runDir, runId, token, now) {
  return withRunJsonLock(runDir, async () => {
    const current = tryReadHeartbeatFile(heartbeatPath(runDir));
    if (current.error) return { continue: false, reason: "invalid-heartbeat-lease" };
    if (!current.value) return { continue: false, reason: "missing-heartbeat-lease" };
    const state = inspectHeartbeatLease(current.value, runId, token, now);
    if (!state.active) {
      if (state.reason === "heartbeat-lease-stopping") {
        writeHeartbeatFile(
          heartbeatPath(runDir),
          stoppedHeartbeatState(state.lease, {
            lastTickAt: now,
            now,
            reason: state.lease?.stop_reason || "stop-requested",
            stopRequestedAt: state.lease?.stop_requested_at || now,
          }),
        );
      } else if (state.reason === "heartbeat-lease-expired") {
        writeHeartbeatFile(heartbeatPath(runDir), stoppedHeartbeatState(state.lease, { lastTickAt: now, now, reason: "max-duration-exceeded" }));
      }
      return { continue: false, reason: state.reason };
    }

    const next = validateHeartbeatState({
      ...state.lease,
      status: "running",
      pid: process.pid,
      last_tick_at: now,
    });
    writeHeartbeatFile(heartbeatPath(runDir), next);
    return { continue: true, reason: null };
  });
}

async function finalizeHeartbeatStop(runDir, token, { now, reason, stopRequestedAt } = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = tryReadHeartbeatFile(heartbeatPath(runDir));
    if (current.error || !current.value) return null;
    if (current.value.token !== token) return null;
    if (HEARTBEAT_TERMINAL_STATUSES.has(current.value.status)) return current.value;
    const next = stoppedHeartbeatState(current.value, {
      lastTickAt: resolveStoppedHeartbeatTickAt(runDir, current.value),
      now,
      reason,
      stopRequestedAt,
    });
    writeHeartbeatFile(heartbeatPath(runDir), next);
    return next;
  });
}

async function markHeartbeatError(runDir, token, now, reason) {
  try {
    return await withRunJsonLock(runDir, async () => {
      const current = tryReadHeartbeatFile(heartbeatPath(runDir));
      if (current.error || !current.value) return null;
      if (current.value.token !== token) return null;
      if (HEARTBEAT_TERMINAL_STATUSES.has(current.value.status)) return current.value;
      const next = validateHeartbeatState({
        ...current.value,
        last_tick_at: resolveStoppedHeartbeatTickAt(runDir, current.value),
        status: "error",
        stopped_at: now,
        stop_reason: reason || current.value.stop_reason || "heartbeat-error",
      });
      writeHeartbeatFile(heartbeatPath(runDir), next);
      return next;
    });
  } catch {
    return null;
  }
}

async function waitForHeartbeatStop(runDir, token, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const current = tryReadHeartbeatFile(heartbeatPath(runDir));
    if (current.value) {
      if (current.value.token !== token || HEARTBEAT_TERMINAL_STATUSES.has(current.value.status)) return current.value;
      if (!isProcessAlive(current.value.pid)) return null;
    } else if (!current.error) {
      return null;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(DEFAULT_HEARTBEAT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return null;
}

function signalHeartbeatLoop(runDir, token) {
  const runtime = activeHeartbeatLoops.get(runDir);
  if (!runtime || runtime.token !== token) return false;
  if (runtime.waiter) {
    runtime.waiter.resolve("signal");
    return true;
  }
  runtime.pendingWake = true;
  return true;
}

function waitForHeartbeatInterval(runtime, intervalMs) {
  if (runtime.pendingWake) {
    runtime.pendingWake = false;
    return Promise.resolve("signal");
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (runtime.waiter?.timer === timer) runtime.waiter = null;
      resolve("interval");
    }, intervalMs);
    runtime.waiter = {
      timer,
      resolve(reason) {
        clearTimeout(timer);
        if (runtime.waiter?.timer === timer) runtime.waiter = null;
        resolve(reason);
      },
    };
  });
}

function clearHeartbeatWaiter(runtime) {
  if (!runtime.waiter) return;
  runtime.waiter.resolve("cleared");
}

function heartbeatLeaseReplaceable(lease, now) {
  if (HEARTBEAT_TERMINAL_STATUSES.has(lease.status) || stringValue(lease.stopped_at)) return true;
  const deadlineMs = Date.parse(lease.deadline_at);
  const nowMs = Date.parse(now);
  if (Number.isNaN(deadlineMs) || Number.isNaN(nowMs)) return false;
  if (nowMs >= deadlineMs) return true;
  return !isProcessAlive(lease.pid);
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

function stoppedHeartbeatState(lease, { lastTickAt, now, reason, stopRequestedAt } = {}) {
  return validateHeartbeatState({
    ...lease,
    last_tick_at: lastTickAt || lease.last_tick_at,
    status: "stopped",
    stop_requested_at: stopRequestedAt || lease.stop_requested_at || null,
    stopped_at: now || timestamp(),
    stop_reason: reason || lease.stop_reason || "stop-requested",
  });
}

function resolveStoppedHeartbeatTickAt(runDir, lease) {
  const lastTickAt = stringValue(lease?.last_tick_at) ? lease.last_tick_at : null;
  const run = tryReadRunFile(join(runDir, "run.json"));
  const heartbeatAt = stringValue(run.value?.heartbeat_at) ? run.value.heartbeat_at : null;
  return latestTimestamp(lastTickAt, heartbeatAt) || lastTickAt || heartbeatAt || timestamp();
}

function latestTimestamp(left, right) {
  const leftMs = parseTimestamp(left);
  const rightMs = parseTimestamp(right);
  if (leftMs === null) return rightMs === null ? null : right;
  if (rightMs === null) return left;
  return rightMs >= leftMs ? right : left;
}

function parseTimestamp(value) {
  if (!stringValue(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
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

function normalizeHeartbeatPhase(phase) {
  if (!stringValue(phase)) throw new Error(`heartbeat phase must be one of ${HEARTBEAT_PHASES.join(", ")}`);
  if (!HEARTBEAT_PHASE_SET.has(phase)) throw new Error(`heartbeat phase must be one of ${HEARTBEAT_PHASES.join(", ")}`);
  return phase;
}

function normalizeHeartbeatInterval(value) {
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, normalizePositiveInteger(value, DEFAULT_HEARTBEAT_INTERVAL_MS, "intervalMs"));
}

function normalizeHeartbeatDuration(value) {
  return normalizePositiveInteger(value, DEFAULT_HEARTBEAT_MAX_DURATION_MS, "maxDurationMs");
}

function normalizeHeartbeatWait(value) {
  if (value === undefined || value === null) return DEFAULT_HEARTBEAT_STOP_WAIT_MS;
  const next = Number(value);
  if (!Number.isInteger(next) || next < 0) throw new Error("waitMs must be a non-negative integer");
  return next;
}

function normalizePositiveInteger(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const next = Number(value);
  if (!Number.isInteger(next) || next <= 0) throw new Error(`${name} must be a positive integer`);
  return next;
}

function timestamp(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid heartbeat timestamp");
  return new Date(parsed).toISOString();
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

function isRunJsonLockTimeout(error) {
  return error instanceof Error && /timed out waiting for run\.json lock/.test(error.message);
}

function deferred() {
  let resolve;
  let settled = false;
  const promise = new Promise((nextResolve) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      nextResolve(value);
    };
  });
  return { promise, resolve };
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
