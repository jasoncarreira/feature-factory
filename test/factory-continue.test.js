import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "./helpers/git-fixture.js";
import { createReviewRecord } from "./helpers/review-record-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { assertContinuationBindingsCurrent, buildContinuation, continueFactory as continueFactoryImpl, persistFactoryRunResumeEnv, recoverDisruptedRun, resumeFactory as resumeFactoryImpl, startFactory as startFactoryImpl } from "../src/factory.js";
import { validateRun } from "../src/validate.js";
import { CARRY_FORWARD_REQUIRED_SUMMARY, assertPublishedCarryForwardRun, completeSliceBuilderTaskDispatch, transitionIntegrationAmendment, transitionTerminalResult, completeSpecialBuilderTaskDispatch, prepareSliceBuilderTaskDispatch, prepareSpecialBuilderTaskDispatch, transitionPanelVerdicts, transitionPrePrFenceEstablished, transitionPrCreated, transitionRunSlice, transitionSliceMerged } from "../src/run-state.js";
import { ISSUE128_BASELINE_ROUTE_INVENTORY, ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG, emitIssue128FinishAndDiscloseMutations } from "./helpers/durable-record-mutations.js";
import { decodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { executeCheckedTestExecution } from "../src/test-execution.js";
import { RuntimeAdmissionError } from "../src/runtime-identity.js";
import { deliveryEnvelopeForSlices, passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";
import { publishAmendmentReportFor, writeOwnerDispatch } from "./helpers/integration-amendment/fixture.js";
import { withTestRuntimeAdmission } from "./helpers/runtime-admission.js";

const continueFactory = (runId, options) => continueFactoryImpl(runId, withTestRuntimeAdmission(options));
const resumeFactory = (runId, options) => resumeFactoryImpl(runId, withTestRuntimeAdmission(options));
const startFactory = (args, options) => startFactoryImpl(args, withTestRuntimeAdmission(options));

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const currentTestPath = fileURLToPath(import.meta.url);
const issue128WorkerEnv = "OPENCODE_ISSUE128_CONTINUATION_WORKER";
const issue128WorkerChunkEnv = "OPENCODE_ISSUE128_CONTINUATION_CHUNK";
const issue128WorkerChunkCount = 2;
const issue128WorkerTests = Object.freeze({
  "ordinary-continuation": "preserves an ordinary merged A2/S2 row only with its same-binding merged owner",
  "checkpoint-continuation": "preserves a checkpoint-bound merged A2/S2 owner pair and rejects owner drift before publication",
});
const issue128WorkerRecords = Object.freeze({
  "ordinary-continuation": "continuation-carry-forward-accepted-slice-v2",
  "checkpoint-continuation": "checkpoint-carry-forward-accepted-slice-v2",
});
const issue128WorkerRoute = process.env[issue128WorkerEnv] || null;
if (issue128WorkerRoute !== null && !Object.hasOwn(issue128WorkerTests, issue128WorkerRoute)) {
  throw new Error(`unsupported ${issue128WorkerEnv} route '${issue128WorkerRoute}'`);
}
const issue128WorkerChunkText = process.env[issue128WorkerChunkEnv];
if (issue128WorkerRoute === null && issue128WorkerChunkText !== undefined) {
  throw new Error(`${issue128WorkerChunkEnv} requires ${issue128WorkerEnv}`);
}
if (issue128WorkerRoute !== null && !/^(0|[1-9]\d*)$/u.test(issue128WorkerChunkText || "")) {
  throw new Error(`${issue128WorkerChunkEnv} must be an integer chunk index`);
}
const issue128WorkerChunk = issue128WorkerRoute === null ? null : Number(issue128WorkerChunkText);
if (issue128WorkerChunk !== null && issue128WorkerChunk >= issue128WorkerChunkCount) {
  throw new Error(`${issue128WorkerChunkEnv} must be less than ${issue128WorkerChunkCount}`);
}

describe("factory continue schema-v2 carry-forward", { concurrency: 2 }, () => {
  // Overlap the isolated matrices with independent fixture tests instead of extending the file's serial tail.
  if (issue128WorkerRoute === null) it("runs ordinary and checkpoint continuation mutation workers concurrently", async () => {
    const workers = Object.entries(issue128WorkerTests).flatMap(([route, testName]) =>
      Array.from({ length: issue128WorkerChunkCount }, (_, chunk) => runIssue128ContinuationWorker(route, testName, chunk)));
    const results = await Promise.all(workers);
    for (const result of results) {
      const diagnostics = issue128WorkerDiagnostics(result);
      assert.equal(result.error, null, diagnostics);
      assert.equal(result.signal, null, diagnostics);
      assert.equal(result.code, 0, diagnostics);
      result.completion = parseIssue128WorkerCompletion(result.stdout, diagnostics);
      assert.equal(result.completion.route, result.route, diagnostics);
      assert.equal(result.completion.chunk, result.chunk, diagnostics);
      assert.equal(result.completion.chunk_count, issue128WorkerChunkCount, diagnostics);
      assert.deepEqual(result.completion.baseline_ids, result.chunk === 0 ? issue128BaselineIdsForRoute(result.route) : [], diagnostics);
      assert.equal(result.completion.executed, result.completion.mutation_names.length, diagnostics);
      assert.equal(result.completion.mutation_digest, issue128MutationNameDigest(result.completion.mutation_names), diagnostics);
    }
    for (const route of Object.keys(issue128WorkerTests)) {
      const routeCompletions = results.filter((result) => result.route === route).map(({ completion }) => completion);
      assert.deepEqual(routeCompletions.map(({ chunk }) => chunk).sort((a, b) => a - b), [0, 1], `${route}: exact worker chunks`);
      assert.equal(routeCompletions.reduce((sum, { executed }) => sum + executed, 0), 178, `${route}: exact executed mutation count`);
      const expectedNames = issue128MutationNamesForRoute(route);
      assert.equal(expectedNames.length, 178, `${route}: exact emitted mutation count`);
      const observedNames = routeCompletions.flatMap(({ mutation_names: names }) => names);
      assert.equal(new Set(observedNames).size, observedNames.length, `${route}: no duplicate mutation names across chunks`);
      assert.deepEqual([...observedNames].sort(), [...expectedNames].sort(), `${route}: no missing or unexpected mutation names`);
      const observedByName = new Set(observedNames);
      assert.equal(issue128MutationNameDigest(expectedNames.filter((name) => observedByName.has(name))), issue128MutationNameDigest(expectedNames), `${route}: exact emitter-order mutation digest`);
    }
    const expectedBaselineIds = Object.keys(issue128WorkerTests).flatMap(issue128BaselineIdsForRoute);
    const observedBaselineIds = results.flatMap(({ completion }) => completion.baseline_ids);
    assert.equal(new Set(observedBaselineIds).size, observedBaselineIds.length, "no duplicate continuation baseline IDs across chunks or routes");
    assert.deepEqual([...observedBaselineIds].sort(), [...expectedBaselineIds].sort(), "no missing or unexpected continuation baseline IDs");
  });

  it("rejects every non-v2 continuation selector before reservation or child effects", () => {
    const fixture = createV2Fixture("carry-current-route-only", { accepted: ["A"], mergeOrder: ["A"] });
    const targetRunId = "carry-current-route-only-next";
    try {
      for (const invoke of [
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: targetRunId }),
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: targetRunId, dryRun: true }),
      ]) assert.throws(invoke, /requires --carry-forward/u);

      const cli = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", targetRunId, "--dry-run", "--json"]);
      assert.equal(cli.status, 1);
      assert.equal(cli.stdout, "");
      assert.equal(cli.stderr, "error: factory continue requires --carry-forward\n");
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuation-targets"]), "");
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(refOid(fixture.repo, `refs/heads/${targetRunId}`), null);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", targetRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", targetRunId)), false);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects v1 and incomplete continuation payloads before route authority lookup", () => {
    const fixture = createV2Fixture("carry-payload-current-only", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const continuation = buildContinuation(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: "carry-payload-current-only-next",
        carryForward: true,
      });
      const envelope = (value) => `ffpayload-v1:${Buffer.from(JSON.stringify({
        operator_request: `Continue blocked feature-factory run '${fixture.runId}' as '${value.target.run_id}' using review '${value.review.ref}'.`,
        driver: { mode: "interactive", pr_mode: "ready", post_pr_ci: { enabled: false } },
        continuation: value,
      })).toString("base64url")}`;
      const cases = [
        ["v1", (value) => { value.schema_version = 1; }, "invalid-continuation-schema"],
        ["missing carry-forward", (value) => { delete value.carry_forward; }, "invalid-continuation-carry-forward"],
        ["missing configuration", (value) => { delete value.configuration; }, "invalid-continuation-schema"],
        ["retired post-PR", (value) => { value.post_pr = {}; }, "invalid-continuation"],
      ];
      assert.equal(cases.length, 4);
      for (const [label, mutate, reason] of cases) {
        const value = structuredClone(continuation);
        mutate(value);
        assert.deepEqual(decodeFeatureCommandPayload(envelope(value), { repo: fixture.repo }), { ok: false, reason }, label);
      }
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuation-targets"]), "");
    } finally { cleanup(fixture.repo); }
  });

  it("builds and rechecks one canonical v2 carry-forward in PLAN order without allocating resources", () => {
    const fixture = createV2Fixture("carry-interleaved", { accepted: ["A", "C"], mergeOrder: ["C", "A"] });
    try {
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-interleaved-next", carryForward: true, dryRun: true });
      const carry = result.candidate.carry_forward;
      assert.equal(result.status, "dry-run");
      assert.equal(result.launchable, false);
      assert.equal(result.payload, undefined);
      assert.equal(result.candidate.schema_version, 2);
      assert.deepEqual(carry, {
        scope: "full-remaining-plan",
        plan_ref: "plan/slices.json",
        plan_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
        start_commit: fixture.mergeCommits.A,
        accepted_slices: [acceptedManifestRow(fixture, "A"), acceptedManifestRow(fixture, "C")],
        remaining_slice_ids: ["B"],
      });
      assert.deepEqual(JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json"), "utf8")).integration_gate.required_commands, [
        { program: "npm", args: ["run", "check"] },
      ]);
      assert.deepEqual(fixture.actualMergeOrder, [fixture.mergeCommits.C, fixture.mergeCommits.A]);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-interleaved-next")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", "carry-interleaved-next")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/carry-interleaved-next"], { cwd: fixture.repo }).status, 0);
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      const cli = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "carry-interleaved-cli", "--carry-forward", "--dry-run", "--json"]);
      assert.equal(cli.status, 0, cli.stderr);
      const cliResult = JSON.parse(cli.stdout);
      assert.equal(cliResult.candidate.schema_version, 2);
      assert.equal(cliResult.launchable, false);
      assert.deepEqual(cliResult.candidate.configuration, {
        mode: "interactive", github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3,
        post_pr_policy: continuationEligibilityPostPr("disabled", 0).policy,
      });
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-interleaved-cli")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("carries a conflict-merged slice with exact proof sidecars and rejects every tamper", async () => {
    const fixture = await createConflictCarryForwardFixture("carry-conflict-proof");
    const childRunId = "carry-conflict-proof-next";
    try {
      const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true });
      const accepted = candidate.carry_forward.accepted_slices[0];
      assert.deepEqual(accepted.integration_conflict, fixture.conflict);

      for (const [label, mutate, expected] of [
        ["claim bytes", () => writeFileSync(join(fixture.runDir, fixture.conflict.claim_ref), "{}\n"), /special builder|conflict.*claim|dispatch.*claim|hash.*stale/u],
        ["closure bytes", () => writeFileSync(join(fixture.runDir, fixture.conflict.closure_ref), "{}\n"), /special builder|conflict.*closure|dispatch.*closure|hash.*stale/u],
        ["proof bytes", () => updateRun(fixture, (run) => { run.slices[0].integration_conflict.integration_proof.integrated_tree = "f".repeat(40); }), /integrated bytes changed|conflict.*proof/u],
      ]) {
        const claimBytes = readFileSync(join(fixture.runDir, fixture.conflict.claim_ref));
        const closureBytes = readFileSync(join(fixture.runDir, fixture.conflict.closure_ref));
        const runBytes = readFileSync(join(fixture.runDir, "run.json"));
        mutate();
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: `${childRunId}-${label.replaceAll(" ", "-")}`, carryForward: true }),
          expected,
          label,
        );
        writeFileSync(join(fixture.runDir, fixture.conflict.claim_ref), claimBytes);
        writeFileSync(join(fixture.runDir, fixture.conflict.closure_ref), closureBytes);
        writeFileSync(join(fixture.runDir, "run.json"), runBytes);
      }

      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
      });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
      assert.deepEqual(child.slices[0].integration_conflict, fixture.conflict);
      for (const ref of [fixture.conflict.claim_ref, fixture.conflict.closure_ref]) {
        assert.deepEqual(readFileSync(join(childRunDir, ref)), readFileSync(join(fixture.runDir, ref)), ref);
      }
      assert.equal(result.payload.continuation.carry_forward.accepted_slices[0].integration_conflict.resolution_commit, fixture.conflict.resolution_commit);
    } finally {
      cleanup(fixture.repo);
    }
  });

  for (const detached of [false, true]) it(`fails carry-forward ${detached ? "detached" : "foreground"} runtime admission before invoking its launch seam`, async () => {
    const fixture = createV2Fixture(`carry-runtime-admission-${detached ? "detached" : "foreground"}`, { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = `${fixture.runId}-next`;
    const remediation = "runtime admission failed: accepted package CLI source=[redacted]; remediation: run npm with exact argv [\"install\",\"--global\",\"--\",\"[redacted]\"]";
    let launches = 0;
    try {
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        detached,
        headless: detached,
        runtimeAdmissionFn: () => { throw new RuntimeAdmissionError(remediation); },
        foregroundLaunchFn: async () => { launches += 1; },
        detachedLaunchFn: async () => { launches += 1; },
      }), (error) => error.message === remediation);
      assert.equal(launches, 0);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects a legacy plan without integration_gate at v2 carry-forward construction", () => {
    const fixture = createV2Fixture("carry-legacy-plan", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      delete plan.integration_gate;
      writeJson(planPath, plan);

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-legacy-plan-next", carryForward: true, dryRun: true }),
        /plan\.integration_gate: is required/u,
      );
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-legacy-plan-next")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires current accepted work-decomposer plan and review authority for v2 construction", () => {
    const fixture = createV2Fixture("carry-unaccepted-decomposition", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const runPath = join(fixture.runDir, "run.json");
      const run = JSON.parse(readFileSync(runPath, "utf8"));
      run.steps = run.steps.filter((step) => step.agent !== "work-decomposer");
      writeJson(runPath, run);
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-unaccepted-decomposition-next", carryForward: true, dryRun: true }),
        /accepted work-decomposer plan authority/u,
      );
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-unaccepted-decomposition-next")), false);
    } finally {
      cleanup(fixture.repo);
    }

    const cases = [
      ["plan-ref", (fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").artifact_ref = "artifacts/plan.json"; }],
      ["plan-hash", (fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = `sha256:${"0".repeat(64)}`; }],
      ["plan-bytes", (fixture) => {
        const path = join(fixture.runDir, "plan", "slices.json");
        const plan = JSON.parse(readFileSync(path, "utf8"));
        plan.slices[0].acceptance = ["substituted acceptance"];
        writeJson(path, plan);
      }],
      ["review-ref", (_fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").acceptance.review_ref = "reviews/other.json"; }],
      ["review-hash", (_fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").acceptance.review_hash = `sha256:${"1".repeat(64)}`; }],
      ["review-bytes", (fixture) => writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "REJECT" })],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`carry-decomposition-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        const runPath = join(fixture.runDir, "run.json");
        const run = JSON.parse(readFileSync(runPath, "utf8"));
        mutate(fixture, run);
        writeJson(runPath, run);
        assert.throws(
          () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true, dryRun: true }),
          /accepted work-decomposer plan authority|bound plan|work-decomposer review|acceptance/u,
          label,
        );
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", `${fixture.runId}-next`)), false, label);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("accepts zero merged slices only when start_commit equals the recorded base", () => {
    const fixture = createV2Fixture("carry-zero", { accepted: [], mergeOrder: [] });
    try {
      const continuation = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-zero-next", carryForward: true });
      assert.equal(continuation.carry_forward.start_commit, fixture.baseCommit);
      assert.deepEqual(continuation.carry_forward.accepted_slices, []);
      assert.deepEqual(continuation.carry_forward.remaining_slice_ids, ["A", "B", "C"]);

      runGit(fixture.repo, ["commit", "--allow-empty", "-m", "unrecorded parent commit"]);
      updateRun(fixture, (run) => { run.updated_at = "2026-07-08T12:02:00.000Z"; });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-zero-drift", carryForward: true }),
        /zero accepted slices requires start_commit equal target\.base_commit/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("privately rejects every v2 closed-shape and partition forgery", () => {
    const cases = [
      ["outer unknown", (value) => { value.carry_forward.extra = true; }],
      ["accepted unknown", (value) => { value.carry_forward.accepted_slices[0].status = "merged"; }],
      ["missing plan hash", (value) => { delete value.carry_forward.plan_hash; }],
      ["duplicate accepted", (value) => { value.carry_forward.accepted_slices.push(structuredClone(value.carry_forward.accepted_slices[0])); }],
      ["duplicate remaining", (value) => { value.carry_forward.remaining_slice_ids.push("B"); }],
      ["partition overlap", (value) => { value.carry_forward.remaining_slice_ids = ["A"]; }],
      ["partition omission", (value) => { value.carry_forward.remaining_slice_ids = ["B"]; }],
      ["partition unknown", (value) => { value.carry_forward.remaining_slice_ids = ["B", "unknown"]; }],
      ["empty remaining", (value) => { value.carry_forward.remaining_slice_ids = []; }],
      ["wrong plan ref", (value) => { value.carry_forward.plan_ref = "plan/other.json"; }],
      ["start mismatch", (value) => { value.carry_forward.start_commit = "d".repeat(40); }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`private-shape-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true });
        mutate(candidate);
        assert.throws(
          () => assertContinuationBindingsCurrent(fixture.repo, fixture.runDir, candidate),
          /carry_forward|partition|closed shape|candidate/u,
          label,
        );
      } finally { cleanup(fixture.repo); }
    }
  });

  it("fails closed on missing/mutable sidecars, partial successor tuples, non-APPROVE, and plan drift", () => {
    const cases = [
      ["missing evidence", (fixture) => rmSync(join(fixture.runDir, "evidence", "A.json")), /missing (?:parent )?evidence ref/u],
      ["mutable review", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "A.json"), "{}\n"), /hashes are stale|subject must match/u],
      ["partial successor", (fixture) => updateRun(fixture, (run) => { delete run.slices[0].review_hash; }), /require complete evidence_hash, review_hash, and reviewed_commit bindings/u],
      ["non approve", (fixture) => {
        const reviewPath = join(fixture.runDir, "reviews", "A.json");
        const review = JSON.parse(readFileSync(reviewPath, "utf8"));
        review.verdict = "REJECT";
        review.convergence = "converging";
        review.remaining_fix_count = 1;
        review.required_fixes = ["reject accepted slice"];
        review.remediation_context = { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["A.txt"], fix_owner: "A" }] };
        writeJson(reviewPath, review);
        updateRun(fixture, (run) => {
          run.slices[0].review_hash = hashFile(reviewPath);
          run.slices[0].attempt_reviews[0].review_hash = run.slices[0].review_hash;
          run.slices[0].attempt_reviews[0].verdict = "REJECT";
          run.slices[0].attempt_reviews[0].remaining_fix_count = 1;
        });
      }, /requires APPROVE review/u],
      ["plan drift", (fixture) => {
        const planPath = join(fixture.runDir, "plan", "slices.json");
        const plan = JSON.parse(readFileSync(planPath, "utf8"));
        plan.slices.splice(1, 1);
        plan.delivery_envelope = deliveryEnvelopeForSlices(plan.slices);
        writeJson(planPath, plan);
      }, /exactly classify the bound plan/u],
    ];
    for (const [label, mutate, expected] of cases) {
      const fixture = createV2Fixture(`carry-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        mutate(fixture);
        assert.throws(() => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }), expected, label);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("rejects non-ancestor, extra, missing, and malformed first-parent merge authority", () => {
    const cases = [
      ["non ancestor", (fixture) => {
        runGit(fixture.repo, ["checkout", "--orphan", "orphan-base"]);
        runGit(fixture.repo, ["rm", "-rf", "."]);
        writeFileSync(join(fixture.repo, "orphan.txt"), "orphan\n");
        runGit(fixture.repo, ["add", "orphan.txt"]);
        runGit(fixture.repo, ["commit", "-m", "orphan"]);
        const orphan = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
        runGit(fixture.repo, ["checkout", fixture.runId]);
        updateRun(fixture, (run) => { run.base_commit = orphan; });
      }, /not an ancestor|must descend from target\.base_commit/u],
      ["extra", (fixture) => { runGit(fixture.repo, ["commit", "--allow-empty", "-m", "extra"]); }, /all and only accepted merge commits/u],
      ["missing", (fixture) => updateRun(fixture, (run) => { run.slices[0].merge_commit = fixture.baseCommit; }), /all and only accepted merge commits|unique full commits/u],
      ["malformed", (fixture) => updateRun(fixture, (run) => {
        const reviewPath = join(fixture.runDir, "reviews", "A.json");
        const review = JSON.parse(readFileSync(reviewPath, "utf8"));
        review.reviewed_commit = fixture.baseCommit;
        for (const disposition of review.invariant_family_ledger.dispositions) disposition.reviewed_commit = fixture.baseCommit;
        writeJson(reviewPath, review);
        run.slices[0].reviewed_commit = fixture.baseCommit;
        run.slices[0].attempt_reviews[0].reviewed_commit = fixture.baseCommit;
        run.slices[0].review_hash = hashFile(reviewPath);
        run.slices[0].attempt_reviews[0].review_hash = run.slices[0].review_hash;
      }), /review history is stale|sidecar heads must equal reviewed_commit|second parent/u],
    ];
    for (const [label, mutate, expected] of cases) {
      const fixture = createV2Fixture(`chain-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        mutate(fixture);
        assert.throws(() => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }), expected, label);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("enforces ordered origin-base outcomes", () => {
    const moved = createV2Fixture("origin-moved", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      runGit(moved.repo, ["checkout", "main"]);
      writeFileSync(join(moved.repo, "remote-only.txt"), "moved\n");
      runGit(moved.repo, ["add", "remote-only.txt"]);
      runGit(moved.repo, ["commit", "-m", "move origin"]);
      runGit(moved.repo, ["push", "origin", "main:main"]);
      runGit(moved.repo, ["checkout", moved.runId]);
      assert.throws(() => buildContinuation(moved.runId, { cwd: moved.repo, review: "reviewer.json", runId: "origin-moved-next", carryForward: true }), (error) => error.code === "stale-parent-base-moved");
    } finally { cleanup(moved.repo); }

    const contains = createV2Fixture("origin-contains", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      runGit(contains.repo, ["push", "origin", `${contains.runId}:main`]);
      assert.throws(() => buildContinuation(contains.runId, { cwd: contains.repo, review: "reviewer.json", runId: "origin-contains-next", carryForward: true }), (error) => error.code === "rebaseline-required");
    } finally { cleanup(contains.repo); }

    const unavailable = createV2Fixture("origin-unavailable", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      runGit(unavailable.repo, ["remote", "remove", "origin"]);
      assert.throws(() => buildContinuation(unavailable.runId, { cwd: unavailable.repo, review: "reviewer.json", runId: "origin-unavailable-next", carryForward: true }), (error) => error.code === "origin-base-unavailable");
    } finally { cleanup(unavailable.repo); }
  });

  it("does not mutate process-global FETCH_HEAD while observing origin", () => {
    const fixture = createV2Fixture("origin-fetch-head", { accepted: ["A"], mergeOrder: ["A"] });
    const fetchHead = join(fixture.repo, ".git", "FETCH_HEAD");
    try {
      writeFileSync(fetchHead, "sentinel fetch head\n");
      const commands = [];
      buildContinuation(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: "origin-fetch-head-next", carryForward: true,
        originSpawnSync(file, args, options) {
          commands.push([...args]);
          return spawnSync(file, args, options);
        },
      });
      assert.equal(readFileSync(fetchHead, "utf8"), "sentinel fetch head\n");
      const fetches = commands.filter((args) => args[0] === "fetch");
      assert.equal(fetches.length, 2);
      for (const args of fetches) {
        assert.equal(args.includes("--no-write-fetch-head"), true);
        assert.match(args.at(-1), /^[0-9a-f]{40}$/u);
      }
    } finally { cleanup(fixture.repo); }
  });

  it("fails closed for malformed, missing, multiple, and unfetchable origin observations", () => {
    const cases = [
      ["malformed", () => ({ status: 0, stdout: "not-an-oid\trefs/heads/main\n", stderr: "" })],
      ["missing", () => ({ status: 2, stdout: "", stderr: "missing" })],
      ["multiple", () => ({ status: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/main\n`, stderr: "" })],
      ["unfetchable", (file, args, options) => args[0] === "fetch" ? { status: 1, stdout: "", stderr: "unfetchable" } : spawnSync(file, args, options)],
    ];
    for (const [label, originSpawnSync] of cases) {
      const fixture = createV2Fixture(`origin-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true, originSpawnSync }),
          (error) => error.code === "origin-base-unavailable",
          label,
        );
      } finally { cleanup(fixture.repo); }
    }

    const invalid = createV2Fixture("origin-invalid-ref", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      updateRun(invalid, (run) => { run.base_ref = "refs/remotes/upstream/main"; });
      assert.throws(
        () => buildContinuation(invalid.runId, { cwd: invalid.repo, review: "reviewer.json", runId: "origin-invalid-ref-next", carryForward: true }),
        (error) => error.code === "origin-base-invalid",
      );
    } finally { cleanup(invalid.repo); }
  });

  it("re-observes origin after a deterministic remote race before returning", () => {
    const fixture = createV2Fixture("origin-recheck-race", { accepted: ["A"], mergeOrder: ["A"] });
    let observations = 0;
    try {
      assert.throws(
        () => buildContinuation(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: "origin-recheck-race-next", carryForward: true,
          beforeOriginFetch() {
            observations += 1;
            if (observations === 1) runGit(fixture.repo, ["push", "origin", `${fixture.runId}:main`]);
          },
        }),
        (error) => error.code === "rebaseline-required",
      );
      assert.equal(observations, 2);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects nonzero post-PR attempts even in otherwise eligible pre-PR phases", () => {
    for (const phase of ["disabled", "awaiting-pr"]) {
      const fixture = createV2Fixture(`eligibility-${phase}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        updateRun(fixture, (run) => { run.post_pr = continuationEligibilityPostPr(phase, 1); });
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }),
          /attempt.*zero|pre-PR/u,
        );
      } finally { cleanup(fixture.repo); }
    }
  });

  it("enforces the complete pre-PR carry-forward eligibility boundary without mutation", () => {
    const cases = [
      ["root pr_url", (run) => { run.pr_url = "https://github.com/acme/repo/pull/7"; }],
      ["terminal pr_url", (run) => { run.terminal_result.pr_url = "https://github.com/acme/repo/pull/7"; }],
      ["steering pr_fence", (run) => { run.steering = continuationEligibilitySteeringFence(); }],
      ["post-pr phase", (run) => { run.post_pr = { ...continuationEligibilityPostPr("awaiting-pr"), phase: "observing" }; }],
      ["disabled nonzero attempt", (run) => { run.post_pr = continuationEligibilityPostPr("disabled", 1); }],
      ["awaiting-pr nonzero attempt", (run) => { run.post_pr = continuationEligibilityPostPr("awaiting-pr", 1); }],
      ["observation", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), observation: {} }; }],
      ["remediation", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), remediation: {} }; }],
      ["continuation review", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), continuation_review: {} }; }],
      ["terminal fact", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), terminal_fact: {} }; }],
      ["PR operation", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), pr_operation: {} }; }],
      ["evidence refs", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), evidence_refs: [{ ref: "evidence/post-pr.json", hash: `sha256:${"a".repeat(64)}` }] }; }],
      ["malformed post-pr", (run) => { run.post_pr = { phase: "disabled", attempt: 0 }; }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`eligibility-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        updateRun(fixture, mutate);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }),
          /pre-PR|post-PR|before PR|ValidationError|requires --new-pr|must|allowed only/u,
          label,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", `${fixture.runId}-next`)), false, label);
      } finally { cleanup(fixture.repo); }
    }

    for (const phase of ["disabled", "awaiting-pr"]) {
      const fixture = createV2Fixture(`eligible-${phase}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        updateRun(fixture, (run) => { run.post_pr = continuationEligibilityPostPr(phase, 0); });
        const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true });
        assert.equal(candidate.carry_forward.remaining_slice_ids.length, 2, phase);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects an all-merged parent because no remaining slice exists", () => {
    const fixture = createV2Fixture("eligibility-all-merged", { accepted: ["A", "B", "C"], mergeOrder: ["A", "B", "C"] });
    try {
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "eligibility-all-merged-next", carryForward: true }),
        /at least one nonmerged slice/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("accepts the exact terminal nonconvergence review as the v2 carry-forward selector", () => {
    const fixture = createV2Fixture("nonconvergent-route", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const { head, evidenceRef, reviewRef, priorReviewRef, currentReview } = configureNonconvergentRoute(fixture);

      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-v1" }),
        /requires --carry-forward/u,
      );

      const continuation = buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-next", carryForward: true });
      const exactTerminalResult = structuredClone(JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")).terminal_result);

      assert.equal(continuation.review.ref, reviewRef);
      assert.equal(continuation.review.verdict, "REJECT");
      assert.deepEqual(continuation.review.required_fixes, ["replace the missed category"]);
      assert.deepEqual(continuation.carry_forward.remaining_slice_ids, ["B", "C"]);

      const alternateRef = "reviews/B.alternate.json";
      writeJson(join(fixture.runDir, alternateRef), { subject: "B", verdict: "REJECT", summary: "alternate parent ref", required_fixes: ["other"] });
      updateRun(fixture, (run) => { run.slices[1].review_ref = alternateRef; });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: alternateRef, runId: "nonconvergent-route-alternate", carryForward: true }),
        /must equal run\.terminal_result\.nonconvergence\.source_review\.review_ref/u,
      );

      updateRun(fixture, (run) => {
        run.terminal_result = { status: "blocked", run_id: run.run_id, pr_url: null, reason: "generic-block", summary: "generic", artifacts: {} };
      });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: alternateRef, runId: "nonconvergent-route-generic", carryForward: true }),
        /must equal run\.terminal_result\.nonconvergence\.source_review\.review_ref/u,
      );

      updateRun(fixture, (run) => { run.slices[1].review_ref = reviewRef; run.terminal_result = exactTerminalResult; });
      writeJson(join(fixture.runDir, reviewRef), {
        subject: "B", attempt: 2, reviewed_commit: head, verdict: "REJECT", convergence: "nonconvergent", late_discovery_strike: false,
        remaining_fix_count: 1, required_fixes: ["rewritten after terminalization"],
        ownership_ratification: { schema_version: 1, paths: [] },
        remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "nonconvergent", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
      });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-rewritten", carryForward: true }),
        /attempt 2 review history is stale|consume the exact source review bytes/u,
      );
      writeJson(join(fixture.runDir, reviewRef), currentReview);
      writeJson(join(fixture.runDir, priorReviewRef), {
        subject: "B", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "converging", late_discovery_strike: false,
        remaining_fix_count: 1, required_fixes: ["rewritten earlier history"],
        ownership_ratification: { schema_version: 1, paths: [] },
        remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
      });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-history-rewritten", carryForward: true }),
        /attempt 1 review history is stale/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("injects exact terminal nonconvergence evidence into the first child builder dispatch", async () => {
    const fixture = createV2Fixture("nonconvergent-dispatch", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const { evidenceRef, reviewRef } = configureNonconvergentRoute(fixture);
      const childRunId = "nonconvergent-dispatch-next";
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: reviewRef,
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
      });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childWorktree = join(fixture.repo, ".opencode", "worktrees", childRunId);
      await transitionRunSlice(childRunDir, "B", { status: "running", attempts: 1, branch: childRunId, worktree: childWorktree });

      const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
        run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
      });
      assert.equal(context.task_context, "fresh");
      assert.deepEqual(context.prior.origin, { kind: "carry-forward-nonconvergence", parent_run_id: fixture.runId });
      assert.equal(context.prior.binding.evidence_ref, evidenceRef);
      assert.equal(JSON.parse(Buffer.from(context.prior.review.bytes, "base64").toString("utf8")).required_fixes[0], "replace the missed category");
      assert.equal(JSON.parse(Buffer.from(context.prior.evidence.bytes, "base64").toString("utf8")).attempt, 2);

      const parentEvidencePath = join(fixture.runDir, evidenceRef);
      const parentEvidenceBytes = readFileSync(parentEvidencePath, "utf8");
      await transitionRunSlice(childRunDir, "C", { status: "running", attempts: 1, branch: childRunId, worktree: childWorktree });
      writeFileSync(parentEvidencePath, `${parentEvidenceBytes}\n`, "utf8");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, {
          run_id: childRunId, slice_id: "C", attempt: 1, agent: "backend-builder",
        }),
        /schema-v2 parent evidence|schema-v2 parent run|parent.*stale|review history is stale/u,
      );
      writeFileSync(parentEvidencePath, parentEvidenceBytes, "utf8");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, {
          run_id: childRunId, slice_id: "C", attempt: 1, agent: "backend-builder",
        }, {
          claimDispatch: true,
          completionToken: "parent-authority-race-token",
          atomicWriteHooks: { beforeCommit: () => writeFileSync(parentEvidencePath, `${parentEvidenceBytes}\n`, "utf8") },
        }),
        /prior authority changed before claim publication|commit failed/u,
      );
      writeFileSync(parentEvidencePath, parentEvidenceBytes, "utf8");
      const completionToken = "parent-authority-closure-token";
      const claimed = await prepareSliceBuilderTaskDispatch(fixture.repo, {
        run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
      }, { claimDispatch: true, completionToken });
      writeFileSync(parentEvidencePath, `${parentEvidenceBytes}\n`, "utf8");
      await assert.rejects(
        completeSliceBuilderTaskDispatch(fixture.repo, {
          run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
          claim_ref: claimed.dispatch_claim.ref, claim_hash: claimed.dispatch_claim.hash, completion_token: completionToken,
        }),
        /schema-v2 parent evidence|schema-v2 parent run|parent.*stale|review history is stale/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("injects the exact selected ordinary slice REJECT into the child builder dispatch", async () => {
    const fixture = createV2Fixture("slice-review-dispatch", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const { evidenceRef, reviewRef } = configureConvergingSliceRoute(fixture);
      const childRunId = "slice-review-dispatch-next";
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: reviewRef,
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
      });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childWorktree = join(fixture.repo, ".opencode", "worktrees", childRunId);
      await transitionRunSlice(childRunDir, "B", { status: "running", attempts: 1, branch: childRunId, worktree: childWorktree });

      const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
        run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
      });
      assert.equal(context.task_context, "fresh");
      assert.deepEqual(context.prior.origin, { kind: "continuation-slice-review", parent_run_id: fixture.runId });
      assert.equal(context.prior.binding.review_ref, reviewRef);
      assert.equal(JSON.parse(Buffer.from(context.prior.review.bytes, "base64").toString("utf8")).required_fixes[0], "apply the selected correction");
      assert.equal(JSON.parse(Buffer.from(context.prior.evidence.bytes, "base64").toString("utf8")).subject, "B");

      const parentReviewPath = join(fixture.runDir, reviewRef);
      const parentReviewBytes = readFileSync(parentReviewPath, "utf8");
      writeFileSync(parentReviewPath, `${parentReviewBytes}\n`, "utf8");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder" }),
        /schema-v2 parent review|parent.*stale|review history is stale/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("requires accepted unchanged planning and forbids draft carry-forward before allocation", () => {
    for (const [label, mutate] of [
      ["unaccepted", (fixture) => updateRun(fixture, (run) => { run.steps[0].status = "rejected"; delete run.steps[0].acceptance; })],
      ["changed", (fixture) => writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "changed after acceptance\n")],
    ]) {
      const fixture = createV2Fixture(`planning-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        mutate(fixture);
        assert.throws(() => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }), /accepted unchanged planning|accepted spec-writer step|changed since acceptance|planning_reuse/u, label);
        assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "", label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects caller-scaffolded v2 children without changing parent or child state", async () => {
    const fixture = createV2Fixture("v2-consumer-fence", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "v2-consumer-fence-next";
    try {
      const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      mkdirSync(childRunDir, { recursive: true });
      writeJson(join(childRunDir, "run.json"), createRunRecord({
        run_id: childRunId,
        branch: childRunId,
        worktree: candidate.target.worktree,
        continuation: candidate,
      }));
      const parentBefore = readFileSync(join(fixture.runDir, "run.json"));
      const childBefore = readFileSync(join(childRunDir, "run.json"));

      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /closed mode\/pr configuration|published carry-forward|exact closed immutable configuration/u);

      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), parentBefore);
      assert.deepEqual(readFileSync(join(childRunDir, "run.json")), childBefore);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", `refs/heads/${childRunId}`], { cwd: fixture.repo }).status, 0);
    } finally { cleanup(fixture.repo); }
  });

  it("rechecks optional panels and deterministic parent/plan/branch mutations before returning", () => {
    const panel = createV2Fixture("carry-panels", { accepted: ["A"], mergeOrder: ["A"], panels: true });
    try {
      const continuation = buildContinuation(panel.runId, { cwd: panel.repo, review: "reviewer.json", runId: "carry-panels-next", carryForward: true });
      assert.equal(continuation.carry_forward.start_commit, panel.mergeCommits.A);
      writeFileSync(join(panel.runDir, "reviews", "security.json"), "{}\n");
      assert.throws(() => buildContinuation(panel.runId, { cwd: panel.repo, review: "reviewer.json", runId: "carry-panels-stale", carryForward: true }), /security.*hash|verdict/u);
    } finally { cleanup(panel.repo); }

    for (const [label, mutate, expected] of [
      ["plan", ({ parentRunDir }) => writeFileSync(join(parentRunDir, "plan", "slices.json"), "{\"slices\":[]}"), /bound plan|plan\/slices\.json|carry_forward/u],
      ["sidecar", ({ parentRunDir }) => writeFileSync(join(parentRunDir, "reviews", "A.json"), "{}\n"), /parent_(?:reviews|evidence) bindings changed|hashes are stale|subject must match/u],
      ["branch", ({ continuation }) => runGit(continuation.parent.worktree, ["commit", "--allow-empty", "-m", "branch drift"]), /branch\/commit binding is stale/u],
    ]) {
      const fixture = createV2Fixture(`recheck-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        assert.throws(() => buildContinuation(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true,
          beforeCarryForwardReturn: mutate,
        }), expected, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("binds same-checkpoint B1 source and stored configuration through continuation, claim, and child root", async () => {
    for (const reviewTier of [null, "strict"]) {
      const suffix = reviewTier ?? "null";
      const fixture = createV2Fixture(`checkpoint-b1-${suffix}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `checkpoint-b1-${suffix}-next`;
      try {
        const bound = bindCheckpointContinuationFixture(fixture, reviewTier);
        const result = await continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: "reviewer.json",
          runId: childRunId,
          carryForward: true,
          foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
        });
        const continuation = result.payload.continuation;
        const child = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8"));
        const claim = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", expectedClaim(continuation).claimRef]));

        assert.deepEqual(continuation.configuration, bound.configuration);
        assert.equal(continuation.checkpoint_source_hash, canonicalHash(bound.source));
        assert.equal(continuation.configuration_hash, canonicalHash(bound.configuration));
        assert.equal(claim.checkpoint_source_hash, continuation.checkpoint_source_hash);
        assert.equal(claim.configuration_hash, continuation.configuration_hash);
        assert.deepEqual(child.checkpoint_source, bound.source);
        assert.equal(reviewTier === null ? !Object.hasOwn(child, "review_tier") : child.review_tier === reviewTier, true);
        assert.deepEqual(continuation.planning_reuse, {
          eligible: true,
          plan_ref: "plan/slices.json",
          plan_hash: bound.source.child_plan_hash,
          review_ref: "reviews/work-decomposer.json",
          review_hash: bound.source.child_disposition_hash,
        });
        assert.equal(child.steps.some((step) => step.agent === "spec-writer"), false);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "artifacts", "technical-brief.md")), false);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "reviews", "spec-writer.json")), false);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects missing, review-only, stale, and cross-bound S2 owners before ordinary child publication", () => {
    const cases = [
      ["missing", (run) => { run.slices = run.slices.filter(({ id }) => id !== "owner"); }],
      ["review-only", (run) => { const owner = run.slices.find(({ id }) => id === "owner"); owner.status = "review"; delete owner.merge_commit; }],
      ["stale", (run) => { run.slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0].owner_review_hash = `sha256:${"0".repeat(64)}`; }],
      ["cross-bound", (run) => { run.slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0].owner_slice_id = "consumer"; }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2SiblingAuthorityFixture(`issue128-ordinary-${label}`);
      const childRunId = `${fixture.runId}-next`;
      try {
        updateRun(fixture, mutate);
        const parentBytes = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        assert.throws(
          () => continueFactory(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true, dryRun: true }),
          /owner|sibling|binding|stale|accepted|merged|dependency|unknown/u,
          label,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), parentBytes, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
        assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects checkpoint B1 configuration conflicts and cross-checkpoint source before allocation", () => {
    const conflict = createV2Fixture("checkpoint-b1-conflict", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      bindCheckpointContinuationFixture(conflict, "strict");
      assert.throws(() => continueFactory(conflict.runId, {
        cwd: conflict.repo, review: "reviewer.json", runId: "checkpoint-b1-v1-next",
      }), /requires --carry-forward/u);
      assert.throws(() => continueFactory(conflict.runId, {
        cwd: conflict.repo, review: "reviewer.json", runId: "checkpoint-b1-conflict-next", carryForward: true, autonomous: true,
      }), /mode conflicts with published immutable configuration/u);
      assert.equal(refOid(conflict.repo, continuationReservationRef("checkpoint-b1-conflict-next")), null);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/checkpoint-b1-conflict-next"], { cwd: conflict.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).status, 0);
      assert.equal(gitStdout(conflict.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(existsSync(join(conflict.repo, ".opencode", "worktrees", "checkpoint-b1-conflict-next")), false);
      assert.equal(existsSync(join(conflict.repo, ".opencode", "factory", "checkpoint-b1-conflict-next")), false);
    } finally { cleanup(conflict.repo); }

    const crossed = createV2Fixture("checkpoint-b1-crossed", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      bindCheckpointContinuationFixture(crossed, null);
      updateRun(crossed, (run) => {
        run.checkpoint_source.checkpoint_id = "checkpoint-002";
        run.checkpoint_source.checkpoint_ordinal = 2;
      });
      assert.throws(() => continueFactory(crossed.runId, {
        cwd: crossed.repo, review: "reviewer.json", runId: "checkpoint-b1-crossed-next", carryForward: true,
      }), /cross-checkpoint/u);
      assert.equal(refOid(crossed.repo, continuationReservationRef("checkpoint-b1-crossed-next")), null);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/checkpoint-b1-crossed-next"], { cwd: crossed.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).status, 0);
      assert.equal(gitStdout(crossed.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(existsSync(join(crossed.repo, ".opencode", "worktrees", "checkpoint-b1-crossed-next")), false);
      assert.equal(existsSync(join(crossed.repo, ".opencode", "factory", "checkpoint-b1-crossed-next")), false);
    } finally { cleanup(crossed.repo); }
  });

  it("publishes a child from a parent whose settled blocked amendment is retained", async () => {
    // #150 restored the documented recovery path for a blocked integration
    // amendment: the parent terminalizes `carry-forward-required`, keeps the
    // blocked amendment authority, and continues in a fresh schema-v2 child.
    // Its regression proved the admission gate, but stopped before reservation
    // and publication because the amendment fixture's git history has no
    // accepted merge commits. This drives the whole path on the carry-forward
    // fixture, which does, and pins the two facts that make the gate safe:
    // the parent keeps its amendment, and the child inherits none of it.
    const fixture = createV2Fixture("amendment-carry", { accepted: ["A"], mergeOrder: ["A"], pathPrefix: "src/" });
    const childRunId = "amendment-carry-next";
    try {
      // A is merged, so it is a legal amendment owner; B is pristine pending and
      // depends on A, so it is a legal consumer.
      // createV2Fixture writes a parent already blocked at the pre-PR gate, but an
      // amendment can only be reported against a running run. Restore that
      // earlier point so the sequence is the real one: running run acquires an
      // amendment, the amendment blocks, and only then does the run terminalize
      // carry-forward-required.
      const parent = JSON.parse(readFileSync(join(fixture.runDir, "run.json")));
      // An amendment is excluded once panel, pre-PR, PR, or post-PR authority
      // exists, so wind the parent back to the point before those: a running run
      // with quiescent slices and no verdicts recorded yet.
      const running = { ...parent, status: "running" };
      for (const key of ["terminal_result", "validator", "security_review"]) delete running[key];
      if (running.gates) delete running.gates.pre_pr;
      // The amendment owner must retain complete dispatch authority on its
      // current attempt review; ordinary carry-forward never reads it, so the
      // carry-forward fixture does not publish one.
      const ownerSlice = running.slices.find((slice) => slice.id === "A");
      const ownerDispatch = writeOwnerDispatch(fixture.runDir, fixture.baseCommit, fixture.reviewedCommits.A, fixture.repo, {
        runId: fixture.runId, sliceId: "A", branch: `${fixture.runId}--A`,
      });
      // assertNoUnresolvedSliceDispatches binds the *current* attempt on the slice
      // itself, while the amendment owner check reads the last attempt review, so
      // both carry the sidecar refs.
      Object.assign(ownerSlice, ownerDispatch, { dispatch_required: true, branch: `${fixture.runId}--A`, worktree: fixture.repo });
      Object.assign(ownerSlice.attempt_reviews.at(-1), ownerDispatch);
      writeJson(join(fixture.runDir, "run.json"), running);
      const plan = JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json")));
      // Read the artifact id from the consumer's own delivery unit rather than
      // assuming the generator's numbering.
      const consumerUnit = plan.delivery_envelope.delivery_units.find((unit) => unit.slice_id === "B");
      const request = { owner_slice_id: "A", consumer_slice_id: "B", defect_path: "src/A.txt", verification_artifact_id: consumerUnit.verification_artifacts[0].id };
      publishAmendmentReportFor({ runDir: fixture.runDir, run: JSON.parse(readFileSync(join(fixture.runDir, "run.json"))), request });
      await transitionIntegrationAmendment(fixture.runDir, { action: "report", ...request }, { repoRoot: fixture.repo });
      await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "amendment unsupported for this run state" }, { repoRoot: fixture.repo });
      assert.equal(JSON.parse(readFileSync(join(fixture.runDir, "run.json"))).integration_amendment.status, "blocked");

      // A blocked amendment terminalizes with no steering boundary at all.
      const terminal = await transitionTerminalResult(fixture.runDir, {
        status: "blocked", reason: "carry-forward-required", summary: CARRY_FORWARD_REQUIRED_SUMMARY, artifacts: {},
      }, { blockedAmendmentTerminal: true });
      assert.equal(terminal.terminal_result.reason, "carry-forward-required");
      assert.equal(terminal.run.integration_amendment.status, "blocked", "terminalization retains the amendment");

      let launched;
      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        // No validator exists on this parent (an amendment is excluded after panel
        // authority), so the continuation consumes the merged slice review, which
        // continuationReviewSources accepts as a `slice` kind.
        review: "A.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async (repo, args) => { launched = { repo, args }; return { status: "started", run_id: childRunId }; },
      });

      // Reservation and publication both completed.
      assert.equal(result.status, "started");
      assert.equal(launched.repo, gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]));
      assertPublishedCarryForwardRun(launched.repo, result.payload.continuation, { driver: result.payload.driver });

      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const child = JSON.parse(readFileSync(join(childRunDir, "run.json")));
      // The adopted merged parent slice and the remaining pending slices.
      const childSlices = Object.fromEntries(child.slices.map((slice) => [slice.id, slice.status]));
      assert.deepEqual(childSlices, { A: "merged", B: "pending", C: "pending" });

      // The two facts that make admitting a blocked parent safe: the parent's
      // authority is untouched, and none of it reaches the child.
      assert.equal(JSON.parse(readFileSync(join(fixture.runDir, "run.json"))).integration_amendment.status, "blocked", "publication must not mutate parent amendment authority");
      assert.equal(child.integration_amendment, undefined, "child must inherit no amendment authority");
      assert.equal(child.terminal_result, null);
      assert.equal(child.pr_url, null);
    } finally { cleanup(fixture.repo); }
  });

  it("atomically publishes and launches the complete canonical child after exact allocation", async () => {
    const fixture = createV2Fixture("allocation-happy", { accepted: ["A", "C"], mergeOrder: ["C", "A"] });
    const childRunId = "allocation-happy-next";
    const transactions = [];
    try {
      let launched;
      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async (repo, args) => { launched = { repo, args }; return { status: "started", run_id: childRunId }; },
        refTransactionSpawnSync(file, args, options) {
          transactions.push({ file, args: [...args], input: String(options.input) });
          return spawnSync(file, args, options);
        },
      });
      const expected = expectedClaim(result.payload.continuation);
      const expectedBytes = canonicalJson(expected.claim);
      const expectedDigest = createHash("sha256").update(canonicalJson(expected.parentIdentity)).digest("hex");
      const zero = "0".repeat(40);

      const claimRef = `refs/opencode/continuations/${expectedDigest}`;
      assert.equal(result.status, "started", JSON.stringify(result));
      assert.deepEqual(result.publication, { published: true, replayed: false });
      assert.equal(result.payload.driver.ready, true);
      assert.equal(result.payload.driver.pr_mode, "ready");
      assert.equal(result.payload.driver.mode, "interactive");
      assert.equal(result.payload.driver.github_account, null);
      assert.equal(gitStdout(fixture.repo, ["cat-file", "-t", claimRef]), "blob");
      assert.equal(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", claimRef]), expectedBytes);
      assert.deepEqual(JSON.parse(expectedBytes), expected.claim);
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
      assert.equal(gitStdout(fixture.repo, ["show-ref", "--verify", "--hash", expected.claim.child_branch_ref]), result.payload.continuation.carry_forward.start_commit);
      assert.equal(gitStdout(result.payload.continuation.target.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]), result.payload.continuation.carry_forward.start_commit);
      assert.equal(gitStdout(result.payload.continuation.target.worktree, ["symbolic-ref", "HEAD"]), expected.claim.child_branch_ref);
      assert.equal(child.continuation.schema_version, 2);
      assert.equal(child.schema_version, 1);
      assert.equal(child.max_parallel_slices, 3);
      assert.equal(child.max_retries, 3);
      assert.equal(Object.hasOwn(child, "review_tier"), false);
      assert.deepEqual(child.post_pr, continuationEligibilityPostPr("disabled", 0));
      assert.deepEqual(child.gates, {});
      assert.deepEqual(child.slices.map(({ id, status, attempts }) => ({ id, status, attempts })), [
        { id: "A", status: "merged", attempts: 1 }, { id: "B", status: "pending", attempts: 0 }, { id: "C", status: "merged", attempts: 1 },
      ]);
      assert.equal(child.steps[0].attempts, 0);
      assert.equal(child.steps[0].status, "accepted");
      assert.deepEqual(child.steps[1], {
        agent: "work-decomposer", status: "accepted", attempts: 1,
        artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(childRunDir, "plan", "slices.json")),
          review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(childRunDir, "reviews", "work-decomposer.json")),
        },
      });
      assert.deepEqual(child.steps[2], { agent: "test-verifier", status: "blocked", attempts: 0 });
      assert.equal(child.steps.length, 3);
      assert.equal(child.validator, null);
      assert.equal(child.security_review, null);
      assert.equal(child.pr_url, null);
      for (const ref of ["artifacts/test-report.md", "artifacts/validation-report.md", "artifacts/pr-body.md", "artifacts/plan.md"]) {
        assert.equal(existsSync(join(childRunDir, ref)), false, ref);
      }
      assert.deepEqual(readFileSync(join(childRunDir, "reviews", "work-decomposer.json")), readFileSync(join(fixture.runDir, "reviews", "work-decomposer.json")));
      assert.deepEqual(readFileSync(join(childRunDir, "plan", "slices.json")), readFileSync(join(fixture.runDir, "plan", "slices.json")));
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature", "SKILL.md")), true);
      assert.equal(launched.repo, gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]));
      assert.match(launched.args.at(-1), /^ffpayload-v1:/u);
      assertPublishedCarryForwardRun(launched.repo, result.payload.continuation, { driver: result.payload.driver });
      const decoded = decodeFeatureCommandPayload(launched.args.at(-1), { repo: launched.repo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.deepEqual(decoded.payload.driver, result.payload.driver);
      const mismatch = structuredClone(result.payload);
      mismatch.driver.ready = false;
      assert.deepEqual(decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(mismatch)).toString("base64url")}`, { repo: launched.repo }), { ok: false, reason: "unpublished-or-mismatched-carry-forward" });
      assert.equal(transactions.length, 1);
      assert.deepEqual(transactions[0].args, ["update-ref", "--no-deref", "--stdin"]);
      assert.equal(transactions[0].input, [
        "start",
        `verify ${expected.parentIdentity.parent_branch_ref} ${expected.claim.start_commit}`,
        `update ${claimRef} ${refOid(fixture.repo, claimRef)} ${zero}`,
        `update ${expected.claim.child_branch_ref} ${expected.claim.start_commit} ${zero}`,
        "prepare",
        "commit",
        "",
      ].join("\n"));
    } finally { cleanup(fixture.repo); }
  });

  it("publishes and replays complete multi-attempt carry-forward history", async () => {
    const fixture = createV2Fixture("multi-attempt-publication", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "multi-attempt-publication-next";
    const launches = [];
    try {
      const history = configureMultiAttemptAcceptedSlice(fixture, "A");
      const parentBytes = new Map(history.flatMap((entry) => [entry.evidence_ref, entry.review_ref])
        .map((ref) => [ref, readFileSync(join(fixture.runDir, ref))]));
      const launch = async (repo, args) => {
        launches.push({ repo, payload: args.at(-1) });
        return { status: "started", run_id: childRunId };
      };
      const options = {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        now: "2026-07-18T12:00:00.000Z",
        foregroundLaunchFn: launch,
      };

      const result = await continueFactory(fixture.runId, options);
      const accepted = result.payload.continuation.carry_forward.accepted_slices[0];
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
      const childSlice = child.slices.find((slice) => slice.id === "A");

      assert.deepEqual(accepted.attempt_reviews, history);
      assert.deepEqual(childSlice.attempt_reviews, history);
      assert.equal(accepted.attempt_reviews[0].review_ref, "reviews/A.attempt-1.json");
      assert.equal(accepted.attempt_reviews[1].review_ref, "reviews/A.attempt-2.json");
      assert.notEqual(accepted.attempt_reviews[0].review_hash, accepted.attempt_reviews[1].review_hash);
      assert.notEqual(accepted.attempt_reviews[0].evidence_hash, accepted.attempt_reviews[1].evidence_hash);
      for (const [ref, bytes] of parentBytes) assert.deepEqual(readFileSync(join(childRunDir, ref)), bytes, ref);

      const decoded = decodeFeatureCommandPayload(launches[0].payload, { repo: launches[0].repo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.deepEqual(decoded.payload.continuation.carry_forward.accepted_slices[0].attempt_reviews, history);
      const replay = await continueFactory(fixture.runId, options);
      assert.deepEqual(replay.publication, { published: true, replayed: true });
      const replayDecoded = decodeFeatureCommandPayload(launches[1].payload, { repo: launches[1].repo });
      assert.equal(replayDecoded.ok, true, JSON.stringify(replayDecoded));
      assert.deepEqual(replayDecoded.payload.continuation.carry_forward.accepted_slices[0].attempt_reviews, history);
    } finally { cleanup(fixture.repo); }

    for (const [label, mutate, expected] of [
      ["historical deletion", (candidate) => rmSync(join(candidate.runDir, "reviews", "A.attempt-1.json")), /missing.*review|review.*missing/u],
      ["historical byte drift", (candidate) => {
        const path = join(candidate.runDir, "evidence", "A.attempt-1.json");
        writeFileSync(path, `${readFileSync(path, "utf8")} `);
      }, /history is stale|hashes are stale/u],
      ["historical hash drift", (candidate) => updateRun(candidate, (run) => { run.slices[0].attempt_reviews[0].review_hash = `sha256:${"0".repeat(64)}`; }), /history is stale|hashes are stale/u],
    ]) {
      const candidate = createV2Fixture(`multi-attempt-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        configureMultiAttemptAcceptedSlice(candidate, "A");
        mutate(candidate);
        assert.throws(
          () => buildContinuation(candidate.runId, { cwd: candidate.repo, review: "reviewer.json", runId: `${candidate.runId}-next`, carryForward: true }),
          expected,
          label,
        );
      } finally { cleanup(candidate.repo); }
    }
  });

  it("runs the full final recheck after candidate build and rejects every authority mutation without resources", () => {
    const cases = [
      ["parent", (fixture) => writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `)],
      ["plan", (fixture) => writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}")],
      ["sidecar", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "A.json"), "{}\n")],
      ["branch", (fixture) => runGit(fixture.repo, ["commit", "--allow-empty", "-m", "allocation branch race"])],
      ["origin", (fixture) => {
        runGit(fixture.repo, ["checkout", "main"]);
        runGit(fixture.repo, ["commit", "--allow-empty", "-m", "allocation origin race"]);
        runGit(fixture.repo, ["push", "origin", "main:main"]);
        runGit(fixture.repo, ["checkout", fixture.runId]);
      }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`allocation-recheck-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      try {
        assert.throws(() => continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          beforeRefTransaction: () => mutate(fixture),
        }), /continuation|parent|plan|review|branch|origin|stale/u, label);
        assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "", label);
        assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("atomically rejects a parent branch move after final recheck and before the ref transaction executes", () => {
    const fixture = createV2Fixture("allocation-parent-transaction-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-parent-transaction-race-next";
    const parentRef = `refs/heads/${fixture.runId}`;
    let raced = false;
    try {
      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        refTransactionSpawnSync(file, args, options) {
          if (!raced) {
            raced = true;
            updateRef(fixture.repo, parentRef, fixture.baseCommit);
          }
          return spawnSync(file, args, options);
        },
      }), /parent|transaction|verify|conflict/u);
      assert.equal(raced, true);
      assert.equal(refOid(fixture.repo, parentRef), fixture.baseCommit);
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
    } finally { cleanup(fixture.repo); }
  });

  it("leaves no child before allocation and exact-replays publication after allocation crashes", async () => {
    const before = createV2Fixture("allocation-crash-before", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      assert.throws(() => continueFactory(before.runId, {
        cwd: before.repo, review: "reviewer.json", runId: "allocation-crash-before-next", carryForward: true,
        beforeRefTransaction: () => { throw new Error("crash before transaction"); },
      }), /crash before transaction/u);
      assert.equal(gitStdout(before.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(refOid(before.repo, "refs/heads/allocation-crash-before-next"), null);
    } finally { cleanup(before.repo); }

    const after = createV2Fixture("allocation-crash-after", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-crash-after-next";
    let committed;
    try {
      assert.throws(() => continueFactory(after.runId, {
        cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        afterRefTransaction: (state) => { committed = state; throw new Error("crash after transaction"); },
      }), /crash after transaction/u);
      assert.equal(refOid(after.repo, committed.claimRef), committed.claimOid);
      assert.equal(refOid(after.repo, committed.childBranchRef), committed.startCommit);
      assert.equal(existsSync(join(after.repo, ".opencode", "worktrees", childRunId)), false);

      const launch = async () => ({ status: "started", run_id: childRunId });
      const recovered = await continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.deepEqual(recovered.publication, { published: true, replayed: false });
      const replay = await continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.deepEqual(replay.publication, { published: true, replayed: true });
      assert.equal(refOid(after.repo, committed.claimRef), committed.claimOid);
      assert.equal(refOid(after.repo, committed.childBranchRef), committed.startCommit);
      assert.equal(gitStdout(join(after.repo, ".opencode", "worktrees", childRunId), ["rev-parse", "HEAD"]), committed.startCommit);
      assert.equal(existsSync(join(after.repo, ".opencode", "factory", childRunId, "run.json")), true);
    } finally { cleanup(after.repo); }
  });

  it("exact-replays committed refs after interruption of claim-bound worktree reservation", async () => {
    const fixture = createV2Fixture("allocation-worktree-reservation-crash", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-worktree-reservation-crash-next";
    let reservation;
    try {
      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        afterWorktreeReserve(state) {
          reservation = state;
          throw new Error("interrupted after claim-bound worktree reservation");
        },
      }), /interrupted after claim-bound worktree reservation/u);
      assert.equal(existsSync(reservation.reservationPath), true);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), fixture.mergeCommits.A);
      assert.notEqual(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");

      const recovered = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }) });
      assert.deepEqual(recovered.publication, { published: true, replayed: false });
      assert.equal(gitStdout(join(fixture.repo, ".opencode", "worktrees", childRunId), ["rev-parse", "HEAD"]), fixture.mergeCommits.A);
      assert.equal(existsSync(reservation.reservationPath), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json")), true);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects half states and every non-exact replay without overwriting or repair", () => {
    const cases = [
      ["only claim", ({ repo, expected }) => updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(expected.claim)))],
      ["only branch", ({ repo, candidate }) => updateRef(repo, `refs/heads/${candidate.target.run_id}`, candidate.carry_forward.start_commit)],
      ["wrong object", ({ repo, candidate, expected }) => {
        updateRef(repo, expected.claimRef, candidate.carry_forward.start_commit);
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["wrong child", ({ repo, candidate, expected }) => {
        const wrong = { ...expected.claim, child_run_id: "different-child" };
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(wrong)));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["extra field", ({ repo, candidate, expected }) => {
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson({ ...expected.claim, extra: true })));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["missing field", ({ repo, candidate, expected }) => {
        const missing = { ...expected.claim };
        delete missing.start_commit;
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(missing)));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["noncanonical bytes", ({ repo, candidate, expected }) => {
        updateRef(repo, expected.claimRef, writeBlob(repo, `${JSON.stringify(expected.claim, null, 2)}\n`));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["wrong branch target", ({ repo, fixture, expected }) => {
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(expected.claim)));
        updateRef(repo, expected.claim.child_branch_ref, fixture.baseCommit);
      }],
    ];
    for (const [label, arrange] of cases) {
      const fixture = createV2Fixture(`allocation-conflict-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      try {
        const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
        const expected = expectedClaim(candidate);
        arrange({ repo: fixture.repo, fixture, candidate, expected });
        const beforeClaim = refOid(fixture.repo, expected.claimRef);
        const beforeBranch = refOid(fixture.repo, expected.claim.child_branch_ref);
        assert.throws(
          () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true }),
          /conflict|only one registered ref/u,
          label,
        );
        assert.equal(refOid(fixture.repo, expected.claimRef), beforeClaim, label);
        assert.equal(refOid(fixture.repo, expected.claim.child_branch_ref), beforeBranch, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("loses deterministic claim or branch races atomically without creating the other ref", () => {
    for (const racedRef of ["claim", "branch"]) {
      const fixture = createV2Fixture(`allocation-race-${racedRef}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      let expected;
      try {
        assert.throws(() => continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          beforeRefTransaction(state) {
            expected = state;
            if (racedRef === "claim") updateRef(fixture.repo, state.claimRef, writeBlob(fixture.repo, "{}"));
            else updateRef(fixture.repo, state.childBranchRef, fixture.baseCommit);
          },
        }), /transaction conflicted|only one registered ref|conflict/u, racedRef);
        const claim = refOid(fixture.repo, expected.claimRef);
        const branch = refOid(fixture.repo, expected.childBranchRef);
        if (racedRef === "claim") {
          assert.equal(claim, writeBlob(fixture.repo, "{}"));
          assert.equal(branch, null);
        } else {
          assert.equal(claim, null);
          assert.equal(branch, fixture.baseCommit);
        }
        assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("preserves a foreign target worktree and the committed claim tombstone on worktree conflict", () => {
    const fixture = createV2Fixture("allocation-foreign-worktree", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-foreign-worktree-next";
    const target = join(fixture.repo, ".opencode", "worktrees", childRunId);
    try {
      const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
      const expected = expectedClaim(candidate);
      runGit(fixture.repo, ["worktree", "add", target, "main"]);

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true }),
        /worktree conflicts|branch-mismatch/u,
      );
      assert.equal(gitStdout(target, ["symbolic-ref", "HEAD"]), "refs/heads/main");
      assert.equal(gitStdout(target, ["rev-parse", "HEAD"]), fixture.baseCommit);
      assert.equal(refOid(fixture.repo, expected.claimRef), writeBlob(fixture.repo, canonicalJson(expected.claim)));
      assert.equal(refOid(fixture.repo, expected.claim.child_branch_ref), candidate.carry_forward.start_commit);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
    } finally { cleanup(fixture.repo); }
  });

  it("rechecks every publication authority and configuration after staging without partial visibility", async () => {
    const cases = [
      ["parent", (fixture) => writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `)],
      ["plan", (fixture) => writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}")],
      ["sidecar", (fixture) => writeFileSync(join(fixture.runDir, "evidence", "A.json"), "{}\n")],
      ["parent branch", (fixture) => runGit(fixture.repo, ["commit", "--allow-empty", "-m", "publication parent race"])],
      ["origin", (fixture) => {
        runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "publication origin race"]);
        runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
      }],
      ["claim", (fixture, state) => updateRef(fixture.repo, state.allocation.claim_ref, writeBlob(fixture.repo, "{}"))],
      ["worktree", (fixture, state) => runGit(state.continuation.target.worktree, ["checkout", "--detach", fixture.baseCommit])],
      ["config", (_fixture, state) => { state.configuration.pr_mode = "draft"; }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`publication-race-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      const options = {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      };
      try {
        await assert.rejects(continueFactory(fixture.runId, {
          ...options,
          beforeCarryForwardPublish(state) {
            assert.equal(existsSync(state.targetRunDir), false, `${label}: child invisible before publication`);
            assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false, `${label}: skill not seeded before publication`);
            mutate(fixture, state);
          },
        }), /carry-forward|continuation|parent|plan|sidecar|branch|origin|claim|worktree|configuration|stale|changed/u, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("publishes a complete child with the native atomic directory rename", async () => {
    const fixture = createV2Fixture("publication-native-rename", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-native-rename-next";
    let renames = 0;
    try {
      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        publicationRenameSync(source, target) {
          renames += 1;
          assert.equal(existsSync(source), true);
          assert.equal(existsSync(target), false);
          renameSync(source, target);
        },
        foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
      });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      assert.equal(renames, 1);
      assert.deepEqual(result.publication, { published: true, replayed: false });
      assert.equal(validateRun(JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"))).run_id, childRunId);
    } finally { cleanup(fixture.repo); }
  });

  it("fails closed on native rename failure without child publication or launch", async () => {
    const fixture = createV2Fixture("publication-rename-failure", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-rename-failure-next";
    const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
    let launches = 0;
    try {
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        publicationRenameSync() { throw new Error("injected rename failure"); },
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /atomic no-overwrite directory move failed/u);
      assert.equal(launches, 0);
      assert.equal(existsSync(childRunDir), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false);
    } finally { cleanup(fixture.repo); }
  });

  it("never overwrites a publication-race winner and leaves no staged partial child", async () => {
    const fixture = createV2Fixture("publication-target-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-target-race-next";
    const target = join(fixture.repo, ".opencode", "factory", childRunId);
    let launches = 0;
    try {
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        beforeCarryForwardRename() { mkdirSync(target, { recursive: true }); writeFileSync(join(target, "foreign.txt"), "foreign\n"); },
        publicationRenameSync() { assert.fail("foreign target must win before rename"); },
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /already exists|factory run directory/u);
      assert.equal(readFileSync(join(target, "foreign.txt"), "utf8"), "foreign\n");
      assert.equal(existsSync(join(target, "run.json")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false);
      assert.equal(launches, 0);
    } finally { cleanup(fixture.repo); }

    const linked = createV2Fixture("publication-symlink-race", { accepted: ["A"], mergeOrder: ["A"] });
    const linkedRunId = "publication-symlink-race-next";
    const outside = join(linked.repo, "outside-child");
    launches = 0;
    try {
      mkdirSync(outside);
      await assert.rejects(continueFactory(linked.runId, {
        cwd: linked.repo, review: "reviewer.json", runId: linkedRunId, carryForward: true,
        beforeCarryForwardRename({ targetRunDir }) { symlinkSync(outside, targetRunDir, "dir"); },
        publicationRenameSync() { assert.fail("symlink target must win before rename"); },
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /already exists|factory run directory/u);
      assert.equal(existsSync(join(outside, "run.json")), false);
      assert.equal(readFileSync(join(linked.runDir, "run.json"), "utf8").includes(linked.runId), true);
      assert.equal(launches, 0);
    } finally { cleanup(linked.repo); }

    const empty = createV2Fixture("publication-empty-race", { accepted: ["A"], mergeOrder: ["A"] });
    const emptyRunId = "publication-empty-race-next";
    const emptyTarget = join(empty.repo, ".opencode", "factory", emptyRunId);
    launches = 0;
    try {
      await assert.rejects(continueFactory(empty.runId, {
        cwd: empty.repo, review: "reviewer.json", runId: emptyRunId, carryForward: true,
        afterCarryForwardTargetObservation() { mkdirSync(emptyTarget); },
        publicationRenameSync() { assert.fail("empty target must win before rename"); },
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /already exists|will not be overwritten|factory run directory/u);
      assert.equal(existsSync(emptyTarget), true);
      assert.equal(existsSync(join(emptyTarget, "run.json")), false);
      assert.equal(existsSync(join(empty.repo, ".opencode", "skills", "feature")), false);
      assert.equal(launches, 0);
    } finally { cleanup(empty.repo); }
  });

  it("revalidates parent commands and accepted decomposition after target observation before child rename", async () => {
    const fixture = createV2Fixture("publication-command-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-command-race-next";
    const planPath = join(fixture.runDir, "plan", "slices.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.integration_gate.required_commands.unshift({ program: "node", args: ["--test", "test/acceptance.test.js"] });
    writeJson(planPath, plan);
    const parentRunPath = join(fixture.runDir, "run.json");
    const parentRun = JSON.parse(readFileSync(parentRunPath, "utf8"));
    parentRun.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
    writeJson(parentRunPath, parentRun);
    let launches = 0;
    try {
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        afterCarryForwardTargetObservation() {
          const changed = JSON.parse(readFileSync(planPath, "utf8"));
          changed.integration_gate.required_commands[0].args[1] = "test/other.test.js";
          writeJson(planPath, changed);
        },
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /plan|decomposition|authority|changed/u);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      assert.equal(launches, 0);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("recovers exact publication across both atomic rename crash boundaries", async () => {
    const before = createV2Fixture("publication-crash-before", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      await assert.rejects(continueFactory(before.runId, {
        cwd: before.repo, review: "reviewer.json", runId: "publication-crash-before-next", carryForward: true,
        beforeCarryForwardRename() { throw new Error("crash before publication rename"); },
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /crash before publication rename/u);
      assert.equal(existsSync(join(before.repo, ".opencode", "factory", "publication-crash-before-next")), false);
      const retried = await continueFactory(before.runId, { cwd: before.repo, review: "reviewer.json", runId: "publication-crash-before-next", carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      assert.deepEqual(retried.publication, { published: true, replayed: false });
    } finally { cleanup(before.repo); }

    const after = createV2Fixture("publication-crash-after", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-crash-after-next";
    try {
      await assert.rejects(continueFactory(after.runId, {
        cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        afterCarryForwardPublish() { throw new Error("crash after publication rename"); },
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /crash after publication rename/u);
      const published = validateRun(JSON.parse(readFileSync(join(after.repo, ".opencode", "factory", childRunId, "run.json"), "utf8")));
      assert.equal(published.run_id, childRunId);
      const replay = await continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      assert.deepEqual(replay.publication, { published: true, replayed: true });
    } finally { cleanup(after.repo); }
  });

  it("closes carry-forward configuration defaults, overrides, conflicts, and replay", async () => {
    const fixture = createV2Fixture("carry-config", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-config-next";
    try {
      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, headless: true,
        ghAccount: "octo-org", draft: true, postPrCi: true, reviewer: "reviewer-login", postPrPollSeconds: 45,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const child = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8"));
      assert.equal(child.mode, "headless");
      assert.equal(child.github_account, "octo-org");
      assert.equal(child.pr_mode, "draft");
      assert.equal(child.post_pr.policy.enabled, true);
      assert.equal(child.post_pr.policy.initial_poll_ms, 45_000);
      assert.deepEqual(child.post_pr.policy.review, { required: true, reviewer_login: "reviewer-login", source: "driver" });
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.driver.post_pr_ci.initial_poll_ms, 45_000);
      const equalResume = await resumeFactory(childRunId, {
        cwd: fixture.repo,
        dryRun: true,
        headless: true,
        ghAccount: "octo-org",
        draft: true,
        postPrCi: true,
        reviewer: "reviewer-login",
        postPrPollSeconds: 45,
      });
      assert.equal(equalResume.status, "dry-run");
      const beforeResumeConflict = readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"));
      for (const [label, conflict] of [
        ["mode", { autonomous: true }],
        ["account", { ghAccount: "different" }],
        ["PR", { ready: true }],
        ["post-PR", { noPostPrCi: true }],
        ["reviewer", { postPrCi: true, reviewer: "different-reviewer" }],
      ]) {
        await assert.rejects(
          resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true, ...conflict }),
          /conflicts with published immutable configuration/u,
          label,
        );
      }
      await assert.rejects(
        startFactory([`resume ${childRunId}`], { cwd: fixture.repo, autonomous: true }),
        /mode conflicts with published immutable configuration/u,
      );
      assert.deepEqual(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json")), beforeResumeConflict);
      await assert.rejects(async () => continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, headless: true,
        ghAccount: "different", draft: true, postPrCi: true, reviewer: "reviewer-login", postPrPollSeconds: 45,
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /conflicts with published immutable configuration/u);
      assert.equal(JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8")).github_account, "octo-org");
    } finally { cleanup(fixture.repo); }

    for (const row of [
      {
        label: "defaults",
        options: {},
        expected: { mode: "interactive", github_account: null, pr_mode: "ready", postPrEnabled: false, phase: "disabled", ready: true },
      },
      {
        label: "autonomous ready enabled",
        options: { autonomous: true, ready: true, postPrCi: true },
        expected: { mode: "autonomous", github_account: null, pr_mode: "ready", postPrEnabled: true, phase: "awaiting-pr", ready: true },
      },
      {
        label: "detached no-draft",
        options: { detached: true, noDraft: true, ghAccount: "explicit-owner" },
        expected: { mode: "headless", github_account: "explicit-owner", pr_mode: "ready", postPrEnabled: false, phase: "disabled", ready: true },
      },
    ]) {
      const matrix = createV2Fixture(`carry-config-${row.label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        const runId = `${matrix.runId}-next`;
        const published = await continueFactory(matrix.runId, {
          cwd: matrix.repo,
          review: "reviewer.json",
          runId,
          carryForward: true,
          ...row.options,
          foregroundLaunchFn: async () => ({ status: "started" }),
          detachedLaunchFn: async () => ({ status: "started" }),
        });
        const child = JSON.parse(readFileSync(join(matrix.repo, ".opencode", "factory", runId, "run.json"), "utf8"));
        assert.equal(child.mode, row.expected.mode, row.label);
        assert.equal(child.github_account, row.expected.github_account, row.label);
        assert.equal(child.pr_mode, row.expected.pr_mode, row.label);
        assert.equal(child.post_pr.policy.enabled, row.expected.postPrEnabled, row.label);
        assert.equal(child.post_pr.phase, row.expected.phase, row.label);
        assert.equal(child.post_pr.attempt, 0, row.label);
        assert.deepEqual(child.post_pr.evidence_refs, [], row.label);
        assert.equal(published.payload.driver.ready, row.expected.ready, row.label);
      } finally { cleanup(matrix.repo); }
    }

    const remoteAccount = createV2Fixture("carry-config-remote-account", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const localOrigin = gitStdout(remoteAccount.repo, ["config", "--get", "remote.origin.url"]);
      const githubOrigin = "https://github.com/remote-owner/example.git";
      runGit(remoteAccount.repo, ["config", `url.${localOrigin}.insteadOf`, githubOrigin]);
      runGit(remoteAccount.repo, ["remote", "set-url", "origin", githubOrigin]);
      const runId = `${remoteAccount.runId}-next`;
      await continueFactory(remoteAccount.runId, {
        cwd: remoteAccount.repo,
        review: "reviewer.json",
        runId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const child = JSON.parse(readFileSync(join(remoteAccount.repo, ".opencode", "factory", runId, "run.json"), "utf8"));
      assert.equal(child.github_account, "remote-owner");
    } finally { cleanup(remoteAccount.repo); }

    for (const [label, opts] of [
      ["mode", { autonomous: true, headless: true }], ["PR", { draft: true, ready: true }], ["post-PR", { postPrCi: true, noPostPrCi: true }],
      ["account", { ghAccount: "one", ghAccountOccurrences: 2 }],
    ]) {
      const conflict = createV2Fixture(`carry-config-conflict-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        assert.throws(() => continueFactory(conflict.runId, { cwd: conflict.repo, review: "reviewer.json", runId: `${conflict.runId}-next`, carryForward: true, ...opts }), /conflict|only one|only once|mutually exclusive/u, label);
        assert.equal(gitStdout(conflict.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "", label);
      } finally { cleanup(conflict.repo); }
    }
  });

  it("preserves progressed remaining slices and returns terminal children without relaunch", async () => {
    const fixture = createV2Fixture("carry-progress", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-progress-next";
    let launches = 0;
    const launch = async () => { launches += 1; return { status: "started" }; };
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const beforeAcceptedMutation = readFileSync(join(childDir, "run.json"));
      await assert.rejects(transitionRunSlice(childDir, "A", (slice) => { slice.status = "running"; slice.attempts += 1; }), /cannot transition from merged|immutable/u);
      assert.deepEqual(readFileSync(join(childDir, "run.json")), beforeAcceptedMutation);
      await transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.branch = `${childRunId}--B`; slice.worktree = ".opencode/worktrees/B"; slice.attempts = 1; });
      const progressedBytes = readFileSync(join(childDir, "run.json"));
      const resumed = await resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true });
      assert.equal(resumed.payload.resume.schema_version, 2);
      assert.equal(resumed.payload.driver.mode, "interactive");
      assert.equal(resumed.payload.driver.ready, true);
      assertPublishedCarryForwardRun(fixture.repo, JSON.parse(progressedBytes.toString("utf8")).continuation, { driver: resumed.payload.driver });
      const decodedResume = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(resumed.payload)).toString("base64url")}`, { repo: fixture.repo });
      assert.equal(decodedResume.ok, true, JSON.stringify(decodedResume));
      assert.equal(Object.hasOwn(decodedResume.payload.driver, "run_id"), false);
      assert.deepEqual(decodedResume.payload.driver, resumed.payload.driver);
      assert.deepEqual(readFileSync(join(childDir, "run.json")), progressedBytes);
      const replay = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.deepEqual(replay.publication, { published: true, replayed: true });
      assert.deepEqual(readFileSync(join(childDir, "run.json")), progressedBytes);
      const terminal = JSON.parse(progressedBytes.toString("utf8"));
      terminal.status = "blocked";
      terminal.terminal_result = { status: "blocked", run_id: childRunId, pr_url: null, reason: "remaining work blocked", summary: "blocked", artifacts: {} };
      writeJson(join(childDir, "run.json"), terminal);
      const terminalReplay = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.equal(terminalReplay.status, "blocked");
      assert.equal(terminalReplay.launched, false);
      assert.equal(launches, 2);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects test-verifier progress until the published v2 child projection is complete", async () => {
    const fixture = createV2Fixture("carry-public-test-verifier", { accepted: ["A", "C"], mergeOrder: ["C", "A"] });
    const childRunId = "carry-public-test-verifier-next";
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const beforeMerged = runCli(fixture.repo, ["factory", "step", childRunId, "test-verifier", "running", "--attempts", "1", "--json"]);
      assert.notEqual(beforeMerged.status, 0);
      assert.match(beforeMerged.stderr, /whole-story route requires a complete merged slice projection/u);

      const childFile = join(fixture.repo, ".opencode", "factory", childRunId, "run.json");
      const child = JSON.parse(readFileSync(childFile, "utf8"));
      Object.assign(child.slices.find((slice) => slice.id === "B"), writeMergedSliceFixture(dirname(childFile), "B", child.continuation.carry_forward.start_commit));
      writeJson(childFile, child);
      const afterMerged = runCli(fixture.repo, ["factory", "step", childRunId, "test-verifier", "running", "--attempts", "1", "--json"]);
      assert.equal(afterMerged.status, 0, afterMerged.stderr);
      assert.equal(JSON.parse(afterMerged.stdout).step.status, "running");
      const childDir = dirname(childFile);
      const head = gitStdout(fixture.repo, ["rev-parse", `refs/heads/${childRunId}^{commit}`]);
      writeFileSync(join(childDir, "artifacts", "test-report.md"), "canonical integration pass\n");
      writeJson(join(childDir, "evidence", "test-verifier.attempt-1.json"), {
        subject: "test-verifier", attempt: 1, status: "pass", review_ready: true, head_sha: head,
        commands: JSON.parse(readFileSync(join(childDir, "plan", "slices.json"), "utf8")).integration_gate.required_commands.map((command) => ({ ...command, status: "pass" })),
      });
      writeJson(join(childDir, "reviews", "test-verifier.attempt-1.json"), {
        subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [],
      });
      const beforeCallerEvidence = readFileSync(childFile);
      const accepted = runCli(fixture.repo, [
        "factory", "step", childRunId, "test-verifier", "accepted", "--attempts", "1",
        "--artifact-ref", "artifacts/test-report.md", "--evidence-ref", "evidence/test-verifier.attempt-1.json",
        "--review-ref", "reviews/test-verifier.attempt-1.json", "--json",
      ]);
      assert.notEqual(accepted.status, 0, "caller-authored evidence must not create schema-v2 acceptance authority");
      assert.deepEqual(readFileSync(childFile), beforeCallerEvidence);
      rmSync(join(childDir, "evidence", "test-verifier.attempt-1.json"));
      const checked = await executeCheckedTestExecution(childDir, {
        env: { PATH: "/fixture/bin" }, now: "2026-07-17T12:00:00.000Z",
        spawnFn() {
          const childProcess = new EventEmitter();
          childProcess.stdout = new PassThrough();
          childProcess.stderr = new PassThrough();
          childProcess.kill = () => true;
          queueMicrotask(() => childProcess.emit("close", 0, null));
          return childProcess;
        },
      });
      assert.equal(checked.status, "pass");
      assert.equal(checked.receipt_ref, "evidence/test-verifier.attempt-1.json");
      const acceptedChecked = runCli(fixture.repo, [
        "factory", "step", childRunId, "test-verifier", "accepted", "--attempts", "1",
        "--artifact-ref", "artifacts/test-report.md", "--evidence-ref", checked.receipt_ref,
        "--review-ref", "reviews/test-verifier.attempt-1.json", "--json",
      ]);
      assert.equal(acceptedChecked.status, 0, acceptedChecked.stderr);
      const acceptedStep = JSON.parse(acceptedChecked.stdout).step;
      assert.equal(acceptedStep.execution_claim.state, "completed");
      assert.equal(acceptedStep.execution_claim.status, "pass");
      assert.match(acceptedStep.execution_claim_hash, /^sha256:[0-9a-f]{64}$/u);
      assert.deepEqual(Object.keys(acceptedStep.acceptance).sort(), ["artifact_hash", "artifact_ref", "evidence_hash", "evidence_ref", "review_hash", "review_ref", "reviewed_head_sha"]);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects schema downgrade and resume-policy override ingress", async () => {
    const fixture = createV2Fixture("carry-schema-ingress", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-schema-ingress-next";
    try {
      const published = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const downgraded = structuredClone(published.payload);
      downgraded.continuation.schema_version = 1;
      delete downgraded.continuation.carry_forward;
      const decodedDowngrade = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(downgraded)).toString("base64url")}`, { repo: fixture.repo });
      assert.deepEqual(decodedDowngrade, { ok: false, reason: "invalid-continuation-schema" });

      const resumed = await resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true });
      const downgradedResume = structuredClone(resumed.payload);
      downgradedResume.resume.schema_version = 1;
      delete downgradedResume.driver.post_pr_ci;
      const decodedResume = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(downgradedResume)).toString("base64url")}`, { repo: fixture.repo });
      assert.deepEqual(decodedResume, { ok: false, reason: "resume-schema-route-mismatch" });

      const policyOverride = structuredClone(resumed.payload);
      policyOverride.resume.post_pr_policy.enabled = true;
      const decodedPolicy = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(policyOverride)).toString("base64url")}`, { repo: fixture.repo });
      assert.deepEqual(decodedPolicy, { ok: false, reason: "unpublished-or-mismatched-carry-forward-resume" });
    } finally { cleanup(fixture.repo); }
  });

  it("reads factory continuation blobs structurally without reconstructing their JSON bytes", async () => {
    const fixture = createV2Fixture("carry-structural-git-blobs", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-structural-git-blobs-next";
    try {
      const published = await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const continuation = published.payload.continuation;
      const claimRef = expectedClaim(continuation).claimRef;
      const reservationRef = continuationReservationRef(childRunId);
      const claim = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", claimRef]));
      const reservation = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", reservationRef]));
      const canonicalClaimOid = refOid(fixture.repo, claimRef);
      const canonicalReservationOid = refOid(fixture.repo, reservationRef);
      const structuralClaimOid = writeBlob(fixture.repo, `${JSON.stringify(claim, null, 2)}\n`);
      const structuralReservationOid = writeBlob(fixture.repo, `${JSON.stringify(reservation, null, 2)}\n`);
      updateRef(fixture.repo, claimRef, structuralClaimOid);
      updateRef(fixture.repo, reservationRef, structuralReservationOid);
      assert.notEqual(structuralClaimOid, canonicalClaimOid);
      assert.notEqual(structuralReservationOid, canonicalReservationOid);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const replay = await resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true });
        assert.equal(replay.status, "dry-run");
        assert.equal(refOid(fixture.repo, claimRef), structuralClaimOid);
        assert.equal(refOid(fixture.repo, reservationRef), structuralReservationOid);
      }
    } finally { cleanup(fixture.repo); }
  });

  it("rejects malformed, cross-bound, conflicting, and drifted continuation Git records", async () => {
    const fixture = createV2Fixture("carry-structural-git-rejections", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-structural-git-rejections-next";
    try {
      const published = await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const continuation = published.payload.continuation;
      const claimRef = expectedClaim(continuation).claimRef;
      const reservationRef = continuationReservationRef(childRunId);
      const claim = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", claimRef]));
      const reservation = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", reservationRef]));
      const claimOid = refOid(fixture.repo, claimRef);
      const reservationOid = refOid(fixture.repo, reservationRef);
      const rejectResume = async (label, ref, oid, pattern) => {
        updateRef(fixture.repo, ref, oid);
        await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), pattern, label);
        updateRef(fixture.repo, claimRef, claimOid);
        updateRef(fixture.repo, reservationRef, reservationOid);
      };

      await rejectResume("closed reservation shape", reservationRef, writeBlob(fixture.repo, canonicalJson({ ...reservation, extra: true })), /reservation is malformed/u);
      await rejectResume("reservation target binding", reservationRef, writeBlob(fixture.repo, canonicalJson({ ...reservation, child_run_id: "other-child" })), /reservation is malformed/u);
      await rejectResume("reservation authority hash", reservationRef, writeBlob(fixture.repo, canonicalJson({ ...reservation, authority_hash: `sha256:${"f".repeat(64)}` })), /route-mismatch|stale|cross-schema/u);
      await rejectResume("reservation object type", reservationRef, continuation.target.base_commit, /reservation is malformed/u);
      await rejectResume("closed claim shape", claimRef, writeBlob(fixture.repo, canonicalJson({ ...claim, extra: true })), /malformed permanent claim/u);
      await rejectResume("claim object type", claimRef, continuation.target.base_commit, /malformed permanent claim/u);
      await rejectResume("claim parent hash binding", claimRef, writeBlob(fixture.repo, canonicalJson({ ...claim, parent_identity: { ...claim.parent_identity, parent_run_hash: `sha256:${"f".repeat(64)}` } })), /malformed permanent claim|identity mismatch/u);
      await rejectResume("claim target binding", claimRef, writeBlob(fixture.repo, canonicalJson({ ...claim, child_run_id: "other-child" })), /permanent claim is missing/u);

      const conflicting = structuredClone(claim);
      conflicting.parent_identity.parent_run_hash = `sha256:${"e".repeat(64)}`;
      const conflictingRef = `refs/opencode/continuations/${canonicalHash(conflicting.parent_identity).slice("sha256:".length)}`;
      updateRef(fixture.repo, conflictingRef, writeBlob(fixture.repo, canonicalJson(conflicting)));
      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /multiple permanent continuation claims/u);
      runGit(fixture.repo, ["update-ref", "-d", conflictingRef]);

      const drifted = { ...claim, child_branch_ref: "refs/heads/other-child" };
      updateRef(fixture.repo, claimRef, writeBlob(fixture.repo, canonicalJson(drifted)));
      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /identity mismatch/u);
      assert.notEqual(refOid(fixture.repo, claimRef), claimOid, "replay drift must remain visible and unmodified");
    } finally { cleanup(fixture.repo); }
  });

  it("rejects a foreign claim targeting an absent v2 child before allocation side effects", () => {
    const fixture = createV2Fixture("carry-foreign-child-claim", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-foreign-child-claim-next";
    try {
      const candidate = buildContinuation(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
      });
      const foreign = expectedClaim(candidate).claim;
      foreign.parent_identity.parent_run_hash = `sha256:${"f".repeat(64)}`;
      const foreignBytes = canonicalJson(foreign);
      const foreignRef = `refs/opencode/continuations/${createHash("sha256").update(canonicalJson(foreign.parent_identity)).digest("hex")}`;
      updateRef(fixture.repo, foreignRef, writeBlob(fixture.repo, foreignBytes));

      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
      }), /foreign schema-v2 claim/u);
      assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      assert.deepEqual(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]).split("\n"), [foreignRef]);
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuation-targets"]), "");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reproduces post-publication and recovery authority gaps without launching or writing", async () => {
    for (const [label, mutate, fixtureOptions = {}] of [
      ["parent", (fixture) => writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `)],
      ["plan", (fixture) => writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}")],
      ["sidecar", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "A.json"), "{}\n")],
      ["parent-branch", (fixture) => runGit(fixture.repo, ["commit", "--allow-empty", "-m", "post-publication parent branch race"])],
      ["panel", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "security.json"), "{}\n"), { panels: true }],
      ["origin", (fixture) => {
        runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "post-publication origin race"]);
        runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
      }],
      ["claim", (fixture, state) => updateRef(fixture.repo, state.allocation.claim_ref, writeBlob(fixture.repo, "{}"))],
      ["child-branch", (fixture, state) => updateRef(fixture.repo, state.allocation.child_branch_ref, fixture.baseCommit)],
      ["worktree", (fixture, state) => runGit(state.continuation.target.worktree, ["checkout", "--detach", fixture.baseCommit])],
    ]) {
      const fixture = createV2Fixture(`carry-post-publication-${label}`, { accepted: ["A"], mergeOrder: ["A"], ...fixtureOptions });
      const childRunId = `${fixture.runId}-next`;
      let launches = 0;
      try {
        await assert.rejects(continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          afterCarryForwardPublish(state) { mutate(fixture, state); },
          foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
        }), /carry_forward authority changed|origin-base|stale-parent-base|bound plan|parent plan|parent run|parent_evidence|branch|panel|claim|worktree|sidecar|review/u, label);
        assert.equal(launches, 0, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json")), true, label);
      } finally { cleanup(fixture.repo); }
    }

    const recovery = createV2Fixture("carry-recovery-authority", { accepted: ["A"], mergeOrder: ["A"] });
    const recoveryChild = "carry-recovery-authority-next";
    try {
      await continueFactory(recovery.runId, { cwd: recovery.repo, review: "reviewer.json", runId: recoveryChild, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const childFile = join(recovery.repo, ".opencode", "factory", recoveryChild, "run.json");
      const before = readFileSync(childFile);
      writeFileSync(join(recovery.runDir, "plan", "slices.json"), "{\"slices\":[]}");
      await assert.rejects(recoverDisruptedRun(recoveryChild, { cwd: recovery.repo }), /carry_forward authority changed|bound plan/u);
      assert.deepEqual(readFileSync(childFile), before);
    } finally { cleanup(recovery.repo); }
  });

  it("rejects resume and semantic writes after merged child history is reset", async () => {
    const fixture = createV2Fixture("carry-merged-history-reset", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-merged-history-reset-next";
    try {
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childFile = join(childDir, "run.json");
      const child = JSON.parse(readFileSync(childFile, "utf8"));
      const worktree = child.worktree;
      runGit(worktree, ["commit", "--allow-empty", "-m", "merge remaining B"]);
      const mergedCommit = gitStdout(worktree, ["rev-parse", "HEAD"]);
      Object.assign(child.slices.find((slice) => slice.id === "B"), writeMergedSliceFixture(childDir, "B", mergedCommit));
      writeJson(childFile, child);
      runGit(worktree, ["reset", "--hard", child.continuation.carry_forward.start_commit]);
      const before = readFileSync(childFile);

      await assert.rejects(
        transitionRunSlice(childDir, "C", (slice) => { slice.status = "running"; slice.attempts = 1; }),
        /merged slice 'B'.*not an ancestor of exact clean child HEAD/u,
      );
      await assert.rejects(
        resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }),
        /merged slice 'B'.*not an ancestor of exact clean child HEAD/u,
      );
      assert.deepEqual(readFileSync(childFile), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("binds one exact clean child HEAD snapshot through semantic run replacement", async () => {
    const fixture = createV2Fixture("carry-semantic-head-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-semantic-head-race-next";
    try {
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childFile = join(childDir, "run.json");
      const worktree = JSON.parse(readFileSync(childFile, "utf8")).worktree;
      const before = readFileSync(childFile);

      await assert.rejects(
        transitionRunSlice(childDir, "C", (slice) => { slice.status = "running"; slice.attempts = 1; }, {
          atomicWriteHooks: { beforeCommit: () => runGit(worktree, ["commit", "--allow-empty", "-m", "race semantic publication"]) },
        }),
        (error) => error?.cause?.message === "schema-v2 local publication authority changed before mutation",
      );
      assert.deepEqual(readFileSync(childFile), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects multiple permanent claims for one published schema-v2 child", async () => {
    const fixture = createV2Fixture("carry-multiple-claims", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-multiple-claims-next";
    try {
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const existingRef = gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]);
      const existingOid = refOid(fixture.repo, existingRef);
      const duplicate = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", existingOid]));
      duplicate.parent_identity.parent_run_hash = `sha256:${"f".repeat(64)}`;
      const duplicateOid = writeBlob(fixture.repo, canonicalJson(duplicate));
      updateRef(fixture.repo, `refs/opencode/continuations/${canonicalHash(duplicate.parent_identity).slice("sha256:".length)}`, duplicateOid);

      await assert.rejects(
        resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }),
        /multiple permanent continuation claims target run/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps every copied planning byte immutable across v2 mutation, downstream, resume, and launch entry points", async () => {
    const fixture = createV2Fixture("carry-planning-immutable", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-planning-immutable-next";
    let launches = 0;
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; } });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const runFile = join(childDir, "run.json");
      const cases = [
        ["artifacts/story.md", () => transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.attempts = 1; slice.branch = `${childRunId}--B`; slice.worktree = ".opencode/worktrees/B"; })],
        ["artifacts/research-map.md", () => transitionPanelVerdicts(childDir, { validator: { verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json" }, security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" } }, { repoRoot: fixture.repo })],
        ["artifacts/design-brief.md", () => transitionPrePrFenceEstablished(childDir, {})],
        ["artifacts/technical-brief.md", () => transitionPrCreated(childDir, {}, { fenceToken: "missing-fence" })],
        ["reviews/spec-writer.json", () => resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true })],
        ["plan/slices.json", () => transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.attempts = 1; })],
        ["reviews/work-decomposer.json", () => resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true })],
      ];
      for (const [ref, invoke] of cases) {
        const path = join(childDir, ref);
        const original = readFileSync(path);
        const before = readFileSync(runFile);
        writeFileSync(path, `${original.toString("utf8")}drift\n`);
        await assert.rejects(async () => invoke(), /published inherited planning bytes changed|published inherited spec review bytes changed|published carry-forward plan bytes do not match|published carry-forward child directory is invalid/u, ref);
        assert.deepEqual(readFileSync(runFile), before, ref);
        writeFileSync(path, original);
      }

      const storyPath = join(childDir, "artifacts", "story.md");
      const story = readFileSync(storyPath);
      writeFileSync(storyPath, `${story.toString("utf8")}launch drift\n`);
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /published inherited planning bytes changed/u);
      assert.equal(launches, 1);
      writeFileSync(storyPath, story);

      const designPath = join(childDir, "artifacts", "design-brief.md");
      const design = readFileSync(designPath);
      const beforeEnv = readFileSync(runFile);
      await assert.rejects(persistFactoryRunResumeEnv(childRunId, {
        cwd: fixture.repo,
        resumeEnvHooks: { beforeWrite: () => writeFileSync(designPath, `${design.toString("utf8")}resume env race\n`) },
      }), /published inherited planning bytes changed/u);
      assert.deepEqual(readFileSync(runFile), beforeEnv);
      writeFileSync(designPath, design);
    } finally { cleanup(fixture.repo); }
  });

  it("rechecks complete v2 authority after launch ownership acquisition", async () => {
    for (const kind of ["parent", "origin"]) {
      const fixture = createV2Fixture(`carry-launch-race-${kind}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      let launches = 0;
      try {
        await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; } });
        await assert.rejects(continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          launchHooks: { afterClaimAcquired() {
            if (kind === "parent") writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `);
            else {
              runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "launch origin race"]);
              runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
            }
          } },
          foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
        }), /parent run\.json changed|origin-base|stale-parent-base/u, kind);
        assert.equal(launches, 1, kind);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "process-launch.lock", "owner.json")), false, kind);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rechecks complete v2 authority before recovery mutation", async () => {
    for (const kind of ["origin", "plan", "planning"]) {
      const fixture = createV2Fixture(`carry-recovery-race-${kind}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      try {
        await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
        const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
        const childFile = join(childDir, "run.json");
        const before = readFileSync(childFile);
        if (kind === "plan") writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}");
        else if (kind === "planning") writeFileSync(join(childDir, "artifacts", "research-map.md"), "drift\n");
        else {
          runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "recovery origin race"]);
          runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
        }
        await assert.rejects(recoverDisruptedRun(childRunId, { cwd: fixture.repo }), /bound plan|published inherited planning bytes changed|origin-base|stale-parent-base/u, kind);
        assert.deepEqual(readFileSync(childFile), before, kind);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("starts only dependency-ready remaining rows and never consumes adopted attempts", async () => {
    const fixture = createV2Fixture("carry-dependencies", { accepted: ["C"], mergeOrder: ["C"] });
    const childRunId = "carry-dependencies-next";
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const before = JSON.parse(readFileSync(join(childDir, "run.json"), "utf8"));
      assert.deepEqual(before.slices.map(({ id, status, attempts }) => ({ id, status, attempts })), [
        { id: "A", status: "pending", attempts: 0 }, { id: "B", status: "pending", attempts: 0 }, { id: "C", status: "merged", attempts: 1 },
      ]);
      await assert.rejects(transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.attempts = 1; }), /not dependency-ready: A/u);
      const after = JSON.parse(readFileSync(join(childDir, "run.json"), "utf8"));
      assert.equal(after.slices[1].attempts, 0);
      assert.equal(after.slices[2].attempts, 1);
    } finally { cleanup(fixture.repo); }
  });

  it("rechecks parent origin authority before schema-v2 resume mutation", async () => {
    const fixture = createV2Fixture("carry-resume-origin", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-resume-origin-next";
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const childFile = join(fixture.repo, ".opencode", "factory", childRunId, "run.json");
      const before = readFileSync(childFile);
      runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "resume origin moved"]);
      runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /stale-parent-base-moved|rebaseline-required/u);
      assert.deepEqual(readFileSync(childFile), before);
    } finally { cleanup(fixture.repo); }
  });

});

