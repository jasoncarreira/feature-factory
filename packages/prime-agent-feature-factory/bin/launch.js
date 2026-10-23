// Start an unattended feature run as a Prime daemon session, then exit.
//
//   node launch.js [--cwd DIR] [--prime EXE] [--socket PATH] [--skill PATH]... [--name NAME]
//     [--max-turns N] [--max-continuations N] [--max-tokens N] [--timeout-ms N] -- <feature arguments>
//
// Prime 0.10 runs `-p` in-process, where `rlm.spawn` has no child runtime and `agent_message` and
// `agent_observe` do not exist, so a run launched that way stops at its first dispatch. Only a session
// inside a daemon worker can drive one. This creates a resident session (one that outlives its client)
// with the autonomous budget, prompts it with `/skill:feature <arguments>`, prints how to stop it, and
// exits; `prime-agent stop` ends it.
//
// The run needs the `GH_TOKEN` and `FACTORY_PUBLISHING_IDENTITY` this process was given. Prime 0.10.1
// applies a create's `launchEnv` to the session's worker, so it is always sent. Prime 0.10.0 ignores
// `launchEnv` and gives a session the daemon's boot environment instead, which is one reason the daemon is
// this launcher's own, started on a fresh socket with this process's environment. The other is keeping
// a run off an interactive daemon. `--socket` reuses a daemon you started yourself; on 0.10.0 it must
// have booted with the run's environment.
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// The limits OPERATING.md documents for a real issue. Prime's defaults stop a run before Gate 2, and a
// budget named on create leaves every unnamed limit unlimited, so all four are always sent.
export const DEFAULT_BUDGET = Object.freeze({ maxTurns: 600, maxContinuations: 200, maxTokens: 6_000_000, timeoutMs: 21_600_000 });
const BUDGET_FLAGS = { "--max-turns": "maxTurns", "--max-continuations": "maxContinuations", "--max-tokens": "maxTokens", "--timeout-ms": "timeoutMs" };
// macOS caps a Unix socket path at 104 bytes including the terminator.
const SOCKET_PATH_LIMIT = 103;

