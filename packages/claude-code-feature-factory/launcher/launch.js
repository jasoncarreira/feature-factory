// Start an unattended feature run as a detached `claude -p` session, then exit.
//
//   node launch.js [--cwd DIR] [--claude EXE] [--model MODEL] [--log PATH] -- <feature arguments>
//
// A `-p` session lives exactly as long as its process, so the session is started in its own process
// group (setsid) with its output going to a log file: it outlives this launcher and the shell that ran
// it. This prints the session id, its pid and the log, and exits.
//
// The flags isolate the run from the operator's own configuration, and each closes a trap found by
// trying it: without `--setting-sources project` a `-p` run inherits the user's permission settings, so a
// tool nobody allowed for the run can run anyway; without `--strict-mcp-config` the user's MCP connectors
// and their instructions reach every subagent. `--permission-prompts none` denies anything not allowed
// rather than waiting for an answer nobody will give, so an unattended run never hangs on a prompt.
//
// `--strict-mcp-config` also hides the repository's own `.mcp.json`, so the servers `.factory.json` names in
// `mcp_servers` are passed back in explicitly with `--mcp-config` and allowed by name. Without the allow
// rule, `--permission-prompts none` refuses every call to them.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// What a driver and its specialists use, before any project MCP server. Bash is unrestricted because a
// run's verify, test and publish commands are the repository's own; what each specialist is denied comes
// from its subagent file, not here.
export const ALLOWED_TOOLS = Object.freeze(["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "TodoWrite", "Write"]);

// The `.mcp.json` servers whose names match an `mcp_servers` entry of `.factory.json` in `cwd`, where `*`
// matches any run of characters and case is ignored. Either file absent or unreadable means none: the CLI
// validates `.factory.json` at init and reports a bad one there, so the launcher does not second-guess it.
export function projectMcpServers(cwd) {
  const json = (name) => { try { return JSON.parse(readFileSync(join(cwd, name), "utf8")); } catch { return null; } };
  const patterns = json(".factory.json")?.mcp_servers;
  const defined = json(".mcp.json")?.mcpServers;
  if (!Array.isArray(patterns) || !defined || typeof defined !== "object") return {};
  const matchers = patterns.filter((entry) => typeof entry === "string").map((entry) =>
    new RegExp(`^${entry.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "iu"));
  return Object.fromEntries(Object.entries(defined).filter(([name]) => matchers.some((matcher) => matcher.test(name))));
}

export function parseArgs(argv) {
  const split = argv.indexOf("--");
  if (split < 0 || split === argv.length - 1) throw new Error("usage: launch.js [options] -- <feature arguments>");
  const options = { cwd: process.cwd(), claude: "claude", model: null, log: null };
  const flags = argv.slice(0, split);
  for (let index = 0; index < flags.length; index += 2) {
    const [flag, value] = [flags[index], flags[index + 1]];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--cwd") options.cwd = resolve(value);
    else if (flag === "--claude") options.claude = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--log") options.log = resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  return { ...options, request: argv.slice(split + 1).join(" ") };
}

export function claudeArgs({ request, model, mcpServers = {} }, sessionId, pluginRoot = PLUGIN_ROOT) {
  // A server's tools are `mcp__<name>__<tool>`, with characters outside [A-Za-z0-9_-] in the name made `_`,
  // and `mcp__<name>` allows all of them.
  const servers = Object.keys(mcpServers).map((name) => name.replace(/[^A-Za-z0-9_-]/gu, "_"));
  const args = [
    "-p", `/feature-factory:feature ${request}`,
    "--plugin-dir", pluginRoot,
    "--session-id", sessionId,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    ...(servers.length ? ["--mcp-config", JSON.stringify({ mcpServers })] : []),
    "--allowedTools", [...ALLOWED_TOOLS, ...servers.map((name) => `mcp__${name}`)].join(","),
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (model) args.push("--model", model);
  return args;
}

export function launch(options, pluginRoot = PLUGIN_ROOT) {
  // The skill runs the CLI the plugin bundles. A checkout that never ran `npm run vendor` has none, and
  // the run would stop at its first factory command after the session was already started.
  const cli = join(pluginRoot, "vendor", "feature-factory", "bin", "factory.js");
  if (!existsSync(cli)) throw new Error(`no bundled factory CLI at ${cli}; run \`npm run vendor\` in ${pluginRoot}`);
  const sessionId = randomUUID();
  const mcpServers = projectMcpServers(options.cwd);
  const log = options.log ?? join(tmpdir(), `feature-factory-${sessionId}.jsonl`);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    const child = spawn(options.claude, claudeArgs({ ...options, mcpServers }, sessionId, pluginRoot),
      { cwd: options.cwd, detached: true, stdio: ["ignore", fd, fd] });
    child.once("error", () => {});
    child.unref();
    if (!child.pid) throw new Error(`could not start '${options.claude}'`);
    return { sessionId, pid: child.pid, log, cwd: options.cwd, mcp_servers: Object.keys(mcpServers), stop: `kill -TERM -- -${child.pid}` };
  } finally {
    closeSync(fd);
  }
}

// Through the realpath: `import.meta.url` resolves symlinks and argv does not, so on a symlinked install
// (macOS /var -> /private/var, or a linked global prefix) a plain comparison is false and the script would
// exit 0 having printed nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(launch(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
