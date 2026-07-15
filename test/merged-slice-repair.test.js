import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transitionMergedSliceRepair, transitionRunSlice, transitionSliceMerged } from "../src/run-state.js";
import { checkRunConsistency, validateRun } from "../src/validate.js";

const RUN_ID = "repair-run";

describe("merged-sibling repair", () => {
  it("reports a repair only for a merged direct dependency with in-lane evidence-bound defect", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(
        report(fixture, { owner_slice_id: "consumer" }),
        /must be merged/u,
        "a non-merged owner must be rejected",
      );
      await assert.rejects(
        report(fixture, { consumer_slice_id: "unrelated" }),
        /must directly depend on owner/u,
        "a non-dependent consumer must be rejected",
      );
      await assert.rejects(
        report(fixture, { defect_path: "src/other/place.js" }),
        /outside owner slice/u,
        "an out-of-lane defect path must be rejected",
      );
      await assert.rejects(
        report(fixture, { defect_path: "../escape.js" }),
        /safe repository-relative path/u,
      );

      const { merged_slice_repair: repair } = await report(fixture);
      assert.equal(repair.status, "reported");
      assert.equal(repair.attempts, 0);
      assert.equal(repair.max_attempts, 2);
      assert.match(repair.evidence_hash, /^sha256:[0-9a-f]{64}$/u);

      await assert.rejects(report(fixture), /only one merged-slice repair incident/u);
      assert.doesNotThrow(() => validateRun(readRun(fixture)));
    } finally {
      cleanup(fixture);
    }
  });

  it("enforces quiescence, monotonic attempts, and the two-attempt ceiling", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      writeRunSliceStatus(fixture, "other", "running", 1);
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 }),
        /quiesce slice work first/u,
      );
      writeRunSliceStatus(fixture, "other", "pending", 0);

      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 2 }),
        /must advance from 0 to 1/u,
      );
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 });

      writeReview(fixture, "repair-attempt-1.json", { subject: "repair:owner", verdict: "REJECT", required_fixes: ["tighten the sort key"] });
      await transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-attempt-1.json" });
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 2 });

      writeReview(fixture, "repair-attempt-2.json", { subject: "repair:owner", verdict: "REJECT", required_fixes: ["still wrong"] });
      await transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-attempt-2.json" });
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 3 }),
        /exceeds max_attempts 2/u,
        "attempt 3 must be refused; block and use a recovery run",
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("binds reviews by hash, requires APPROVE to merge, and quiesces slice work both directions", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 });

      await assert.rejects(
        transitionRunSlice(fixture.runDir, "other", { status: "running", attempts: 1 }, { mustExist: true }),
        /cannot start while a merged-slice repair is active/u,
      );
      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "other", { merge_commit: "abc1234" }),
        /cannot merge while a merged-slice repair is active/u,
      );

      writeReview(fixture, "repair-reject.json", { subject: "repair:owner", verdict: "REJECT", required_fixes: ["fix it"] });
      await transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-reject.json" });
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "merged", merge_commit: "abc1234" }),
        /requires an APPROVE verdict/u,
      );

      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 2 });
      writeReview(fixture, "repair-approve.json", { subject: "repair:owner", verdict: "APPROVE", required_fixes: [] });
      await transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-approve.json" });

      writeReview(fixture, "repair-approve.json", { subject: "repair:owner", verdict: "APPROVE", required_fixes: [], tampered: true });
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "merged", merge_commit: "abc1234" }),
        /no longer matches its hash-bound record/u,
        "a tampered review must fail the merge",
      );

      writeReview(fixture, "repair-approve.json", { subject: "repair:owner", verdict: "APPROVE", required_fixes: [] });
      await transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-approve.json" });
      const { merged_slice_repair: merged } = await transitionMergedSliceRepair(fixture.runDir, { status: "merged", merge_commit: "abc1234" });
      assert.equal(merged.status, "merged");

      const resumed = await transitionRunSlice(fixture.runDir, "other", { status: "running", attempts: 1 }, { mustExist: true });
      assert.equal(resumed.slice.status, "running");

      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 3 }),
        /terminal/u,
        "a merged repair is terminal; a further defect requires a recovery run",
      );
      assert.doesNotThrow(() => validateRun(readRun(fixture)));
    } finally {
      cleanup(fixture);
    }
  });

  it("reports repair evidence and review hash drift through run consistency checks", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      writeFileSync(join(fixture.runDir, "evidence", "consumer-failure.json"), JSON.stringify({ subject: "consumer", status: "fail", drift: true }));
      const result = checkRunConsistency(fixture.runDir, readRun(fixture));
      assert.equal(result.ok, false, "evidence drift must be reported");
      const evidenceCheck = result.checks.find((check) => check.name === "run.merged_slice_repair.evidence_ref");
      assert.equal(evidenceCheck.ok, false);
    } finally {
      cleanup(fixture);
    }
  });

  it("blocks with a reason from any active state and stays terminal", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      const { merged_slice_repair: blocked } = await transitionMergedSliceRepair(fixture.runDir, { status: "blocked", reason: "fix needs a contract amendment" });
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.reason, "fix needs a contract amendment");
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 }),
        /terminal/u,
      );
      assert.doesNotThrow(() => validateRun(readRun(fixture)));
    } finally {
      cleanup(fixture);
    }
  });
});

