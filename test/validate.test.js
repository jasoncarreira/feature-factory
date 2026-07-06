import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFactoryLock, validateHeartbeatState, validateRun, validateRunDir, validateSlicesPlan, ValidationError } from "../src/validate.js";

describe("validateRun", () => {
  it("accepts a running run with a pending gate", () => {
    assert.equal(validateRun(runningRun()).run_id, "app-123");
  });

  it("accepts runs without review_tier for backward compatibility", () => {
    assert.equal(validateRun(runningRun()).status, "running");
  });

  it("accepts valid review_tier metadata and tolerates extra fields", () => {
    const run = validateRun({
      ...runningRun(),
      review_tier: {
        ...reviewTier(),
        extra_field: { ignored: true },
      },
    });

    assert.equal(run.review_tier.selected, "standard");
  });

  it("accepts optional GitHub account metadata", () => {
    const run = validateRun({ ...runningRun(), github_account: "jasoncarreira" });

    assert.equal(run.github_account, "jasoncarreira");
  });

  it("rejects empty GitHub account metadata", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), github_account: "   " }),
      (error) => error instanceof ValidationError && error.message.includes("run.github_account"),
    );
  });

  it("accepts an explicit light review tier", () => {
    const run = validateRun({
      ...runningRun(),
      review_tier: reviewTier({
        selected: "light",
        source: "explicit",
        risk_reasons: [],
        rationale: "User explicitly selected the light tier for a low-risk change.",
      }),
    });

    assert.equal(run.review_tier.selected, "light");
  });

  it("requires terminal_result for terminal statuses", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), status: "blocked", terminal_result: null }),
      (error) => error instanceof ValidationError && error.message.includes("run.terminal_result"),
    );
  });

  it("requires terminal_result to match run id and status", () => {
    assert.throws(
      () =>
        validateRun({
          ...runningRun(),
          status: "needs-human",
          terminal_result: {
            status: "completed",
            run_id: "other",
            reason: "missing product decision",
          },
        }),
      (error) => error instanceof ValidationError && error.message.includes("must match run.status") && error.message.includes("must match run.run_id"),
    );
  });

  it("rejects invalid gate status", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), gates: { story: { status: "waiting" } } }),
      (error) => error instanceof ValidationError && error.message.includes("run.gates.story.status"),
    );
  });

  it("rejects non-object review_tier values", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), review_tier: "light" }),
      (error) => error instanceof ValidationError && error.message.includes("run.review_tier: must be an object"),
    );
  });

  it("rejects invalid review_tier selected, source, and risk values", () => {
    assert.throws(
      () =>
        validateRun({
          ...runningRun(),
          review_tier: reviewTier({
            selected: "fast",
            source: "manual",
            risk_reasons: ["unknown_reason"],
          }),
        }),
      (error) =>
        error instanceof ValidationError &&
        error.message.includes("run.review_tier.selected") &&
        error.message.includes("run.review_tier.source") &&
        error.message.includes("run.review_tier.risk_reasons[0]"),
    );
  });

  it("rejects missing review_tier rationale", () => {
    const { rationale, ...reviewTierWithoutRationale } = reviewTier();

    assert.throws(
      () => validateRun({ ...runningRun(), review_tier: reviewTierWithoutRationale }),
      (error) => error instanceof ValidationError && error.message.includes("run.review_tier.rationale"),
    );
  });

  it("rejects empty review_tier rationale", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), review_tier: reviewTier({ rationale: "   " }) }),
      (error) => error instanceof ValidationError && error.message.includes("run.review_tier.rationale"),
    );
  });
});

