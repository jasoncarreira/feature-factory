import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashFile } from "../src/refs.js";
import { completeIntegrationAmendmentReviewTaskDispatch, completeSpecialBuilderTaskDispatch, heartbeatOnce, inspectContinuationRouteSchema, prepareIntegrationAmendmentReviewTaskDispatch, prepareSpecialBuilderTaskDispatch, transitionContinuationAdoption, transitionGateDecision, transitionIntegrationAmendment, transitionRunJson, transitionRunSlice, transitionSteeringBoundaryOpened, transitionTerminalResult } from "../src/run-state.js";
import { checkRunConsistency, inspectIntegrationAmendmentInventory } from "../src/validate.js";
import { buildContinuation, cleanupRun, collectCleanupTargets, continueFactory, executeIntegrationAmendment, recordReviewDispatchProvenance, recoverDisruptedRun, resumeFactory, startHeartbeat, stopHeartbeat } from "../src/factory.js";
import plugin from "../src/plugin.js";
import { FEATURE_BRANCH, NOW, RUN_ID, addPristineTestVerifier, amendmentReviewPrompt, bindAmendmentDispatch, blocked, checkedReviewPromptContext, cleanup, cleanupFixtures, commitCandidate, commitCandidatePath, createFixture, downstreamProductionConsumers, executionOptions, git, makeReportClaimActive, publishAmendmentReview, reachIntegrated, reachMerged, reachVerified, readJson, readRun, reportRequest, reviewFromContext, reviewMarker, rewriteExecutionBinding, rewriteReportAsForeignRun, sha, snapshotAmendmentGateAuthority, writeJson, writeVerification } from "./helpers/integration-amendment/fixture.js";

after(cleanupFixtures);