if (issue128WorkerRoute !== null) describe("issue 128 continuation executable oracle", { concurrency: true }, () => {
  if (issue128WorkerRoute === "ordinary-continuation") it("preserves an ordinary merged A2/S2 row only with its same-binding merged owner", async () => {
    const observedBaselineIds = [];
    if (issue128WorkerChunk === 0) {
      const fixtureName = `issue128-ordinary-sibling-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`;
      const fixture = createV2SiblingAuthorityFixture(fixtureName);
      const childRunId = `${fixtureName}-next`;
      try {
        const parent = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
        const parentConsumer = parent.slices.find(({ id }) => id === "consumer");
        const refs = parent.slices.flatMap((slice) => (slice.attempt_reviews || []).flatMap((entry) => [entry.evidence_ref, entry.review_ref, entry.dispatch_claim_ref, entry.dispatch_closure_ref]));
        const parentBytes = new Map(refs.map((ref) => [ref, readFileSync(join(fixture.runDir, ref))]));

        const result = await continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: fixture.continuationReviewRef,
          runId: childRunId,
          carryForward: true,
          foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
        });
        const accepted = result.payload.continuation.carry_forward.accepted_slices;
        const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
        const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
        const childConsumer = child.slices.find(({ id }) => id === "consumer");

        assert.deepEqual(accepted.map(({ id }) => id), ["owner", "consumer"]);
        assert.deepEqual(accepted.find(({ id }) => id === "consumer"), fixture.issue128Catalog.source);
        observedBaselineIds.push(fixture.issue128Catalog.id);
        assert.deepEqual(observedBaselineIds, issue128BaselineIdsForRoute("ordinary-continuation"));
        assert.deepEqual(childConsumer.attempt_reviews, parentConsumer.attempt_reviews);
        assert.deepEqual(issue128CarryForwardProjection(childConsumer), fixture.issue128Catalog.source);
        assert.deepEqual(childConsumer.effective_paths, ["src/consumer/**", "src/owner/shared.js"]);
        assert.equal(childConsumer.attempt_reviews[0].modified_extensions[0].authority, "non-conflicting-sibling");
        for (const [ref, bytes] of parentBytes) assert.deepEqual(readFileSync(join(childRunDir, ref)), bytes, ref);
      } finally { cleanup(fixture.repo); }
    }

    const mutationFixture = createV2SiblingAuthorityFixture(`issue128-ordinary-oracle-mutations-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`);
    let mutations;
    try {
      mutations = exerciseIssue128ContinuationMutations(mutationFixture, "continuation-carry-forward-accepted-slice-v2", issue128WorkerChunk, issue128WorkerChunkCount);
      assert.equal(mutations.executed, 89);
    } finally { cleanup(mutationFixture.repo); }
    process.stdout.write(`${issue128WorkerCompletion("ordinary-continuation", issue128WorkerChunk, observedBaselineIds, mutations)}\n`);
  });

  if (issue128WorkerRoute === "checkpoint-continuation") it("preserves a checkpoint-bound merged A2/S2 owner pair and rejects owner drift before publication", async () => {
    const observedBaselineIds = [];
    if (issue128WorkerChunk === 0) {
      const fixtureName = `issue128-checkpoint-sibling-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`;
      const fixture = createV2SiblingAuthorityFixture(fixtureName);
      const childRunId = `${fixtureName}-next`;
      const checkpointRow = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === "checkpoint-carry-forward-accepted-slice-v2");
      try {
        const bound = bindCheckpointContinuationFixture(fixture, "strict");
        const parent = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
        const parentConsumer = parent.slices.find(({ id }) => id === "consumer");
        const result = await continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: fixture.continuationReviewRef,
          runId: childRunId,
          carryForward: true,
          foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
        });
        const child = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8"));
        assert.deepEqual(child.checkpoint_source, bound.source);
        assert.deepEqual(result.payload.continuation.carry_forward.accepted_slices.find(({ id }) => id === "consumer"), checkpointRow.source);
        assert.deepEqual(issue128CarryForwardProjection(child.slices.find(({ id }) => id === "consumer")), checkpointRow.source);
        observedBaselineIds.push(checkpointRow.id);
        assert.deepEqual(observedBaselineIds, issue128BaselineIdsForRoute("checkpoint-continuation"));
        assert.deepEqual(child.slices.find(({ id }) => id === "consumer").attempt_reviews, parentConsumer.attempt_reviews);
        assert.equal(result.payload.continuation.carry_forward.accepted_slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0].owner_slice_id, "owner");
      } finally { cleanup(fixture.repo); }

      for (const field of ["owner_reviewed_commit", "owner_diff_base_commit"]) {
        const identity = createV2SiblingAuthorityFixture(`issue128-checkpoint-${field}-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`);
        const staleChild = `issue128-checkpoint-stale-${field}-chunk-${issue128WorkerChunk}-next`;
        try {
          bindCheckpointContinuationFixture(identity, null);
          updateRun(identity, (run) => {
            run.slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0][field] = "0".repeat(40);
          });
          const parentBytes = readFileSync(join(identity.runDir, "run.json"), "utf8");
          assert.throws(
            () => continueFactory(identity.runId, { cwd: identity.repo, review: identity.continuationReviewRef, runId: staleChild, carryForward: true, dryRun: true }),
            /owner|sibling|binding|stale|cross-bound/u,
            field,
          );
          assert.equal(readFileSync(join(identity.runDir, "run.json"), "utf8"), parentBytes, field);
          assert.equal(existsSync(join(identity.repo, ".opencode", "factory", staleChild)), false, field);
          assert.equal(refOid(identity.repo, `refs/heads/${staleChild}`), null, field);
        } finally { cleanup(identity.repo); }
      }
    }

    const mutationFixture = createV2SiblingAuthorityFixture(`issue128-checkpoint-stale-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`);
    let mutations;
    try {
      bindCheckpointContinuationFixture(mutationFixture, null);
      mutations = exerciseIssue128ContinuationMutations(mutationFixture, "checkpoint-carry-forward-accepted-slice-v2", issue128WorkerChunk, issue128WorkerChunkCount);
      assert.equal(mutations.executed, 89);
    } finally { cleanup(mutationFixture.repo); }
    process.stdout.write(`${issue128WorkerCompletion("checkpoint-continuation", issue128WorkerChunk, observedBaselineIds, mutations)}\n`);
  });

});