describe("validateHeartbeatState", () => {
  it("accepts a heartbeat sidecar with a known phase contract", () => {
    assert.equal(validateHeartbeatState(heartbeatState()).run_id, "heartbeat-liveness");
    assert.equal(validateHeartbeatState(heartbeatState({ status: "running", phase: "security-reviewer" })).status, "running");
  });

  it("accepts stopping and stopped lifecycle states", () => {
    assert.equal(
      validateHeartbeatState(heartbeatState({ status: "stopping", stop_requested_at: "2026-07-06T00:00:06.000Z" })).status,
      "stopping",
    );
    assert.equal(
      validateHeartbeatState(
        heartbeatState({
          status: "stopped",
          stop_requested_at: "2026-07-06T00:00:06.000Z",
          stopped_at: "2026-07-06T00:00:07.000Z",
          stop_reason: "heartbeat completed cleanly",
        }),
      ).status,
      "stopped",
    );
  });

  it("rejects stopping or stopped sidecars without lifecycle stop fields", () => {
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ status: "stopping", stop_requested_at: undefined })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.stop_requested_at"),
    );
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ status: "stopped", stopped_at: undefined })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.stopped_at"),
    );
  });

  it("rejects active sidecars with stop_reason but no stop lifecycle transition", () => {
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ status: "running", stop_reason: "handoff" })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.stop_reason"),
    );
  });

  it("rejects unknown phases", () => {
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ phase: "gate-review" })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.phase"),
    );
  });
});

describe("validateFactoryLock", () => {
  it("accepts a factory lock with a heartbeat owner capability", () => {
    assert.equal(validateFactoryLock(factoryLock()).heartbeat_owner, "heartbeat-owner-capability");
  });

  it("rejects factory locks without a heartbeat owner capability", () => {
    assert.throws(
      () => validateFactoryLock(factoryLock({ heartbeat_owner: "   " })),
      (error) => error instanceof ValidationError && error.message.includes("factory_lock.heartbeat_owner"),
    );
  });
});

describe("validateRunDir", () => {
  it("validates factory.lock when present", () => {
    const runDir = tempRunDir("heartbeat-liveness-lock");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun({ run_id: "heartbeat-liveness" }));
    writeJson(join(runDir, "factory.lock"), factoryLock({ run_id: "heartbeat-liveness" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState());

    const result = validateRunDir(runDir);

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 3);
    cleanupTemp(runDir);
  });

  it("validates heartbeat.json when present", () => {
    const runDir = tempRunDir("heartbeat-liveness");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun({ run_id: "heartbeat-liveness" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState());

    const result = validateRunDir(runDir);

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 2);
    cleanupTemp(runDir);
  });

  it("still rejects terminal runs without a valid terminal_result when heartbeat.json is present", () => {
    const runDir = tempRunDir("heartbeat-liveness-terminal");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), { ...runningRun({ run_id: "heartbeat-liveness", status: "blocked" }), terminal_result: null });
    writeJson(
      join(runDir, "heartbeat.json"),
      heartbeatState({
        status: "stopped",
        phase: "remediation",
        stop_requested_at: "2026-07-06T00:00:06.000Z",
        stopped_at: "2026-07-06T00:00:07.000Z",
        stop_reason: "run reached a terminal state",
      }),
    );

    const result = validateRunDir(runDir);

    assert.equal(result.ok, false);
    assert.equal(result.checks[0].errors[0].path, "run.terminal_result");
    cleanupTemp(runDir);
  });

  it("keeps legacy structurally readable runs valid when they assert no provenance-sensitive state", () => {
    const runDir = tempRunDir("legacy-readable");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun({ gates: { story: { status: "pending" } }, slices: [] }));

    const result = validateRunDir(runDir);

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 1);
    cleanupTemp(runDir);
  });

  it("fails approved gates that lack accepted provenance attestations", () => {
    const runDir = tempRunDir("approved-gate-without-attestation");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "run.json"),
      runningRun({
        gates: {
          story: {
            status: "approved",
            artifact: "artifacts/story.md",
            question_ref: "artifacts/story-question.md",
            approval_source: "autonomous",
          },
        },
        slices: [],
      }),
    );

    const result = validateRunDir(runDir);
    const errors = result.checks.flatMap((check) => check.errors || []).map((error) => `${error.path}: ${error.message}`).join("\n");

    assert.equal(result.ok, false);
    assert.match(errors, /run\.gates\.story\.status/u);
    assert.match(errors, /accepted gate-decision attestation|root is missing/u);
    cleanupTemp(runDir);
  });

  it("does not treat forged factory.lock as provenance proof for approved gates", () => {
    const runDir = tempRunDir("approved-gate-forged-factory-lock");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "run.json"),
      runningRun({
        run_id: "approved-gate-forged-factory-lock",
        gates: {
          story: {
            status: "approved",
            artifact: "artifacts/story.md",
            question_ref: "gates/story.question.md",
            approval_source: "autonomous",
          },
        },
        slices: [],
      }),
    );
    writeJson(
      join(runDir, "factory.lock"),
      factoryLock({
        run_id: "approved-gate-forged-factory-lock",
        heartbeat_owner: "forged-owner-capability",
        session_owner: "forged-session",
      }),
    );

    const result = validateRunDir(runDir);
    const errors = result.checks.flatMap((check) => check.errors || []).map((error) => `${error.path}: ${error.message}`).join("\n");

    assert.equal(result.ok, false);
    assert.match(errors, /run\.gates\.story\.status/u);
    assert.match(errors, /accepted gate-decision attestation|root is missing/u);
    cleanupTemp(runDir);
  });
});