describe("generic integration amendment", () => {
  it("derives and closes the checked owner-stack integration-amendment dispatch", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      const attempt = built.integration_amendment.attempts[0];
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder" }, {
        repoRoot: fixture.repo, claimDispatch: true, completionToken: "process-local-capability", now: NOW,
      });
      assert.equal(context.target.branch, attempt.branch_ref.slice("refs/heads/".length));
      assert.equal(context.target.worktree, attempt.worktree);
      assert.equal(context.target.head, attempt.build_base_commit);
      assert.equal(context.authority.owner.id, "owner");
      assert.deepEqual(context.authority.path_policy, { effective_paths: ["src/owner/**"], expansion_allowed: false });

      const candidate = commitCandidate(attempt.worktree);
      const closed = await completeSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder",
        claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: "process-local-capability",
      }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(closed.completion_head, candidate);
      const run = readRun(fixture);
      assert.equal(run.special_builder_dispatch.completion_head, candidate);
      assert.equal(run.special_builder_dispatch.closure_ref, closed.closure_ref);
    } finally { cleanup(fixture); }
  });

  it("replays special builder claim and closure crash boundaries without changing authority", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      const marker = { run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder" };
      await assert.rejects(prepareSpecialBuilderTaskDispatch(fixture.repo, marker, {
        repoRoot: fixture.repo, claimDispatch: true, completionToken: "special-crash-token", now: NOW,
        specialDispatchClaimAtomicWriteHooks: { afterCommit: () => { throw new Error("crash-after-special-claim"); } },
      }), /crash-after-special-claim/u);
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, marker, {
        repoRoot: fixture.repo, claimDispatch: true, completionToken: "special-crash-token", now: NOW,
      });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      const completion = { ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: "special-crash-token" };
      await assert.rejects(completeSpecialBuilderTaskDispatch(fixture.repo, completion, {
        repoRoot: fixture.repo, now: NOW,
        specialDispatchClosureAtomicWriteHooks: { beforeCommit: () => { throw new Error("crash-before-special-closure"); } },
      }), (error) => /crash-before-special-closure/u.test(error?.cause?.message || error?.message));
      await assert.rejects(completeSpecialBuilderTaskDispatch(fixture.repo, completion, {
        repoRoot: fixture.repo, now: NOW,
        specialDispatchClosureAtomicWriteHooks: { afterCommit: () => { throw new Error("crash-after-special-closure"); } },
      }), /crash-after-special-closure/u);
      const closed = await completeSpecialBuilderTaskDispatch(fixture.repo, completion, { repoRoot: fixture.repo, now: NOW });
      assert.equal(closed.completion_head, candidate);
      assert.equal(readRun(fixture).special_builder_dispatch.completion_head, candidate);
    } finally { cleanup(fixture); }
  });

  it("accepts reviews only through the exact fresh synchronous work-reviewer callback", async () => {
    const skipped = createFixture();
    try {
      await transitionIntegrationAmendment(skipped.runDir, reportRequest(), { repoRoot: skipped.repo, now: NOW });
      const built = await transitionIntegrationAmendment(skipped.runDir, { action: "build", attempt: 1 }, { repoRoot: skipped.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(skipped, candidate);
      await assert.rejects(transitionIntegrationAmendment(skipped.runDir, { action: "review" }, { repoRoot: skipped.repo, now: NOW }), /closed-unconsumed reviewer authority|reviewer claim|review publication provenance|missing reviews ref/u);
    } finally { cleanup(skipped); }

    const precreated = createFixture();
    try {
      await transitionIntegrationAmendment(precreated.runDir, reportRequest(), { repoRoot: precreated.repo, now: NOW });
      const built = await transitionIntegrationAmendment(precreated.runDir, { action: "build", attempt: 1 }, { repoRoot: precreated.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(precreated, candidate);
      const amendment = readRun(precreated).integration_amendment;
      writeJson(join(precreated.runDir, "reviews", `integration-amendment-${amendment.amendment_id}.attempt-1.json`), { forged: true });
      await assert.rejects(prepareIntegrationAmendmentReviewTaskDispatch(precreated.repo, reviewMarker(amendment), {
        claimDispatch: true, completionToken: "precreated-token", now: NOW,
      }), /already exists before checked reviewer dispatch|unknown sidecar|orphaned without its claim/u);
    } finally { cleanup(precreated); }

    const callback = createFixture();
    try {
      await transitionIntegrationAmendment(callback.runDir, reportRequest(), { repoRoot: callback.repo, now: NOW });
      const built = await transitionIntegrationAmendment(callback.runDir, { action: "build", attempt: 1 }, { repoRoot: callback.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(callback, candidate);
      const amendment = readRun(callback).integration_amendment;
      const instance = await plugin({ directory: callback.repo });
      const identity = { tool: "task", sessionID: "review-session", callID: "review-call" };
      const task = { args: { subagent_type: "work-reviewer", prompt: amendmentReviewPrompt(amendment) } };
      await instance["tool.execute.before"](identity, task);
      const context = checkedReviewPromptContext(task.args.prompt);
      assert.equal(context.candidate_commit, candidate);
      assert.deepEqual(context.ownership.map(({ id }) => id), ["owner", "consumer"]);
      await assert.rejects(instance["tool.execute.after"]({ ...identity, args: { ...task.args, subagent_type: "security-reviewer" } }, {
        output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {},
      }), /cross-role|callback identity/u);
      assert.equal(existsSync(join(callback.runDir, context.review_ref)), false);
      await instance["tool.execute.after"]({ ...identity, args: task.args }, {
        output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {},
      });
      assert.equal(existsSync(join(callback.runDir, context.review_ref)), false, "a rejected callback must destroy pending reviewer capability");
    } finally { cleanup(callback); }
  });

  it("classifies reviewer effects and fences every semantic action until exact review consumption", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
      const amendment = readRun(fixture).integration_amendment;
      const marker = reviewMarker(amendment);
      const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, marker, {
        claimDispatch: true, completionToken: "effect-token", now: NOW,
      });
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "active-claim-only");
      for (const request of [{ action: "block", reason: "must not bypass" }, { action: "build", attempt: 1 }, { action: "integrate" }, { action: "review" }]) {
        await assert.rejects(transitionIntegrationAmendment(fixture.runDir, request, { repoRoot: fixture.repo, now: NOW }), /reviewer effect is active-claim-only|closed-unconsumed reviewer authority/u);
      }

      const review = reviewFromContext(context, "APPROVE", []);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "effect-token", output: JSON.stringify(review),
      }, {
        now: NOW,
        amendmentReviewClosureAtomicWriteHooks: { beforeCommit: () => { throw new Error("closure-publication-paused"); } },
      }), (error) => /closure-publication-paused/u.test(error?.cause?.message || error?.message));
      const reviewPath = join(fixture.runDir, context.review_ref);
      const reviewBytes = readFileSync(reviewPath);
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "review-published-without-closure");
      await assert.rejects(prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, marker, {
        claimDispatch: true, completionToken: "replacement-token", now: NOW,
      }), /reviewer effect is review-published-without-closure/u);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "must not bypass" }, { repoRoot: fixture.repo, now: NOW }), /reviewer effect is review-published-without-closure/u);

      await completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "effect-token", output: JSON.stringify(review),
      }, { now: NOW });
      assert.deepEqual(readFileSync(reviewPath), reviewBytes);
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "closed-unconsumed");
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "must not bypass" }, { repoRoot: fixture.repo, now: NOW }), /reviewer effect is closed-unconsumed/u);
      const consumed = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(consumed.integration_amendment.status, "reviewed");
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "consumed");
    } finally { cleanup(fixture); }
  });

  it("replays review and closure publication ambiguity without overwriting bytes", async () => {
    for (const [name, hooks, expectedState] of [
      ["review-publication", { amendmentReviewPublicationAtomicWriteHooks: { afterCommit: () => { throw new Error("after-review-publication"); } } }, "review-published-without-closure"],
      ["closure-publication", { amendmentReviewClosureAtomicWriteHooks: { afterCommit: () => { throw new Error("after-closure-publication"); } } }, "closed-unconsumed"],
    ]) {
      const fixture = createFixture();
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
        const amendment = readRun(fixture).integration_amendment;
        const marker = reviewMarker(amendment);
        const token = `${name}-token`;
        const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, marker, { claimDispatch: true, completionToken: token, now: NOW });
        const review = reviewFromContext(context, "APPROVE", []);
        const completion = { ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: token, output: JSON.stringify(review) };
        await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, completion, { now: NOW, ...hooks }), new RegExp(`after-${name}`, "u"));
        assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, expectedState, name);
        const reviewBytes = readFileSync(join(fixture.runDir, context.review_ref));
        const closurePath = join(fixture.runDir, context.dispatch_claim.closure_ref);
        const closureBytes = existsSync(closurePath) ? readFileSync(closurePath) : null;
        const replay = await completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, completion, { now: NOW });
        assert.equal(replay.replayed, true, name);
        assert.deepEqual(readFileSync(join(fixture.runDir, context.review_ref)), reviewBytes, `${name} review bytes`);
        if (closureBytes) assert.deepEqual(readFileSync(closurePath), closureBytes, `${name} closure bytes`);
      } finally { cleanup(fixture); }
    }
  });

  it("retains the real plugin callback only for exact review or closure publication ambiguity", async () => {
    for (const [name, hookName, expectedState] of [
      ["review", "amendmentReviewPublicationAtomicWriteHooks", "review-published-without-closure"],
      ["closure", "amendmentReviewClosureAtomicWriteHooks", "closed-unconsumed"],
    ]) {
      const fixture = createFixture();
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
        const amendment = readRun(fixture).integration_amendment;
        const instance = await plugin({ directory: fixture.repo }, {
          dispatchLockOptions: {
            now: NOW,
            [hookName]: { afterCommit: () => { throw new Error(`plugin-after-${name}-publication`); } },
          },
        });
        const identity = { tool: "task", sessionID: `${name}-ambiguity-session`, callID: `${name}-ambiguity-call` };
        const task = { args: { subagent_type: "work-reviewer", prompt: amendmentReviewPrompt(amendment) } };
        await instance["tool.execute.before"](identity, task);
        const context = checkedReviewPromptContext(task.args.prompt);
        const result = { output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {} };

        await assert.rejects(instance["tool.execute.after"]({ ...identity, args: task.args }, result), new RegExp(`plugin-after-${name}-publication`, "u"));
        assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, expectedState);
        const reviewPath = join(fixture.runDir, context.review_ref);
        const closurePath = join(fixture.runDir, context.dispatch_claim.closure_ref);
        const reviewBytes = readFileSync(reviewPath);
        const closureBytes = existsSync(closurePath) ? readFileSync(closurePath) : null;

        await instance["tool.execute.after"]({ ...identity, args: task.args }, result);
        assert.deepEqual(readFileSync(reviewPath), reviewBytes, `${name} replay must not replace review bytes`);
        if (closureBytes) assert.deepEqual(readFileSync(closurePath), closureBytes, `${name} replay must not replace closure bytes`);
        assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "closed-unconsumed");

        const completedReviewBytes = readFileSync(reviewPath);
        const completedClosureBytes = readFileSync(closurePath);
        await instance["tool.execute.after"]({ ...identity, args: task.args }, result);
        assert.deepEqual(readFileSync(reviewPath), completedReviewBytes, `${name} completed callback must be deleted`);
        assert.deepEqual(readFileSync(closurePath), completedClosureBytes, `${name} completed closure must be immutable`);
      } finally { cleanup(fixture); }
    }
  });

  it("rejects orphan reviewer review and closure sidecars", async () => {
    for (const kind of ["review", "closure"]) {
      const fixture = createFixture();
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
        const amendment = readRun(fixture).integration_amendment;
        const name = createHash("sha256").update(`${RUN_ID}\0integration-amendment-review\0${amendment.amendment_id}\0${1}`, "utf8").digest("hex");
        if (kind === "review") writeJson(join(fixture.runDir, "reviews", `integration-amendment-${amendment.amendment_id}.attempt-1.json`), { orphan: true });
        else writeJson(join(fixture.runDir, "dispatch", `${name}.amendment-review.closed.json`), { kind: "checked-integration-amendment-review-dispatch-closure" });
        assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /orphan/u, kind);
      } finally { cleanup(fixture); }
    }
  });

  it("consumes a successful real plugin reviewer callback", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
      const amendment = readRun(fixture).integration_amendment;
      const instance = await plugin({ directory: fixture.repo });
      const identity = { tool: "task", sessionID: "successful-review-session", callID: "successful-review-call" };
      const task = { args: { subagent_type: "work-reviewer", prompt: amendmentReviewPrompt(amendment) } };
      await instance["tool.execute.before"](identity, task);
      const context = checkedReviewPromptContext(task.args.prompt);
      await instance["tool.execute.after"]({ ...identity, args: task.args }, { output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {} });
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "closed-unconsumed");
      const reviewed = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(reviewed.integration_amendment.status, "reviewed");
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "consumed");
    } finally { cleanup(fixture); }
  });

  it("create-publishes one review, exact-replays without overwrite, and rejects stale callback authority", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(fixture, candidate);
      const published = await publishAmendmentReview(fixture, "APPROVE", []);
      const reviewPath = join(fixture.runDir, published.context.review_ref);
      const before = readFileSync(reviewPath);
      const replay = await completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(readRun(fixture).integration_amendment), claim_ref: published.context.dispatch_claim.ref,
        claim_hash: published.context.dispatch_claim.hash, completion_token: "review-token-1", output: JSON.stringify(published.review),
      }, { now: NOW });
      assert.equal(replay.replayed, true);
      assert.deepEqual(readFileSync(reviewPath), before);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(readRun(fixture).integration_amendment), claim_ref: published.context.dispatch_claim.ref,
        claim_hash: published.context.dispatch_claim.hash, completion_token: "review-token-1",
        output: JSON.stringify({ ...published.review, verdict: "REJECT", required_fixes: ["different"] }),
      }, { now: NOW }), /conflicts with preexisting bytes|existing closure/u);
      assert.deepEqual(readFileSync(reviewPath), before);
    } finally { cleanup(fixture); }

    const stale = createFixture();
    try {
      await transitionIntegrationAmendment(stale.runDir, reportRequest(), { repoRoot: stale.repo, now: NOW });
      const built = await transitionIntegrationAmendment(stale.runDir, { action: "build", attempt: 1 }, { repoRoot: stale.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(stale, candidate);
      const amendment = readRun(stale).integration_amendment;
      const context = await prepareIntegrationAmendmentReviewTaskDispatch(stale.repo, reviewMarker(amendment), { claimDispatch: true, completionToken: "stale-token", now: NOW });
      commitCandidate(built.integration_amendment.attempts[0].worktree);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(stale.repo, {
        ...reviewMarker(amendment), claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "stale-token", output: JSON.stringify(reviewFromContext(context, "APPROVE", [])),
      }, { now: NOW }), /worktree authority is stale|context changed|branch\/worktree authority/u);
    } finally { cleanup(stale); }
  });

  it("rejects stale attempt-2 prior fixes after reviewer dispatch", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      let result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(result.integration_amendment.attempts[0].worktree));
      await publishAmendmentReview(fixture, "REJECT", ["original exact fix"]);
      await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(result.integration_amendment.attempts[1].worktree));
      const amendment = readRun(fixture).integration_amendment;
      const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(amendment), { claimDispatch: true, completionToken: "attempt-2-token", now: NOW });
      const priorPath = join(fixture.runDir, amendment.attempts[0].review_ref);
      const prior = readJson(priorPath);
      prior.required_fixes = ["changed after dispatch"];
      writeJson(priorPath, prior);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(amendment), claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "attempt-2-token", output: JSON.stringify(reviewFromContext(context, "APPROVE", [])),
      }, { now: NOW }), /prior|review|authority|hash is stale/u);
      assert.equal(existsSync(join(fixture.runDir, context.review_ref)), false);
    } finally { cleanup(fixture); }
  });

  it("enforces sole all-slice ownership for exact and recursive lanes", async () => {
    const exact = createFixture({ ownerPaths: ["src/owner/api.js"] });
    try {
      await transitionIntegrationAmendment(exact.runDir, reportRequest(), { repoRoot: exact.repo, now: NOW });
      const built = await transitionIntegrationAmendment(exact.runDir, { action: "build", attempt: 1 }, { repoRoot: exact.repo, now: NOW });
      bindAmendmentDispatch(exact, commitCandidate(built.integration_amendment.attempts[0].worktree));
      await publishAmendmentReview(exact, "APPROVE", []);
      const reviewed = await transitionIntegrationAmendment(exact.runDir, { action: "review" }, { repoRoot: exact.repo, now: NOW });
      assert.deepEqual(reviewed.integration_amendment.attempts[0].changed_paths, ["src/owner/api.js"]);
    } finally { cleanup(exact); }

    for (const [name, fixtureOptions, changedPath] of [
      ["direct-consumer", { consumerPaths: ["src/consumer/**", "src/owner/consumer.js"] }, "src/owner/consumer.js"],
      ["unrelated-sibling", { extraSlices: [{ id: "sibling", effective_paths: ["src/owner/sibling.js"] }] }, "src/owner/sibling.js"],
      ["recursive-overlap", { extraSlices: [{ id: "sibling", effective_paths: ["src/owner/nested/**"] }] }, "src/owner/nested/value.js"],
    ]) {
      const fixture = createFixture(fixtureOptions);
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        const candidate = commitCandidatePath(built.integration_amendment.attempts[0].worktree, changedPath, name);
        bindAmendmentDispatch(fixture, candidate);
        await assert.rejects(prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(readRun(fixture).integration_amendment), {
          claimDispatch: true, completionToken: `${name}-token`, now: NOW,
        }), /not solely owned by admitted owner/u, name);
      } finally { cleanup(fixture); }
    }
  });

  it("fences lifecycle effects after claim publication and for every nonmerged manifest", async () => {
    const claimed = createFixture({ publishReport: false });
    try {
      await assert.rejects(executeIntegrationAmendment(claimed.runDir, reportRequest(), executionOptions([{ code: 1 }], [], {
        integrationAmendmentExecutionHooks: {
          afterClaim: async () => startHeartbeat(RUN_ID, { phase: "amendment-race" }, { cwd: claimed.repo }),
        },
      })), /heartbeat start rejected: integration amendment authority is active-claim-only/u);
      assert.equal(readJson(join(claimed.runDir, "evidence", "integration-amendment.report.claim.json")).state, "active");
    } finally { cleanup(claimed); }

    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      await assert.rejects(resumeFactory(RUN_ID, { cwd: fixture.repo, dryRun: true }), /integration amendment authority is reported/u);
      await assert.rejects(cleanupRun(RUN_ID, { cwd: fixture.repo, force: true }), /cleanup rejected: integration amendment authority is reported/u);
      await assert.rejects(startHeartbeat(RUN_ID, { phase: "amendment" }, { cwd: fixture.repo }), /heartbeat start rejected: integration amendment authority is reported/u);
    } finally { cleanup(fixture); }
  });

  it("fences continuation construction, reservation/allocation/publication ingress, adoption, route replay, local resume, and provenance", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const beforeRefs = git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode/continuation-targets", "refs/opencode/continuations"]);
      for (const operation of [
        () => buildContinuation(RUN_ID, { cwd: fixture.repo, runId: "amendment-child", review: "reviews/owner.json" }),
        () => continueFactory(RUN_ID, { cwd: fixture.repo, runId: "amendment-child", review: "reviews/owner.json", carryForward: true }),
        () => inspectContinuationRouteSchema(fixture.repo, RUN_ID, 1, { route: "continuation" }),
        () => inspectContinuationRouteSchema(fixture.repo, RUN_ID, 1, { route: "resume", ordinaryResumeSchema: 1 }),
        () => transitionContinuationAdoption(fixture.runDir, { repoRoot: fixture.repo }),
        () => resumeFactory(RUN_ID, { cwd: fixture.repo, dryRun: true }),
        () => recordReviewDispatchProvenance(RUN_ID, { agent: "work-reviewer", subject: "amendment-review", attempt: 1, promptHash: sha("prompt"), promptBytes: 6 }, { cwd: fixture.repo }),
      ]) await assert.rejects(Promise.resolve().then(operation), /integration-amendment-continuation-unsupported|integration amendment (?:is|authority is) reported|run\.json writer rejected/u);
      assert.equal(git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode/continuation-targets", "refs/opencode/continuations"]), beforeRefs);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "amendment-child")), false);
    } finally { cleanup(fixture); }
  });

  it("rejects recovery before worktree or terminal mutation and permits only checked blocked terminalization", async () => {
    const recovery = createFixture();
    try {
      await transitionIntegrationAmendment(recovery.runDir, reportRequest(), { repoRoot: recovery.repo, now: NOW });
      let worktreeHook = false;
      let terminalHook = false;
      await assert.rejects(recoverDisruptedRun(RUN_ID, {
        cwd: recovery.repo,
        recoveryHooks: {
          beforeWorktreeAdd: () => { worktreeHook = true; },
          beforeTerminalWrite: () => { terminalHook = true; },
        },
      }), /recovery rejected: integration amendment authority is reported/u);
      assert.equal(worktreeHook, false);
      assert.equal(terminalHook, false);
    } finally { cleanup(recovery); }

    const blocked = createFixture();
    try {
      await transitionIntegrationAmendment(blocked.runDir, reportRequest(), { repoRoot: blocked.repo, now: NOW });
      await assert.rejects(transitionTerminalResult(blocked.runDir, { status: "blocked", reason: "unchecked" }), /integration amendment is reported/u);
      await transitionIntegrationAmendment(blocked.runDir, { action: "block", reason: "checked amendment stop" }, { repoRoot: blocked.repo, now: NOW });
      const terminal = await transitionTerminalResult(blocked.runDir, { status: "blocked", reason: "checked amendment stop" }, { now: NOW });
      assert.equal(terminal.run.status, "blocked");
      assert.equal(terminal.run.integration_amendment.status, "blocked");
    } finally { cleanup(blocked); }
  });

  it("rechecks merged amendment authority immediately before every forced cleanup deletion effect", async () => {
    for (const [name, hookName] of [
      ["worktree", "beforeWorktreeRemove"],
      ["branch", "beforeBranchDelete"],
      ["run-directory", "beforeRunDirectoryRemove"],
    ]) {
      const fixture = createFixture();
      try {
        const verified = await reachVerified(fixture);
        await transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
        let fired = false;
        await assert.rejects(cleanupRun(RUN_ID, {
          cwd: fixture.repo,
          force: true,
          now: NOW,
          cleanupHooks: {
            [hookName]: () => {
              if (fired) return;
              fired = true;
              writeJson(join(fixture.runDir, "run.json"), verified.run);
            },
          },
        }), /cleanup rejected: integration amendment authority is verified|integration amendment.*stale|persisted sibling owner reviewed branch\/worktree head is stale|does not resolve/u, name);
        assert.equal(fired, true, name);
        assert.equal(existsSync(fixture.runDir), true, name);
      } finally { cleanup(fixture); }
    }
  });

  it("previews merged amendment cleanup without deleting candidate worktrees, branches, or run authority", async () => {
    const fixture = createFixture();
    try {
      await reachMerged(fixture);
      const run = readRun(fixture);
      const targets = collectCleanupTargets(run);
      const runBytes = readFileSync(join(fixture.runDir, "run.json"));

      const preview = await cleanupRun(RUN_ID, {
        cwd: fixture.repo,
        force: true,
        dryRun: true,
        now: NOW,
      });

      assert.equal(preview.dry_run, true);
      assert.equal(preview.removed_run_dir, false);
      assert.equal(preview.removed_worktrees.length > 0, true, "preview reports removable worktrees");
      assert.equal(preview.deleted_branches.length > 0, true, "preview reports deletable branches");
      const ownerWorktree = targets.worktrees.find(({ branch }) => branch === "owner-build").worktree;
      assert.equal(preview.removed_worktrees.includes(realpathSync(ownerWorktree)), true);
      assert.equal(preview.deleted_branches.includes("owner-build"), true);
      assert.equal(existsSync(fixture.runDir), true);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), runBytes);
      for (const { branch, worktree } of targets.worktrees) {
        assert.equal(existsSync(worktree), true, worktree);
        assert.equal(git(fixture.repo, ["show-ref", "--verify", `refs/heads/${branch}`]).trim().length > 0, true, branch);
      }
    } finally { cleanup(fixture); }
  });

  it("fences heartbeat stop/tick/publication and generic semantic-writer commit races", async () => {
    const heartbeat = createFixture({ publishReport: false });
    try {
      addPristineTestVerifier(heartbeat);
      await startHeartbeat(RUN_ID, { phase: "amendment-fixture", intervalMs: 1000 }, { cwd: heartbeat.repo, now: NOW });
      await stopHeartbeat(RUN_ID, {}, { cwd: heartbeat.repo, now: NOW });
      await executeIntegrationAmendment(heartbeat.runDir, reportRequest(), executionOptions([{ code: 1 }], []));
      await assert.rejects(stopHeartbeat(RUN_ID, {}, { cwd: heartbeat.repo, now: NOW }), /heartbeat stop rejected: integration amendment authority is reported/u);
      await assert.rejects(heartbeatOnce(heartbeat.runDir, { now: NOW }), /integration amendment is reported|run\.json writer rejected/u);
    } finally { cleanup(heartbeat); }

    const publication = createFixture({ publishReport: false });
    try {
      addPristineTestVerifier(publication);
      await executeIntegrationAmendment(publication.runDir, reportRequest(), executionOptions([{ code: 0 }], []));
      await assert.rejects(startHeartbeat(RUN_ID, { phase: "publication-race", intervalMs: 1000 }, {
        cwd: publication.repo,
        now: NOW,
        heartbeatAtomicWriteHooks: { beforeSidecarCommit: () => makeReportClaimActive(publication) },
      }), /heartbeat publication rejected: integration amendment authority is active-claim-only/u);
      assert.equal(existsSync(join(publication.runDir, "heartbeat.json")), false);
    } finally { cleanup(publication); }

    const writer = createFixture({ publishReport: false });
    try {
      await executeIntegrationAmendment(writer.runDir, reportRequest(), executionOptions([{ code: 0 }], []));
      await assert.rejects(transitionRunJson(writer.runDir, (run) => { run.review_tier = "race"; }, {
        atomicWriteHooks: { beforeCommit: () => makeReportClaimActive(writer) },
      }), (error) => /integration amendment authority changed before protected run\.json replacement|active-claim-only/u.test(error?.cause?.message || error?.message));
      assert.equal(readRun(writer).review_tier, undefined);
    } finally { cleanup(writer); }
  });

  it("derives amendment worktrees from the repository root for a managed feature worktree", async () => {
    const fixture = createFixture({ managedFeatureWorktree: true });
    try {
      const verified = await reachVerified(fixture);
      const attempt = verified.integration_amendment.attempts[0];
      assert.equal(attempt.worktree, join(fixture.repo, ".opencode", "worktrees", `${FEATURE_BRANCH}--amend-${fixture.amendmentId}-a1`));
      assert.equal(verified.integration_amendment.integration.worktree, join(fixture.repo, ".opencode", "worktrees", `${FEATURE_BRANCH}--amend-${fixture.amendmentId}-staged`));
      const merged = await transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(merged.integration_amendment.status, "merged");
      assert.equal(git(fixture.featureWorktree, ["status", "--porcelain"]).trim(), "");
    } finally { cleanup(fixture); }
  });

  it("classifies the fixed pre-manifest tombstone and fails closed on orphans", () => {
    const fixture = createFixture();
    try {
      const inventory = inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture));
      assert.equal(inventory.classification, "completed-nonzero-receipt-no-manifest");
      rmSync(join(fixture.runDir, "evidence", "integration-amendment.report.claim.json"));
      assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /orphan/u);
    } finally { cleanup(fixture); }
  });

  it("rejects stale plan, owner, baseline, sidecar, and attempt Git authority", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const planBytes = readFileSync(planPath);
      const plan = JSON.parse(planBytes);
      plan.slices[0].acceptance.push("drift");
      writeJson(planPath, plan);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /plan|decomposition|stale|changed/u);
      writeFileSync(planPath, planBytes);

      const runPath = join(fixture.runDir, "run.json");
      const runBytes = readFileSync(runPath);
      const run = JSON.parse(runBytes);
      run.slices[0].merge_commit = fixture.base;
      writeJson(runPath, run);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /owner|merge|stale|authority/u);
      writeFileSync(runPath, runBytes);

      git(fixture.repo, ["commit", "--allow-empty", "-m", "baseline drift"]);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /baseline|authority|stale/u);
      git(fixture.repo, ["reset", "--hard", fixture.baseline]);

      const receiptPath = join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.report.receipt.json`);
      const receiptBytes = readFileSync(receiptPath);
      const receipt = JSON.parse(receiptBytes);
      receipt.duration_ms += 1;
      writeJson(receiptPath, receipt);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /receipt|hash|stale/u);
      writeFileSync(receiptPath, receiptBytes);

      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo });
      git(fixture.repo, ["update-ref", built.integration_amendment.attempts[0].branch_ref, fixture.reviewedCommit]);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /branch\/worktree authority is stale|head-mismatch/u);
    } finally { cleanup(fixture); }
  });

  it("rechecks amendment authority after an awaited pre-commit hook", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const receiptPath = join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.report.receipt.json`);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, {
        repoRoot: fixture.repo,
        now: NOW,
        atomicWriteHooks: {
          beforeCommit: async () => {
            await Promise.resolve();
            const receipt = readJson(receiptPath);
            receipt.duration_ms += 1;
            writeJson(receiptPath, receipt);
          },
        },
      }), (error) => /receipt hash is stale|authority changed/u.test(error?.cause?.message || error?.message));
      assert.equal(readRun(fixture).integration_amendment.status, "reported");
    } finally { cleanup(fixture); }
  });

  it("rejects premature publication and foreign feature worktree identities", async () => {
    const premature = createFixture();
    try {
      const integrated = await reachIntegrated(premature);
      git(premature.repo, ["update-ref", `refs/heads/${FEATURE_BRANCH}`, integrated.integration_amendment.integration.commit, premature.baseline]);
      await assert.rejects(transitionIntegrationAmendment(premature.runDir, { action: "verify" }, { repoRoot: premature.repo }), /feature ref is stale|recoverable publication authority|clean integration worktree/u);
    } finally { cleanup(premature); }

    for (const mode of ["detached", "wrong-branch"]) {
      const fixture = createFixture();
      try {
        await reachVerified(fixture);
        if (mode === "detached") git(fixture.repo, ["checkout", "--detach", fixture.baseline]);
        else git(fixture.repo, ["checkout", "-b", "foreign-feature", fixture.baseline]);
        assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, false);
        await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo }), /outside the three recoverable publication cases|stale or dirty|feature worktree identity is stale/u);
      } finally { cleanup(fixture); }
    }

    const merged = createFixture();
    try {
      const verified = await reachVerified(merged);
      await transitionIntegrationAmendment(merged.runDir, { action: "merge" }, { repoRoot: merged.repo, now: NOW });
      git(merged.repo, ["checkout", "--detach", verified.integration_amendment.integration.commit]);
      assert.equal(checkRunConsistency(merged.runDir, readRun(merged)).ok, false);
    } finally { cleanup(merged); }
  });

  it("rejects report and verification execution cross-binding", async () => {
    const report = createFixture();
    try {
      const claimPath = join(report.runDir, "evidence", "integration-amendment.report.claim.json");
      const claim = readJson(claimPath);
      claim.run_id = "another-run";
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(report.runDir, readRun(report)), /another run or baseline|same run and probe/u);
    } finally { cleanup(report); }

    const verifyIdentity = createFixture();
    try {
      await reachIntegrated(verifyIdentity);
      writeVerification(verifyIdentity);
      const claimPath = join(verifyIdentity.runDir, "evidence", `integration-amendment-${verifyIdentity.amendmentId}.verify.claim.json`);
      const claim = readJson(claimPath);
      claim.identity.defect_path = "src/owner/other.js";
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(verifyIdentity.runDir, readRun(verifyIdentity)), /identity is stale or cross-bound/u);
    } finally { cleanup(verifyIdentity); }

    const unknown = createFixture();
    try {
      await reachIntegrated(unknown);
      writeVerification(unknown);
      const claimPath = join(unknown.runDir, "evidence", `integration-amendment-${unknown.amendmentId}.verify.claim.json`);
      const claim = readJson(claimPath);
      claim.state = "unknown";
      delete claim.completed_at;
      delete claim.status;
      claim.failed_at = NOW;
      claim.reason = "receipt-publication-indeterminate";
      claim.receipt_status = "fail";
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(unknown.runDir, readRun(unknown)), /unknown integration amendment verification receipt binding is stale/u);
    } finally { cleanup(unknown); }
  });

  it("rejects every report baseline binding mismatch and coherent foreign-run identity", () => {
    for (const field of ["head_sha", "tree_sha", "cwd"]) {
      const fixture = createFixture();
      try {
        rewriteExecutionBinding(fixture, field, field === "cwd" ? "/tmp/foreign-amendment-worktree" : fixture.base);
        assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /another run or baseline/u, field);
      } finally { cleanup(fixture); }
    }

    const foreign = createFixture();
    try {
      rewriteReportAsForeignRun(foreign);
      assert.throws(() => inspectIntegrationAmendmentInventory(foreign.runDir, readRun(foreign)), /another run or baseline/u);
    } finally { cleanup(foreign); }
  });

  it("rejects unknown verification receipt hash drift", async () => {
    const fixture = createFixture();
    try {
      await reachIntegrated(fixture);
      writeVerification(fixture);
      const claimPath = join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.verify.claim.json`);
      const claim = readJson(claimPath);
      claim.state = "unknown";
      delete claim.completed_at;
      delete claim.status;
      claim.failed_at = NOW;
      claim.reason = "receipt-publication-indeterminate";
      claim.receipt_status = "pass";
      claim.receipt_hash = sha("wrong-receipt-bytes");
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /unknown integration amendment verification receipt binding is stale/u);
    } finally { cleanup(fixture); }
  });

  it("retains an all-preserved REJECT across attempt 2 and blocks terminally", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      let result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      let candidate = commitCandidate(result.integration_amendment.attempts.at(-1).worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "REJECT", ["tighten the integration behavior"]);
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(result.integration_amendment.attempts[0].state, "reviewed");

      result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo, now: NOW });
      candidate = commitCandidate(result.integration_amendment.attempts.at(-1).worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "REJECT", ["still not isolated"]);
      await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      const blocked = await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "attempt budget exhausted" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(blocked.integration_amendment.status, "blocked");
      assert.equal(blocked.integration_amendment.blocked.origin, "reviewed-reject");
      await assert.rejects(transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 1 }), /integration amendment is blocked/u);
    } finally { cleanup(fixture); }
  });

  it("binds distinct REJECT and APPROVE review authority across attempt 2", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      let result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      let candidate = commitCandidate(result.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "REJECT", ["tighten the integration behavior"]);
      await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo, now: NOW });
      candidate = commitCandidate(result.integration_amendment.attempts.at(-1).worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "APPROVE", []);
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(result.integration_amendment.attempts.length, 2);
      assert.equal(checkRunConsistency(fixture.runDir, result.run).ok, true);
      const blocked = await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "operator stop after approval" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(blocked.integration_amendment.blocked.origin, "reviewed-approve");
      assert.equal(checkRunConsistency(fixture.runDir, blocked.run).ok, true);
    } finally { cleanup(fixture); }
  });

  it("rejects blocked integrated and verified origins bound to a REJECT review", async () => {
    for (const origin of ["integrated", "verified"]) {
      const fixture = createFixture();
      try {
        if (origin === "integrated") await reachIntegrated(fixture);
        else await reachVerified(fixture);
        const run = readRun(fixture);
        const attempt = run.integration_amendment.attempts.at(-1);
        const reviewPath = join(fixture.runDir, attempt.review_ref);
        const review = readJson(reviewPath);
        review.verdict = "REJECT";
        review.required_fixes = ["still rejected"];
        writeJson(reviewPath, review);
        attempt.review_hash = hashFile(reviewPath);
        run.integration_amendment.status = "blocked";
        run.integration_amendment.blocked = { origin, reason: "stopped", blocked_at: NOW };
        writeJson(join(fixture.runDir, "run.json"), run);
        const consistency = checkRunConsistency(fixture.runDir, run);
        assert.equal(consistency.ok, false);
        assert.match(JSON.stringify(consistency.checks), /requires an exact APPROVE review|reviewer publication hash is stale|review_hash is stale or cross-bound/u);
      } finally { cleanup(fixture); }
    }
  });

  it("rejects caller authority fields without entering fallback routing", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { ...reportRequest(), commit: fixture.baseline }), /does not accept caller authority field/u);
      assert.equal(readRun(fixture).integration_amendment, undefined);
    } finally { cleanup(fixture); }
  });

  it("fences gate, panel, PR, and post-PR production entries before effects for unresolved and blocked amendments", async () => {
    for (const status of ["reported", "blocked"]) {
      const consumers = [
        ["gate boundary", (fixture) => transitionSteeringBoundaryOpened(fixture.runDir, "gate")],
        ["gate decision", (fixture) => transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" })],
        ...downstreamProductionConsumers(),
      ];
      for (const [name, invoke] of consumers) {
        const fixture = createFixture();
        try {
          await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
          if (status === "blocked") await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "checked blocked fixture" }, { repoRoot: fixture.repo, now: NOW });
          const before = snapshotAmendmentGateAuthority(fixture);
          await assert.rejects(invoke(fixture), /integration amendment is (?:reported|blocked)|writer rejected/u, `${status}:${name}`);
          assert.deepEqual(snapshotAmendmentGateAuthority(fixture), before, `${status}:${name}: protected gate authority`);
        } finally { cleanup(fixture); }
      }
    }
  });

  it("revalidates merged amendment sidecar and Git authority at gate, panel, PR, and post-PR consumers", async () => {
    for (const drift of ["sidecar", "git"]) {
      for (const [name, invoke] of downstreamProductionConsumers({ includeGate: true })) {
        const fixture = createFixture();
        try {
          await reachMerged(fixture);
          if (name === "PR") installCurrentPrFence(fixture);
          if (drift === "sidecar") {
            const receiptPath = join(fixture.runDir, readRun(fixture).integration_amendment.failure_execution.receipt_ref);
            const receipt = readJson(receiptPath);
            receipt.duration_ms += 1;
            writeJson(receiptPath, receipt);
          } else {
            git(fixture.featureWorktree, ["commit", "--allow-empty", "-m", `stale Git authority before ${name}`]);
          }
          const before = readFileSync(join(fixture.runDir, "run.json"));
          await assert.rejects(invoke(fixture), /integration amendment|receipt|authority|feature ref|worktree|stale/u, `${drift}:${name}`);
          assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before, `${drift}:${name}: protected run bytes`);
        } finally { cleanup(fixture); }
      }
    }
  });

});

function installCurrentPrFence(fixture) {
  const run = readRun(fixture);
  const head = git(fixture.featureWorktree, ["rev-parse", "HEAD"]).trim();
  run.steering = {
    schema_version: 1,
    generation: 0,
    pending: null,
    uncheckpointed: null,
    boundary: null,
    action_claim: null,
    last_action: null,
    pr_fence: {
      token: "current-pr-fence",
      generation: 0,
      state_hash: sha("current-pr-fence-state"),
      created_at: NOW,
      operation_id: `ffpr-v1-${"a".repeat(64)}`,
      repository: "acme/repo",
      head_ref: run.branch,
      head_sha: head,
      base_ref: "main",
      base_sha: fixture.base,
      draft: false,
    },
    history: [],
  };
  writeJson(join(fixture.runDir, "run.json"), run);
}