function runIssue128ContinuationWorker(route, testName, chunk) {
  return new Promise((resolve) => {
    const env = { ...process.env, [issue128WorkerEnv]: route, [issue128WorkerChunkEnv]: String(chunk) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "--test-name-pattern", `^${escapeRegExp(testName)}$`, currentTestPath], {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (childError) => { error = childError; });
    child.on("close", (code, signal) => resolve({ route, chunk, code, signal, error, stdout, stderr }));
  });
}

function issue128WorkerDiagnostics({ route, chunk, code, signal, error, stdout, stderr }) {
  return [
    `${route} chunk ${chunk} worker failed (code=${String(code)}, signal=${String(signal)})`,
    error ? error.stack || error.message : "",
    stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
    stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
  ].filter(Boolean).join("\n");
}

const issue128WorkerCompletionPrefix = "issue128 continuation worker complete: ";

function issue128WorkerCompletion(route, chunk, baselineIds, mutations) {
  return `${issue128WorkerCompletionPrefix}${JSON.stringify({
    route,
    chunk,
    chunk_count: issue128WorkerChunkCount,
    baseline_ids: baselineIds,
    executed: mutations.executed,
    mutation_names: mutations.mutationNames,
    mutation_digest: mutations.mutationDigest,
  })}`;
}

