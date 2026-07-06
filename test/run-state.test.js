import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatOnce, mutateRunJsonLocked, withRunJsonLock } from "../src/run-state.js";

const HEARTBEAT_OWNER = "heartbeat-owner-capability";

describe("withRunJsonLock", () => {
  it("writes owner metadata and cleans up the lock when the callback fails", async () => {
    const fixture = createRunFixture();

    try {
      await assert.rejects(
        withRunJsonLock(fixture.runDir, async () => {
          const owner = readJson(join(fixture.runDir, "run-json.lock", "owner.json"));
          assert.equal(existsSync(join(fixture.runDir, "run-json.lock")), true);
          assert.equal(owner.pid, process.pid);
          assert.equal(typeof owner.hostname, "string");
          throw new Error("boom");
        }),
        /boom/,
      );

      assert.equal(existsSync(join(fixture.runDir, "run-json.lock")), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("times out while another holder owns the lock", async () => {
    const fixture = createRunFixture();
    const hold = deferred();

    try {
      const owner = withRunJsonLock(fixture.runDir, async () => {
        await hold.promise;
      });

      await waitFor(() => existsSync(join(fixture.runDir, "run-json.lock")));
      await assert.rejects(
        withRunJsonLock(fixture.runDir, async () => {}, { timeoutMs: 40, retryDelayMs: 5 }),
        /timed out waiting for run\.json lock/,
      );

      hold.resolve();
      await owner;
    } finally {
      hold.resolve();
      fixture.cleanup();
    }
  });
});

describe("mutateRunJsonLocked", () => {
  it("updates run.json under the lock and leaves no temp files behind", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());

    try {
      const result = await mutateRunJsonLocked(fixture.runDir, (run) => {
        run.updated_at = "2026-07-06T11:30:00.000Z";
        run.gates.brief = {
          status: "approved",
          artifact: "artifacts/brief.md",
        };
      });

      const stored = readJson(join(fixture.runDir, "run.json"));
      assert.equal(result.updated, true);
      assert.equal(stored.updated_at, "2026-07-06T11:30:00.000Z");
      assert.equal(stored.gates.brief.status, "approved");
      assert.deepEqual(readdirSync(fixture.runDir).sort(), ["run.json"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads the latest run.json after acquiring the lock to avoid lost updates", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    const hold = deferred();

    try {
      const owner = withRunJsonLock(fixture.runDir, async () => {
        writeJson(join(fixture.runDir, "run.json"), {
          ...baseRun(),
          updated_at: "2026-07-06T11:45:00.000Z",
          gates: {
            story: {
              ...baseRun().gates.story,
              status: "approved",
              answer: "approve",
              answered_at: "2026-07-06T11:40:00.000Z",
            },
          },
        });
        await hold.promise;
      });

      await waitFor(() => existsSync(join(fixture.runDir, "run-json.lock")));
      const mutation = mutateRunJsonLocked(
        fixture.runDir,
        (run) => {
          assert.equal(run.updated_at, "2026-07-06T11:45:00.000Z");
          assert.equal(run.gates.story.status, "approved");
          return { ...run, heartbeat_at: "2026-07-06T11:50:00.000Z" };
        },
        { timeoutMs: 200, retryDelayMs: 5 },
      );

      await sleep(20);
      hold.resolve();
      await owner;

      const result = await mutation;
      const stored = readJson(join(fixture.runDir, "run.json"));
      assert.equal(result.updated, true);
      assert.equal(stored.updated_at, "2026-07-06T11:45:00.000Z");
      assert.equal(stored.gates.story.status, "approved");
      assert.equal(stored.heartbeat_at, "2026-07-06T11:50:00.000Z");
    } finally {
      hold.resolve();
      fixture.cleanup();
    }
  });
});

describe("heartbeatOnce", () => {
  it("updates only heartbeat_at when the lease matches an active running run", async () => {
    const fixture = createRunFixture();
    const original = baseRun({
      validator: { verdict: "GO-WITH-NITS", report: "validator.md", loops: 1 },
      security_review: { verdict: "PASS", report: "security.md", loops: 1 },
      pr_url: "https://example.com/pr/1",
      terminal_result: null,
    });
    writeJson(join(fixture.runDir, "run.json"), original);
    writeJson(join(fixture.runDir, "factory.lock"), factoryLock());
    writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease());

    try {
      const result = await heartbeatOnce(fixture.runDir, {
        token: "lease-1",
        ownerPid: 4242,
        ownerCapability: HEARTBEAT_OWNER,
        now: "2026-07-06T12:00:00.000Z",
      });

      assert.equal(result.updated, true);
      assert.deepEqual(readJson(join(fixture.runDir, "heartbeat.json")), heartbeatLease());
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), {
        ...original,
        heartbeat_at: "2026-07-06T12:00:00.000Z",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("skips terminal runs without masking the terminal state", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "factory.lock"), factoryLock());
    writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease());

    try {
      for (const status of ["completed", "blocked", "partial", "needs-human"]) {
        const current = terminalRun(status);
        writeJson(join(fixture.runDir, "run.json"), current);

        const result = await heartbeatOnce(fixture.runDir, {
          token: "lease-1",
          ownerPid: 4242,
          ownerCapability: HEARTBEAT_OWNER,
          now: "2026-07-06T12:10:00.000Z",
        });

        assert.equal(result.updated, false);
        assert.equal(result.reason, "terminal-status");
        assert.equal(result.status, status);
        assert.equal(result.run.terminal_result.status, status);
        assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("skips missing, invalid, expired, and nonmatching heartbeat leases", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "factory.lock"), factoryLock());

    try {
      for (const scenario of [
        {
          name: "missing lease",
          reason: "missing-heartbeat-lease",
          setup: () => rmSync(join(fixture.runDir, "heartbeat.json"), { force: true }),
        },
        {
          name: "invalid json",
          reason: "invalid-heartbeat-lease",
          setup: () => writeFileSync(join(fixture.runDir, "heartbeat.json"), "{not-json\n", "utf8"),
        },
        {
          name: "missing canonical deadline",
          reason: "invalid-heartbeat-lease",
          setup: () => {
            const lease = heartbeatLease();
            delete lease.deadline_at;
            lease.expires_at = "2026-07-06T12:30:00.000Z";
            writeJson(join(fixture.runDir, "heartbeat.json"), lease);
          },
        },
        {
          name: "unknown phase",
          reason: "invalid-heartbeat-lease",
          setup: () => writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease({ phase: "review-panel" })),
        },
        {
          name: "run id mismatch",
          reason: "heartbeat-run-id-mismatch",
          setup: () => writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease({ run_id: "other-run" })),
        },
        {
          name: "token mismatch",
          reason: "heartbeat-token-mismatch",
          setup: () => writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease({ token: "other-token" })),
        },
        {
          name: "owner mismatch",
          reason: "heartbeat-owner-mismatch",
          setup: () => writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease({ pid: 9898 })),
        },
        {
          name: "stopping lease",
          reason: "heartbeat-lease-stopping",
          setup: () =>
            writeJson(
              join(fixture.runDir, "heartbeat.json"),
              heartbeatLease({ status: "stopping", stop_requested_at: "2026-07-06T11:58:00.000Z", stop_reason: "handoff" }),
            ),
        },
        {
          name: "stopped lease",
          reason: "heartbeat-lease-stopped",
          setup: () =>
            writeJson(
              join(fixture.runDir, "heartbeat.json"),
              heartbeatLease({ status: "stopped", stopped_at: "2026-07-06T11:59:00.000Z", stop_reason: "completed" }),
            ),
        },
        {
          name: "active lease with stop markers",
          reason: "invalid-heartbeat-lease",
          setup: () =>
            writeJson(
              join(fixture.runDir, "heartbeat.json"),
              heartbeatLease({ status: "running", stop_requested_at: "2026-07-06T11:58:00.000Z", stop_reason: "handoff" }),
            ),
        },
        {
          name: "active lease with stop_reason only",
          reason: "invalid-heartbeat-lease",
          setup: () => writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease({ status: "running", stop_reason: "handoff" })),
        },
        {
          name: "expired lease",
          reason: "heartbeat-lease-expired",
          setup: () => writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease({ deadline_at: "2026-07-06T11:59:59.000Z" })),
        },
      ]) {
        const current = baseRun();
        writeJson(join(fixture.runDir, "run.json"), current);
        scenario.setup();

        const result = await heartbeatOnce(fixture.runDir, {
          token: "lease-1",
          ownerPid: 4242,
          ownerCapability: HEARTBEAT_OWNER,
          now: "2026-07-06T12:00:00.000Z",
        });

        assert.equal(result.updated, false, scenario.name);
        assert.equal(result.reason, scenario.reason, scenario.name);
        assert.equal(result.status, "running", scenario.name);
        assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current, scenario.name);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses to tick while story, brief, or pre_pr gates are pending", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "factory.lock"), factoryLock());
    writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease());

    try {
      for (const gate of ["story", "brief", "pre_pr"]) {
        const current = baseRun({
          gates: {
            story: { status: gate === "story" ? "pending" : "approved", artifact: "artifacts/story.md" },
            brief: { status: gate === "brief" ? "pending" : "approved", artifact: "artifacts/brief.md" },
            pre_pr: { status: gate === "pre_pr" ? "pending" : "approved", artifact: "artifacts/pre_pr.md" },
          },
        });
        writeJson(join(fixture.runDir, "run.json"), current);

        const result = await heartbeatOnce(fixture.runDir, {
          token: "lease-1",
          ownerPid: 4242,
          ownerCapability: HEARTBEAT_OWNER,
          now: "2026-07-06T12:00:00.000Z",
        });

        assert.equal(result.updated, false, gate);
        assert.equal(result.reason, "protected-gate-pending", gate);
        assert.equal(result.gate, gate, gate);
        assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current, gate);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("does not refresh heartbeat_at when no in-flight steps or slices remain", async () => {
    const fixture = createRunFixture();
    const current = baseRun({
      steps: [{ agent: "story-reader", status: "accepted", attempts: 1, artifact_ref: "artifacts/story.md" }],
      slices: [{ id: "state-lock-core", stack: "backend", depends_on: [], status: "merged", attempts: 1 }],
    });
    writeJson(join(fixture.runDir, "run.json"), current);
    writeJson(join(fixture.runDir, "factory.lock"), factoryLock());
    writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease());

    try {
      const result = await heartbeatOnce(fixture.runDir, {
        token: "lease-1",
        ownerPid: 4242,
        ownerCapability: HEARTBEAT_OWNER,
        now: "2026-07-06T12:00:00.000Z",
      });

      assert.equal(result.updated, false);
      assert.equal(result.reason, "no-in-flight-work");
      assert.equal(result.status, "running");
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "heartbeat.json")), heartbeatLease());
    } finally {
      fixture.cleanup();
    }
  });

  it("requires the trusted heartbeat owner capability from factory.lock", async () => {
    const fixture = createRunFixture();
    const current = baseRun();
    writeJson(join(fixture.runDir, "run.json"), current);
    writeJson(join(fixture.runDir, "factory.lock"), factoryLock());
    writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease());

    try {
      await assert.rejects(
        heartbeatOnce(fixture.runDir, {
          token: "lease-1",
          ownerPid: 4242,
          now: "2026-07-06T12:00:00.000Z",
        }),
        /owner capability/i,
      );

      await assert.rejects(
        heartbeatOnce(fixture.runDir, {
          token: "lease-1",
          ownerPid: 4242,
          ownerCapability: "forged-owner-capability",
          now: "2026-07-06T12:00:00.000Z",
        }),
        /owner capability/i,
      );

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
    } finally {
      fixture.cleanup();
    }
  });
});

