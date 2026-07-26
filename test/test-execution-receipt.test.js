import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";
import { executeCheckedTestExecution } from "../src/test-execution.js";
import { hashValue } from "../src/refs.js";
import {
  claimCheckedTestExecution,
  classifyWholeStoryTestRoute,
  evaluateWholeStoryRouteSink,
  markCheckedTestExecutionUnknown,
  transitionRecoverOrphan,
  transitionRunJson,
  transitionRunStep,
  transitionSteeringBoundaryOpened,
  transitionSteeringConflict,
  transitionSteeringConsumed,
  transitionSteeringQueued,
  transitionTerminalResult,
} from "../src/run-state.js";
import { validateRun, validateTestExecutionReceipt, TEST_EXECUTION_STREAM_LIMIT_BYTES } from "../src/validate.js";
import { runFixtureGit, spawnSync } from "./helpers/git-fixture.js";
import { publishSyntheticV2Parent } from "./helpers/v2-parent-fixture.js";

const NOW = "2026-07-17T12:00:00.000Z";
const LATER = "2026-07-17T12:00:01.000Z";
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

describe("checked test execution receipt", () => {
  it("evaluates every DMC1 dimension across all 26 real route-and-sink enforcement seams", () => {
    const routeState = { continuation: "absent", checkpoint_source: "absent", checkpoint_progress: "absent", conflict: "absent", slice_projection: "all-merged" };
    const routeCases = [
      ["ordinary", {}, "ordinary-fresh-v1", "SINK04"],
      ["schema-v1 continuation", { continuation: "v1" }, "legacy-unselected", "SINK05"],
      ["schema-v2 continuation", { continuation: "v2" }, "schema-v2", "SINK01"],
      ["checkpoint source", { checkpoint_source: "present" }, "legacy-unselected", "SINK06"],
      ["checkpoint progress", { checkpoint_progress: "present" }, "legacy-unselected", "SINK07"],
      ["delegated conflict", { conflict: "present" }, "delegated-conflict", "SINK02"],
      ["combined", { continuation: "v2", conflict: "present" }, "schema-v2+delegated-conflict", "SINK03"],
      ["empty projection", { slice_projection: "empty" }, "legacy-unselected", "SINK08"],
      ["incomplete projection", { slice_projection: "incomplete" }, "legacy-unselected", "SINK08"],
    ];
    for (const [label, overrides, route, selectedSink] of routeCases) {
      for (let index = 1; index <= 8; index += 1) {
        const sink = `SINK${String(index).padStart(2, "0")}`;
        const selected = sink === selectedSink;
        assert.deepEqual(
          evaluateWholeStoryRouteSink({ ...routeState, ...overrides, sink }),
          { route, sink, allowed: selected, reason: selected ? "selected-route" : "route-mismatch" },
          `${label} ${sink}`,
        );
      }
    }

    const passing = { ...routeState, claim: "absent", evidence: "absent", base: "equal", head: "equal", review: "fresh", pr_mode: "ready" };
    const sinkRows = [
      ["SINK09", {}, true, "allowed"],
      ["SINK10", {}, true, "allowed"],
      ["SINK11", {}, true, "allowed"],
      ["SINK12", { claim: "active" }, true, "allowed"],
      ["SINK13", { claim: "completed-fail", evidence: "exact-fail" }, true, "allowed"],
      ["SINK14", { claim: "completed-pass", evidence: "legacy" }, false, "checked-evidence-required"],
      ["SINK15", { claim: "completed-pass", evidence: "exact-pass" }, true, "allowed"],
      ["SINK16", { claim: "completed-pass", evidence: "exact-pass" }, true, "allowed"],
      ["SINK17", { claim: "completed-pass", evidence: "exact-pass" }, true, "allowed"],
      ["SINK18", { base: "ancestor" }, true, "allowed"],
      ["SINK19", { pr_mode: "draft" }, false, "ordinary-fresh-ready-required"],
      ["SINK20", { base: "ancestor" }, true, "allowed"],
      ["SINK21", { base: "moving" }, false, "base-moving"],
      ["SINK22", { review: "stale" }, false, "review-stale"],
      ["SINK23", { base: "unavailable" }, false, "base-unavailable"],
      ["SINK24", { head: "mismatch" }, false, "head-mismatch"],
      ["SINK25", { claim: "unknown", evidence: "stale", base: "non-ancestor", head: "dirty", review: "absent", pr_mode: "draft" }, true, "independent-contract"],
      ["SINK26", { base: "cleanup-failed" }, true, "independent-contract"],
    ];
    assert.equal(sinkRows.length, 18);
    for (const [sink, overrides, allowed, reason] of sinkRows) {
      assert.deepEqual(evaluateWholeStoryRouteSink({ ...passing, ...overrides, sink }), { route: "ordinary-fresh-v1", sink, allowed, reason }, sink);
    }

    for (const claim of ["absent", "active", "unknown", "completed-pass", "completed-fail"]) {
      assert.deepEqual(evaluateWholeStoryRouteSink({ ...passing, sink: "SINK12", claim }), {
        route: "ordinary-fresh-v1", sink: "SINK12", allowed: claim === "active", reason: claim === "active" ? "allowed" : "active-claim-required",
      }, `claim ${claim}`);
    }
    for (const evidence of ["absent", "exact-pass", "exact-fail", "legacy", "stale"]) {
      assert.deepEqual(evaluateWholeStoryRouteSink({ ...passing, sink: "SINK14", claim: "completed-pass", evidence }), {
        route: "ordinary-fresh-v1", sink: "SINK14", allowed: evidence === "exact-pass", reason: evidence === "exact-pass" ? "allowed" : "checked-evidence-required",
      }, `evidence ${evidence}`);
    }
    for (const base of ["equal", "ancestor", "non-ancestor", "unavailable", "moving", "cleanup-failed"]) {
      assert.deepEqual(evaluateWholeStoryRouteSink({ ...passing, sink: "SINK18", base }), {
        route: "ordinary-fresh-v1", sink: "SINK18", allowed: ["equal", "ancestor"].includes(base), reason: ["equal", "ancestor"].includes(base) ? "allowed" : `base-${base}`,
      }, `base ${base}`);
    }
    for (const head of ["equal", "dirty", "mismatch", "missing"]) {
      assert.deepEqual(evaluateWholeStoryRouteSink({ ...passing, sink: "SINK09", head }), {
        route: "ordinary-fresh-v1", sink: "SINK09", allowed: head === "equal", reason: head === "equal" ? "allowed" : `head-${head}`,
      }, `head ${head}`);
    }
    for (const review of ["fresh", "stale", "absent"]) {
      assert.deepEqual(evaluateWholeStoryRouteSink({ ...passing, sink: "SINK22", review }), {
        route: "ordinary-fresh-v1", sink: "SINK22", allowed: review === "fresh", reason: review === "fresh" ? "allowed" : `review-${review}`,
      }, `review ${review}`);
    }
  });

  it("selects ordinary fresh exactly once and rejects legacy evidence as a parallel whole-story answer", async () => {
    const fixture = createExecutionFixture("checked-ordinary-fresh", undefined, { ordinary: true, testStatus: "blocked", testAttempts: 0 });
    try {
      const initial = readJson(join(fixture.runDir, "run.json"));
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, initial), "ordinary-fresh-v1");
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, { ...initial, continuation: { schema_version: 1 } }), "legacy-unselected");
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, { ...initial, checkpoint_source: {} }), "legacy-unselected");
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, { ...initial, checkpoint_progress: {} }), "legacy-unselected");
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, { ...initial, slices: initial.slices.map((slice) => ({ ...slice, status: "review" })) }), "legacy-unselected");
      assert.throws(
        () => classifyWholeStoryTestRoute(fixture.runDir, { ...initial, run_id: "different-run" }),
        /canonical factory run directory/u,
      );
      const started = await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }, { mustExist: true });
      assert.equal(started.step.status, "running");
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, started.run), "ordinary-fresh-v1");

      for (const status of ["rejected", "blocked", "running"]) {
        await assert.rejects(
          transitionRunStep(fixture.runDir, "work-decomposer", { status, attempts: status === "running" ? 2 : 1 }, { mustExist: true }),
          /accepted work-decomposer authority cannot regress/u,
          status,
        );
      }

      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "caller-authored legacy evidence\n");
      writeJson(join(fixture.runDir, "evidence", "legacy.json"), { subject: "test-verifier", status: "pass" });
      writeJson(join(fixture.runDir, "reviews", "test-verifier.attempt-1.json"), {
        subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: fixture.head, required_fixes: [],
      });
      await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
        evidence_ref: "evidence/legacy.json", review_ref: "reviews/test-verifier.attempt-1.json",
      }, { mustExist: true }), /completed checked execution claim/u);

      const calls = [];
      const completed = await executeCheckedTestExecution(fixture.runDir, executionOptions([{}, {}], calls));
      assert.equal(completed.status, "pass");
      assert.deepEqual(calls.map(({ program, args }) => [program, args]), [
        ["node", ["--test", "test/acceptance.test.js"]],
        ["npm", ["run", "check"]],
      ]);
      const accepted = await transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
        evidence_ref: completed.receipt_ref, review_ref: "reviews/test-verifier.attempt-1.json",
      }, { mustExist: true });
      assert.equal(accepted.step.acceptance.evidence_hash, completed.receipt_hash);
      assert.equal(accepted.step.acceptance.reviewed_head_sha, fixture.head);
    } finally { cleanup(fixture.repo); }
  });

  it("preserves the established schema-v2 acceptance error contract", async () => {
    const fixture = createExecutionFixture("checked-schema-v2-error-contract");
    try {
      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "legacy evidence must not pass\n");
      writeJson(join(fixture.runDir, "evidence", "legacy.json"), { subject: "test-verifier", status: "pass" });
      writeJson(join(fixture.runDir, "reviews", "test-verifier.attempt-1.json"), {
        subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: fixture.head, required_fixes: [],
      });
      await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
        evidence_ref: "evidence/legacy.json", review_ref: "reviews/test-verifier.attempt-1.json",
      }, { mustExist: true }), /schema-v2 test authority requires a completed checked execution claim/u);
    } finally { cleanup(fixture.repo); }
  });

  it("claims before sequential shell-free execution, publishes a passing receipt, and exact-replays without process or write", async () => {
    const fixture = createExecutionFixture("checked-pass");
    const calls = [];
    try {
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, readJson(join(fixture.runDir, "run.json"))), "schema-v2");
      const result = await executeCheckedTestExecution(fixture.runDir, executionOptions([
        { stdout: "acceptance ok\n" },
        { stderr: "check ok\n" },
      ], calls));

      assert.deepEqual(Object.keys(result), ["ok", "run_id", "attempt", "status", "step_status", "head_sha", "plan_hash", "receipt_ref", "receipt_hash", "replayed"]);
      assert.equal(result.ok, true);
      assert.equal(result.status, "pass");
      assert.equal(result.step_status, "running");
      assert.equal(result.replayed, false);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map(({ program, args, options }) => [program, args, options.cwd, options.shell]), [
        ["node", ["--test", "test/acceptance.test.js"], fixture.repo, false],
        ["npm", ["run", "check"], fixture.repo, false],
      ]);
      assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["GIT_TERMINAL_PROMPT", "HOME", "PATH", "TERM"].sort());
      assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(Object.hasOwn(calls[0].options.env, "NODE_OPTIONS"), false);
      assert.equal(Object.hasOwn(calls[0].options.env, "NPM_TOKEN"), false);

      const receiptPath = join(fixture.runDir, result.receipt_ref);
      const receipt = validateTestExecutionReceipt(readJson(receiptPath));
      assert.equal(receipt.review_ready, true);
      assert.equal(receipt.timeout_ms, 1_000);
      assert.deepEqual(receipt.commands.map(({ outcome, status, exit_code }) => [outcome, status, exit_code]), [["exited", "pass", 0], ["exited", "pass", 0]]);
      assert.deepEqual(receipt.commands[0].stdout, { captured_bytes: 14, sha256: hashBytes("acceptance ok\n"), truncated: false });
      assert.deepEqual(receipt.commands[1].stderr, { captured_bytes: 9, sha256: hashBytes("check ok\n"), truncated: false });
      const run = validateRun(readJson(join(fixture.runDir, "run.json")));
      const step = run.steps.find(({ agent }) => agent === "test-verifier");
      assert.equal(step.execution_claim.state, "completed");
      assert.equal(step.execution_claim.status, "pass");
      assert.equal(step.execution_claim.timeout_ms, 1_000);
      assert.equal(step.execution_claim.receipt_hash, result.receipt_hash);
      assert.equal(step.execution_claim_hash, hashValue(step.execution_claim));

      const runBytes = readFileSync(join(fixture.runDir, "run.json"));
      const receiptBytes = readFileSync(receiptPath);
      const replay = await executeCheckedTestExecution(fixture.runDir, {
        ...executionOptions([], []),
        spawnFn() { throw new Error("replay must not spawn"); },
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.status, "pass");
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), runBytes);
      assert.deepEqual(readFileSync(receiptPath), receiptBytes);

      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "independent report\n");
      writeJson(join(fixture.runDir, "reviews", "test-verifier.attempt-1.json"), {
        subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: fixture.head, required_fixes: [],
      });
      const accepted = await transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
        evidence_ref: result.receipt_ref, review_ref: "reviews/test-verifier.attempt-1.json",
      }, { mustExist: true });
      assert.equal(accepted.step.execution_claim.status, "pass");
      assert.equal(accepted.step.acceptance.evidence_hash, result.receipt_hash);
      assert.equal(accepted.step.acceptance.reviewed_head_sha, fixture.head);
    } finally { cleanup(fixture.repo); }
  });

  it("records every decided failure outcome, keeps running later commands, and rejects the same attempt", async () => {
    const commands = [
      { program: "node", args: ["nonzero"] },
      { program: "node", args: ["signal"] },
      { program: "missing-program", args: [] },
      { program: "node", args: ["timeout"] },
      { program: "node", args: ["output"] },
      { program: "npm", args: ["run", "check"] },
    ];
    const fixture = createExecutionFixture("checked-failures", commands);
    const calls = [];
    try {
      const result = await executeCheckedTestExecution(fixture.runDir, executionOptions([
        { code: 7, stdout: "nonzero raw output\n" },
        { signal: "SIGTERM" },
        { launchThrow: true },
        { waitForKill: true },
        { stdout: Buffer.alloc(TEST_EXECUTION_STREAM_LIMIT_BYTES + 17, 97) },
        { stdout: "last command still ran\n" },
      ], calls, { commandTimeoutMs: 5 }));

      assert.equal(result.ok, false);
      assert.equal(result.status, "fail");
      assert.equal(result.step_status, "rejected");
      assert.equal(calls.length, commands.length);
      const receiptText = readFileSync(join(fixture.runDir, result.receipt_ref), "utf8");
      assert.equal(receiptText.includes("nonzero raw output"), false);
      assert.equal(receiptText.includes("last command still ran"), false);
      const receipt = validateTestExecutionReceipt(JSON.parse(receiptText));
      assert.deepEqual(receipt.commands.map(({ outcome }) => outcome), ["exited", "signaled", "launch-error", "timeout", "output-limit", "exited"]);
      assert.deepEqual(receipt.commands.map(({ exit_code, signal, error_code }) => [exit_code, signal, error_code]), [
        [7, null, null], [null, "SIGTERM", null], [null, null, "spawn-failed"], [null, "SIGKILL", null], [null, "SIGKILL", null], [0, null, null],
      ]);
      assert.deepEqual(receipt.commands[4].stdout, { captured_bytes: TEST_EXECUTION_STREAM_LIMIT_BYTES, sha256: hashBytes(Buffer.alloc(TEST_EXECUTION_STREAM_LIMIT_BYTES, 97)), truncated: true });
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.steps.find(({ agent }) => agent === "test-verifier").execution_claim.status, "fail");

      const replayCalls = [];
      const replay = await executeCheckedTestExecution(fixture.runDir, executionOptions([], replayCalls));
      assert.equal(replay.status, "fail");
      assert.equal(replay.replayed, true);
      assert.equal(replayCalls.length, 0);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects replay when a claim and receipt are rebound to a different timeout", async () => {
    const fixture = createExecutionFixture("checked-timeout-replay");
    try {
      const result = await executeCheckedTestExecution(fixture.runDir, executionOptions([{}, {}], []));
      const receiptPath = join(fixture.runDir, result.receipt_ref);
      const receipt = readJson(receiptPath);
      receipt.timeout_ms = 2_000;
      writeJson(receiptPath, receipt);
      const runPath = join(fixture.runDir, "run.json");
      const run = readJson(runPath);
      const step = run.steps.find(({ agent }) => agent === "test-verifier");
      step.execution_claim.timeout_ms = 2_000;
      step.execution_claim.receipt_hash = hashFile(receiptPath);
      step.execution_claim_hash = hashValue(step.execution_claim);
      writeJson(runPath, run);

      await assert.rejects(executeCheckedTestExecution(fixture.runDir, executionOptions([], [])), /timeout_ms|current authority/u);
    } finally { cleanup(fixture.repo); }
  });

  it("fails closed on an unclosable killed process with only out-of-band reconciliation diagnostics", async () => {
    const fixture = createExecutionFixture("checked-indeterminate", [{ program: "npm", args: ["run", "check"] }]);
    try {
      await assert.rejects(executeCheckedTestExecution(fixture.runDir, executionOptions([
        { waitForKill: true, neverCloseAfterKill: true },
      ], [], { commandTimeoutMs: 5, closeTimeoutMs: 5 })), isOperatorReconciliationRequired);
      const unknown = readJson(join(fixture.runDir, "run.json"));
      const claim = unknown.steps.find(({ agent }) => agent === "test-verifier").execution_claim;
      assert.equal(claim.state, "unknown");
      assert.equal(claim.reason, "process-outcome-indeterminate");
      const before = readFileSync(join(fixture.runDir, "run.json"));
      await assert.rejects(executeCheckedTestExecution(fixture.runDir, executionOptions([], [])), isOperatorReconciliationRequired);
      for (const reason of [undefined, "", "ordinary recovery", "test-execution-reconciliation", "operator says reconciled"]) {
        await assert.rejects(transitionRecoverOrphan(fixture.runDir, reason), isOperatorReconciliationRequired, String(reason));
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before, String(reason));
      }
      const executeDiagnostic = runCli(fixture.repo, ["factory", "test-execute", fixture.runId, "--json"]);
      assert.equal(executeDiagnostic.status, 1);
      assert.deepEqual(JSON.parse(executeDiagnostic.stdout), {
        ok: false,
        error: {
          code: "TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED",
          message: "checked test execution outcome is unknown; no supported factory command may clear, replace, terminalize, retry, or advance the claim; trusted out-of-band operator/process reconciliation is required",
        },
      });
      const recoverDiagnostic = runCli(fixture.repo, ["factory", "recover", fixture.runId, "--reason", "test-execution-reconciliation", "--json"]);
      assert.equal(recoverDiagnostic.status, 1);
      assert.match(recoverDiagnostic.stderr, /no supported factory command.*trusted out-of-band operator\/process reconciliation is required/u);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
    } finally { cleanup(fixture.repo); }
  });

  it("marks authority drift and receipt publication uncertainty unknown without a retry", async () => {
    for (const mode of ["authority", "receipt"]) {
      const fixture = createExecutionFixture(`checked-unknown-${mode}`);
      try {
        const options = executionOptions([
          mode === "authority" ? { beforeClose: () => writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{}\n") } : {},
          {},
        ], []);
        if (mode === "receipt") options.receiptAtomicWriteHooks = { beforeCommit() { throw new Error("injected uncertain publication"); } };
        await assert.rejects(executeCheckedTestExecution(fixture.runDir, options), isOperatorReconciliationRequired);
        const claim = readJson(join(fixture.runDir, "run.json")).steps.find(({ agent }) => agent === "test-verifier").execution_claim;
        assert.equal(claim.state, "unknown");
        assert.equal(claim.reason, mode === "authority" ? "authority-changed" : "receipt-publication-indeterminate");
      } finally { cleanup(fixture.repo); }
    }
  });

  it("keeps active or unknown checked execution fail-closed across recovery, terminal, steering, step, and retry routes", async () => {
    for (const state of ["active", "unknown"]) {
      for (const terminal of ["terminal-result", "steering-conflict"]) {
        const fixture = createExecutionFixture(`checked-terminal-guard-${state}-${terminal}`);
        try {
          const claimed = await claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: "123e4567-e89b-42d3-a456-426614174000" });
          if (state === "unknown") await markCheckedTestExecutionUnknown(fixture.runDir, claimed.claim, "process-outcome-indeterminate", { now: LATER });
          let consume;
          let sidecar = null;
          if (terminal === "terminal-result") {
            const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal", { now: NOW });
            consume = () => transitionTerminalResult(fixture.runDir, { status: "needs-human", reason: "generic terminal bypass" }, { boundaryToken: opened.boundary.token });
          } else {
            const queued = await transitionSteeringQueued(fixture.runDir, "conflicting operator request", { now: NOW, id: "conflict" });
            const consumed = await transitionSteeringConsumed(fixture.runDir, { ref: queued.steering.ref, hash: queued.steering.hash }, { now: LATER });
            sidecar = join(fixture.runDir, consumed.steering.ref);
            consume = () => transitionSteeringConflict(fixture.runDir, { ref: consumed.steering.ref, hash: consumed.steering.hash, reason: "generic steering bypass" });
          }
          const beforeRun = readFileSync(join(fixture.runDir, "run.json"));
          const beforeSidecar = sidecar ? readFileSync(sidecar) : null;
          await assert.rejects(consume(), isOperatorReconciliationRequired);
          assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), beforeRun);
          if (sidecar) assert.deepEqual(readFileSync(sidecar), beforeSidecar);
        } finally { cleanup(fixture.repo); }
      }

      const fixture = createExecutionFixture(`checked-route-guard-${state}`);
      try {
        const claimed = await claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: "123e4567-e89b-42d3-a456-426614174000" });
        if (state === "unknown") await markCheckedTestExecutionUnknown(fixture.runDir, claimed.claim, "process-outcome-indeterminate", { now: LATER });
        const before = readFileSync(join(fixture.runDir, "run.json"));
        for (const reason of [undefined, "", "ordinary recovery", "test-execution-reconciliation", "operator says reconciled"]) {
          await assert.rejects(transitionRecoverOrphan(fixture.runDir, reason), isOperatorReconciliationRequired, `${state}:${String(reason)}`);
          assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
        }
        for (const status of ["accepted", "rejected", "blocked"]) {
          await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", { status, attempts: 1 }, { mustExist: true }), /active or unknown checked test execution cannot change step status/u);
          assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
        }
        await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", (step) => {
          delete step.execution_claim;
          delete step.execution_claim_hash;
        }, { mustExist: true }), /execution_claim can only be changed by checked test execution transitions/u);
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
        await assert.rejects(transitionRunJson(fixture.runDir, (run) => {
          const step = run.steps.find(({ agent }) => agent === "test-verifier");
          delete step.execution_claim;
          delete step.execution_claim_hash;
        }), /step transitions must use transitionRunStep/u);
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
        await assert.rejects(executeCheckedTestExecution(fixture.runDir, executionOptions([], [])), state === "active"
          ? (error) => error?.code === "TEST_EXECUTION_ACTIVE" && /no supported factory command.*out-of-band operator\/process reconciliation/u.test(error.message)
          : isOperatorReconciliationRequired);
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
        const diagnostic = JSON.parse(runCli(fixture.repo, ["factory", "test-execute", fixture.runId, "--json"]).stdout);
        assert.equal(diagnostic.error.code, state === "active" ? "TEST_EXECUTION_ACTIVE" : "TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED");
        assert.match(diagnostic.error.message, /no supported factory command may clear, replace, terminalize, retry, or advance the claim; trusted out-of-band operator\/process reconciliation is required/u);
      } finally { cleanup(fixture.repo); }
    }
  });
});

