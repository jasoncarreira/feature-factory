import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import plugin from "./plugin.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function collectProvenance(options = {}) {
  const resolvedConfig = await resolvePluginConfig(options.pluginOptions || {});
  return {
    feature_factory_version: packageVersion(),
    opencode_version: commandOutput("opencode", ["--version"]),
    plugin_spec: options.pluginSpec || "opencode-feature-factory",
    resolved_models: Object.fromEntries(
      Object.entries(resolvedConfig.agent || {}).map(([name, agent]) => [name, agent.model || null]),
    ),
    resolved_variants: Object.fromEntries(
      Object.entries(resolvedConfig.agent || {}).map(([name, agent]) => [name, agent.variant || null]),
    ),
    driver: {
      kind: options.driverKind || "cli",
      name: "feature-factory",
      version: packageVersion(),
    },
    capabilities: detectCapabilities(options.cwd || process.cwd()),
  };
}

export async function resolvePluginConfig(pluginOptions = {}) {
  const hooks = await plugin({}, pluginOptions);
  const cfg = {};
  hooks.config(cfg);
  return cfg;
}

export function detectCapabilities(cwd = process.cwd()) {
  return {
    git: commandOk("git", ["--version"]),
    gh: commandOk("gh", ["--version"]),
    gh_auth: commandOk("gh", ["auth", "status"]),
    opencode: commandOk("opencode", ["--version"]),
    opencode_run_command: opencodeRunSupports("--command"),
    opencode_run_dir: opencodeRunSupports("--dir"),
    git_repo: commandOk("git", ["rev-parse", "--show-toplevel"], cwd),
    base_branch: detectBaseBranch(cwd),
    factory_gitignored: gitIgnored(cwd, ".opencode/factory/"),
    worktrees_gitignored: gitIgnored(cwd, ".opencode/worktrees/"),
  };
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.version || "unknown";
}

function commandOk(command, args, cwd = process.cwd()) {
  return spawnSync(command, args, { cwd, stdio: "ignore" }).status === 0;
}

function commandOutput(command, args, cwd = process.cwd()) {
  const proc = spawnSync(command, args, { cwd, encoding: "utf8" });
  return proc.status === 0 ? (proc.stdout || proc.stderr || "").trim() : null;
}

function opencodeRunSupports(flag) {
  const help = commandOutput("opencode", ["run", "--help"]);
  return Boolean(help && help.includes(flag));
}

function detectBaseBranch(cwd) {
  const symbolic = commandOutput("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
  if (symbolic) return symbolic.replace(/^origin\//, "");
  for (const candidate of ["main", "master", "development", "develop"]) {
    if (commandOk("git", ["rev-parse", "--verify", `origin/${candidate}`], cwd)) return candidate;
  }
  return null;
}

function gitIgnored(cwd, path) {
  if (!existsSync(join(cwd, ".git")) && !commandOk("git", ["rev-parse", "--show-toplevel"], cwd)) return null;
  return commandOk("git", ["check-ignore", path], cwd);
}
