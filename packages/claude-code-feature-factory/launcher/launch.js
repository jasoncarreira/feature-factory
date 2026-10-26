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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// What a driver and its specialists use. Bash is unrestricted because a run's verify, test and publish
// commands are the repository's own; each specialist's narrower `tools` list is enforced by its subagent
// file, not here.
export const ALLOWED_TOOLS = Object.freeze(["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "TodoWrite", "Write"]);

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

export function claudeArgs({ request, model }, sessionId, pluginRoot = PLUGIN_ROOT) {
  const args = [
    "-p", `/feature-factory:feature ${request}`,
    "--plugin-dir", pluginRoot,
    "--session-id", sessionId,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--allowedTools", ALLOWED_TOOLS.join(","),
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
  const log = options.log ?? join(tmpdir(), `feature-factory-${sessionId}.jsonl`);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    const child = spawn(options.claude, claudeArgs(options, sessionId, pluginRoot),
      { cwd: options.cwd, detached: true, stdio: ["ignore", fd, fd] });
    child.once("error", () => {});
    child.unref();
    if (!child.pid) throw new Error(`could not start '${options.claude}'`);
    return { sessionId, pid: child.pid, log, cwd: options.cwd, stop: `kill -TERM -- -${child.pid}` };
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