function createExecutionFixture(runId, commands = [{ program: "node", args: ["--test", "test/acceptance.test.js"] }, { program: "npm", args: ["run", "check"] }], options = {}) {
  const repo = mkdtempSync(join(tmpdir(), "feature-factory-checked-execution-"));
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "fixture"]);
  runGit(repo, ["checkout", "-b", runId]);
  const head = gitOutput(repo, ["rev-parse", "HEAD"]);
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const directory of ["artifacts", "evidence", "reviews", "plan"]) mkdirSync(join(runDir, directory), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted brief\n");
  writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", attempt: 1, verdict: "APPROVE" });
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE" });
  writeJson(join(runDir, "reviews", "validator.json"), { subject: "parent", attempt: 1, verdict: "NO-GO" });
  writeJson(join(runDir, "evidence", "slice.json"), { subject: "slice", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  const plan = withDeliveryEnvelope({
    slices: [{ id: "slice", stack: "backend", paths: ["README.md"], depends_on: [], acceptance: ["works"], test_plan: ["checked"] }],
    integration_gate: { required_commands: commands, timeout_ms: 1_000 },
  });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  const sliceEvidenceRef = "evidence/slice.json";
  const sliceEvidenceHash = hashFile(join(runDir, sliceEvidenceRef));
  const familyEvidenceRef = "evidence/slice.family.json";
  const familyEvidence = writeVerificationArtifactReceipt({
    runDir, runId, plan, sliceId: "slice", attempt: 1, reviewedCommit: head,
    artifactId: "fixture-artifact-1", evidenceRef: familyEvidenceRef,
    result: { type: "verification-result", outcome: "pass", summary: "Verify slice behavior passed" },
  });
  const sliceReview = createSliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: head });
  sliceReview.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "slice", reviewedCommit: head, evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash });
  writeJson(join(runDir, "reviews", "slice.json"), sliceReview);
  const briefHash = hashFile(join(runDir, "artifacts", "technical-brief.md"));
  const specReviewHash = hashFile(join(runDir, "reviews", "spec-writer.json"));
  const planHash = hashFile(join(runDir, "plan", "slices.json"));
  const decompositionReviewHash = hashFile(join(runDir, "reviews", "work-decomposer.json"));
  const validatorReviewHash = hashFile(join(runDir, "reviews", "validator.json"));
  const sliceReviewRef = "reviews/slice.json";
  const sliceReviewHash = hashFile(join(runDir, sliceReviewRef));
  const sliceAttemptReview = createSliceAttemptReview({ evidenceRef: sliceEvidenceRef, evidenceHash: sliceEvidenceHash, reviewRef: sliceReviewRef, reviewHash: sliceReviewHash, reviewedCommit: head });
  const policy = { enabled: false, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } };
  const continuation = {
    schema_version: 2, kind: "blocked-run-continuation", created_at: NOW, operator_summary: "checked execution fixture",
    parent: { run_id: "parent", status: "blocked", run_ref: ".opencode/factory/parent/run.json", run_hash: hashBytes("parent"), branch: "parent", commit: head, worktree: "/tmp/parent" },
    review: { kind: "validator", ref: "reviews/validator.json", hash: validatorReviewHash, subject: "parent", summary: "continue", required_fixes: ["verify"], source: "run.validator.review_ref" },
    target: { run_id: runId, branch: runId, worktree: repo, base_ref: "main", base_commit: head },
    parent_artifacts: [{ kind: "technical_brief", ref: "artifacts/technical-brief.md", hash: briefHash }],
    parent_evidence: [], parent_reviews: [{ kind: "review", ref: "reviews/spec-writer.json", hash: specReviewHash }, { kind: "review", ref: "reviews/validator.json", hash: validatorReviewHash }],
    planning_reuse: { eligible: true, spec_review_ref: "reviews/spec-writer.json", spec_review_hash: specReviewHash, spec_artifact_ref: "artifacts/technical-brief.md", spec_artifact_hash: briefHash, child_spec_review_ref: "reviews/spec-writer.json" },
    configuration: { mode: "headless", github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3, post_pr_policy: policy },
    carry_forward: { scope: "full-remaining-plan", plan_ref: "plan/slices.json", plan_hash: planHash, start_commit: head, accepted_slices: [], remaining_slice_ids: ["slice"] },
  };
  const run = {
    schema_version: 1, run_id: runId, mode: "headless", status: "running", base_ref: "main", base_commit: head, branch: runId, worktree: repo,
    github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3, gates: {}, ...(options.ordinary ? {} : { continuation }),
    post_pr: { schema_version: 1, policy, phase: "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null },
    slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["README.md"], effective_paths: ["README.md"], status: "merged", attempts: 1, attempt_reviews: [sliceAttemptReview], evidence_ref: sliceEvidenceRef, evidence_hash: sliceEvidenceHash, review_ref: sliceReviewRef, review_hash: sliceReviewHash, reviewed_commit: head, merge_commit: head }],
    steps: [
      { agent: "spec-writer", status: "accepted", attempts: 0, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json", acceptance: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: briefHash, review_ref: "reviews/spec-writer.json", review_hash: specReviewHash }, inherited_acceptance: { from_run_id: "parent", parent_spec_review_ref: "reviews/spec-writer.json", artifact_hash: briefHash, review_hash: specReviewHash } },
      { agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json", acceptance: { artifact_ref: "plan/slices.json", artifact_hash: planHash, review_ref: "reviews/work-decomposer.json", review_hash: decompositionReviewHash } },
      { agent: "test-verifier", status: options.testStatus || "running", attempts: options.testAttempts ?? 1 },
    ],
  };
  if (options.ordinary) delete run.steps[0].inherited_acceptance;
  if (!options.ordinary) publishSyntheticV2Parent(runDir, continuation);
  writeJson(join(runDir, "run.json"), validateRun(run));
  return { repo, runDir, runId, head };
}

