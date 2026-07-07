#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { cleanupRun, heartbeatStatus, listRuns, startFactory, startHeartbeat, status, stopHeartbeat, validateState, watchRun, writeGateAnswer } from "./factory.js";
import { runDoctor } from "./doctor.js";
import { collectProvenance } from "./provenance.js";
import { assertHeartbeatOwnerCapability, heartbeatOnce } from "./run-state.js";
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
  const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc");
  mkdirSync(dirname(configPath), { recursive: true });
  const pluginSpec = local ? localPluginSpec() : "opencode-feature-factory";
  const cfg = readConfig(configPath);
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
  if (sub === "provenance") return print(await collectProvenance({ cwd: opts.cwd }), { ...opts, json: true });
  if (sub === "answer") {
    const [runId, gate, ...answerParts] = positional;
    return print(writeGateAnswer(runId, gate, answerParts.join(" "), opts), opts);
  }
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
  }
  return opts;
}

function positionals(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--repo", "--gh-account", "--model", "--interval", "--max-duration", "--wait-ms", "--phase", "--token", "--reviewer"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    output.push(arg);
  }
  return output;
}

function print(value, opts) {
  if (value === undefined) return;
  if (value === null || opts.json || typeof value !== "object") {
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) console.log(`${item.run_id}\t${item.status}\t${item.gate || "-"}\t${item.updated_at || "-"}`);
    return;
  }
  for (const [key, val] of Object.entries(value)) console.log(`${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
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

function readConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  return stripped ? JSON.parse(stripped) : {};
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
