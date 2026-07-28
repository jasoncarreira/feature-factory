import assert from "node:assert/strict";
import { ChildProcess, spawn as spawnChild } from "./helpers/git-fixture.js";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createTrackedProcessCleanup } from "./process-cleanup-helper.js";

const HELPER = fileURLToPath(new URL("./process-cleanup-helper.js", import.meta.url));
const SLEEP_SCRIPT = "setInterval(() => {}, 1000)";

async function spawned(child) {
  if (child.pid) return child;
  await once(child, "spawn");
  return child;
}

async function stopFixture(child, originalKill = child.kill.bind(child)) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  originalKill("SIGTERM");
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 500); })]);
  clearTimeout(timer);
}

function spawnWithCapturedKill(owner, kill, ...spawnArgs) {
  const originalKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = kill;
  try {
    return owner.spawn(...spawnArgs);
  } finally {
    ChildProcess.prototype.kill = originalKill;
  }
}

describe("tracked process cleanup", () => {
  it("captures signaling for the exact owned child", async () => {
    const owner = createTrackedProcessCleanup({ timeoutMs: 500, diagnostic: () => {} });
    const exited = owner.spawn(process.execPath, ["-e", ""], {}, { label: "exited" });
    await once(exited, "exit");
    const surviving = await spawned(owner.spawn(process.execPath, ["-e", SLEEP_SCRIPT], {}, { label: "owned" }));
    const unowned = await spawned(spawnChild(process.execPath, ["-e", SLEEP_SCRIPT]));
    const unownedOriginalKill = unowned.kill.bind(unowned);
    let redirectedCalls = 0;
    surviving.kill = (signal) => {
      redirectedCalls += 1;
      return unownedOriginalKill(signal);
    };

    try {
      const report = await owner.cleanup();
      assert.equal(redirectedCalls, 0);
      assert.notEqual(surviving.signalCode, null);
      assert.equal(unowned.signalCode, null);
      assert.equal(report.signaledCount, 1);
      assert.equal(report.timedOut, false);
      assert.equal(report.diagnostics[0].label, "owned");
    } finally {
      await stopFixture(unowned, unownedOriginalKill);
    }
  });

  it("does not let metadata label coercion reenter cleanup and create a child afterward", async () => {
    const owner = createTrackedProcessCleanup({ diagnostic: () => {} });
    let coercionCalls = 0;
    let reentrantCleanup;
    const metadata = {
      label: {
        toString() {
          coercionCalls += 1;
          reentrantCleanup = owner.cleanup();
          return "reentrant";
        },
      },
    };

    assert.throws(
      () => owner.spawn(process.execPath, ["-e", SLEEP_SCRIPT], {}, metadata),
      /cleanup has started/u,
    );
    assert.equal(coercionCalls, 1);
    const report = await reentrantCleanup;
    assert.equal(report.signaledCount, 0);
    assert.deepEqual(report.diagnostics, []);
  });

  it("rejects detached creation before spawn and exposes no group signaling API", () => {
    const owner = createTrackedProcessCleanup();
    assert.throws(
      () => owner.spawn(process.execPath, ["-e", ""], { detached: true }),
      /does not support detached/u,
    );
    assert.deepEqual(Object.keys(owner).sort(), ["cleanup", "spawn"]);
  });

  it("snapshots a stateful detached option once before spawning", async () => {
    const owner = createTrackedProcessCleanup({ diagnostic: () => {} });
    let detachedReads = 0;
    const options = {
      get detached() {
        detachedReads += 1;
        return detachedReads > 1;
      },
    };

    const child = owner.spawn(process.execPath, ["-e", ""], options);
    await once(child, "exit");
    assert.equal(detachedReads, 1);
    const report = await owner.cleanup();
    assert.equal(report.signaledCount, 0);
    assert.deepEqual(report.diagnostics, []);
  });

  it("contains no discovery, broad, process-level, or negative-pid signaling", () => {
    const source = readFileSync(HELPER, "utf8");
    for (const prohibited of ["process." + "kill(", "p" + "kill", "kill" + "all"]) {
      assert.equal(source.includes(prohibited), false, prohibited);
    }
    assert.doesNotMatch(source, /\.kill\(\s*-\s*\w/gu);
    assert.equal((source.match(/record\.signal\("SIGTERM"\)/gu) || []).length, 1);
  });

  it("handles spawn failures, false and thrown signals, exit races, and diagnostic failures", async () => {
    const owner = createTrackedProcessCleanup({ timeoutMs: 20, diagnostic: () => { throw new Error("diagnostic"); } });
    const failed = owner.spawn(`missing-command-${Date.now()}`);
    failed.on("error", () => {});
    await new Promise((resolve) => failed.once("close", resolve));

    const falseChild = await spawned(spawnWithCapturedKill(
      owner,
      () => false,
      process.execPath,
      ["-e", SLEEP_SCRIPT],
      {},
      { label: "false" },
    ));
    const falseOriginalKill = falseChild.kill.bind(falseChild);

    const thrownChild = await spawned(spawnWithCapturedKill(
      owner,
      () => {
        const error = new Error("x".repeat(500));
        error.code = "UNSUPPORTED";
        throw error;
      },
      process.execPath,
      ["-e", SLEEP_SCRIPT],
      {},
      { label: "throw" },
    ));
    const thrownOriginalKill = thrownChild.kill.bind(thrownChild);

    const racedChild = await spawned(spawnWithCapturedKill(
      owner,
      function raceSignal() {
        this.emit("exit", 0, null);
        return false;
      },
      process.execPath,
      ["-e", SLEEP_SCRIPT],
      {},
      { label: "race" },
    ));
    const racedOriginalKill = racedChild.kill.bind(racedChild);

    try {
      const report = await owner.cleanup();
      assert.equal(report.timedOut, true);
      assert.ok(report.diagnostics.some(({ outcome }) => outcome === "signal-returned-false"));
      assert.ok(report.diagnostics.some(({ outcome }) => outcome === "signal-threw"));
      assert.ok(report.diagnostics.some(({ outcome }) => outcome === "signal-exit-race"));
      assert.ok(report.diagnostics.some(({ outcome }) => outcome === "deadline-survivor"));
      assert.ok(report.diagnostics.every(({ errorMessage }) => errorMessage === null || errorMessage.length <= 300));
    } finally {
      await Promise.all([
        stopFixture(falseChild, falseOriginalKill),
        stopFixture(thrownChild, thrownOriginalKill),
        stopFixture(racedChild, racedOriginalKill),
      ]);
    }
  });

  it("uses one short deadline and supports concurrent, repeated cleanup", async () => {
    const owner = createTrackedProcessCleanup({ timeoutMs: 15, diagnostic: () => {} });
    const child = await spawned(spawnWithCapturedKill(owner, () => false, process.execPath, ["-e", SLEEP_SCRIPT]));
    const originalKill = child.kill.bind(child);
    const started = Date.now();

    try {
      const first = owner.cleanup();
      const concurrent = owner.cleanup();
      assert.equal(first, concurrent);
      const report = await first;
      assert.equal(await owner.cleanup(), report);
      assert.equal(report.timedOut, true);
      assert.ok(Date.now() - started < 500);
      assert.throws(() => owner.spawn(process.execPath, ["-e", ""]), /cleanup has started/u);
    } finally {
      await stopFixture(child, originalKill);
    }
  });

  it("bounds metadata, caps diagnostics, reports omissions, and excludes args and environment", async () => {
    const emitted = [];
    const owner = createTrackedProcessCleanup({ timeoutMs: 10, diagnostic: (entry) => emitted.push(entry) });
    const fixtures = [];
    const secretArg = "SECRET_ARGUMENT";
    const secretEnv = "SECRET_ENVIRONMENT";

    try {
      for (let index = 0; index < 11; index += 1) {
        const child = await spawned(spawnWithCapturedKill(
          owner,
          () => false,
          process.execPath,
          ["-e", SLEEP_SCRIPT, secretArg],
          { env: { ...process.env, PROCESS_CLEANUP_SECRET: secretEnv } },
          { label: `${index}-${"l".repeat(300)}` },
        ));
        const originalKill = child.kill.bind(child);
        fixtures.push([child, originalKill]);
      }

      const report = await owner.cleanup();
      assert.equal(report.diagnostics.length, 20);
      assert.equal(report.omittedDiagnosticCount, 2);
      assert.equal(emitted.length, 21);
      assert.equal(emitted.at(-1).outcome, "diagnostics-omitted");
      const serialized = JSON.stringify(report);
      assert.equal(serialized.includes(secretArg), false);
      assert.equal(serialized.includes(secretEnv), false);
      assert.ok(report.diagnostics.every(({ label, command }) => label.length <= 160 && command.length <= 160));
    } finally {
      await Promise.all(fixtures.map(([child, originalKill]) => stopFixture(child, originalKill)));
    }
  });
});
