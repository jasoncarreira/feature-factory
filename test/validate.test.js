import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRun, validateSlicesPlan, ValidationError } from "../src/validate.js";

describe("validateRun", () => {
  it("accepts a running run with a pending gate", () => {
    assert.equal(validateRun(runningRun()).run_id, "app-123");
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

function runningRun() {
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
