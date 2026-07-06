import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { validateRun, validateRunDir, validateSlicesPlan } from "./validate.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TERMINAL_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);

export function startFactory(args, opts = {}) {
  if (!args.length) throw new Error("factory start requires a feature prompt");
  const repo = repoRoot(opts.cwd || process.cwd());
  seedRepoSkill(repo);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(formatPrompt(args.join(" "), opts));
  if (opts.detached) return startDetached(repo, commandArgs);
  const proc = spawnSync("opencode", commandArgs, { cwd: repo, stdio: "inherit" });
  if (proc.status !== 0) throw new Error(`opencode exited ${proc.status ?? 1}`);
}

export function listRuns(opts = {}) {
  const root = factoryRoot(opts.cwd || process.cwd());
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((runId) => {
      const file = join(root, runId, "run.json");
      if (!existsSync(file)) return null;
      const run = tryReadRunFile(file);
      if (run.error) {
        return {
          run_id: runId,
          status: "invalid",
          gate: null,
          updated_at: null,
          path: file,
          error: run.error,
        };
      }
      return {
        run_id: run.value.run_id || runId,
        status: run.value.status || "unknown",
        gate: pendingGate(run.value),
        updated_at: run.value.updated_at || null,
        path: file,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

export function status(runId, opts = {}) {
  const run = loadRun(runId, opts);
  return {
    run_id: run.run_id,
    schema_version: run.schema_version || run.version || null,
    mode: run.mode || null,
    status: run.status || "unknown",
    heartbeat_at: run.heartbeat_at || null,
    branch: run.branch || null,
    worktree: run.worktree || null,
    pending_gate: pendingGate(run),
    gates: run.gates || {},
    pr_url: run.pr_url || null,
    terminal_result: run.terminal_result || null,
    updated_at: run.updated_at || null,
  };
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
  const runDirs = runId ? [resolveRunDir(runId, opts)] : allRunDirs(opts);
  const runs = runDirs.map((dir) => ({ run_dir: dir, ...validateRunDir(dir) }));
  return { ok: runs.every((item) => item.ok), runs };
}

export function cleanupRun(runId, opts = {}) {
  const repo = repoRoot(opts.cwd || process.cwd());
  const runDir = resolveRunDir(runId, { ...opts, cwd: repo });
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
  for (const branch of cleanupBranches(run)) deleteBranch(repo, branch, result, opts);

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

function deleteBranch(repo, branch, result, opts) {
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
  if (!opts.dryRun) {
    const proc = spawnSync("git", ["branch", "-D", name], { cwd: repo, encoding: "utf8" });
    if (proc.status !== 0) {
      result.skipped_branches.push({ branch: name, reason: (proc.stderr || proc.stdout || "git branch delete failed").trim() });
      return;
    }
  }
  result.deleted_branches.push(name);
}

function insideWorktreeRoot(repo, worktree) {
  const root = physicalPath(resolve(repo, ".opencode", "worktrees"));
  const rel = relative(root, physicalPath(worktree));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function physicalPath(path) {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

function loadRun(runId, opts = {}) {
  return readRunFile(join(resolveRunDir(runId, opts), "run.json"));
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

function normalizeAnswer(answer) {
  const text = String(answer).trim();
  if (text === "approve" || text === "stop" || text.startsWith("changes:")) return text;
  throw new Error("answer must be exactly approve, stop, or start with changes:");
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
  if (opts.autonomous) return autonomousPrompt(prompt, opts);
  if (!opts.headless) return prompt;
  return `${prompt}

[Feature Factory Driver Mode]
Run in headless scripted mode: advance the factory only until the next gate or terminal status, write the gate question file and run.json state, then exit. If an answer file already exists for the pending gate, consume it, record approved answers with approval_source "external-driver", and continue to the next gate. Do not wait for interactive chat input.`;
}

export function validateSlices(plan) {
  return validateSlicesPlan(plan);
}

function autonomousPrompt(prompt, opts) {
  const extras = [];
  if (opts.ready) extras.push("If a draft PR is created successfully and repository policy allows, mark it ready for review after creation.");
  if (opts.reviewer) extras.push(`After creating the PR, request review from: ${opts.reviewer}.`);
  return `${prompt}

[Feature Factory Autonomous Mode]
Run in autonomous scripted mode. This is explicit operator opt-in.

Drive the factory to a terminal state without relying on an external gate relay:

- Keep the normal durable control plane under .opencode/factory/<run-id>/ and keep writing gate question files for auditability.
- Do not stop at story or brief gates when the producing artifacts are complete, internally consistent, and no product/security/UX/external-policy ambiguity remains. Record these as approved with answer "approve", approval_source "autonomous", and a short evidence note in run.json.
- If story or brief approval would require a human product decision, mark the run status "needs-human" with a clear reason and terminal_result, then stop.
- At pre_pr, use the factory's own two-lens panel verdict as the gate decision. GO/PASS may approve pre_pr autonomously and proceed to draft PR creation. Any validator NO-GO or security-reviewer BLOCK is NO-GO.
- On NO-GO, run the bounded remediation loop described by the feature skill, re-observe, and re-run the panel. Do not exceed run.json.max_retries or 3 attempts if unset.
- If remediation is exhausted, mark status "blocked" with the top finding and terminal_result, then stop.
- Never auto-merge. Draft PR creation is the final autonomous side effect.
- At every terminal state, write run.json.terminal_result with status, run_id, pr_url, reason, summary, and artifact references useful to external harnesses.

${extras.join("\n")}`.trim();
}