function parseIssue128WorkerCompletion(stdout, diagnostics) {
  const line = stdout.split("\n").find((entry) => entry.includes(issue128WorkerCompletionPrefix));
  assert.ok(line, diagnostics);
  return JSON.parse(line.slice(line.indexOf(issue128WorkerCompletionPrefix) + issue128WorkerCompletionPrefix.length));
}

function issue128MutationNamesForRoute(route) {
  const recordId = issue128WorkerRecords[route];
  const row = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === recordId);
  assert.ok(row, `${route}: registered mutation row`);
  return emitIssue128FinishAndDiscloseMutations(row).map(({ name }) => name);
}

function issue128MutationNameDigest(names) {
  return createHash("sha256").update(names.join("\0"), "utf8").digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// The carry-forward git topology (bare origin, per-slice reviewed commits,
// first-parent merges) depends only on (accepted, mergeOrder), not on runId or
// panels. It is the expensive part — ~13 git subprocesses per fixture — and the
// loop tests rebuild it many times with constant params. Build it once per
// (accepted, mergeOrder) key under a placeholder runId, then clone and rebind
// branches to the caller's runId. Commit SHAs are captured from the template
// and preserved by the copy, so the cloned repo is internally consistent and
// the runDir/run.json (written afterward, unchanged) references real commits.
const V2_TEMPLATE_RUN = "v2template";
const v2Templates = new Map();
const v2TemplateDirs = [];

function configureNonconvergentRoute(fixture) {
  const head = gitStdout(fixture.repo, ["rev-parse", `${fixture.runId}^{commit}`]);
  const evidenceRef = "evidence/B.attempt-2.json";
  const reviewRef = "reviews/B.attempt-2.json";
  const priorEvidenceRef = "evidence/B.attempt-1.json";
  const priorReviewRef = "reviews/B.attempt-1.json";
  writeJson(join(fixture.runDir, priorEvidenceRef), { subject: "B", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  writeJson(join(fixture.runDir, priorReviewRef), {
    subject: "B", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "converging", late_discovery_strike: false,
    remaining_fix_count: 1, required_fixes: ["first correction"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
  });
  writeJson(join(fixture.runDir, evidenceRef), { subject: "B", attempt: 2, status: "pass", review_ready: true, head_sha: head });
  const currentReview = {
    subject: "B", attempt: 2, reviewed_commit: head, verdict: "REJECT", convergence: "nonconvergent", late_discovery_strike: false,
    remaining_fix_count: 1, required_fixes: ["replace the missed category"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "nonconvergent", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
  };
  writeJson(join(fixture.runDir, reviewRef), currentReview);
  const priorReview = {
    attempt: 1,
    evidence_ref: priorEvidenceRef,
    evidence_hash: hashFile(join(fixture.runDir, priorEvidenceRef)),
    review_ref: priorReviewRef,
    review_hash: hashFile(join(fixture.runDir, priorReviewRef)),
    reviewed_commit: head,
    diff_base_commit: head,
    ratified_paths: [],
    verdict: "REJECT",
    convergence: "converging",
    late_discovery_strike: false,
    remaining_fix_count: 1,
  };
  const sourceReview = {
    attempt: 2,
    evidence_ref: evidenceRef,
    evidence_hash: hashFile(join(fixture.runDir, evidenceRef)),
    review_ref: reviewRef,
    review_hash: hashFile(join(fixture.runDir, reviewRef)),
    reviewed_commit: head,
    diff_base_commit: head,
    ratified_paths: [],
    verdict: "REJECT",
    convergence: "nonconvergent",
    late_discovery_strike: false,
    remaining_fix_count: 1,
  };
  updateRun(fixture, (run) => {
    run.slices[1] = {
      ...run.slices[1], status: "blocked", attempts: 2, evidence_ref: evidenceRef, review_ref: reviewRef,
      attempt_reviews: [priorReview, sourceReview], blocked_reason: "slice-review-nonconvergent",
    };
    run.terminal_result = {
      status: "blocked", run_id: fixture.runId, pr_url: null, reason: "slice-review-nonconvergent", summary: "nonconvergent", artifacts: {},
      nonconvergence: {
        schema_version: 1, kind: "slice-review-nonconvergence", slice_id: "B", source_review: sourceReview,
        continuation: { program: "feature-factory", args: ["factory", "continue", fixture.runId, "--review", reviewRef, "--run-id", "<new-run-id>", "--carry-forward", "--json"] },
      },
    };
  });
  return { head, evidenceRef, reviewRef, priorEvidenceRef, priorReviewRef, currentReview, sourceReview };
}

function configureConvergingSliceRoute(fixture) {
  const head = gitStdout(fixture.repo, ["rev-parse", `${fixture.runId}^{commit}`]);
  const evidenceRef = "evidence/B.attempt-1.json";
  const reviewRef = "reviews/B.attempt-1.json";
  writeJson(join(fixture.runDir, evidenceRef), { subject: "B", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  writeJson(join(fixture.runDir, reviewRef), {
    subject: "B", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "converging", late_discovery_strike: false,
    remaining_fix_count: 1, required_fixes: ["apply the selected correction"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
  });
  const source = {
    attempt: 1,
    evidence_ref: evidenceRef,
    evidence_hash: hashFile(join(fixture.runDir, evidenceRef)),
    review_ref: reviewRef,
    review_hash: hashFile(join(fixture.runDir, reviewRef)),
    reviewed_commit: head,
    diff_base_commit: head,
    ratified_paths: [],
    verdict: "REJECT",
    convergence: "converging",
    late_discovery_strike: false,
    remaining_fix_count: 1,
  };
  updateRun(fixture, (run) => {
    run.slices[1] = {
      ...run.slices[1], status: "blocked", attempts: 1, evidence_ref: evidenceRef, review_ref: reviewRef,
      attempt_reviews: [source], blocked_reason: "slice review rejected",
    };
  });
  return { evidenceRef, reviewRef, source };
}

// `pathPrefix` places slice files under a directory. Bare top-level files are
// classified as privileged control-plane paths, so a fixture whose slice owns
// `A.txt` cannot be used as an integration-amendment defect path; `src/A.txt`
// can. Defaults to "" so every existing caller keeps today's layout, and the
// prefix joins the cache key so prefixed and bare templates never alias.
function v2GitTemplate(accepted, mergeOrder, pathPrefix = "") {
  const key = JSON.stringify([accepted, mergeOrder, pathPrefix]);
  const cached = v2Templates.get(key);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "factory-carry-template-"));
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "test\n", "utf8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init"]);
  runGit(dir, ["init", "--bare", join(dir, ".git", "test-origin.git")]);
  runGit(dir, ["remote", "add", "origin", join(dir, ".git", "test-origin.git")]);
  runGit(dir, ["push", "origin", "main:main"]);
  const baseCommit = gitStdout(dir, ["rev-parse", "main^{commit}"]);
  runGit(dir, ["checkout", "-b", V2_TEMPLATE_RUN, baseCommit]);
  const reviewedCommits = {};
  const mergeCommits = {};
  for (const id of accepted) {
    runGit(dir, ["checkout", "-b", `${V2_TEMPLATE_RUN}--${id}`, baseCommit]);
    const slicePath = `${pathPrefix}${id}.txt`;
    mkdirSync(dirname(join(dir, slicePath)), { recursive: true });
    writeFileSync(join(dir, slicePath), `${id}\n`);
    runGit(dir, ["add", slicePath]);
    runGit(dir, ["commit", "-m", `reviewed ${id}`]);
    reviewedCommits[id] = gitStdout(dir, ["rev-parse", "HEAD"]);
  }
  runGit(dir, ["checkout", V2_TEMPLATE_RUN]);
  for (const id of mergeOrder) {
    runGit(dir, ["merge", "--no-ff", "--no-edit", `${V2_TEMPLATE_RUN}--${id}`]);
    mergeCommits[id] = gitStdout(dir, ["rev-parse", "HEAD"]);
  }
  const template = { dir, baseCommit, reviewedCommits, mergeCommits };
  // Teardown must never observe and remove a template still being built.
  v2TemplateDirs.push(dir);
  v2Templates.set(key, template);
  return template;
}

function createV2Fixture(runId, { accepted = ["A"], mergeOrder = accepted, panels = false, fixturePrefix = "factory-carry-forward-", pathPrefix = "" } = {}) {
  const repo = mkdtempSync(join(tmpdir(), fixturePrefix));
  const template = v2GitTemplate(accepted, mergeOrder, pathPrefix);
  cpSync(template.dir, repo, { recursive: true });
  // Repoint the copied bare origin at this repo's copy, not the template's.
  runGit(repo, ["remote", "set-url", "origin", join(repo, ".git", "test-origin.git")]);
  const { baseCommit, reviewedCommits, mergeCommits } = template;
  // Recreate the runId-named branches at the captured SHAs, then remove the
  // placeholder branches so no template-named refs linger.
  for (const id of accepted) runGit(repo, ["branch", `${runId}--${id}`, reviewedCommits[id]]);
  const tip = mergeOrder.length ? mergeCommits[mergeOrder[mergeOrder.length - 1]] : baseCommit;
  runGit(repo, ["checkout", "-b", runId, tip]);
  runGit(repo, ["branch", "-D", V2_TEMPLATE_RUN, ...accepted.map((id) => `${V2_TEMPLATE_RUN}--${id}`)]);

  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeFileSync(join(runDir, "artifacts", "research-map.md"), "research\n");
  writeFileSync(join(runDir, "artifacts", "design-brief.md"), "design\n");
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted brief\n");
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "blocked\n");
  writeJson(join(runDir, "reviews", "spec-writer.json"), createReviewRecord({ subject: "spec-writer", verdict: "APPROVE", required_fixes: [], summary: "accepted planning" }));
  writeJson(join(runDir, "reviews", "reviewer.json"), { ...createReviewRecord({ subject: runId, attempt: 1, verdict: "NO-GO", required_fixes: undefined, summary: "needs continuation" }), reviewed_head_sha: tip });
  writeJson(join(runDir, "reviews", "security.json"), { subject: runId, attempt: 1, verdict: "BLOCK", reviewed_head_sha: tip });
  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [
      { id: "A", stack: "backend", paths: [`${pathPrefix}A.txt`], depends_on: [], acceptance: ["A accepted"], test_plan: ["test A"] },
      { id: "B", stack: "backend", paths: [`${pathPrefix}B.txt`], depends_on: ["A"], acceptance: ["B accepted"], test_plan: ["test B"] },
      { id: "C", stack: "backend", paths: [`${pathPrefix}C.txt`], depends_on: [], acceptance: ["C accepted"], test_plan: ["test C"] },
    ],
  });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  // `attempt` must equal the accepted step's `attempts` for any consumer that
  // checks decomposition authority with requireApprovingReview. The acceptance
  // review_hash below is derived from these bytes, so this stays self-consistent.
  writeJson(join(runDir, "reviews", "work-decomposer.json"), createReviewRecord({ subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [], summary: "accepted decomposition" }));

  const slices = plan.slices.map((planned) => {
    if (!accepted.includes(planned.id)) return { id: planned.id, stack: planned.stack, depends_on: planned.depends_on, declared_paths: [...planned.paths], effective_paths: [...planned.paths], status: "pending", attempts: 0 };
    const evidenceRef = `evidence/${planned.id}.json`;
    const familyEvidenceRef = `evidence/${planned.id}.family.json`;
    const reviewRef = `reviews/${planned.id}.json`;
    writeJson(join(runDir, evidenceRef), { subject: planned.id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommits[planned.id] });
    const evidenceHash = hashFile(join(runDir, evidenceRef));
    const familyEvidence = writeFamilyReceipt(runDir, runId, plan, planned.id, 1, reviewedCommits[planned.id], familyEvidenceRef);
    writeJson(join(runDir, reviewRef), {
      subject: planned.id, attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
      required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommits[planned.id],
      invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: planned.id, reviewedCommit: reviewedCommits[planned.id], evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash }),
    });
    const reviewHash = hashFile(join(runDir, reviewRef));
    const attemptReview = {
      attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
      reviewed_commit: reviewedCommits[planned.id], diff_base_commit: baseCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    };
    return {
      id: planned.id, stack: planned.stack, depends_on: planned.depends_on, declared_paths: [...planned.paths], effective_paths: [...planned.paths], status: "merged", attempts: 1,
      evidence_ref: evidenceRef, evidence_hash: evidenceHash,
      review_ref: reviewRef, review_hash: reviewHash,
      reviewed_commit: reviewedCommits[planned.id], merge_commit: mergeCommits[planned.id],
      attempt_reviews: [attemptReview],
    };
  });
  const run = createRunRecord({
    run_id: runId,
    status: "blocked",
    base_ref: "main",
    base_commit: baseCommit,
    branch: runId,
    worktree: repo,
    slices,
    steps: [
      {
        agent: "spec-writer", status: "accepted", attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
        acceptance: {
          artifact_ref: "artifacts/technical-brief.md", artifact_hash: hashFile(join(runDir, "artifacts", "technical-brief.md")),
          review_ref: "reviews/spec-writer.json", review_hash: hashFile(join(runDir, "reviews", "spec-writer.json")),
        },
      },
      {
        agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
          review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
        },
      },
    ],
    validator: {
      verdict: "NO-GO",
      report: "artifacts/validation-report.md",
      report_hash: hashFile(join(runDir, "artifacts", "validation-report.md")),
      review_ref: "reviews/reviewer.json",
      review_hash: hashFile(join(runDir, "reviews", "reviewer.json")),
      reviewed_head_sha: tip,
    },
    security_review: {
      verdict: "BLOCK",
      review_ref: "reviews/security.json",
      review_hash: hashFile(join(runDir, "reviews", "security.json")),
      reviewed_head_sha: tip,
    },
    terminal_result: { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} },
  });
  if (panels) {
    const startCommit = gitStdout(repo, ["rev-parse", `${runId}^{commit}`]);
    writeFileSync(join(runDir, "artifacts", "validation-report.md"), "validation\n");
    writeJson(join(runDir, "reviews", "reviewer.json"), { subject: runId, attempt: 1, verdict: "NO-GO", reviewed_head_sha: startCommit, summary: "needs continuation" });
    writeJson(join(runDir, "reviews", "security.json"), { subject: runId, attempt: 1, verdict: "BLOCK", reviewed_head_sha: startCommit });
    run.validator = {
      verdict: "NO-GO", report: "artifacts/validation-report.md", review_ref: "reviews/reviewer.json",
      report_hash: hashFile(join(runDir, "artifacts", "validation-report.md")), review_hash: hashFile(join(runDir, "reviews", "reviewer.json")), reviewed_head_sha: startCommit,
    };
    run.security_review = { verdict: "BLOCK", review_ref: "reviews/security.json", review_hash: hashFile(join(runDir, "reviews", "security.json")), reviewed_head_sha: startCommit };
  }
  writeJson(join(runDir, "run.json"), run);
  const actualMergeOrder = gitStdout(repo, ["rev-list", "--first-parent", "--reverse", `${baseCommit}..${runId}`]).split("\n").filter(Boolean);
  return { repo, runDir, runId, baseCommit, reviewedCommits, mergeCommits, actualMergeOrder };
}

