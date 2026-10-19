import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGET, createCommand, daemonEnv, freshSocketPath, launch, parseArgs } from "../bin/launch.js";

const LAUNCH = fileURLToPath(new URL("../bin/launch.js", import.meta.url));

// A daemon that speaks the line protocol the way Prime 0.10's does: it greets on connect, and each
// response echoes the envelope id. `refuse` names a command type answered with an error instead, and
// `drop` one whose acknowledgement is lost: the daemon takes it and closes the connection unanswered.
function fakeDaemon(socket, { refuse = null, drop = null } = {}) {
  const received = [];
  const server = createServer((stream) => {
    stream.write(`${JSON.stringify({ type: "daemon_hello", protocol: { version: 9 } })}\n`);
    createInterface({ input: stream }).on("line", (line) => {
      const envelope = JSON.parse(line);
      received.push(envelope);
      const { command } = envelope;
      if (command.type === drop) return stream.destroy();
      const reply = command.type === refuse ? { error: `${refuse} is not allowed` }
        : command.type === "create" ? { data: { activeSessionId: "abc123def456" } } : { data: {} };
      stream.write(`${JSON.stringify({ type: "response", id: envelope.id, ...reply })}\n`);
    });
  });
  return new Promise((ok) => server.listen(socket, () => ok({ received, close: () => new Promise((done) => server.close(done)) })));
}

describe("Prime unattended launch", () => {
  it("creates a resident autonomous session on a daemon and prompts it with the feature skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "ff-launch-"));
    const socket = join(root, "d.sock");
    const daemon = await fakeDaemon(socket);
    try {
      const options = parseArgs(["--socket", socket, "--cwd", root, "--max-turns", "7", "--", "--autonomous", "136"]);
      const launched = await launch(options);
      assert.deepEqual(launched, { socket, activeSessionId: "abc123def456", stop: `PRIME_AGENT_DAEMON_SOCKET=${socket} prime-agent stop abc123def456` });
      const [create, prompt] = daemon.received;
      assert.deepEqual([create.protocol, create.command.id], [{ version: 9 }, create.id], "the envelope carries the greeting's protocol and the id twice");
      // Resident, or the session dies with this client the moment it exits. The whole budget is sent, because a
      // named budget leaves every unnamed limit unlimited rather than at Prime's defaults.
      assert.equal(create.command.lifecycle, "resident");
      assert.deepEqual(create.command.config, { cwd: root, autonomous: { enabled: true, ...DEFAULT_BUDGET, maxTurns: 7 } });
      assert.deepEqual([prompt.command.type, prompt.command.activeSessionId, prompt.command.message],
        ["prompt", "abc123def456", "/skill:feature --autonomous 136"]);
    } finally { await daemon.close(); }

    // A refusal is reported and nothing is prompted; the CLI exits nonzero with no stdout to bind.
    const refusing = await fakeDaemon(join(root, "r.sock"), { refuse: "create" });
    try {
      const child = spawn(process.execPath, [LAUNCH, "--socket", join(root, "r.sock"), "--", "x"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const status = await new Promise((ok) => child.on("close", ok));
      assert.deepEqual([status, stdout], [1, ""], "a refused launch prints nothing to bind and exits nonzero");
      assert.match(stderr, /create refused: "create is not allowed"/u);
      await assert.rejects(launch(parseArgs(["--socket", join(root, "r.sock"), "--", "x"])), /create refused: "create is not allowed"/u);
      assert.deepEqual(refusing.received.map((envelope) => envelope.command.type).slice(-1), ["create"], "no prompt after a refused create");
    } finally { await refusing.close(); }

    // Once create has succeeded a resident session exists whatever happens next, so a failed prompt still
    // prints its handle, and says whether the prompt was refused or may be running unconfirmed.
    const run = async (args) => {
      const child = spawn(process.execPath, [LAUNCH, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      return { status: await new Promise((ok) => child.on("close", ok)), stdout, stderr };
    };
    for (const [name, behaviour, prompt, message] of [["p.sock", { refuse: "prompt" }, "refused", /prompt refused: "prompt is not allowed"/u],
      ["l.sock", { drop: "prompt" }, "unconfirmed", /closed the connection before the prompt response/u]]) {
      const sock = join(root, name);
      const failing = await fakeDaemon(sock, behaviour);
      try {
        const { status, stdout, stderr } = await run(["--socket", sock, "--", "x"]);
        assert.equal(status, 1, `${prompt}: the launch failed`);
        assert.deepEqual(JSON.parse(stdout), { socket: sock, activeSessionId: "abc123def456",
          stop: `PRIME_AGENT_DAEMON_SOCKET=${sock} prime-agent stop abc123def456`, prompt }, `${prompt}: the handle survives the failure`);
        assert.match(stderr, message);
        // An unconfirmed prompt may be a running driver, so it is never sent twice.
        assert.deepEqual(failing.received.map((envelope) => envelope.command.type), ["create", "prompt"], `${prompt}: one prompt, no retry`);
      } finally { await failing.close(); }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("parses only its own options, keeps the request verbatim, and starts its daemon clean", () => {
    assert.deepEqual(parseArgs(["--", "--autonomous", "--base", "main", "136"]).request, "--autonomous --base main 136");
    assert.deepEqual(parseArgs(["--skill", "a/SKILL.md", "--skill", "b/SKILL.md", "--", "x"]).skills.map((path) => path.split("/").slice(-2).join("/")),
      ["a/SKILL.md", "b/SKILL.md"]);
    for (const [argv, message] of [[["x"], /usage/u], [["--"], /usage/u], [["--max-turns", "0", "--", "x"], /positive integer/u],
      [["--max-tokens", "1e6", "--", "x"], /positive integer/u], [["--cwd", "--", "x"], /missing value for --cwd|unknown option/u], [["--bogus", "1", "--", "x"], /unknown option --bogus/u]]) {
      assert.throws(() => parseArgs(argv), message, argv.join(" "));
    }
    assert.deepEqual(createCommand({ cwd: "/r", skills: ["/s/SKILL.md"], name: "n", budget: DEFAULT_BUDGET }).config.skills, ["/s/SKILL.md"]);
    assert.equal("skills" in createCommand({ cwd: "/r", skills: [], name: "n", budget: DEFAULT_BUDGET }).config, false,
      "no --skill sends no skills key, leaving the session to discovery alone");
    // A daemon started from inside a Prime session would otherwise come up as a worker and never handshake.
    assert.deepEqual(daemonEnv({ PATH: "/bin", GH_TOKEN: "t", PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1", PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: "x" }),
      { PATH: "/bin", GH_TOKEN: "t" }, "the run's credentials must reach the daemon, its worker identity must not");
    const fresh = freshSocketPath("stamp", { TMPDIR: "/tmp" });
    assert.equal(fresh, `/tmp/prime-agent-${process.getuid()}/feature-stamp.sock`);
    assert.equal(freshSocketPath("stamp", { TMPDIR: `/${"x".repeat(120)}` }), fresh, "a TMPDIR too long for a socket falls back to /tmp");
  });
});
