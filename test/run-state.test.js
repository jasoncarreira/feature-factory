import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAttestationIndex, createRunBaseAttestation } from "../src/provenance-authority.js";
import {
  hashRunState,
  heartbeatOnce,
  mutateRunJsonLocked,
  transitionGateDecision,
  transitionLifecycleRun,
  transitionRunJson,
  transitionRunSlice,
  transitionRunStep,
  transitionTerminalResult,
  withRunJsonLock,
} from "../src/run-state.js";
import { validateRunAuthority, validateRunDir } from "../src/validate.js";

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
  it("fails closed on provenance-sensitive no-index writes and leaves run.json untouched", async () => {
    const fixture = createRunFixture();
    const current = baseRun();
    writeJson(join(fixture.runDir, "run.json"), current);

    try {
      await assert.rejects(
        mutateRunJsonLocked(fixture.runDir, (run) => {
          run.updated_at = "2026-07-06T11:30:00.000Z";
          run.gates.brief = {
            status: "approved",
            artifact: "artifacts/brief.md",
          };
        }),
        /no provenance-sensitive next claims.*gate:brief/u,
      );

      const stored = readJson(join(fixture.runDir, "run.json"));
      assert.deepEqual(stored, current);
      assert.deepEqual(readdirSync(fixture.runDir).sort(), ["run.json"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects provenance-sensitive current claims after acquiring the lock", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    const hold = deferred();
    let mutatorCalled = false;
    const latestCurrent = {
      ...baseRun(),
      updated_at: "2026-07-06T11:45:00.000Z",
      gates: {
        story: {
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
          status: "approved",
          answer: "approve",
          answered_at: "2026-07-06T11:40:00.000Z",
        },
      },
    };

    try {
      const owner = withRunJsonLock(fixture.runDir, async () => {
        writeJson(join(fixture.runDir, "run.json"), latestCurrent);
        await hold.promise;
      });

      await waitFor(() => existsSync(join(fixture.runDir, "run-json.lock")));
      const mutation = mutateRunJsonLocked(
        fixture.runDir,
        (run) => {
          mutatorCalled = true;
          return { ...run, heartbeat_at: "2026-07-06T11:50:00.000Z" };
        },
        { timeoutMs: 200, retryDelayMs: 5 },
      );

      await sleep(20);
      hold.resolve();
      await owner;

      await assert.rejects(mutation, /no provenance-sensitive current claims.*gate:story/u);
      const stored = readJson(join(fixture.runDir, "run.json"));
      assert.equal(mutatorCalled, false);
      assert.deepEqual(stored, latestCurrent);
    } finally {
      hold.resolve();
      fixture.cleanup();
    }
  });

  it("still allows non-sensitive no-index mutations", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());

    try {
      const result = await mutateRunJsonLocked(fixture.runDir, (run) => {
        run.updated_at = "2026-07-06T11:35:00.000Z";
        run.gates.brief = {
          status: "pending",
          artifact: "artifacts/brief.md",
        };
      });

      const stored = readJson(join(fixture.runDir, "run.json"));
      assert.equal(result.updated, true);
      assert.equal(stored.updated_at, "2026-07-06T11:35:00.000Z");
      assert.equal(stored.gates.brief.status, "pending");
      assert.deepEqual(readdirSync(fixture.runDir).sort(), ["run.json"]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("transition helpers", () => {
  it("rejects stale expectedCurrentHash after another writer wins the lock", async () => {
    const fixture = createRunFixture();
    const initial = baseRun();
    const latestCurrent = {
      ...baseRun(),
      updated_at: "2026-07-06T11:45:00.000Z",
    };
    writeJson(join(fixture.runDir, "run.json"), initial);
    const hold = deferred();
    let mutatorCalled = false;

    try {
      const owner = withRunJsonLock(fixture.runDir, async () => {
        writeJson(join(fixture.runDir, "run.json"), latestCurrent);
        await hold.promise;
      });

      await waitFor(() => existsSync(join(fixture.runDir, "run-json.lock")));
      const mutation = transitionRunJson(
        fixture.runDir,
        (run) => {
          mutatorCalled = true;
          run.updated_at = "2026-07-06T11:50:00.000Z";
        },
        {
          expectedCurrentHash: hashRunState(initial),
          timeoutMs: 200,
          retryDelayMs: 5,
        },
      );

      await sleep(20);
      hold.resolve();
      await owner;

      await assert.rejects(
        mutation,
        /stale run\.json transition: expected current hash .* found .*/u,
      );
      assert.equal(mutatorCalled, false);
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), latestCurrent);
    } finally {
      hold.resolve();
      fixture.cleanup();
    }
  });

  it("lets transitionLifecycleRun bypass active heartbeat checks only when explicitly allowed", async () => {
    const fixture = createRunFixture();
    const current = baseRun();
    writeJson(join(fixture.runDir, "run.json"), current);
    writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease());

    try {
      await assert.rejects(
        transitionLifecycleRun(fixture.runDir, (run) => {
          run.updated_at = "2026-07-06T11:55:00.000Z";
        }),
        /stop heartbeat before foreground semantic run\.json writes/u,
      );

      const result = await transitionLifecycleRun(
        fixture.runDir,
        (run) => {
          run.updated_at = "2026-07-06T11:55:00.000Z";
        },
        { allowActiveHeartbeat: true },
      );

      assert.equal(result.updated, true);
      assert.equal(result.run.updated_at, "2026-07-06T11:55:00.000Z");
      assert.equal(readJson(join(fixture.runDir, "run.json")).updated_at, "2026-07-06T11:55:00.000Z");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps terminal_result and run status consistent", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());

    try {
      const result = await transitionTerminalResult(fixture.runDir, {
        status: "blocked",
        run_id: "other-run",
        reason: "waiting for approval",
        summary: "halted",
        artifacts: { notes: "artifacts/blocked.md" },
      });

      const stored = readJson(join(fixture.runDir, "run.json"));
      assert.equal(result.updated, true);
      assert.equal(result.status, "blocked");
      assert.equal(result.terminal_result.status, "blocked");
      assert.equal(result.terminal_result.run_id, "heartbeat-liveness");
      assert.equal(stored.status, "blocked");
      assert.equal(stored.terminal_result.status, "blocked");
      assert.equal(stored.terminal_result.run_id, "heartbeat-liveness");
      assert.equal(stored.terminal_result.reason, "waiting for approval");
    } finally {
      fixture.cleanup();
    }
  });

  it("updates and seeds run steps through transitionRunStep", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());

    try {
      const updated = await transitionRunStep(fixture.runDir, "story-reader", (step, context) => {
        assert.equal(context.index, 0);
        assert.equal(context.current.status, "accepted");
        step.status = "blocked";
        step.attempts = 2;
      });
      assert.equal(updated.step_index, 0);
      assert.equal(updated.step.agent, "story-reader");
      assert.equal(updated.step.status, "blocked");
      assert.equal(updated.step.attempts, 2);

      const added = await transitionRunStep(fixture.runDir, "spec-writer", {
        status: "running",
        attempts: 1,
        artifact_ref: "artifacts/spec.md",
      });
      assert.equal(added.step_index, 1);
      assert.deepEqual(added.step, {
        agent: "spec-writer",
        status: "running",
        attempts: 1,
        artifact_ref: "artifacts/spec.md",
      });

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")).steps, [
        {
          agent: "story-reader",
          status: "blocked",
          attempts: 2,
          artifact_ref: "artifacts/story.md",
        },
        {
          agent: "spec-writer",
          status: "running",
          attempts: 1,
          artifact_ref: "artifacts/spec.md",
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("updates and seeds run slices through transitionRunSlice", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());

    try {
      const updated = await transitionRunSlice(fixture.runDir, "state-lock-core", (slice, context) => {
        assert.equal(context.index, 0);
        assert.equal(context.current.status, "running");
        slice.status = "blocked";
        slice.attempts = 2;
        slice.blocked_reason = "waiting for review";
      });
      assert.equal(updated.slice_index, 0);
      assert.equal(updated.slice.id, "state-lock-core");
      assert.equal(updated.slice.status, "blocked");
      assert.equal(updated.slice.attempts, 2);
      assert.equal(updated.slice.blocked_reason, "waiting for review");

      const added = await transitionRunSlice(fixture.runDir, "run-state-tests", {
        stack: "backend",
        depends_on: ["state-lock-core"],
        status: "pending",
      });
      assert.equal(added.slice_index, 1);
      assert.deepEqual(added.slice, {
        id: "run-state-tests",
        stack: "backend",
        depends_on: ["state-lock-core"],
        status: "pending",
      });

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")).slices, [
        {
          id: "state-lock-core",
          stack: "backend",
          depends_on: [],
          status: "blocked",
          branch: "heartbeat-liveness--state-lock-core",
          worktree: ".opencode/worktrees/heartbeat-liveness--state-lock-core",
          attempts: 2,
          blocked_reason: "waiting for review",
        },
        {
          id: "run-state-tests",
          stack: "backend",
          depends_on: ["state-lock-core"],
          status: "pending",
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("cannot approve a story gate directly without an accepted gate-decision attestation", async () => {
    const fixture = createRunFixture();
    const current = baseRun();
    writeJson(join(fixture.runDir, "run.json"), current);
    const originalIndex = writeRunBaseAuthority(fixture.runDir).index;

    try {
      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          run.gates.story = { status: "approved" };
        }),
        /approved gate requires an accepted gate-decision attestation/u,
      );

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);
    } finally {
      fixture.cleanup();
    }
  });

  it("records an approved story gate through transitionGateDecision", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    writeRunBaseAuthority(fixture.runDir);
    writeFixture(fixture.runDir, "artifacts/story.md", "story artifact\n");
    writeFixture(fixture.runDir, "gates/story.question.md", "approve story?\n");
    writeFixture(fixture.runDir, "gates/story.answer", "approve\n");

    try {
      const result = await transitionGateDecision(fixture.runDir, "story", {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
        approval_source: "human",
      });

      const stored = readJson(join(fixture.runDir, "run.json"));
      const index = readJson(join(fixture.runDir, "attestations", "index.json"));
      assert.equal(result.updated, true);
      assert.equal(result.gate, "story");
      assert.equal(result.attestation_ref, "attestations/gates/story.json");
      assert.equal(stored.gates.story.status, "approved");
      assert.equal(index.entries.length, 2);
      assert.equal(index.entries[1].ref, "attestations/gates/story.json");
      assert.equal(index.entries[1].type, "gate-decision");
    } finally {
      fixture.cleanup();
    }
  });

  it("records approved gates whose artifact, question, and answer refs are json files", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    writeRunBaseAuthority(fixture.runDir);
    writeFixture(fixture.runDir, "artifacts/story.json", "{\n  \"title\": \"Story\"\n}\n");
    writeFixture(fixture.runDir, "gates/story.question.json", "{\n  \"question\": \"Approve?\"\n}\n");
    writeFixture(fixture.runDir, "gates/story.answer.json", "{\n  \"answer\": \"approve\"\n}\n");

    try {
      const result = await transitionGateDecision(fixture.runDir, "story", {
        status: "approved",
        artifact: "artifacts/story.json",
        question_ref: "gates/story.question.json",
        answer_ref: "gates/story.answer.json",
        approval_source: "human",
      });

      assert.equal(result.updated, true);
      assert.equal(result.attestation_ref, "attestations/gates/story.json");
      assert.equal(validateRunDir(fixture.runDir).ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects generic gate reopen from approved status without transitionGateDecision", async () => {
    const fixture = createRunFixture();
    const approvedGate = {
      status: "approved",
      artifact: "artifacts/story.md",
      question_ref: "gates/story.question.md",
      answer_ref: "gates/story.answer",
      approval_source: "human",
    };
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    writeRunBaseAuthority(fixture.runDir);
    writeFixture(fixture.runDir, "artifacts/story.md", "story artifact\n");
    writeFixture(fixture.runDir, "gates/story.question.md", "approve story?\n");
    writeFixture(fixture.runDir, "gates/story.answer", "approve\n");

    try {
      await transitionGateDecision(fixture.runDir, "story", approvedGate);
      const current = readJson(join(fixture.runDir, "run.json"));
      const originalIndex = readJson(join(fixture.runDir, "attestations", "index.json"));

      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          run.gates.story = { status: "pending" };
        }),
        /approved gate transitions must use transitionGateDecision/u,
      );

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);

      await assert.rejects(
        mutateRunJsonLocked(fixture.runDir, (run) => {
          run.gates.story = { status: "pending" };
        }),
        /approved gate transitions must use transitionGateDecision/u,
      );

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);
      assert.equal(validateRunDir(fixture.runDir).ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects generic gate re-approval after a gate is reopened", async () => {
    const fixture = createRunFixture();
    const approvedGate = {
      status: "approved",
      artifact: "artifacts/story.md",
      question_ref: "gates/story.question.md",
      answer_ref: "gates/story.answer",
      approval_source: "human",
    };
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    writeRunBaseAuthority(fixture.runDir);
    writeFixture(fixture.runDir, "artifacts/story.md", "story artifact\n");
    writeFixture(fixture.runDir, "gates/story.question.md", "approve story?\n");
    writeFixture(fixture.runDir, "gates/story.answer", "approve\n");

    try {
      await transitionGateDecision(fixture.runDir, "story", approvedGate);
      const reopened = await transitionGateDecision(fixture.runDir, "story", { status: "pending" });
      const index = readJson(join(fixture.runDir, "attestations", "index.json"));
      const latest = readJson(join(fixture.runDir, index.entries.at(-1).ref));

      assert.match(reopened.attestation_ref, /^attestations\/gates\/story\/\d+\.json$/u);
      assert.equal(latest.bindings.decision, "pending");

      const current = readJson(join(fixture.runDir, "run.json"));
      const originalIndex = readJson(join(fixture.runDir, "attestations", "index.json"));

      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          run.gates.story = { status: "approved" };
        }),
        /latest accepted gate decision 'pending'/u,
      );

      await assert.rejects(
        mutateRunJsonLocked(fixture.runDir, (run) => {
          run.gates.story = { ...approvedGate };
        }),
        /latest accepted gate decision 'pending'/u,
      );

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);
    } finally {
      fixture.cleanup();
    }
  });

  it("requires approved gates to keep all attested binding fields", async () => {
    const fixture = createRunFixture();
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    writeRunBaseAuthority(fixture.runDir);
    writeFixture(fixture.runDir, "artifacts/story.md", "story artifact\n");
    writeFixture(fixture.runDir, "gates/story.question.md", "approve story?\n");
    writeFixture(fixture.runDir, "gates/story.answer", "approve\n");

    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
        approval_source: "human",
      });

      const current = readJson(join(fixture.runDir, "run.json"));
      const originalIndex = readJson(join(fixture.runDir, "attestations", "index.json"));

      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          run.gates.story = { status: "approved" };
        }),
        /accepted gate artifact ref is missing/u,
      );

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails public validation for sparse approved replays and reopened stale approvals until re-approved", async () => {
    const fixture = createRunFixture();
    const approvedGate = {
      status: "approved",
      artifact: "artifacts/story.md",
      question_ref: "gates/story.question.md",
      answer_ref: "gates/story.answer",
      approval_source: "human",
    };
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    writeRunBaseAuthority(fixture.runDir);
    writeFixture(fixture.runDir, "artifacts/story.md", "story artifact\n");
    writeFixture(fixture.runDir, "gates/story.question.md", "approve story?\n");
    writeFixture(fixture.runDir, "gates/story.answer", "approve\n");

    try {
      await transitionGateDecision(fixture.runDir, "story", approvedGate);
      const approvedRun = readJson(join(fixture.runDir, "run.json"));

      writeJson(join(fixture.runDir, "run.json"), {
        ...approvedRun,
        gates: { story: { status: "approved" } },
      });

      let authority = validateRunAuthority(fixture.runDir, readJson(join(fixture.runDir, "run.json")));
      assert.equal(authority.ok, false);
      assert.match(collectCheckErrors(authority), /accepted gate artifact ref is missing/u);
      assert.equal(validateRunDir(fixture.runDir).ok, false);

      writeJson(join(fixture.runDir, "run.json"), approvedRun);
      await transitionGateDecision(fixture.runDir, "story", { status: "pending" });
      const reopenedRun = readJson(join(fixture.runDir, "run.json"));

      writeJson(join(fixture.runDir, "run.json"), {
        ...reopenedRun,
        gates: { story: { status: "approved" } },
      });
      authority = validateRunAuthority(fixture.runDir, readJson(join(fixture.runDir, "run.json")));
      assert.equal(authority.ok, false);
      assert.match(collectCheckErrors(authority), /latest accepted gate decision 'pending'/u);
      assert.equal(validateRunDir(fixture.runDir).ok, false);

      writeJson(join(fixture.runDir, "run.json"), {
        ...reopenedRun,
        gates: { story: { ...approvedGate } },
      });
      authority = validateRunAuthority(fixture.runDir, readJson(join(fixture.runDir, "run.json")));
      assert.equal(authority.ok, false);
      assert.match(collectCheckErrors(authority), /latest accepted gate decision 'pending'/u);
      assert.equal(validateRunDir(fixture.runDir).ok, false);

      writeJson(join(fixture.runDir, "run.json"), reopenedRun);
      await transitionGateDecision(fixture.runDir, "story", approvedGate);

      authority = validateRunAuthority(fixture.runDir, readJson(join(fixture.runDir, "run.json")));
      assert.equal(authority.ok, true);
      assert.equal(validateRunDir(fixture.runDir).ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects symlinked attestation gate parents without writing outside the run", async () => {
    const fixture = createRunFixture();
    const outsideAttestations = join(fixture.root, "outside-attestations");
    writeJson(join(fixture.runDir, "run.json"), baseRun());
    writeRunBaseAuthority(fixture.runDir);
    writeFixture(fixture.runDir, "artifacts/story.md", "story artifact\n");
    writeFixture(fixture.runDir, "gates/story.question.md", "approve story?\n");
    writeFixture(fixture.runDir, "gates/story.answer", "approve\n");
    mkdirSync(outsideAttestations, { recursive: true });
    rmSync(join(fixture.runDir, "attestations", "gates"), { recursive: true, force: true });
    symlinkSync(outsideAttestations, join(fixture.runDir, "attestations", "gates"), "dir");

    const current = readJson(join(fixture.runDir, "run.json"));
    const originalIndex = readJson(join(fixture.runDir, "attestations", "index.json"));

    try {
      await assert.rejects(
        transitionGateDecision(fixture.runDir, "story", {
          status: "approved",
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
          approval_source: "human",
        }),
        /symlink/u,
      );

      assert.equal(existsSync(join(outsideAttestations, "story.json")), false);
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);
    } finally {
      fixture.cleanup();
    }
  });

  it("rolls back staged gate-decision files when the next state fails validation", async () => {
    const fixture = createRunFixture();
    const current = baseRun();
    writeJson(join(fixture.runDir, "run.json"), current);
    const originalIndex = writeRunBaseAuthority(fixture.runDir).index;
    writeFixture(fixture.runDir, "artifacts/pre_pr.md", "pre-pr artifact\n");
    writeFixture(fixture.runDir, "gates/pre_pr.question.md", "approve pre-pr?\n");
    writeFixture(fixture.runDir, "gates/pre_pr.answer", "approve\n");

    try {
      await assert.rejects(
        transitionGateDecision(fixture.runDir, "pre_pr", {
          status: "approved",
          artifact: "artifacts/pre_pr.md",
          question_ref: "gates/pre_pr.question.md",
          answer_ref: "gates/pre_pr.answer",
          approval_source: "autonomous",
        }),
        /run\.gates\.pre_pr\.status: approved pre_pr gate requires/u,
      );

      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);
      assert.equal(existsSync(join(fixture.runDir, "attestations", "gates", "pre_pr.json")), false);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("heartbeatOnce", () => {
  it("updates only heartbeat_at when the lease matches an active running run", async () => {
    const fixture = createRunFixture();
    const original = baseRun({ terminal_result: null, review_tier: { selected: "standard", source: "default", risk_reasons: [], rationale: "n/a" } });
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

  it("fails closed on forged approved protected gates before refreshing heartbeat_at", async () => {
    const fixture = createRunFixture();
    const current = baseRun({
      gates: {
        story: {
          status: "approved",
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
        },
      },
    });
    ensureAuthorityDirs(fixture.runDir);
    writeJson(join(fixture.runDir, "run.json"), current);
    writeJson(join(fixture.runDir, "factory.lock"), factoryLock());
    writeJson(join(fixture.runDir, "heartbeat.json"), heartbeatLease());

    try {
      await assert.rejects(
        heartbeatOnce(fixture.runDir, {
          token: "lease-1",
          ownerPid: 4242,
          ownerCapability: HEARTBEAT_OWNER,
          now: "2026-07-06T12:00:00.000Z",
        }),
        /gate-decision attestation|attestations\/index\.json/u,
      );
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), current);
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
let repoContextCache = null;

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
    branch: null,
    worktree: null,
    gates: {},
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

function ensureAuthorityDirs(runDir) {
  for (const directory of ["evidence", "artifacts", "reviews", "attestations", "gates"]) {
    mkdirSync(join(runDir, directory), { recursive: true });
  }
}

function writeRunBaseAuthority(runDir) {
  ensureAuthorityDirs(runDir);
  const context = repoContext();
  const runBase = createRunBaseAttestation({
    run_id: "heartbeat-liveness",
    sequence: 1,
    prev_hash: null,
    created_at: "2026-07-06T11:00:00.000Z",
    bindings: {
      repo_root: context.repoRoot,
      run_dir: runDir,
      git_common_dir: context.gitCommonDir,
      feature_branch: context.branch,
      feature_worktree: context.featureWorktree,
      base_ref: "HEAD",
      base_commit: context.headCommit,
      base_tree: context.headTree,
    },
  });
  writeJson(join(runDir, "attestations", "run-base.json"), runBase);
  const index = createAttestationIndex([{ ref: "attestations/run-base.json", attestation: runBase }]);
  writeJson(join(runDir, "attestations", "index.json"), index);
  return { runBase, index };
}

function writeFixture(runDir, ref, contents) {
  const path = join(runDir, ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectCheckErrors(result) {
  return (Array.isArray(result?.checks) ? result.checks : [])
    .flatMap((check) => Array.isArray(check?.errors) ? check.errors : [])
    .map((error) => `${error.path}: ${error.message}`)
    .join("\n");
}

function repoContext() {
  if (repoContextCache) return repoContextCache;
  // Worktree identity checks require the attested feature worktree to live
  // under <repo>/.opencode/worktrees, so build a hermetic repo instead of
  // deriving authority bindings from wherever the tests happen to run.
  const repo = join(tmpdir(), `heartbeat-liveness-repo-${process.pid}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  gitStdout(repo, ["init", "-b", "main"]);
  gitStdout(repo, ["config", "user.name", "Run State Fixture"]);
  gitStdout(repo, ["config", "user.email", "run-state-fixture@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n", "utf8");
  gitStdout(repo, ["add", "."]);
  gitStdout(repo, ["commit", "-m", "base"]);
  const branch = "heartbeat-liveness-branch";
  const worktreePath = join(repo, ".opencode", "worktrees", branch);
  mkdirSync(dirname(worktreePath), { recursive: true });
  gitStdout(repo, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  process.on("exit", () => rmSync(repo, { recursive: true, force: true }));
  const featureWorktree = realpathSync(worktreePath);
  const gitCommonDir = realpathSync(resolve(featureWorktree, gitStdout(featureWorktree, ["rev-parse", "--git-common-dir"])));
  repoContextCache = {
    featureWorktree,
    gitCommonDir,
    repoRoot: dirname(gitCommonDir),
    branch,
    headCommit: gitStdout(featureWorktree, ["rev-parse", "HEAD"]),
    headTree: gitStdout(featureWorktree, ["rev-parse", "HEAD^{tree}"]),
  };
  return repoContextCache;
}

function gitStdout(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
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
