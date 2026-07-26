import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { superviseDetachedLaunch } from "../src/detached-log-supervisor.js";

describe("detached log supervisor", () => {
  it("reports the actual child pid and drains serialized sanitized stdout/stderr", async () => {
    const fixture = createFixture("sanitize");
    const messages = [];
    try {
      const result = await superviseDetachedLaunch(init(fixture), { send: (message) => messages.push(message) });
      assert.equal(messages[0].type, "spawned");
      assert.equal(messages[1].type, "ready");
      assert.equal(messages[0].pid, messages[1].pid);
      assert.equal(result.pid, messages[1].pid);
      const log = readFileSync(fixture.log, "utf8");
      assert.match(log, /Authorization: Basic \[redacted\]/u);
      assert.doesNotMatch(log, /dXNlcjpzdXBlci1zZWNyZXQ/u);
      assert.equal(log.includes("\r"), false);
      assert.equal(log.includes("\u001b"), false);
      assert.equal(log.includes("\u0007"), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when a serialized log append fails without exposing source text", async () => {
    const fixture = createFixture("append-failure");
    let appends = 0;
    try {
      await assert.rejects(
        superviseDetachedLaunch(init(fixture), {
          send() {},
          appendFileFn: async () => {
            appends += 1;
            if (appends > 1) throw new Error("Authorization: Basic dXNlcjpmYWlsdXJlLXNlY3JldA==\u001b[31m");
          },
        }),
        (error) => {
          assert.doesNotMatch(error.message, /dXNlcjpmYWlsdXJl/u);
          assert.equal(error.message.includes("\u001b"), false);
          return true;
        },
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("cleans up the scoped run heartbeat before recording supervisor exit", async () => {
    const fixture = createFixture("heartbeat-cleanup");
    const runDir = join(fixture.root, ".opencode", "factory", "scoped-run");
    const calls = [];
    const launchToken = "opaque-supervisor-launch-token";
    mkdirSync(join(runDir, "processes"), { recursive: true });
    try {
      await superviseDetachedLaunch({
        ...init(fixture),
        env: { ...init(fixture).env, OPENCODE_FACTORY_LAUNCH_CLAIM: launchToken },
        runDir,
        runId: "scoped-run",
        executionId: "execution-1",
        logRef: "processes/child.log",
        recordEvidence: true,
      }, {
        send() {},
        inspectorFn: (pid) => ({ ok: true, inspector: "test", pid, start_marker: "start-1", command_name: "opencode", cwd: fixture.root }),
        stopHeartbeatFn: async (scopedRunDir) => calls.push(scopedRunDir),
      });

      assert.deepEqual(calls, [runDir]);
      const evidence = JSON.parse(readFileSync(join(runDir, "process.json"), "utf8"));
      assert.equal(evidence.state, "exited");
      assert.equal(evidence.launch_token_hash, `sha256:${createHash("sha256").update(launchToken, "utf8").digest("hex")}`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("resolves when the child closes during identity settling", async () => {
    // `close` is emitted once. Registering the listener only after the awaited
    // identity work meant a short-lived child's close was missed and the
    // supervisor promise stayed pending forever — a real main-CI hang.
    const fixture = createFixture("close-during-settle");
    const runDir = join(fixture.root, ".opencode", "factory", "scoped-run");
    mkdirSync(join(runDir, "processes"), { recursive: true });
    const child = stubChild();
    try {
      const result = await withTimeout(superviseDetachedLaunch({
        ...init(fixture),
        runDir,
        runId: "scoped-run",
        executionId: "execution-1",
        logRef: "processes/child.log",
        recordEvidence: true,
      }, {
        spawnFn: () => child,
        send() {},
        // Close arrives while the supervisor is awaiting identity settling.
        sleepFn: async () => {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
        },
        inspectorFn: (pid) => ({ ok: true, inspector: "test", pid, start_marker: "start-1", command_name: "opencode", cwd: fixture.root }),
        stopHeartbeatFn: async () => {},
      }));

      assert.deepEqual(result, { pid: child.pid, status: "exited" });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("resolves for a child that already exited before supervision", async () => {
    const fixture = createFixture("already-exited");
    const child = stubChild();
    child.exitCode = 3;
    child.stdout.end();
    child.stderr.end();
    try {
      const result = await withTimeout(superviseDetachedLaunch(init(fixture), {
        spawnFn: () => child,
        send() {},
      }));

      assert.deepEqual(result, { pid: child.pid, status: "exited" });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function stubChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

// A hang is the defect under test, so bound it here rather than letting the
// runner time out with no attribution.
function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`supervisor did not settle within ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

function createFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `detached-supervisor-${name}-`));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = join(bin, "opencode");
  writeFileSync(script, `#!/usr/bin/env node
process.stdout.write("out Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ=\\r\\n");
process.stderr.write("err \\u001b]8;;https://evil.test\\u0007x\\n");
`, "utf8");
  chmodSync(script, 0o755);
  return { root, bin, log: join(root, "child.log") };
}

function init(fixture) {
  return {
    repo: fixture.root,
    commandArgs: ["run", "test"],
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH || ""}` },
    log: fixture.log,
    recordEvidence: false,
  };
}
