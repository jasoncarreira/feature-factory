#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { listRuns, startFactory, status, watchRun, writeGateAnswer } from "./factory.js";
import { runDoctor } from "./doctor.js";
import { collectProvenance } from "./provenance.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  console.log(`feature-factory

Commands:
  install [--local]             Add this package to ~/.config/opencode/opencode.jsonc
  doctor [--local]              Check opencode/plugin/provider/tool prerequisites
  factory start [--repo PATH] [--headless] <prompt...>
  factory list                  List local factory runs
  factory status [run-id]       Read .opencode/factory state
  factory answer <run> <gate> <approve|stop|changes: ...>
  factory watch [run-id]        Print status changes as JSON
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
  if (!cfg.plugin.includes(pluginSpec)) cfg.plugin.push(pluginSpec);
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
  if (sub === "start") return startFactory(positional, opts);
  if (sub === "list") return print(listRuns(opts), opts);
  if (sub === "status") return print(status(positional[0], opts), opts);
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

function options(args) {
  const opts = {
    cwd: process.cwd(),
    json: args.includes("--json"),
    local: args.includes("--local"),
    models: args.includes("--models"),
    providerSmoke: args.includes("--provider-smoke"),
    headless: args.includes("--headless") || args.includes("--detached"),
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repo") opts.cwd = resolve(args[++index]);
    if (args[index] === "--model") opts.model = args[++index];
    if (args[index] === "--interval") opts.intervalMs = Number(args[++index]);
  }
  return opts;
}

function positionals(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--repo", "--model", "--interval"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    output.push(arg);
  }
  return output;
}

function print(value, opts) {
  if (opts.json || typeof value !== "object") {
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) console.log(`${item.run_id}\t${item.status}\t${item.gate || "-"}\t${item.updated_at || "-"}`);
    return;
  }
  for (const [key, val] of Object.entries(value)) console.log(`${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
}

function readConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  return stripped ? JSON.parse(stripped) : {};
}

function localPluginSpec() {
  return pathToFileURL(join(root, "src", "plugin.js")).href;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