function executionOptions(behaviors, calls, overrides = {}) {
  const queue = [...behaviors];
  return {
    env: { PATH: "/fixture/bin", HOME: "/fixture/home", TERM: "dumb", NODE_OPTIONS: "--inspect", NPM_TOKEN: "secret" },
    now: NOW,
    isoNow: (() => { const values = [NOW, LATER]; return () => values.shift() || LATER; })(),
    spawnFn(program, args, options) {
      const behavior = queue.shift();
      calls.push({ program, args: [...args], options });
      if (!behavior) throw new Error("unexpected spawn");
      if (behavior.launchThrow) throw new Error("launch failed");
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let killed = false;
      child.kill = (signal) => {
        assert.equal(signal, "SIGKILL");
        killed = true;
        if (!behavior.neverCloseAfterKill) queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      };
      queueMicrotask(() => {
        if (behavior.beforeClose) behavior.beforeClose();
        if (behavior.stdout !== undefined) child.stdout.write(behavior.stdout);
        if (behavior.stderr !== undefined) child.stderr.write(behavior.stderr);
        if (behavior.waitForKill || killed) return;
        child.emit("close", behavior.code ?? (behavior.signal ? null : 0), behavior.signal ?? null);
      });
      return child;
    },
    ...overrides,
  };
}

function runGit(cwd, args) {
  const result = runFixtureGit(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function gitOutput(cwd, args) {
  const result = runFixtureGit(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function hashFile(file) { return hashBytes(readFileSync(file)); }
function hashBytes(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function runCli(cwd, args) { return spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, encoding: "utf8" }); }
function isOperatorReconciliationRequired(error) {
  return error?.code === "TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED"
    && /no supported factory command may clear, replace, terminalize, retry, or advance the claim; trusted out-of-band operator\/process reconciliation is required/u.test(error.message);
}
function cleanup(repo) { rmSync(repo, { recursive: true, force: true }); }
