import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "./helpers/git-fixture.js";
import { createPostPrState, hasInFlightHeartbeatWork, transitionGateDecision, transitionMergedSliceRepair, transitionRunSlice, transitionRunStep, transitionSliceMerged, transitionSteeringBoundaryOpened } from "../src/run-state.js";
import { checkRunConsistency, validateRun } from "../src/validate.js";

const POST_PR_POLICY = (enabled) => ({ enabled, wait_ms: 3600000, initial_poll_ms: 30000, max_poll_ms: 120000, check_start_grace_ms: 300000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } });

const RUN_ID = "repair-run";
const FEATURE_BRANCH = "repair-feature";

describe("merged-sibling repair", () => {
  it("reports a repair only for a merged direct dependency with observed failing in-lane evidence", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(report(fixture, { owner_slice_id: "consumer" }), /must be merged/u);
      await assert.rejects(report(fixture, { consumer_slice_id: "unrelated" }), /must directly depend on owner/u);
      await assert.rejects(report(fixture, { defect_path: "src/other/place.js" }), /outside owner slice/u);
      await assert.rejects(report(fixture, { defect_path: "../escape.js" }), /safe repository-relative path/u);
      await assert.rejects(
        report(fixture, { evidence_ref: "evidence/no-subject.json" }),
        /subject must equal the consumer/u,
        "evidence without a subject must be rejected",
      );
      await assert.rejects(
        report(fixture, { evidence_ref: "evidence/passing.json" }),
        /observed failing consumer run/u,
        "non-failing evidence must be rejected",
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

      recordReview(fixture, "repair-attempt-1", { verdict: "REJECT", required_fixes: ["tighten the sort key"] });
      await review(fixture, "repair-attempt-1");
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 2 });

      recordReview(fixture, "repair-attempt-2", { verdict: "REJECT", required_fixes: ["still wrong"] });
      await review(fixture, "repair-attempt-2");
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 3 }),
        /exceeds max_attempts 2/u,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("observes changed paths in the owner lane and keeps the review binding write-once", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 });

      recordReview(fixture, "repair-good", { verdict: "APPROVE", required_fixes: [] });
      writeJson(join(fixture.runDir, "evidence", "repair-out-of-lane.json"), {
        subject: "repair:owner",
        changed_paths: ["src/owner/records.js", "src/consumer/sneaky.js"],
      });
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-good.json", repair_evidence_ref: "evidence/repair-out-of-lane.json" }),
        /outside owner slice/u,
        "an observed out-of-lane changed path must reject the review",
      );
      writeJson(join(fixture.runDir, "evidence", "repair-empty.json"), { subject: "repair:owner", changed_paths: [] });
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-good.json", repair_evidence_ref: "evidence/repair-empty.json" }),
        /non-empty changed_paths/u,
      );

      await review(fixture, "repair-good");

      // Byte-identical re-record is allowed (crash recovery); replacement is not.
      await review(fixture, "repair-good");
      recordReview(fixture, "repair-replacement", { verdict: "APPROVE", required_fixes: [] });
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-replacement.json", repair_evidence_ref: "evidence/repair-attempt.json" }),
        /write-once per attempt/u,
        "a bound review must never be replaced by a different review",
      );
      writeJson(join(fixture.runDir, "reviews", "repair-good.json"), { subject: "repair:owner", verdict: "APPROVE", required_fixes: [], tampered: true });
      await assert.rejects(
        transitionMergedSliceRepair(fixture.runDir, { status: "review", review_ref: "reviews/repair-good.json", repair_evidence_ref: "evidence/repair-attempt.json" }),
        /write-once per attempt/u,
        "rewriting the bound review bytes must be rejected",
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("merges only a real feature-branch commit with a passing consumer reproduction", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 });
      recordReview(fixture, "repair-approve", { verdict: "APPROVE", required_fixes: [] });
      await review(fixture, "repair-approve");

      writeJson(join(fixture.runDir, "evidence", "verification-pass.json"), { subject: "consumer", status: "pass" });
      writeJson(join(fixture.runDir, "evidence", "verification-fail.json"), { subject: "consumer", status: "fail" });

      await assert.rejects(
        merge(fixture, { merge_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
        /does not resolve in the repository/u,
        "an arbitrary SHA-shaped string is not a merge",
      );
      await assert.rejects(
        merge(fixture, { merge_commit: fixture.mainOnlyCommit }),
        /is not contained in feature branch/u,
        "a commit outside the feature branch is not a merge",
      );
      await assert.rejects(
        merge(fixture, { verification_ref: "evidence/verification-fail.json" }),
        /consumer reproduction passing/u,
        "a still-failing reproduction must block the merge",
      );

      const { merged_slice_repair: merged } = await merge(fixture);
      assert.equal(merged.status, "merged");
      assert.match(merged.verification_hash, /^sha256:[0-9a-f]{64}$/u);

      const resumed = await transitionRunSlice(fixture.runDir, "other", { status: "running", attempts: 1 }, { mustExist: true });
      assert.equal(resumed.slice.status, "running");
      await assert.rejects(transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 3 }), /terminal/u);
      assert.doesNotThrow(() => validateRun(readRun(fixture)));
    } finally {
      cleanup(fixture);
    }
  });

  it("quiesces slice starts and merges while a repair is active", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 });
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "other", { status: "running", attempts: 1 }, { mustExist: true }),
        /cannot start while a merged-slice repair is unresolved/u,
      );
      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "other", { merge_commit: "abc1234" }),
        /cannot merge while a merged-slice repair is unresolved/u,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("fences steps and keeps the fence after a blocked repair until terminalization", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      // The reproduced incident: test-verifier must not start while the repair is unresolved.
      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }),
        /cannot advance while a merged-slice repair is unresolved/u,
      );
      const { merged_slice_repair: blocked } = await transitionMergedSliceRepair(fixture.runDir, { status: "blocked", reason: "attempt budget exhausted" });
      assert.equal(blocked.status, "blocked");
      // A blocked repair keeps the run-wide fence: nothing progresses except terminalization.
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "other", { status: "running", attempts: 1 }, { mustExist: true }),
        /cannot start while a merged-slice repair is unresolved/u,
      );
      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }),
        /cannot advance while a merged-slice repair is unresolved/u,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("fences gate boundaries and keeps persisted pre-PR post_pr policy admissible", async () => {
    const fixture = createFixture();
    try {
      // Persisted default-off post-PR policy is normal pre-PR state, not authority.
      mutateRun(fixture, (run) => { run.post_pr = createPostPrState(POST_PR_POLICY(false)); });
      const { merged_slice_repair: repair } = await report(fixture);
      assert.equal(repair.status, "reported");
      // Gate boundaries and approvals are fenced while the repair is unresolved.
      await assert.rejects(
        transitionSteeringBoundaryOpened(fixture.runDir, "gate"),
        /gate boundary cannot open while a merged-slice repair is unresolved/u,
      );
      await assert.rejects(
        approveGate(fixture),
        /cannot be approved while a merged-slice repair is unresolved/u,
        "gate approval is fenced while the repair is active",
      );
      await transitionMergedSliceRepair(fixture.runDir, { status: "blocked", reason: "needs recovery" });
      await assert.rejects(
        transitionSteeringBoundaryOpened(fixture.runDir, "gate"),
        /gate boundary cannot open while a merged-slice repair is unresolved/u,
        "a blocked repair keeps the gate fence",
      );
      await assert.rejects(
        approveGate(fixture),
        /cannot be approved while a merged-slice repair is unresolved/u,
        "gate approval stays fenced after the repair blocks",
      );
      const terminalBoundary = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal");
      assert.ok(terminalBoundary.run.steering.boundary.token, "terminal boundaries stay open for recovery");
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects a report once actual post-PR authority exists", async () => {
    const fixture = createFixture();
    try {
      // Bare persisted policy shells are admissible in both pre-PR phases.
      mutateRun(fixture, (run) => { run.post_pr = createPostPrState(POST_PR_POLICY(true)); run.merged_slice_repair = undefined; });
      const { merged_slice_repair: awaiting } = await report(fixture);
      assert.equal(awaiting.status, "reported");
      // Every authority binding fails admission closed, including the
      // append-only evidence and continuation-review bindings.
      const authorityStates = [
        { attempt: 1 },
        { evidence_refs: [{ ref: "evidence/post-pr-observation.attempt-1.json", hash: "sha256:" + "f".repeat(64) }] },
      ];
      for (const authority of authorityStates) {
        mutateRun(fixture, (run) => {
          run.post_pr = { ...createPostPrState(POST_PR_POLICY(true)), ...authority };
          run.merged_slice_repair = undefined;
        });
        await assert.rejects(report(fixture), /after post-PR authority exists/u, JSON.stringify(authority));
      }
      // continuation_review is schema-coupled to terminal retry exhaustion
      // (phase blocked + terminal run), which admission already rejects three
      // ways; the authority check is defense-in-depth for hand-edited state,
      // and the checked transition still fails closed on it.
      mutateRun(fixture, (run) => {
        run.post_pr = { ...createPostPrState(POST_PR_POLICY(true)), continuation_review: { ref: "reviews/post-pr.json", hash: "sha256:" + "e".repeat(64) } };
        run.merged_slice_repair = undefined;
      });
      await assert.rejects(report(fixture), /after post-PR authority exists|allowed only for retry exhaustion/u, "continuation_review must fail admission closed");
    } finally {
      cleanup(fixture);
    }
  });

  it("admits a report only in the pre-integration window", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(report(fixture, { consumer_slice_id: "merged-consumer" }), /already merged; a post-merge defect belongs to the integration gate/u);
      mutateRun(fixture, (run) => { run.steps = [{ agent: "test-verifier", status: "rejected", attempts: 1 }]; });
      await assert.rejects(report(fixture), /after the test-verifier integration gate has started/u);
      mutateRun(fixture, (run) => { run.steps = []; run.validator = { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" }; });
      await assert.rejects(report(fixture), /after panel verdicts exist/u);
      mutateRun(fixture, (run) => { run.validator = null; run.pr_url = "https://github.com/o/r/pull/1"; });
      await assert.rejects(report(fixture), /after a PR exists/u);
      mutateRun(fixture, (run) => { run.pr_url = null; });
      const { merged_slice_repair: repair } = await report(fixture);
      assert.equal(repair.status, "reported");
    } finally {
      cleanup(fixture);
    }
  });

  it("counts an executing repair as in-flight heartbeat work", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      assert.equal(hasInFlightHeartbeatWork(readRun(fixture)), false, "a reported repair is not yet executing");
      await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 });
      assert.equal(hasInFlightHeartbeatWork(readRun(fixture)), true, "a repairing repair holds heartbeat eligibility");
    } finally {
      cleanup(fixture);
    }
  });

  it("reports repair evidence hash drift through run consistency checks and blocks terminally", async () => {
    const fixture = createFixture();
    try {
      await report(fixture);
      writeJson(join(fixture.runDir, "evidence", "consumer-failure.json"), { subject: "consumer", status: "fail", drift: true });
      const result = checkRunConsistency(fixture.runDir, readRun(fixture));
      assert.equal(result.ok, false, "evidence drift must be reported");
      const evidenceCheck = result.checks.find((check) => check.name === "run.merged_slice_repair.evidence_ref");
      assert.equal(evidenceCheck.ok, false);

      const { merged_slice_repair: blocked } = await transitionMergedSliceRepair(fixture.runDir, { status: "blocked", reason: "fix needs a contract amendment" });
      assert.equal(blocked.status, "blocked");
      await assert.rejects(transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 }), /terminal/u);
    } finally {
      cleanup(fixture);
    }
  });
});

