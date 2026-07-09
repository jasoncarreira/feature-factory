import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants as FS_CONSTANTS, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { hasInFlightHeartbeatWork, resolveGateAnswerTarget, transitionSteeringConsumed, transitionSteeringQueued, withRunJsonLock } from "./run-state.js";
import { pendingProtectedGate, steeringConsistencyChecks, validateHeartbeatState, validateRun, validateRunDir, validateSlicesPlan } from "./validate.js";
import { collectRunDebugSnapshot } from "./env-snapshot.js";
import { diagnoseRunDir, diagnoseRunObject } from "./factory-diagnostics.js";
import { git, repoRoot } from "./git.js";
import { checkWorktreeIdentity, deriveExpectedWorktreePath } from "./worktrees.js";
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

export async function startFactory(args, opts = {}) {
  if (!args.length) throw new Error("factory start requires a feature prompt");
  const repo = repoRoot(opts.cwd || process.cwd());
  const resumeRunId = resumePromptRunId(args, opts);
  if (resumeRunId) {
    const activeHeartbeatPreflight = startResumeActiveHeartbeatPreflight(resumeRunId, { ...opts, cwd: repo, repoRoot: repo });
    if (activeHeartbeatPreflight) return activeHeartbeatPreflight;
    const preflight = await recoverDisruptedRun(resumeRunId, { ...opts, cwd: repo });
    if (!preflight.ok) return preflight;
    const eligibility = startResumeEligibility(preflight, { ...opts, cwd: repo, repoRoot: repo });
    if (!eligibility.ok) return eligibility;
  }
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

export async function recoverDisruptedRun(runId, opts = {}) {
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

  const worktree = resolveRecoveryWorktree(repo, run);
  if (!worktree.ok) {
    return persistRecoveryTerminal(target.runDir, run, "needs-human", worktree.reason, opts);
  }

  const evidence = reconcileRecoveryGitEvidence(repo, run);
  if (!evidence.ok) {
    return persistRecoveryTerminal(target.runDir, run, "blocked", evidence.reason, opts);
  }

  const current = checkExistingRecoveryWorktree(repo, worktree.path, run.branch);
  if (current.status === "healthy") return recoveryEnvelope(run, {
    ok: true,
    durable: true,
    updated: false,
    recovered: false,
    runDir: target.runDir,
    worktree: current.worktree,
    branchHead: evidence.branchHead,
  });
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
  };
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

export async function resumeFactory(runId, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = resolveRunDir(runId, { ...opts, cwd: repo });
  const run = readRunFile(join(runDir, "run.json"));
  const eligibility = resumeEligibility(runDir, run, { ...opts, cwd: repo, repoRoot: repo });
  if (!eligibility.eligible) throw new Error(`resume ineligible: ${eligibility.reasons.join(", ")}`);
  const payload = buildResumePayload(run, { ...opts, repo });
  if (opts.dryRun) return { status: "dry-run", eligible: true, eligibility, payload };

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
    steering: steeringSummary(run),
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
  if (!stringValue(parentRun.branch)) {
    throw new Error(`parent run '${parentRun.run_id}' must have a local branch`);
  }
  if (!branchExists(repo, parentRun.branch)) {
    throw new Error(`parent run '${parentRun.run_id}' requires existing branch '${parentRun.branch}'`);
  }

  const targetRunId = normalizeContinuationTargetRunId(opts.runId, parentRun.run_id);
  assertContinuationTargetAvailable(repo, targetRunId);
  const review = resolveContinuationReview(parentRunDir, requiredContinuationReview(opts.review));
  const reviewSource = resolveContinuationReviewSource(parentRun, review.ref);
  const reviewMetadata = validateContinuationReview(readReviewJson(review.path), review.ref, reviewSource, parentRunDir);
  const targetBaseRef = continuationBaseRef(parentRun);
  const targetBaseCommit = continuationBaseCommit(repo, parentRun, targetBaseRef);

  return {
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
  };
}

function requiredParentWorktree(parentRun) {
  if (!stringValue(parentRun.worktree)) throw new Error(`parent run '${parentRun.run_id}' must have a recorded worktree`);
  return parentRun.worktree;
}

function continuationBaseRef(parentRun) {
  return stringValue(parentRun.base_ref) ? String(parentRun.base_ref).trim() : "main";
}

function continuationBaseCommit(repo, parentRun, baseRef) {
  if (stringValue(parentRun.base_commit)) return String(parentRun.base_commit).trim();
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
  return JSON.stringify(featureCommandPayload(prompt, opts), null, 2);
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
    consume: null,
    raw_message_included: false,
  };
  const pending = steeringPendingMetadata(run.steering?.pending);
  if (pending) {
    steering.pending = pending;
    steering.consume = {
      command: "feature-factory",
      args: ["factory", "steer-consume", run.run_id, "--ref", pending.ref, "--hash", pending.hash, "--json"],
    };
  }
  return {
    operator_request: `resume ${run.run_id}`,
    driver: {
      mode: opts.autonomous ? "autonomous" : opts.headless ? "headless" : "interactive",
      ready: false,
      reviewer: null,
      github_account: resolveGithubAccount(opts),
    },
    resume: {
      schema_version: 1,
      kind: "existing-run-resume",
      run_id: run.run_id,
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
  else if (heartbeat.value && heartbeatIsFresh(heartbeat.value, timestamp(opts.now), opts)) reasons.push("active-heartbeat");
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], diagnostics, steering_checks: steeringChecks, heartbeat: heartbeat.value ? withHeartbeatLiveness(heartbeat.value, opts) : null };
}

function assertResumeMutationAllowed(runDir, run, opts = {}) {
  const eligibility = resumeEligibility(runDir, run, opts);
  if (!eligibility.eligible) throw new Error(`record-resume requires resumable run: ${eligibility.reasons.join(", ")}`);
  return eligibility;
}

function steeringSummary(run) {
  const steering = run?.steering;
  if (!steering || typeof steering !== "object" || Array.isArray(steering)) return { pending: null, consumed_count: 0, latest_consumed: null };
  const consumed = Array.isArray(steering.history) ? steering.history.filter((item) => item?.event === "consumed") : [];
  const latest = consumed[consumed.length - 1] || null;
  return {
    pending: steeringPendingMetadata(steering.pending),
    consumed_count: consumed.length,
    latest_consumed: latest ? {
      id: latest.id,
      ref: latest.ref,
      hash: latest.hash,
      message_chars: latest.message_chars,
      created_at: latest.created_at,
      consumed_at: latest.consumed_at,
    } : null,
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
    if (eventKind === "resume") assertResumeMutationAllowed(runDir, current, opts);
    const next = validateRun({
      ...current,
      debug_snapshot: nextDebugSnapshot(current.debug_snapshot, snapshot, eventKind),
    });
    writeJsonAtomic(runPath, next);
    return next.debug_snapshot;
  }, opts);
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