function createV2SiblingAuthorityFixture(runId) {
  const fixture = createV2Fixture("issue128-oracle", { accepted: [], mergeOrder: [], fixturePrefix: `${runId}-` });
  const catalog = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === "continuation-carry-forward-accepted-slice-v2");
  const staticRepo = createIssue128ContinuationGit();
  runGit(fixture.repo, ["fetch", staticRepo, "+refs/heads/*:refs/issue128-static/*"]);
  const baseCommit = "8b20ea435c507974bec4acb19f81e17969a8cf23";
  const ownerReviewed = catalog.source.attempt_reviews[0].modified_extensions[0].owner_reviewed_commit;
  const ownerMerge = "84ae9626ea3f547d151a9bc024393e5737805355";
  runGit(fixture.repo, ["update-ref", "refs/heads/issue128-owner", ownerReviewed]);
  runGit(fixture.repo, ["update-ref", "refs/heads/issue128-consumer", catalog.source.reviewed_commit]);
  runGit(fixture.repo, ["update-ref", "refs/heads/issue128-oracle", catalog.source.merge_commit]);
  runGit(fixture.repo, ["update-ref", "refs/heads/main", baseCommit]);
  runGit(fixture.repo, ["checkout", "-q", "issue128-oracle"]);
  runGit(fixture.repo, ["push", "--force", "origin", `${baseCommit}:main`]);
  cleanup(staticRepo);

  const plan = withDeliveryEnvelope({
    slices: [
      { id: "owner", stack: "backend", paths: ["src/owner/**"], depends_on: [], acceptance: ["owner"], test_plan: ["node --test owner"] },
      { id: "consumer", stack: "backend", paths: ["src/consumer/**"], depends_on: ["owner"], acceptance: ["consumer"], test_plan: ["node --test consumer"] },
      { id: "remaining", stack: "backend", paths: ["src/remaining/**"], depends_on: ["consumer"], acceptance: ["remaining"], test_plan: ["node --test remaining"] },
    ],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  const planPath = join(fixture.runDir, "plan", "slices.json");
  writeJson(planPath, plan);
  const family = writeFamilyReceipt(fixture.runDir, fixture.runId, plan, "owner", 1, ownerReviewed, "evidence/owner.family.json");
  assert.equal(family.hash, JSON.parse(catalog.external_sources.owner_review.bytes).invariant_family_ledger.dispositions[0].evidence_hash);
  const sidecars = new Map();
  for (const source of Object.values(catalog.external_sources)) {
    if (sidecars.has(source.ref)) continue;
    const path = join(fixture.runDir, source.ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source.bytes, "utf8");
    assert.equal(hashFile(path), source.hash);
    sidecars.set(source.ref, { path, bytes: source.bytes, hash: source.hash });
  }
  const extension = catalog.source.attempt_reviews[0].modified_extensions[0];
  const ownerAttempt = {
    attempt: extension.owner_attempt,
    evidence_ref: extension.owner_evidence_ref,
    evidence_hash: extension.owner_evidence_hash,
    review_ref: extension.owner_review_ref,
    review_hash: extension.owner_review_hash,
    reviewed_commit: extension.owner_reviewed_commit,
    diff_base_commit: extension.owner_diff_base_commit,
    ownership_schema_version: 2,
    ratified_paths: [],
    modified_extensions: [],
    verdict: "APPROVE",
    convergence: "converging",
    late_discovery_strike: false,
    remaining_fix_count: 0,
    dispatch_claim_ref: extension.owner_dispatch_claim_ref,
    dispatch_claim_hash: extension.owner_dispatch_claim_hash,
    dispatch_closure_ref: extension.owner_dispatch_closure_ref,
    dispatch_closure_hash: extension.owner_dispatch_closure_hash,
  };
  const fullSlice = (accepted, attempt, branch, mergeCommit) => ({
    id: accepted.id, stack: "backend", depends_on: accepted.id === "consumer" ? ["owner"] : [],
    declared_paths: accepted.declared_paths, effective_paths: accepted.effective_paths, status: "merged", attempts: accepted.attempts,
    branch, worktree: `/tmp/${branch}`, dispatch_required: true,
    dispatch_claim_ref: attempt.dispatch_claim_ref, dispatch_claim_hash: attempt.dispatch_claim_hash,
    dispatch_closure_ref: attempt.dispatch_closure_ref, dispatch_closure_hash: attempt.dispatch_closure_hash,
    evidence_ref: accepted.evidence_ref, evidence_hash: accepted.evidence_hash, review_ref: accepted.review_ref, review_hash: accepted.review_hash,
    reviewed_commit: accepted.reviewed_commit, attempt_reviews: accepted.attempt_reviews, merge_commit: mergeCommit,
  });
  const ownerAccepted = {
    id: "owner", declared_paths: ["src/owner/**"], effective_paths: ["src/owner/**"], attempts: 1,
    attempt_reviews: [ownerAttempt], evidence_ref: ownerAttempt.evidence_ref, evidence_hash: ownerAttempt.evidence_hash,
    review_ref: ownerAttempt.review_ref, review_hash: ownerAttempt.review_hash, reviewed_commit: ownerReviewed, merge_commit: ownerMerge,
  };
  const runPath = join(fixture.runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  run.slices = [
    fullSlice(ownerAccepted, ownerAttempt, "issue128-owner", ownerMerge),
    fullSlice(catalog.source, catalog.source.attempt_reviews[0], "issue128-consumer", catalog.source.merge_commit),
    { id: "remaining", stack: "backend", depends_on: ["consumer"], declared_paths: ["src/remaining/**"], effective_paths: ["src/remaining/**"], status: "pending", attempts: 0 },
  ];
  run.base_commit = baseCommit;
  run.branch = fixture.runId;
  run.worktree = fixture.repo;
  run.validator = null;
  run.security_review = null;
  run.steps.find(({ agent }) => agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
  writeJson(runPath, run);
  fixture.baseCommit = baseCommit;
  fixture.reviewedCommits = { owner: ownerReviewed, consumer: catalog.source.reviewed_commit };
  fixture.mergeCommits = { owner: ownerMerge, consumer: catalog.source.merge_commit };
  fixture.actualMergeOrder = [ownerMerge, catalog.source.merge_commit];
  fixture.issue128Catalog = catalog;
  fixture.issue128Sidecars = sidecars;
  fixture.continuationReviewRef = catalog.source.review_ref;
  assert.deepEqual(issue128CarryForwardProjection(run.slices.find(({ id }) => id === "consumer")), catalog.source, `${runId}: exact accepted source before checked continue`);
  return fixture;
}

function issue128CarryForwardProjection(slice) {
  return {
    id: slice.id,
    declared_paths: slice.declared_paths,
    effective_paths: slice.effective_paths,
    attempts: slice.attempts,
    attempt_reviews: slice.attempt_reviews,
    evidence_ref: slice.evidence_ref,
    evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref,
    review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit,
    merge_commit: slice.merge_commit,
  };
}

function createIssue128ContinuationGit() {
  const repo = mkdtempSync(join(tmpdir(), "issue128-continuation-git-"));
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "src", "owner"), { recursive: true });
  runGit(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(repo, "docs", "consumer.md"), "baseline consumer\n");
  writeFileSync(join(repo, "src", "owner", "shared.js"), "export const shared = 1;\n");
  runGit(repo, ["add", "README.md", "docs/consumer.md", "src/owner/shared.js"]);
  issue128GitCommit(repo, "2026-01-01T00:00:00Z", ["commit", "-q", "-m", "issue 128 baseline"]);
  const base = gitStdout(repo, ["rev-parse", "HEAD"]);
  assert.equal(base, "8b20ea435c507974bec4acb19f81e17969a8cf23");
  runGit(repo, ["branch", "issue128-owner", base]);
  runGit(repo, ["branch", "issue128-sibling", base]);
  runGit(repo, ["checkout", "-q", "issue128-owner"]);
  writeFileSync(join(repo, "src", "owner", "owned.js"), "export const owned = true;\n");
  runGit(repo, ["add", "src/owner/owned.js"]);
  issue128GitCommit(repo, "2026-01-01T00:01:00Z", ["commit", "-q", "-m", "issue 128 owner"]);
  assert.equal(gitStdout(repo, ["rev-parse", "HEAD"]), "ff72597376c2c7c3771198a766a1ba1c049da558");
  runGit(repo, ["checkout", "-q", "main"]);
  issue128GitCommit(repo, "2026-01-01T00:02:00Z", ["merge", "-q", "--no-ff", "-m", "merge issue 128 owner", "issue128-owner"]);
  const ownerMerge = gitStdout(repo, ["rev-parse", "HEAD"]);
  assert.equal(ownerMerge, "84ae9626ea3f547d151a9bc024393e5737805355");
  runGit(repo, ["checkout", "-q", "issue128-sibling"]);
  writeFileSync(join(repo, "src", "owner", "shared.js"), "export const shared = 2;\n");
  runGit(repo, ["add", "src/owner/shared.js"]);
  issue128GitCommit(repo, "2026-01-01T00:07:00Z", ["commit", "-q", "-m", "issue 128 sibling consumer"]);
  assert.equal(gitStdout(repo, ["rev-parse", "HEAD"]), "ddc920e780e08f2a3561d407b880f22a726b7c9d");
  runGit(repo, ["checkout", "-q", "-b", "issue128-sibling-main", ownerMerge]);
  issue128GitCommit(repo, "2026-01-01T00:08:00Z", ["merge", "-q", "--no-ff", "-m", "merge issue 128 sibling consumer", "issue128-sibling"]);
  assert.equal(gitStdout(repo, ["rev-parse", "HEAD"]), "d209b10df237a6893c2aae54e4a36676588feda9");
  return repo;
}

function issue128GitCommit(repo, date, args) {
  const proc = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Issue 128 Oracle", GIT_AUTHOR_EMAIL: "oracle@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: "Issue 128 Oracle", GIT_COMMITTER_EMAIL: "oracle@example.com", GIT_COMMITTER_DATE: date },
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function exerciseIssue128ContinuationMutations(fixture, recordId, chunk, chunkCount) {
  const row = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === recordId);
  const cases = emitIssue128FinishAndDiscloseMutations(row);
  const selectedCases = cases.map((mutation, index) => ({ mutation, index })).filter(({ index }) => index % chunkCount === chunk);
  const runPath = join(fixture.runDir, "run.json");
  const originalRun = readFileSync(runPath);
  const originalRunHash = hashFile(runPath);
  const attributionMismatches = [];
  for (const { mutation, index } of selectedCases) {
    restoreIssue128ContinuationBaseline(fixture, runPath, originalRun, originalRunHash, mutation);
    if (mutation.code === "B") {
      const source = row.external_sources[mutation.path[1]];
      const sidecar = fixture.issue128Sidecars.get(source.ref);
      writeFileSync(sidecar.path, `${sidecar.bytes} `);
    } else {
      updateRun(fixture, (run) => {
        const source = run.slices.find(({ id }) => id === (mutation.path[0] === "owner_source" ? "owner" : "consumer"));
        applyIssue128PhysicalMutation(source, mutation);
      });
    }
    const childRunId = `${fixture.runId}-oracle-${index}-next`;
    let rejection = null;
    try {
      continueFactory(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true, dryRun: true });
    } catch (error) {
      rejection = error;
    }
    const expectedCheck = recordId.startsWith("checkpoint-") ? "continueFactory checkpoint carry-forward authority" : "continueFactory ordinary carry-forward authority";
    assert.equal(mutation.expected_check, expectedCheck, `${mutation.name}: concrete checked continuation consumer`);
    assert.ok(rejection, `${mutation.name}: ${expectedCheck} must reject`);
    if (!new RegExp(mutation.expected_rejection, "iu").test(rejection.message)) {
      attributionMismatches.push(`${mutation.name}: /${mutation.expected_rejection}/ did not match ${JSON.stringify(rejection.message)}`);
    }
    assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, mutation.name);
    assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null, mutation.name);
  }
  restoreIssue128ContinuationBaseline(fixture, runPath, originalRun, originalRunHash, selectedCases.at(-1).mutation);
  assert.deepEqual(attributionMismatches, [], `${recordId}: every mutation must reach its target-specific ${cases[0].expected_check} rejection`);
  const mutationNames = selectedCases.map(({ mutation }) => mutation.name);
  return { executed: mutationNames.length, mutationNames, mutationDigest: issue128MutationNameDigest(mutationNames) };
}

