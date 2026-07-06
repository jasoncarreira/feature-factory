import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRun, validateSlicesPlan, ValidationError } from "../src/validate.js";

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