function createFixture() {
  const repo = mkdtempSync(join(tmpdir(), "feature-factory-repair-"));
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  for (const dir of ["evidence", "reviews", "plan"]) mkdirSync(join(runDir, dir), { recursive: true });

  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  git(repo, ["branch", FEATURE_BRANCH]);
  git(repo, ["checkout", "-q", FEATURE_BRANCH]);
  writeFileSync(join(repo, "feature.txt"), "feature work\n");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-q", "-m", "feature work"]);
  const featureCommit = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "-q", "main"]);
  writeFileSync(join(repo, "main-only.txt"), "main only\n");
  git(repo, ["add", "main-only.txt"]);
  git(repo, ["commit", "-q", "-m", "main only"]);
  const mainOnlyCommit = git(repo, ["rev-parse", "HEAD"]).trim();

  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: RUN_ID,
    status: "running",
    branch: FEATURE_BRANCH,
    gates: {},
    steps: [],
    slices: [
      { id: "owner", stack: "backend", depends_on: [], status: "merged", attempts: 2, merge_commit: "1111111", review_ref: "reviews/owner.json" },
      { id: "consumer", stack: "backend", depends_on: ["owner"], status: "blocked", attempts: 1, blocked_reason: "owner defect" },
      { id: "merged-consumer", stack: "backend", depends_on: ["owner"], status: "merged", attempts: 1, merge_commit: "2222222", review_ref: "reviews/owner.json" },
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
  writeJson(join(runDir, "evidence", "no-subject.json"), { status: "fail" });
  writeJson(join(runDir, "evidence", "passing.json"), { subject: "consumer", status: "pass" });
  writeJson(join(runDir, "evidence", "repair-attempt.json"), { subject: "repair:owner", changed_paths: ["src/owner/records.js", "test/owner.test.js"] });
  writeJson(join(runDir, "reviews", "owner.json"), { subject: "owner", verdict: "APPROVE", required_fixes: [] });
  return { repo, runDir, featureCommit, mainOnlyCommit };
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
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

function review(fixture, reviewName) {
  return transitionMergedSliceRepair(fixture.runDir, {
    status: "review",
    review_ref: `reviews/${reviewName}.json`,
    repair_evidence_ref: "evidence/repair-attempt.json",
  });
}

function merge(fixture, overrides = {}) {
  return transitionMergedSliceRepair(fixture.runDir, {
    status: "merged",
    merge_commit: fixture.featureCommit,
    verification_ref: "evidence/verification-pass.json",
    ...overrides,
  }, { repoRoot: fixture.repo });
}

function recordReview(fixture, name, review) {
  writeJson(join(fixture.runDir, "reviews", `${name}.json`), { subject: "repair:owner", ...review });
}

function approveGate(fixture) {
  return transitionGateDecision(fixture.runDir, "pre_pr", {
    status: "approved",
    artifact: "artifacts/validation-report.md",
    question_ref: "gates/pre_pr.question.md",
    answer: "approve",
    approval_source: "autonomous",
  });
}

function mutateRun(fixture, mutate) {
  const run = readRun(fixture);
  mutate(run);
  writeJson(join(fixture.runDir, "run.json"), run);
}

function writeRunSliceStatus(fixture, sliceId, status, attempts) {
  const run = readRun(fixture);
  const slice = run.slices.find((item) => item.id === sliceId);
  slice.status = status;
  slice.attempts = attempts;
  writeJson(join(fixture.runDir, "run.json"), run);
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