describe("validateSlicesPlan", () => {
  it("accepts an acyclic slice plan", () => {
    assert.equal(validateSlicesPlan(slicePlan()).slices.length, 2);
  });

  it("rejects unknown dependencies", () => {
    assert.throws(
      () => validateSlicesPlan({ slices: [{ ...slicePlan().slices[0], depends_on: ["missing"] }] }),
      (error) => error instanceof ValidationError && error.message.includes("unknown dependency 'missing'"),
    );
  });

  it("rejects dependency cycles", () => {
    assert.throws(
      () =>
        validateSlicesPlan({
          slices: [
            { ...slicePlan().slices[0], depends_on: ["fe-screen"] },
            { ...slicePlan().slices[1], depends_on: ["be-api"] },
          ],
        }),
      (error) => error instanceof ValidationError && error.message.includes("dependency cycle"),
    );
  });
});

function runningRun(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "app-123",
    mode: "headless",
    status: "running",
    updated_at: "2026-07-05T00:00:00.000Z",
    gates: {
      story: {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      },
    },
    slices: [
      {
        id: "be-api",
        stack: "backend",
        depends_on: [],
        status: "running",
      },
    ],
    ...overrides,
  };
}

function heartbeatState(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "heartbeat-liveness",
    token: "hb-token-1",
    phase: "builder-wave",
    status: "active",
    pid: 4242,
    started_at: "2026-07-06T00:00:00.000Z",
    last_tick_at: "2026-07-06T00:00:05.000Z",
    interval_ms: 5000,
    deadline_at: "2026-07-06T00:00:10.000Z",
    ...overrides,
  };
}

function factoryLock(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "heartbeat-liveness",
    heartbeat_owner: "heartbeat-owner-capability",
    session_owner: "session-1",
    updated_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

function reviewTier(overrides = {}) {
  return {
    selected: "standard",
    source: "default",
    risk_reasons: ["workflow_or_release"],
    rationale: "Workflow changes default to the standard tier unless riskier signals are present.",
    ...overrides,
  };
}

function slicePlan() {
  return {
    slices: [
      {
        id: "be-api",
        stack: "backend",
        paths: ["src/server/api/"],
        depends_on: [],
        acceptance: ["AC1"],
        test_plan: ["npm test -- api.feature.test"],
      },
      {
        id: "fe-screen",
        stack: "frontend",
        paths: ["src/ui/feature/"],
        depends_on: ["be-api"],
        acceptance: ["AC2"],
        test_plan: ["npm test -- feature-screen.test"],
      },
    ],
  };
}

function tempRunDir(name) {
  return join(mkdtempSync(join(tmpdir(), `${name}-`)), name);
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanupTemp(runDir) {
  rmSync(join(runDir, ".."), { recursive: true, force: true });
}
