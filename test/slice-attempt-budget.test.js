import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { completeSliceBuilderTaskDispatch, prepareSliceBuilderTaskDispatch, transitionRecoverOrphan, transitionRunSlice, transitionSteeringBoundaryOpened, transitionSteeringConflict, transitionSteeringConsumed, transitionSteeringQueued, transitionTerminalResult } from "../src/run-state.js";
import { validateRun, validateSlicesPlan } from "../src/validate.js";
import { spawnSync } from "./helpers/git-fixture.js";

describe("uniform slice attempt evidence", () => {
  it("advances one attempt at a time and appends exact review history", async () => {
    const fixture = createFixture("history");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["first", "second"] });
      await startAttempt(fixture, 2);
      const result = await publishReview(fixture, 2, { verdict: "APPROVE" });

      assert.deepEqual(result.slice.attempt_reviews.map((review) => [review.attempt, review.verdict, review.remaining_fix_count]), [
        [1, "REJECT", 2],
        [2, "APPROVE", 0],
      ]);
      assert.equal(result.slice.attempt_reviews[0].evidence_ref, "evidence/slice.attempt-1.json");
      assert.match(result.slice.attempt_reviews[0].review_hash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(result.slice.review_hash, result.slice.attempt_reviews[1].review_hash);
      assert.equal(validateRun(readRun(fixture)).slices[0].attempts, 2);
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects jumps, regressions, attempt four, and caller-authored history", async () => {
    const fixture = createFixture("bounds");
    try {
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 }), /advance exactly to 1|start at attempt 1/u);
      await startAttempt(fixture, 1);
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 3 }), /advance exactly to 2/u);
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 0 }), /stay at 1 or advance exactly to 2|positive/u);
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { attempt_reviews: [{ attempt: 1 }] }), /history is managed/u);
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 }), /attempt advancement requires.*reviewed REJECT/u);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["first"] });
      await startAttempt(fixture, 2);
      await publishReview(fixture, 2, { verdict: "REJECT", fixes: ["second"] });
      await startAttempt(fixture, 3);
      await publishReview(fixture, 3, { verdict: "REJECT", fixes: ["third"] });
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 4 }), /must not exceed 3/u);
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects stale historical review bytes before further progress", async () => {
    const fixture = createFixture("stale-history");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["repair"] });
      await startAttempt(fixture, 2);
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), reviewRecord(fixture, 1, { verdict: "REJECT", fixes: ["rewritten"] }));

      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 3 }),
        /attempt 1 review history is stale/u,
      );
      assert.equal(readRun(fixture).slices[0].attempts, 2);
    } finally {
      cleanup(fixture);
    }
  });

  it("rechecks all historical review bytes at the final run.json replacement boundary", async () => {
    const fixture = createFixture("history-publication-race");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["repair"] });
      await startAttempt(fixture, 2);
      await publishReview(fixture, 2, { verdict: "REJECT", fixes: ["repair again"] });

      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 3 }, {
          atomicWriteHooks: { beforeCommit: () => writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), reviewRecord(fixture, 1, { verdict: "REJECT", fixes: ["raced rewrite"] })) },
        }),
        /attempt 1 review history is stale|commit failed/u,
      );
      assert.equal(readRun(fixture).slices[0].attempts, 2);
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects non-atomic, duplicate, and inconsistent review issue counts", async () => {
    for (const [name, review, error] of [
      ["missing-convergence", { verdict: "REJECT", required_fixes: ["fix"], remaining_fix_count: 1 }, /convergence.*must be/u],
      ["wrong-count", { verdict: "REJECT", convergence: "converging", required_fixes: ["fix"], remaining_fix_count: 2 }, /must equal required_fixes length/u],
      ["duplicate", { verdict: "REJECT", convergence: "converging", required_fixes: ["fix", "fix"], remaining_fix_count: 2 }, /unique trimmed NFC-normalized/u],
      ["approve-with-fix", { verdict: "APPROVE", convergence: "converging", required_fixes: ["fix"], remaining_fix_count: 1 }, /APPROVE review requires zero/u],
      ["missing-classification", { verdict: "REJECT", convergence: "converging", required_fixes: ["fix"], remaining_fix_count: 1, remediation_context: undefined }, /remediation_context.*required/u],
    ]) {
      const fixture = createFixture(name);
      try {
        await startAttempt(fixture, 1);
        const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
        writeJson(join(fixture.runDir, "evidence", "slice.attempt-1.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: head });
        writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), {
          subject: "slice", attempt: 1, reviewed_commit: head,
          remediation_context: { schema_version: 1, fixes: (review.required_fixes || []).map((_, required_fix_index) => ({ required_fix_index, classification: "narrow-correction" })) },
          ...review,
        });
        await assert.rejects(transitionRunSlice(fixture.runDir, "slice", {
          status: "review", attempts: 1, evidence_ref: "evidence/slice.attempt-1.json", review_ref: "reviews/slice.attempt-1.json",
        }), error, name);
        assert.equal(readRun(fixture).slices[0].status, "running");
      } finally {
        cleanup(fixture);
      }
    }
  });

  it("keeps the plan and durable schema closed to a fixed limit of three", () => {
    const plan = {
      integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
      slices: [{ id: "slice", stack: "backend", paths: ["src/"], depends_on: [], acceptance: ["works"], test_plan: ["node --test"] }],
    };
    assert.equal(validateSlicesPlan(plan, { requireIntegrationGate: true }).slices.length, 1);
    assert.throws(() => validateSlicesPlan({ ...plan, slices: [{ ...plan.slices[0], max_attempts: 4 }] }), /max_attempts: is not allowed/u);
    assert.throws(() => validateSlicesPlan({ ...plan, slices: [{ ...plan.slices[0], dominant_concern: "wide" }] }), /dominant_concern: is not allowed/u);
    assert.throws(() => validateRun({ schema_version: 1, run_id: "run", status: "running", slices: [{ id: "slice", status: "running", attempts: 4 }] }), /must not exceed 3/u);
  });

  it("terminalizes an attempted retry from the exact nonconvergent review into checked carry-forward", async () => {
    const fixture = createFixture("nonconvergent-terminal");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["first correction"] });
      await startAttempt(fixture, 2);
      await publishReview(fixture, 2, { verdict: "REJECT", fixes: ["review process missed a category"], convergence: "nonconvergent" });

      const result = await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 3 });

      assert.equal(result.run.status, "blocked");
      assert.equal(result.slice.status, "blocked");
      assert.equal(result.slice.attempts, 2);
      assert.equal(result.slice.blocked_reason, "slice-review-nonconvergent");
      assert.equal(result.run.terminal_result.reason, "slice-review-nonconvergent");
      assert.deepEqual(result.run.terminal_result.nonconvergence.source_review, result.slice.attempt_reviews[1]);
      assert.deepEqual(result.run.terminal_result.nonconvergence.continuation, {
        program: "feature-factory",
        args: ["factory", "continue", "run", "--review", "reviews/slice.attempt-2.json", "--run-id", "<new-run-id>", "--carry-forward", "--json"],
      });
      assert.equal(validateRun(readRun(fixture)).status, "blocked");
    } finally {
      cleanup(fixture);
    }
  });

  it("allows a converging attempt-two rejection to advance to attempt three", async () => {
    const fixture = createFixture("converging-third");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["first"] });
      await startAttempt(fixture, 2);
      await publishReview(fixture, 2, { verdict: "REJECT", fixes: ["second"] });

      const result = await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 3 });

      assert.equal(result.run.status, "running");
      assert.equal(result.slice.status, "running");
      assert.equal(result.slice.attempts, 3);
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects stale nonconvergent review bytes without publishing terminal state", async () => {
    const fixture = createFixture("nonconvergent-stale");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["missed category"], convergence: "nonconvergent" });
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), reviewRecord(fixture, 1, { verdict: "REJECT", fixes: ["rewritten category"], convergence: "nonconvergent" }));

      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 }), /hashes are stale|history is stale/u);
      const run = readRun(fixture);
      assert.equal(run.status, "running");
      assert.equal(run.terminal_result, undefined);
      assert.equal(run.slices[0].status, "review");
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects generic terminalization while an exact current nonconvergent review is pending", async () => {
    const fixture = createFixture("nonconvergent-generic-terminal");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["missed category"], convergence: "nonconvergent" });
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "blocked", attempts: 1, blocked_reason: "generic block" }),
        /cannot transition to ordinary blocked state/u,
      );
      const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal");

      await assert.rejects(
        transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "generic bypass" }, { boundaryToken: opened.boundary.token }),
        /current nonconvergent review must terminalize through the checked next-attempt transition/u,
      );
      assert.equal(readRun(fixture).status, "running");
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects recovery and steering-conflict terminal siblings while nonconvergence is pending", async () => {
    for (const route of ["recover", "steering-conflict"]) {
      const fixture = createFixture(`nonconvergent-${route}`);
      try {
        await startAttempt(fixture, 1);
        await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["missed category"], convergence: "nonconvergent" });
        let terminalize;
        if (route === "recover") {
          terminalize = () => transitionRecoverOrphan(fixture.runDir, "generic recovery bypass");
        } else {
          const queued = await transitionSteeringQueued(fixture.runDir, "conflicting request", { id: "conflict" });
          const consumed = await transitionSteeringConsumed(fixture.runDir, { ref: queued.steering.ref, hash: queued.steering.hash });
          terminalize = () => transitionSteeringConflict(fixture.runDir, { ref: consumed.steering.ref, hash: consumed.steering.hash });
        }

        await assert.rejects(terminalize(), /current nonconvergent review must terminalize through the checked next-attempt transition/u);
        assert.equal(readRun(fixture).status, "running");
      } finally {
        cleanup(fixture);
      }
    }
  });

  it("rejects forged nonconvergence sources and carry-forward routes", async () => {
    const fixture = createFixture("nonconvergent-forgery");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["missed category"], convergence: "nonconvergent" });
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });
      const terminal = readRun(fixture);

      const wrongSource = structuredClone(terminal);
      wrongSource.terminal_result.nonconvergence.source_review.review_hash = `sha256:${"0".repeat(64)}`;
      assert.throws(() => validateRun(wrongSource), /must equal the current latest append-only slice review entry/u);

      const historicalSource = structuredClone(terminal);
      historicalSource.slices[0].attempts = 2;
      historicalSource.slices[0].attempt_reviews.push({
        ...historicalSource.slices[0].attempt_reviews[0],
        attempt: 2,
        evidence_ref: "evidence/slice.attempt-2.json",
        evidence_hash: `sha256:${"1".repeat(64)}`,
        review_ref: "reviews/slice.attempt-2.json",
        review_hash: `sha256:${"2".repeat(64)}`,
      });
      assert.throws(() => validateRun(historicalSource), /must equal the current latest append-only slice review entry/u);

      const wrongRoute = structuredClone(terminal);
      wrongRoute.terminal_result.nonconvergence.continuation.args[7] = "--new-pr";
      assert.throws(() => validateRun(wrongRoute), /exact checked carry-forward command template/u);

      const wrongDisposition = structuredClone(terminal);
      wrongDisposition.status = "needs-human";
      wrongDisposition.terminal_result.status = "needs-human";
      assert.throws(() => validateRun(wrongDisposition), /requires an exact pre-PR blocked run and terminal status/u);
    } finally {
      cleanup(fixture);
    }
  });

  it("derives checked builder Task context from exact current state and review bytes", async () => {
    const fixture = createFixture("builder-dispatch");
    try {
      await startAttempt(fixture, 1);
      const initial = await prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 1, agent: "backend-builder" });
      assert.equal(initial.task_context, "fresh");
      assert.equal(initial.prior, null);
      assert.equal(initial.slice.contract.id, "slice");

      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["small correction"] });
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });
      const remediation = await prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 2, agent: "backend-builder" });
      assert.equal(remediation.task_context, "reuse");
      assert.equal(JSON.parse(Buffer.from(remediation.prior.review.bytes, "base64").toString("utf8")).required_fixes[0], "small correction");
      assert.equal(remediation.authorized_inputs.some((input) => input.ref === "artifacts/technical-brief.md"), true);

      writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "rewritten brief\n", "utf8");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 2, agent: "backend-builder" }),
        /not bound by exact accepted authority/u,
      );
      writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "accepted brief\n", "utf8");
      writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "REJECT", required_fixes: ["rewritten acceptance"] });
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 2, agent: "backend-builder" }),
        /not bound by exact accepted authority/u,
      );
      writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", required_fixes: [] });

      writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), reviewRecord(fixture, 1, { verdict: "REJECT", fixes: ["rewritten"] }));
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 2, agent: "backend-builder" }),
        /hashes are stale|history is stale/u,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("selects fresh checked builder context for any non-narrow prior fix", async () => {
    const fixture = createFixture("builder-dispatch-fresh");
    try {
      await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["replace schema"], classifications: ["schema-redesign"] });
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });

      const context = await prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 2, agent: "backend-builder" });
      assert.equal(context.task_context, "fresh");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 2, agent: "frontend-builder" }),
        /agent does not match/u,
      );
      writeFileSync(join(fixture.repo, "drift.txt"), "drift\n", "utf8");
      git(fixture.repo, ["add", "drift.txt"]);
      git(fixture.repo, ["commit", "-m", "drift after review"]);
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: "run", slice_id: "slice", attempt: 2, agent: "backend-builder" }),
        /head must equal the immediately prior reviewed_commit/u,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("requires exact durable Task closure before review publication", async () => {
    const fixture = createFixture("builder-dispatch-closure");
    try {
      const { context, completionToken } = await startAttempt(fixture, 1, { completeDispatch: false });
      const claimed = readRun(fixture).slices[0];
      assert.equal(claimed.dispatch_required, true);
      assert.equal(claimed.dispatch_claim_ref, context.dispatch_claim.ref);
      assert.equal(claimed.dispatch_claim_hash, context.dispatch_claim.hash);
      assert.equal(Object.hasOwn(claimed, "dispatch_closure_ref"), false);

      await assert.rejects(
        publishReview(fixture, 1, { verdict: "REJECT", fixes: ["repair"] }),
        /remains active or has an unknown outcome/u,
      );
      assert.equal(readRun(fixture).slices[0].status, "running");

      await assert.rejects(
        completeSliceBuilderTaskDispatch(fixture.repo, {
          run_id: "run",
          slice_id: "slice",
          attempt: 1,
          agent: "backend-builder",
          claim_ref: context.dispatch_claim.ref,
          claim_hash: context.dispatch_claim.hash,
          completion_token: "task-forged-token",
        }),
        /completion capability is invalid/u,
      );

      await completeSliceBuilderTaskDispatch(fixture.repo, {
        run_id: "run",
        slice_id: "slice",
        attempt: 1,
        agent: "backend-builder",
        claim_ref: context.dispatch_claim.ref,
        claim_hash: context.dispatch_claim.hash,
        completion_token: completionToken,
      });
      const completed = readRun(fixture).slices[0];
      assert.equal(completed.dispatch_closure_ref, context.dispatch_claim.closure_ref);
      assert.match(completed.dispatch_closure_hash, /^sha256:[0-9a-f]{64}$/u);
      const closurePath = join(fixture.runDir, context.dispatch_claim.closure_ref);
      const closureBytes = readFileSync(closurePath, "utf8");
      assert.equal(JSON.parse(closureBytes).completion_head, gitOutput(fixture.repo, ["rev-parse", "HEAD"]));
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", {
          status: "review",
          attempts: 1,
          evidence_ref: "evidence/slice.attempt-1.json",
          review_ref: "reviews/slice.attempt-1.json",
        }, {
          atomicWriteHooks: {
            beforeCommit: () => {
              const changed = JSON.parse(closureBytes);
              changed.returned_at = "2099-01-01T00:00:00.000Z";
              writeJson(closurePath, changed);
            },
          },
        }),
        /review authority changed before publication|commit failed/u,
      );
      writeFileSync(closurePath, closureBytes, "utf8");
      const result = await transitionRunSlice(fixture.runDir, "slice", {
        status: "review",
        attempts: 1,
        evidence_ref: "evidence/slice.attempt-1.json",
        review_ref: "reviews/slice.attempt-1.json",
      });
      assert.equal(result.slice.status, "review");
    } finally {
      cleanup(fixture);
    }
  });

  it("requires checked dispatch for every newly started successor attempt", async () => {
    const fixture = createFixture("builder-dispatch-required");
    try {
      await transitionRunSlice(fixture.runDir, "slice", {
        status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo,
      });
      assert.equal(readRun(fixture).slices[0].dispatch_required, true);

      await assert.rejects(
        publishReview(fixture, 1, { verdict: "REJECT", fixes: ["repair"] }),
        /requires exact closed checked Task dispatch authority/u,
      );
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 }),
        /requires exact closed checked Task dispatch authority|attempt advancement requires/u,
      );
      assert.equal(readRun(fixture).slices[0].status, "running");
    } finally {
      cleanup(fixture);
    }
  });

  it("requires checked dispatch before a pre-B2 running attempt can publish review", async () => {
    const fixture = createFixture("pre-b2-running-dispatch-required");
    try {
      const run = readRun(fixture);
      Object.assign(run.slices[0], { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(
        publishReview(fixture, 1, { verdict: "REJECT", fixes: ["repair"] }),
        /requires exact closed checked Task dispatch authority/u,
      );
      assert.equal(readRun(fixture).slices[0].status, "running");
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects review when HEAD moves after the checked Task completion", async () => {
    const fixture = createFixture("post-task-head-drift");
    try {
      await startAttempt(fixture, 1);
      commitSliceAttempt(fixture, 2);
      await assert.rejects(
        publishReview(fixture, 1, { verdict: "APPROVE" }),
        /reviewed head must equal the checked Task completion head/u,
      );
      assert.equal(readRun(fixture).slices[0].status, "running");
    } finally {
      cleanup(fixture);
    }
  });

  it("rechecks exact closed dispatch authority at retry and nonconvergence publication", async () => {
    for (const convergence of ["converging", "nonconvergent"]) {
      const fixture = createFixture(`dispatch-commit-bound-${convergence}`);
      try {
        const { context } = await startAttempt(fixture, 1);
        await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["repair"], convergence });
        const closurePath = join(fixture.runDir, context.dispatch_claim.closure_ref);
        const closureBytes = readFileSync(closurePath, "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 }, {
            atomicWriteHooks: {
              beforeCommit: () => {
                const changed = JSON.parse(closureBytes);
                changed.returned_at = "2099-01-01T00:00:00.000Z";
                writeJson(closurePath, changed);
              },
            },
          }),
          /dispatch authority changed before publication|commit failed/u,
          convergence,
        );
        assert.equal(readRun(fixture).status, "running");
        assert.equal(readRun(fixture).slices[0].status, "review");
      } finally {
        cleanup(fixture);
      }
    }
  });

  it("retains every prior attempt dispatch binding before publishing a successor claim", async () => {
    const fixture = createFixture("dispatch-history-retained");
    try {
      const { context } = await startAttempt(fixture, 1);
      await publishReview(fixture, 1, { verdict: "REJECT", fixes: ["repair"] });
      const reviewed = readRun(fixture).slices[0];
      for (const key of ["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]) {
        assert.equal(reviewed.attempt_reviews[0][key], reviewed[key]);
      }
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });
      rmSync(join(fixture.runDir, context.dispatch_claim.ref));

      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, {
          run_id: "run", slice_id: "slice", attempt: 2, agent: "backend-builder",
        }, { claimDispatch: true, completionToken: "successor-token" }),
        /attempt 1 claim disappeared|dispatch claim is missing/u,
      );
      assert.equal(readRun(fixture).slices[0].dispatch_claim_ref, undefined);
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects every terminal sibling while a checked builder dispatch is unresolved", async () => {
    for (const route of ["terminal", "recover", "steering-conflict"]) {
      const fixture = createFixture(`unresolved-dispatch-${route}`);
      try {
        await startAttempt(fixture, 1, { completeDispatch: false });
        let terminalize;
        if (route === "terminal") {
          const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal");
          terminalize = () => transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "dispatch bypass" }, { boundaryToken: opened.boundary.token });
        } else if (route === "recover") {
          terminalize = () => transitionRecoverOrphan(fixture.runDir, "dispatch bypass");
        } else {
          const queued = await transitionSteeringQueued(fixture.runDir, "conflicting request", { id: "dispatch-conflict" });
          const consumed = await transitionSteeringConsumed(fixture.runDir, { ref: queued.steering.ref, hash: queued.steering.hash });
          terminalize = () => transitionSteeringConflict(fixture.runDir, { ref: consumed.steering.ref, hash: consumed.steering.hash });
        }
        await assert.rejects(terminalize(), /unresolved checked slice builder Task dispatch/u, route);
        assert.equal(readRun(fixture).status, "running");
      } finally {
        cleanup(fixture);
      }
    }
  });
});

