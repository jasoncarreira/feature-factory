import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function startFactory(args, opts = {}) {
  if (!args.length) throw new Error("factory start requires a feature prompt");
  const repo = repoRoot(opts.cwd || process.cwd());
  seedRepoSkill(repo);
  const commandArgs = ["run", "--dir", repo, "--command", "feature", "--agent", "feature-factory"];
  if (opts.model) commandArgs.push("--model", opts.model);
  commandArgs.push(formatPrompt(args.join(" "), opts));
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
      const run = readRunFile(file);
      return {
        run_id: run.run_id || runId,
        status: run.status || "unknown",
        gate: pendingGate(run),
        updated_at: run.updated_at || null,
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
    status: run.status || "unknown",
    heartbeat_at: run.heartbeat_at || null,
    branch: run.branch || null,
    worktree: run.worktree || null,
    pending_gate: pendingGate(run),
    gates: run.gates || {},
    pr_url: run.pr_url || null,
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
    const current = JSON.stringify(status(runId, opts));
    if (current !== last) {
      last = current;
      console.log(current);
    }
  };
  print();
  return setInterval(print, intervalMs);
}

function loadRun(runId, opts = {}) {
  return readRunFile(join(resolveRunDir(runId, opts), "run.json"));
}

function readRunFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
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
  if (!opts.headless) return prompt;
  return `${prompt}

[Feature Factory Driver Mode]
Run in headless scripted mode: advance the factory only until the next gate or terminal status, write the gate question file and run.json state, then exit. If an answer file already exists for the pending gate, consume it and continue to the next gate. Do not wait for interactive chat input.`;
}