function restoreIssue128ContinuationBaseline(fixture, runPath, originalRun, originalRunHash, mutation) {
  writeFileSync(runPath, originalRun);
  assert.deepEqual(readFileSync(runPath), originalRun, `${mutation.name}: exact restored parent run bytes`);
  assert.equal(hashFile(runPath), originalRunHash, `${mutation.name}: exact restored parent run hash`);
  for (const sidecar of fixture.issue128Sidecars.values()) {
    writeFileSync(sidecar.path, sidecar.bytes);
    assert.deepEqual(readFileSync(sidecar.path), Buffer.from(sidecar.bytes), `${mutation.name}: exact restored parent sidecar bytes`);
    assert.equal(hashFile(sidecar.path), sidecar.hash, `${mutation.name}: exact restored parent sidecar hash`);
  }
  if (mutation.code === "B") {
    const source = fixture.issue128Catalog.external_sources[mutation.path[1]];
    assert.equal(source.bytes, mutation.expected, `${mutation.name}: exact sidecar target before physical mutation`);
  }
}

function applyIssue128PhysicalMutation(source, mutation) {
  const path = mutation.path.slice(1);
  let owner = source;
  if (mutation.operation === "unknown-key") {
    for (const segment of path) owner = owner[segment];
    const observedBoundary = mutation.path.length === 1 && mutation.path[0] === "source" ? issue128CarryForwardProjection(owner) : owner;
    assert.deepEqual(observedBoundary, mutation.expected, `${mutation.name}: exact continuation object boundary before unsupported-key insertion`);
    assert.equal(Object.hasOwn(owner, mutation.key), false, `${mutation.name}: unsupported continuation key must be new`);
    owner[mutation.key] = mutation.value;
    assert.equal(owner[mutation.key], mutation.value, `${mutation.name}: unsupported continuation key must be physically inserted`);
    return;
  }
  for (const segment of path.slice(0, -1)) owner = owner[segment];
  const key = path.at(-1);
  assert.deepEqual(owner[key], mutation.expected, `${mutation.name}: exact continuation field before physical mutation`);
  if (mutation.code === "K") delete owner[key];
  else if (mutation.code === "V") owner[key] = typeof owner[key] === "string" ? "invalid" : "invalid-type";
  else if (mutation.code === "R") owner[key] = owner[key].startsWith("evidence/") ? "evidence/missing.json" : owner[key].startsWith("dispatch/") ? "dispatch/missing.json" : "reviews/missing.json";
  else if (mutation.code === "H") owner[key] = `sha256:${"0".repeat(64)}`;
  else if (mutation.code === "D") owner[key] = Array.isArray(owner[key]) ? [...owner[key], "synthetic/path"] : `drift-${owner[key]}`;
  else if (mutation.code === "I") owner[key] = Number.isInteger(owner[key]) ? owner[key] + 1 : owner[key]?.length === 40 ? "0".repeat(40) : "cross-bound-owner";
  else if (mutation.code === "X") owner[key] = "1".repeat(40);
  else throw new Error(`unsupported issue #128 physical mutation ${mutation.code}`);
}