async function startAttempt(fixture, attempt, { completeDispatch = true } = {}) {
  const update = { status: "running", attempts: attempt };
  if (attempt === 1) Object.assign(update, { branch: "slice-branch", worktree: fixture.repo });
  const result = await transitionRunSlice(fixture.runDir, "slice", update);
  if (result.run.status !== "running" || result.slice.status !== "running") return { result, context: null, completionToken: null };
  const completionToken = `test-completion-${attempt}`;
  const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
    run_id: "run", slice_id: "slice", attempt, agent: "backend-builder",
  }, { claimDispatch: true, completionToken });
  if (completeDispatch) {
    commitSliceAttempt(fixture, attempt);
    await completeSliceBuilderTaskDispatch(fixture.repo, {
      run_id: "run",
      slice_id: "slice",
      attempt,
      agent: "backend-builder",
      claim_ref: context.dispatch_claim.ref,
      claim_hash: context.dispatch_claim.hash,
      completion_token: completionToken,
    });
  }
  return { result, context, completionToken };
}

async function publishReview(fixture, attempt, options) {
  commitSliceAttempt(fixture, attempt);
  const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  const evidenceRef = `evidence/slice.attempt-${attempt}.json`;
  const reviewRef = `reviews/slice.attempt-${attempt}.json`;
  writeJson(join(fixture.runDir, evidenceRef), { subject: "slice", status: "pass", review_ready: true, attempt, head_sha: head });
  writeJson(join(fixture.runDir, reviewRef), reviewRecord(fixture, attempt, options));
  return transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: attempt, evidence_ref: evidenceRef, review_ref: reviewRef });
}