function createFixture() {
  const repo = mkdtempSync(join(tmpdir(), "feature-factory-repair-"));
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  for (const dir of ["evidence", "reviews", "plan"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: RUN_ID,
    status: "running",
    gates: {},
    steps: [],
    slices: [
      { id: "owner", stack: "backend", depends_on: [], status: "merged", attempts: 2, merge_commit: "1111111", review_ref: "reviews/owner.json" },
      { id: "consumer", stack: "backend", depends_on: ["owner"], status: "blocked", attempts: 1, blocked_reason: "owner defect" },
      { id: "unrelated", stack: "backend", depends_on: [], status: "pending", attempts: 0 },
      { id: "other", stack: "backend", depends_on: [], status: "pending", attempts: 0 },
    ],
  });
  writeJson(join(runDir, "plan", "slices.json"), {
    slices: [
      { id: "owner", stack: "backend", paths: ["src/owner/**", "test/owner.test.js"], depends_on: [], acceptance: ["AC1"], test_plan: ["unit"] },
      { id: "consumer", stack: "backend", paths: ["src/consumer/**"], depends_on: ["owner"], acceptance: ["AC2"], test_plan: ["unit"] },
      { id: "unrelated", stack: "backend", paths: ["src/unrelated/**"], depends_on: [], acceptance: ["AC3"], test_plan: ["unit"] },
      { id: "other", stack: "backend", paths: ["src/other-lane/**"], depends_on: [], acceptance: ["AC4"], test_plan: ["unit"] },
    ],
  });
  writeJson(join(runDir, "evidence", "consumer-failure.json"), { subject: "consumer", status: "fail", review_ready: false });
  writeJson(join(runDir, "reviews", "owner.json"), { subject: "owner", verdict: "APPROVE", required_fixes: [] });
  return { repo, runDir };
}

function report(fixture, overrides = {}) {
  return transitionMergedSliceRepair(fixture.runDir, {
    status: "reported",
    owner_slice_id: "owner",
    consumer_slice_id: "consumer",
    defect_path: "src/owner/records.js",
    evidence_ref: "evidence/consumer-failure.json",
    ...overrides,
  });
}

function writeRunSliceStatus(fixture, sliceId, status, attempts) {
  const run = readRun(fixture);
  const slice = run.slices.find((item) => item.id === sliceId);
  slice.status = status;
  slice.attempts = attempts;
  writeJson(join(fixture.runDir, "run.json"), run);
}

function writeReview(fixture, name, review) {
  writeJson(join(fixture.runDir, "reviews", name), review);
}

function readRun(fixture) {
  return JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function cleanup(fixture) {
  rmSync(fixture.repo, { recursive: true, force: true });
}