function issue128BaselineIdsForRoute(route) {
  return Object.entries(ISSUE128_BASELINE_ROUTE_INVENTORY)
    .filter(([, assignment]) => assignment.route === route)
    .map(([id]) => id);
}

function bindCheckpointContinuationFixture(fixture, reviewTier) {
  const routingRunId = `${fixture.runId}-routing-parent`;
  const manifestHash = `sha256:${"a".repeat(64)}`;
  const manifestRef = `artifacts/checkpoint-routing-${manifestHash.slice("sha256:".length)}.json`;
  const decompositionReviewPath = join(fixture.runDir, "reviews", "work-decomposer.json");
  const decompositionReview = JSON.parse(readFileSync(decompositionReviewPath, "utf8"));
  decompositionReview.attempt = 1;
  writeJson(decompositionReviewPath, decompositionReview);
  const source = {
    schema_version: 1,
    kind: "delivery-checkpoint-source",
    parent_run_id: routingRunId,
    manifest_ref: manifestRef,
    manifest_hash: manifestHash,
    checkpoint_id: "checkpoint-001",
    checkpoint_ordinal: 1,
    root_child_run_id: fixture.runId,
    source_plan_ref: "plan/slices.json",
    source_plan_hash: `sha256:${"b".repeat(64)}`,
    source_review_ref: "reviews/work-decomposer.json",
    source_review_hash: `sha256:${"b".repeat(64)}`,
    source_review_attempt: 1,
    parent_review_identity_hash: `sha256:${"b".repeat(64)}`,
    child_disposition_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
    admission_probe_hash: `sha256:${"b".repeat(64)}`,
    brief_scope_hash: `sha256:${"b".repeat(64)}`,
    child_plan_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
    acceptance_mapping_hash: `sha256:${"b".repeat(64)}`,
    initial_base_ref: "refs/remotes/origin/main",
    initial_base_commit: fixture.baseCommit,
  };
  const run = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
  run.steps.find((step) => step.agent === "work-decomposer").acceptance.review_hash = hashFile(decompositionReviewPath);
  run.mode = "interactive";
  run.github_account = null;
  run.pr_mode = "ready";
  run.max_parallel_slices = 3;
  run.max_retries = 3;
  run.post_pr = continuationEligibilityPostPr("disabled", 0);
  const configuration = {
    mode: run.mode,
    github_account: run.github_account ?? null,
    pr_mode: run.pr_mode,
    max_parallel_slices: run.max_parallel_slices,
    max_retries: run.max_retries,
    post_pr_policy: structuredClone(run.post_pr.policy),
    review_tier: reviewTier,
  };
  run.checkpoint_source = structuredClone(source);
  if (reviewTier === null) delete run.review_tier;
  else run.review_tier = reviewTier;
  writeJson(join(fixture.runDir, "run.json"), run);

  const routingRunDir = join(fixture.repo, ".opencode", "factory", routingRunId);
  mkdirSync(routingRunDir, { recursive: true });
  writeJson(join(routingRunDir, "run.json"), {
    schema_version: 1,
    run_id: routingRunId,
    status: "blocked",
    gates: {},
    checkpoint_progress: {
      schema_version: 1,
      kind: "delivery-checkpoint-progress",
      manifest_ref: manifestRef,
      manifest_hash: manifestHash,
      status: "active",
      entries: [{
        state: "launched",
        checkpoint_id: source.checkpoint_id,
        ordinal: source.checkpoint_ordinal,
        root_child_run_id: source.root_child_run_id,
        branch: source.root_child_run_id,
        worktree: run.worktree,
        base_ref: "refs/remotes/origin/main",
        base_commit: fixture.baseCommit,
        predecessor_checkpoint_id: null,
        predecessor_completed_run_id: null,
        predecessor_merge_commit: null,
        configuration: structuredClone(configuration),
        publication_claim_ref: `refs/opencode/checkpoint-publications/${createHash("sha256").update(source.root_child_run_id).digest("hex")}`,
        publication_claim_oid: "a".repeat(40),
        reserved_at: "2026-07-19T12:00:00.000Z",
        child_run_hash: `sha256:${"b".repeat(64)}`,
        child_plan_hash: source.child_plan_hash,
        brief_scope_hash: source.brief_scope_hash,
        published_at: "2026-07-19T12:01:00.000Z",
        launched_at: "2026-07-19T12:02:00.000Z",
      }],
      final_closure: null,
    },
    terminal_result: {
      status: "blocked",
      run_id: routingRunId,
      pr_url: null,
      reason: "oversized-plan-checkpoint-routing-required",
      summary: "Routed to checkpoints.",
      artifacts: { checkpoint_routing: manifestRef },
    },
  });
  return { source, configuration };
}