let tempCounter = 0;

function createRunFixture() {
  const root = join(tmpdir(), `heartbeat-liveness-${process.pid}-${tempCounter++}`);
  rmSync(root, { recursive: true, force: true });
  const runDir = join(root, ".opencode", "factory", "heartbeat-liveness");
  mkdirSync(runDir, { recursive: true });
  return {
    root,
    runDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseRun(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "heartbeat-liveness",
    mode: "headless",
    status: "running",
    created_at: "2026-07-06T11:00:00.000Z",
    updated_at: "2026-07-06T11:05:00.000Z",
    heartbeat_at: "2026-07-06T11:05:00.000Z",
    branch: "heartbeat-liveness",
    worktree: ".opencode/worktrees/heartbeat-liveness",
    gates: {
      story: {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      },
    },
    steps: [
      {
        agent: "story-reader",
        status: "accepted",
        attempts: 1,
        artifact_ref: "artifacts/story.md",
      },
    ],
    slices: [
      {
        id: "state-lock-core",
        stack: "backend",
        depends_on: [],
        status: "running",
        branch: "heartbeat-liveness--state-lock-core",
        worktree: ".opencode/worktrees/heartbeat-liveness--state-lock-core",
        attempts: 1,
      },
    ],
    validator: null,
    security_review: null,
    pr_url: null,
    terminal_result: null,
    ...overrides,
  };
}

function terminalRun(status) {
  return baseRun({
    status,
    terminal_result: {
      status,
      run_id: "heartbeat-liveness",
      pr_url: null,
      reason: status === "completed" ? null : `${status} run`,
      summary: "done",
      artifacts: {},
    },
  });
}

function heartbeatLease(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "heartbeat-liveness",
    token: "lease-1",
    phase: "slice-review",
    status: "running",
    pid: 4242,
    started_at: "2026-07-06T11:00:00.000Z",
    last_tick_at: "2026-07-06T11:59:30.000Z",
    stop_requested_at: null,
    stopped_at: null,
    interval_ms: 5000,
    deadline_at: "2026-07-06T12:30:00.000Z",
    stop_reason: null,
    ...overrides,
  };
}

function factoryLock(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "heartbeat-liveness",
    heartbeat_owner: HEARTBEAT_OWNER,
    session_owner: "session-1",
    updated_at: "2026-07-06T11:00:00.000Z",
    ...overrides,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 200;
  const stepMs = options.stepMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  if (!predicate()) throw new Error("timed out waiting for test condition");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