export function parseArgs(argv) {
  const split = argv.indexOf("--");
  if (split < 0 || split === argv.length - 1) throw new Error("usage: launch.js [options] -- <feature arguments>");
  const options = { cwd: process.cwd(), prime: "prime-agent", socket: null, skills: [], name: null, budget: { ...DEFAULT_BUDGET } };
  const flags = argv.slice(0, split);
  for (let index = 0; index < flags.length; index += 2) {
    const [flag, value] = [flags[index], flags[index + 1]];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (BUDGET_FLAGS[flag]) {
      if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${flag} must be a positive integer`);
      options.budget[BUDGET_FLAGS[flag]] = Number(value);
    } else if (flag === "--skill") options.skills.push(resolve(value));
    else if (flag === "--cwd") options.cwd = resolve(value);
    else if (flag === "--prime") options.prime = value;
    else if (flag === "--socket") options.socket = resolve(value);
    else if (flag === "--name") options.name = value;
    else throw new Error(`unknown option ${flag}`);
  }
  return { ...options, request: argv.slice(split + 1).join(" ") };
}

export function freshSocketPath(stamp = `${process.pid.toString(36)}${Date.now().toString(36)}`, env = process.env) {
  for (const base of [env.TMPDIR || tmpdir(), "/tmp"]) {
    const path = join(base, `prime-agent-${process.getuid()}`, `feature-${stamp}.sock`);
    if (Buffer.byteLength(path) <= SOCKET_PATH_LIMIT) return path;
  }
  throw new Error("no socket path under the 103-byte limit; pass --socket");
}

// Prime's own daemon launch and its `launchEnv` collection remove the same inherited worker and lease
// variables, or a daemon started from inside a Prime session would come up as a worker that never handshakes.
export function daemonEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PRIME_AGENT_INTERNAL_")));
}

export function createCommand({ cwd, skills, name, budget }, env = process.env) {
  const config = { cwd, autonomous: { enabled: true, ...budget } };
  if (skills.length) config.skills = skills;
  return { type: "create", lifecycle: "resident", name: name ?? `feature-${Date.now().toString(36)}`, config, launchEnv: daemonEnv(env) };
}

function connect(socket) {
  return new Promise((resolveConnection, reject) => {
    const stream = createConnection(socket);
    stream.once("error", reject);
    stream.once("connect", () => {
      stream.off("error", reject);
      // A message no waiter has claimed yet is kept rather than dropped, so the order in which the socket
      // delivers and this code awaits can never lose the greeting or a response.
      const backlog = [];
      const waiting = [];
      const deliver = (message) => {
        const index = waiting.findIndex((entry) => entry.match(message));
        if (index < 0) return backlog.push(message);
        const [entry] = waiting.splice(index, 1);
        entry.ok(message);
      };
      let closed = false;
      createInterface({ input: stream }).on("line", (line) => {
        try { deliver(JSON.parse(line)); } catch { /* not a protocol line */ }
      });
      // A dropped connection fails every waiter at once rather than leaving each to its timeout.
      stream.on("close", () => {
        closed = true;
        for (const entry of waiting.splice(0)) entry.fail(new Error(`the daemon closed the connection before ${entry.what}`));
      });
      stream.on("error", () => {});
      const next = (match, timeoutMs, what) => new Promise((ok, fail) => {
        const index = backlog.findIndex(match);
        if (index >= 0) return ok(backlog.splice(index, 1)[0]);
        if (closed) return fail(new Error(`the daemon closed the connection before ${what}`));
        const timer = setTimeout(() => fail(new Error(`timed out waiting for ${what} on ${socket}`)), timeoutMs);
        waiting.push({ match, what, ok: (message) => { clearTimeout(timer); ok(message); }, fail: (error) => { clearTimeout(timer); fail(error); } });
      });
      resolveConnection({ stream, next });
    });
  });
}

async function daemon(socket, prime) {
  try {
    return await connect(socket);
  } catch {
    mkdirSync(join(socket, ".."), { recursive: true, mode: 0o700 });
    // Detached is setsid on POSIX: the daemon must not die with the shell or supervisor that ran this.
    const child = spawn(prime, ["--mode", "daemon", "--daemon-socket", socket], { detached: true, stdio: "ignore", env: daemonEnv() });
    child.once("error", () => {});
    child.unref();
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      await new Promise((ok) => setTimeout(ok, 250));
      try { return await connect(socket); } catch { /* not listening yet */ }
    }
    throw new Error(`no Prime daemon answered on ${socket} after starting '${prime} --mode daemon'`);
  }
}

export async function launch(options) {
  const socket = options.socket ?? freshSocketPath();
  const { stream, next } = await daemon(socket, options.prime);
  try {
    const hello = await next((message) => message.type === "daemon_hello", 10_000, "the daemon greeting");
    let id = 0;
    const request = async (command) => {
      const requestId = `feature_${++id}`;
      stream.write(`${JSON.stringify({ type: "command", id: requestId, protocol: hello.protocol, clientId: `feature-launch:${process.pid}`, command: { ...command, id: requestId } })}\n`);
      const response = await next((message) => message.type === "response" && message.id === requestId, 30_000, `the ${command.type} response`);
      if (response.error || response.ok === false || response.success === false) {
        throw Object.assign(new Error(`${command.type} refused: ${JSON.stringify(response.error ?? response)}`), { refused: true });
      }
      return response;
    };
    const created = await request(createCommand(options));
    const activeSessionId = created.data?.activeSessionId;
    if (typeof activeSessionId !== "string" || !activeSessionId) throw new Error(`create returned no activeSessionId: ${JSON.stringify(created)}`);
    const handle = { socket, activeSessionId, stop: `PRIME_AGENT_DAEMON_SOCKET=${socket} ${options.prime} stop ${activeSessionId}` };
    try {
      await request({ type: "prompt", activeSessionId, message: `/skill:feature ${options.request}` });
    } catch (error) {
      // From here a resident session exists and outlives this client, so every failure carries its handle.
      // Only an answer that says no is a refusal: a lost or late acknowledgement may follow a prompt the
      // session accepted, and that run may be working on its full budget. Sending it again could start a
      // second driver, so this reports and never retries.
      error.handle = { ...handle, prompt: error.refused ? "refused" : "unconfirmed" };
      throw error;
    }
    return handle;
  } finally {
    stream.end();
  }
}

// Through the realpath: `import.meta.url` resolves symlinks and argv does not, so on a symlinked install
// (macOS /var -> /private/var, or a linked global prefix) a plain comparison is false and the script would
// exit 0 having printed nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await launch(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    // A session that exists is printed even on failure, with how its prompt ended, so it can be stopped.
    if (error.handle) process.stdout.write(`${JSON.stringify(error.handle)}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