async function createConflictCarryForwardFixture(runId) {
  const fixture = createV2Fixture(runId, { accepted: [], mergeOrder: [] });
  const sliceId = "A";
  const branch = `${runId}--${sliceId}`;
  const sliceWorktree = join(fixture.repo, ".opencode", "worktrees", `${runId}-${sliceId}`);
  runGit(fixture.repo, ["branch", branch, fixture.baseCommit]);
  mkdirSync(dirname(sliceWorktree), { recursive: true });
  runGit(fixture.repo, ["worktree", "add", sliceWorktree, branch]);
  writeFileSync(join(sliceWorktree, "A.txt"), "reviewed A bytes\n");
  runGit(sliceWorktree, ["add", "A.txt"]);
  runGit(sliceWorktree, ["commit", "-m", "reviewed conflict A"]);
  const reviewedCommit = gitStdout(sliceWorktree, ["rev-parse", "HEAD"]);

  writeFileSync(join(fixture.repo, "A.txt"), "competing integration A bytes\n");
  runGit(fixture.repo, ["add", "A.txt"]);
  runGit(fixture.repo, ["commit", "-m", "integration baseline for A"]);
  const integrationBaseline = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
  runGit(fixture.repo, ["branch", "-f", "main", integrationBaseline]);
  runGit(fixture.repo, ["push", "--force", "origin", `${integrationBaseline}:main`]);

  const evidenceRef = "evidence/A.json";
  const familyEvidenceRef = "evidence/A.family.json";
  const reviewRef = "reviews/A.json";
  writeJson(join(fixture.runDir, evidenceRef), { subject: sliceId, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const evidenceHash = hashFile(join(fixture.runDir, evidenceRef));
  const plan = JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json"), "utf8"));
  const familyEvidence = writeFamilyReceipt(fixture.runDir, runId, plan, sliceId, 1, reviewedCommit, familyEvidenceRef);
  writeJson(join(fixture.runDir, reviewRef), {
    subject: sliceId, attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0, required_fixes: [],
    ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId, reviewedCommit, evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash }),
  });
  const reviewHash = hashFile(join(fixture.runDir, reviewRef));
  const claimStem = createHash("sha256").update(`${runId}\0${sliceId}\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  const completionToken = "carry-forward-conflict-slice";
  mkdirSync(join(fixture.runDir, "dispatch"), { recursive: true });
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: runId, slice_id: sliceId, attempt: 1,
    agent: "backend-builder", branch, worktree: sliceWorktree, head: fixture.baseCommit,
    context_hash: `sha256:${"a".repeat(64)}`, completion_token_hash: `sha256:${createHash("sha256").update(completionToken).digest("hex")}`,
    claimed_at: "2026-07-18T12:00:00.000Z", closure_ref: closureRef,
  });
  const claimHash = hashFile(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash,
    run_id: runId, slice_id: sliceId, attempt: 1, agent: "backend-builder", branch, worktree: sliceWorktree,
    head: fixture.baseCommit, completion_head: reviewedCommit, context_hash: `sha256:${"a".repeat(64)}`,
    completion_token: completionToken, returned_at: "2026-07-18T12:00:00.000Z",
  });
  const closureHash = hashFile(join(fixture.runDir, closureRef));
  updateRun(fixture, (run) => {
    run.status = "running";
    run.base_commit = integrationBaseline;
    run.terminal_result = null;
    run.validator = null;
    run.security_review = null;
    run.slices[0] = {
      id: sliceId, stack: "backend", depends_on: [], declared_paths: ["A.txt"], effective_paths: ["A.txt"], status: "review", attempts: 1,
      branch, worktree: sliceWorktree, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
      reviewed_commit: reviewedCommit, dispatch_required: true, dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash,
      dispatch_closure_ref: closureRef, dispatch_closure_hash: closureHash,
      attempt_reviews: [{
        attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
        reviewed_commit: reviewedCommit, diff_base_commit: fixture.baseCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
        dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash, dispatch_closure_ref: closureRef, dispatch_closure_hash: closureHash,
      }],
    };
  });

  const merge = spawnSync("git", ["merge", "--no-ff", branch, "-m", "merge conflict A"], { cwd: fixture.repo, encoding: "utf8" });
  assert.notEqual(merge.status, 0, "carry-forward fixture merge must conflict");
  const specialToken = "carry-forward-special-conflict";
  const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: runId, route: "integration-conflict", agent: "backend-builder" }, { claimDispatch: true, completionToken: specialToken });
  writeFileSync(join(fixture.repo, "A.txt"), "delegated integrated A bytes\n");
  runGit(fixture.repo, ["add", "A.txt"]);
  runGit(fixture.repo, ["commit", "-m", "delegated conflict A"]);
  const resolutionCommit = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
  await completeSpecialBuilderTaskDispatch(fixture.repo, {
    run_id: runId, route: "integration-conflict", agent: "backend-builder", claim_ref: context.dispatch_claim.ref,
    claim_hash: context.dispatch_claim.hash, completion_token: specialToken,
  });
  const merged = await transitionSliceMerged(fixture.runDir, sliceId, { merge_commit: resolutionCommit });
  const conflict = merged.slice.integration_conflict || merged.run.integration_conflict;
  updateRun(fixture, (run) => {
    run.status = "blocked";
    run.validator = null;
    run.security_review = null;
    run.terminal_result = { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} };
  });
  return { ...fixture, baseCommit: integrationBaseline, resolutionCommit, conflict, continuationReviewRef: reviewRef };
}

function acceptedManifestRow(fixture, id) {
  const run = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
  const slice = run.slices.find((candidate) => candidate.id === id);
  return {
    id, declared_paths: structuredClone(slice.declared_paths), effective_paths: structuredClone(slice.effective_paths), attempts: slice.attempts,
    evidence_ref: slice.evidence_ref, evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref, review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit, merge_commit: slice.merge_commit, attempt_reviews: structuredClone(slice.attempt_reviews),
  };
}

function configureMultiAttemptAcceptedSlice(fixture, id) {
  const runPath = join(fixture.runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const slice = run.slices.find((candidate) => candidate.id === id);
  const reviewedCommit = slice.reviewed_commit;
  const attemptOne = {
    evidenceRef: `evidence/${id}.attempt-1.json`,
    familyEvidenceRef: `evidence/${id}.family-attempt-1.json`,
    reviewRef: `reviews/${id}.attempt-1.json`,
  };
  const attemptTwo = {
    evidenceRef: `evidence/${id}.attempt-2.json`,
    familyEvidenceRef: `evidence/${id}.family-attempt-2.json`,
    reviewRef: `reviews/${id}.attempt-2.json`,
  };
  writeJson(join(fixture.runDir, attemptOne.evidenceRef), { subject: id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const plan = JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json"), "utf8"));
  const attemptOneFamily = writeFamilyReceipt(fixture.runDir, fixture.runId, plan, id, 1, reviewedCommit, attemptOne.familyEvidenceRef);
  writeJson(join(fixture.runDir, attemptOne.reviewRef), {
    subject: id, attempt: 1, verdict: "REJECT", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 1,
    required_fixes: ["complete the first correction"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: [`${id}.txt`], fix_owner: id }] },
    reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: id, reviewedCommit, evidenceRef: attemptOne.familyEvidenceRef, evidenceHash: attemptOneFamily.hash }),
  });
  writeJson(join(fixture.runDir, attemptTwo.evidenceRef), { subject: id, attempt: 2, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const attemptTwoEvidenceHash = hashFile(join(fixture.runDir, attemptTwo.evidenceRef));
  const attemptTwoFamily = writeFamilyReceipt(fixture.runDir, fixture.runId, plan, id, 2, reviewedCommit, attemptTwo.familyEvidenceRef);
  writeJson(join(fixture.runDir, attemptTwo.reviewRef), {
    subject: id, attempt: 2, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: id, reviewedCommit, evidenceRef: attemptTwo.familyEvidenceRef, evidenceHash: attemptTwoFamily.hash }),
  });
  const history = [
    {
      attempt: 1, evidence_ref: attemptOne.evidenceRef, evidence_hash: hashFile(join(fixture.runDir, attemptOne.evidenceRef)),
      review_ref: attemptOne.reviewRef, review_hash: hashFile(join(fixture.runDir, attemptOne.reviewRef)), reviewed_commit: reviewedCommit,
      diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "REJECT", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 1,
    },
    {
      attempt: 2, evidence_ref: attemptTwo.evidenceRef, evidence_hash: attemptTwoEvidenceHash,
      review_ref: attemptTwo.reviewRef, review_hash: hashFile(join(fixture.runDir, attemptTwo.reviewRef)), reviewed_commit: reviewedCommit,
      diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    },
  ];
  Object.assign(slice, {
    attempts: 2,
    attempt_reviews: history,
    evidence_ref: history[1].evidence_ref,
    evidence_hash: history[1].evidence_hash,
    review_ref: history[1].review_ref,
    review_hash: history[1].review_hash,
    reviewed_commit: reviewedCommit,
  });
  rmSync(join(fixture.runDir, `evidence/${id}.json`));
  rmSync(join(fixture.runDir, `reviews/${id}.json`));
  writeJson(runPath, run);
  return history;
}

function writeMergedSliceFixture(runDir, id, reviewedCommit) {
  const evidenceRef = `evidence/${id}.fixture.json`;
  const familyEvidenceRef = `evidence/${id}.family-fixture.json`;
  const reviewRef = `reviews/${id}.fixture.json`;
  writeJson(join(runDir, evidenceRef), { subject: id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const evidenceHash = hashFile(join(runDir, evidenceRef));
  const plan = JSON.parse(readFileSync(join(runDir, "plan", "slices.json"), "utf8"));
  const runId = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).run_id;
  const familyEvidence = writeFamilyReceipt(runDir, runId, plan, id, 1, reviewedCommit, familyEvidenceRef);
  writeJson(join(runDir, reviewRef), {
    subject: id, attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: id, reviewedCommit, evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash }),
  });
  const reviewHash = hashFile(join(runDir, reviewRef));
  return {
    status: "merged", attempts: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
    reviewed_commit: reviewedCommit, merge_commit: reviewedCommit,
    attempt_reviews: [{ attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 }],
  };
}

function writeFamilyReceipt(runDir, runId, plan, sliceId, attempt, reviewedCommit, evidenceRef) {
  const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  const family = unit.invariant_families[0];
  const artifactId = unit.obligations.find((obligation) => obligation.invariant_family_id === family.id).verification_artifact_id;
  return writeVerificationArtifactReceipt({
    runDir, runId, plan, sliceId, attempt, reviewedCommit, artifactId, evidenceRef,
    result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
  });
}

function continuationEligibilityPostPr(phase, attempt = 0) {
  return {
    schema_version: 1,
    policy: {
      enabled: phase !== "disabled",
      wait_ms: 3_600_000,
      initial_poll_ms: 30_000,
      max_poll_ms: 120_000,
      check_start_grace_ms: 300_000,
      max_transient_errors: 12,
      review: { required: false, reviewer_login: null, source: "none" },
    },
    phase,
    attempt,
    observation: null,
    remediation: null,
    evidence_refs: [],
    continuation_review: null,
    terminal_fact: null,
    pr_operation: null,
  };
}

function continuationEligibilitySteeringFence() {
  return {
    schema_version: 1,
    generation: 0,
    pending: null,
    uncheckpointed: null,
    boundary: null,
    action_claim: null,
    last_action: null,
    pr_fence: { token: "pre-pr-token", generation: 0, state_hash: `sha256:${"a".repeat(64)}`, created_at: "2026-07-08T12:00:00.000Z" },
    history: [],
  };
}

// Every createV2Fixture starts from the identical
// init + config + README-commit repo, so it is built once per process and
// copied per fixture; five git subprocesses per fixture become one recursive
// copy. The copied .git carries the committed identity forward, so later
// commits in a fixture use the same author. The template is never handed to a
// test and is removed at process end.
let gitRepoTemplate = null;

function gitRepoTemplate_() {
  if (!gitRepoTemplate) {
    const repo = mkdtempSync(join(tmpdir(), "factory-continue-template-"));
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "test\n", "utf8");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "init"]);
    gitRepoTemplate = repo;
  }
  return gitRepoTemplate;
}

after(() => {
  if (gitRepoTemplate) rmSync(gitRepoTemplate, { recursive: true, force: true });
  for (const dir of v2TemplateDirs) rmSync(dir, { recursive: true, force: true });
});

function initGitRepo(repo) {
  cpSync(gitRepoTemplate_(), repo, { recursive: true });
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function gitStdout(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function gitStdoutPreserve(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout;
}

function expectedClaim(candidate) {
  const parentIdentity = {
    schema_version: 2,
    kind: "blocked-run-continuation-parent",
    parent_run_id: candidate.parent.run_id,
    parent_run_ref: candidate.parent.run_ref,
    parent_run_hash: candidate.parent.run_hash,
    parent_branch_ref: `refs/heads/${candidate.parent.branch}`,
    target_base_ref: candidate.target.base_ref,
    target_base_commit: candidate.target.base_commit,
    plan_ref: candidate.carry_forward.plan_ref,
    plan_hash: candidate.carry_forward.plan_hash,
    start_commit: candidate.carry_forward.start_commit,
  };
  const claimRef = `refs/opencode/continuations/${createHash("sha256").update(canonicalJson(parentIdentity)).digest("hex")}`;
  return {
    parentIdentity,
    claimRef,
    claim: {
      schema_version: 2,
      kind: "blocked-run-continuation-claim",
      parent_identity: parentIdentity,
      child_run_id: candidate.target.run_id,
      child_branch_ref: `refs/heads/${candidate.target.branch}`,
      start_commit: candidate.carry_forward.start_commit,
      ...(Object.hasOwn(candidate, "checkpoint_source_hash") ? { checkpoint_source_hash: candidate.checkpoint_source_hash, configuration_hash: candidate.configuration_hash } : {}),
    },
  };
}

function continuationReservationRef(runId) {
  return `refs/opencode/continuation-targets/${createHash("sha256").update(runId).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function writeBlob(repo, bytes) {
  const proc = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    encoding: "utf8",
    input: bytes,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function updateRef(repo, ref, oid) {
  runGit(repo, ["update-ref", ref, oid]);
}

function refOid(repo, ref) {
  const proc = spawnSync("git", ["show-ref", "--verify", "--hash", ref], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return proc.status === 0 ? proc.stdout.trim() : null;
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function updateRun(fixture, update) {
  const file = join(fixture.runDir, "run.json");
  const run = JSON.parse(readFileSync(file, "utf8"));
  update(run);
  writeJson(file, run);
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