function commitSliceAttempt(fixture, attempt) {
  const path = join(fixture.repo, "slice.txt");
  const content = `attempt ${attempt}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content, "utf8");
  git(fixture.repo, ["add", "slice.txt"]);
  git(fixture.repo, ["commit", "-m", `slice attempt ${attempt}`]);
}

function reviewRecord(fixture, attempt, { verdict, fixes = [], convergence = "converging", classifications }) {
  return {
    subject: "slice",
    attempt,
    reviewed_commit: gitOutput(fixture.repo, ["rev-parse", "HEAD"]),
    verdict,
    convergence,
    remaining_fix_count: fixes.length,
    required_fixes: fixes,
    remediation_context: {
      schema_version: 1,
      fixes: fixes.map((_, required_fix_index) => ({
        required_fix_index,
        classification: classifications?.[required_fix_index] || (convergence === "nonconvergent" ? "nonconvergent" : "narrow-correction"),
      })),
    },
  };
}

function createFixture(name) {
  const repo = mkdtempSync(join(tmpdir(), `slice-attempt-budget-${name}-`));
  git(repo, ["init", "-b", "slice-branch"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture"]);
  const runDir = join(repo, ".opencode", "factory", "run");
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeJson(join(runDir, "plan", "slices.json"), {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{ id: "slice", stack: "backend", paths: ["src/"], depends_on: [], acceptance: ["works"], test_plan: ["node --test"] }],
  });
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE", required_fixes: [] });
  writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", required_fixes: [] });
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted brief\n", "utf8");
  const planHash = fileHash(join(runDir, "plan", "slices.json"));
  const decompositionReviewHash = fileHash(join(runDir, "reviews", "work-decomposer.json"));
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: "run",
    status: "running",
    branch: "slice-branch",
    worktree: repo,
    steering: { schema_version: 1, generation: 0, pending: null, uncheckpointed: null, boundary: null, action_claim: null, last_action: null, pr_fence: null, history: [] },
    steps: [{
      agent: "spec-writer", status: "accepted", attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
      acceptance: {
        artifact_ref: "artifacts/technical-brief.md", artifact_hash: fileHash(join(runDir, "artifacts", "technical-brief.md")),
        review_ref: "reviews/spec-writer.json", review_hash: fileHash(join(runDir, "reviews", "spec-writer.json")),
      },
    }, {
      agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: { artifact_ref: "plan/slices.json", artifact_hash: planHash, review_ref: "reviews/work-decomposer.json", review_hash: decompositionReviewHash },
    }],
    gates: {},
    slices: [{ id: "slice", stack: "backend", depends_on: [], status: "pending", attempts: 0 }],
  });
  return { repo, runDir };
}

function fileHash(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function readRun(fixture) {
  return JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function gitOutput(repo, args) {
  return git(repo, args).stdout.trim();
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function cleanup(fixture) {
  rmSync(fixture.repo, { recursive: true, force: true });
}
