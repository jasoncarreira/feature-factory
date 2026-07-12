import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { spawnSync as runSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLaunchClaim, recordDetachedProcessEvidence, writeProcessEvidence } from "../src/process-evidence.js";
import { transitionGateDecision, transitionSteeringBoundaryOpened } from "../src/run-state.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

describe("cli gate-decision", () => {
  const matrix = [
    ["T01", "detached-shepherd-started", "started", true, "Detached interactive shepherd started.", "watch", "watch", false, true],
    ["T02", "matching-detached-shepherd-live", "already-running", true, "A matching detached interactive shepherd is already running.", "watch", "watch", false, true],
    ["T03", "run-mode-not-interactive", "manual", false, "The durable run mode is not interactive; the external driver remains responsible for continuation.", "external-driver-continues", null, false, false],
    ["T04", "protected-gate-pending", "paused-at-protected-gate", false, "The run is paused at a protected gate awaiting an explicit answer.", "answer-protected-gate", null, false, false],
    ["T05", "terminal-run", "terminal", false, "The run is already terminal; inspect the durable terminal result.", "inspect-terminal-result", "status", false, false],
    ["T06", "validated-cancelled", "stopped", false, "Validated process evidence shows that the detached shepherd is cancelled.", "confirm-cancellation", "status", false, false],
    ["T07", "cancel-pending", "stopped", false, "Cancellation is pending for the validated detached shepherd.", "confirm-cancellation", "cancel", false, false],
    ["T08", "approval-receipt-missing", "recovery-required", false, "The accepted approval has no valid durable handoff receipt.", "run-resume-check", "resume", false, false],
    ["T09", "approval-snapshot-mismatch", "recovery-required", false, "The accepted approval no longer matches its durable pending-gate snapshot.", "run-resume-check", "resume", false, false],
    ["T10", "steering-generation-mismatch", "recovery-required", false, "The steering generation changed after the approval was accepted.", "run-resume-check", "resume", false, false],
    ["T11", "steering-state-not-clean", "recovery-required", false, "Pending or uncheckpointed steering prevents automatic continuation.", "run-resume-check", "resume", false, false],
    ["T12", "resume-ineligible", "recovery-required", false, "The run is not eligible for detached continuation.", "run-resume-check", "resume", false, false],
    ["T13", "launch-claim-invalid", "recovery-required", false, "The preserved launch claim is invalid and requires manual ownership reconciliation.", "manual-ownership-reconciliation", null, true, false],
    ["T14", "launch-owner-indeterminate", "recovery-required", false, "The preserved launch claim owner cannot be safely proven live or absent.", "manual-ownership-reconciliation", null, true, false],
    ["T15", "launch-claim-conflict", "recovery-required", false, "Another launch claim conflicts with this execution and ownership is ambiguous.", "manual-ownership-reconciliation", null, true, false],
    ["T16", "process-evidence-invalid", "recovery-required", false, "Detached process evidence is invalid; preserve it and reconcile ownership manually.", "manual-ownership-reconciliation", null, false, false],
    ["T17", "process-identity-mismatch", "recovery-required", false, "Recorded detached process identity does not match live inspection; preserve the evidence and reconcile ownership manually.", "manual-ownership-reconciliation", null, false, false],
    ["T18", "prior-process-stopped", "recovery-required", false, "Prior process evidence is stopped or failed-closed; automatic relaunch is forbidden until manual reconciliation.", "manual-ownership-reconciliation", null, false, false],
    ["T19", "claim-acquisition-failed", "recovery-required", false, "The launch claim could not be acquired and no safe ownership decision was possible.", "manual-ownership-reconciliation", null, false, false],
    ["T20", "foreground-release-failed", "recovery-required", false, "The foreground predecessor could not be durably released, so ownership remains ambiguous.", "manual-ownership-reconciliation", null, true, false],
    ["T21", "launch-spawn-failed", "recovery-required", false, "Detached launch failed after predecessor release; process ownership is ambiguous.", "manual-ownership-reconciliation", null, true, false],
    ["T22", "launch-readiness-failed", "recovery-required", false, "Detached launch did not produce matching readiness evidence within the bounded wait.", "manual-ownership-reconciliation", null, true, false],
    ["T23", "launch-evidence-mismatch", "recovery-required", false, "Published detached process evidence does not match the launch claim execution.", "manual-ownership-reconciliation", null, true, false],
  ];

  for (const [id, code, status, automatic, reason, action, commandKind, claim, live] of matrix) {
    it(`${id} drives ${code} through gate-decision and observes the CLI exit`, async () => {
      const fixture = await createApprovedMatrixFixture(`cli-${id.toLowerCase()}`);
      await prepareMatrixCondition(fixture, code);
      const runId = fixture.runId;
      const commands = {
        watch: `feature-factory factory watch ${runId}`,
        status: `feature-factory factory status ${runId} --json`,
        cancel: `feature-factory factory cancel ${runId} --json`,
        resume: `feature-factory factory resume-check ${runId} --json`,
      };
      const expectedHandoff = {
        automatic,
        status,
        run_id: runId,
        gate: "brief",
        reason_code: code,
        reason,
        action,
        action_command: commandKind ? commands[commandKind] : null,
        pid: live ? 9876 : null,
        process_ref: live ? "process.json" : null,
        launch_claim_ref: claim ? "process-launch.lock/owner.json" : null,
        log: live ? "processes/behavior.log" : null,
        status_command: commands.status,
        watch_command: commands.watch,
        recovery_command: commandKind === "resume" ? commands.resume : null,
      };
      const approvalBefore = structuredClone(readJson(join(fixture.runDir, "run.json")).gates.brief);
      try {
        const cliResult = runBehaviorGateCli(fixture, code);
        const expectedExit = Number(id.slice(1)) <= 7 ? 0 : 2;
        assert.equal(cliResult.status, expectedExit, `${cliResult.stderr}\n${cliResult.stdout}\n${readFileSync(join(fixture.runDir, "matrix-metrics.json"), "utf8")}`);
        const printed = JSON.parse(cliResult.stdout);
        assert.equal(printed.gate_accepted, true);
        assert.equal(printed.run.gates.brief.status, "approved");
        assert.deepEqual(printed.handoff, expectedHandoff);
        assert.deepEqual(readJson(join(fixture.runDir, "run.json")).gates.brief, approvalBefore, "accepted approval must be preserved");
        const metrics = readMatrixMetrics(fixture);
        assert.equal(metrics.spawnAttempts, id === "T01" || ["T21", "T22", "T23"].includes(id) ? 1 : 0);
        assert.equal(metrics.signalAttempts, 0);
        assert.equal(metrics.args.some((arg) => String(arg).includes("merge")), false);
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  it("returns the exact started envelope after interactive approval readiness", async () => {
    const fixture = createFixture("cli-interactive-handoff", { interactive: true });
    const bin = installFakeOpencode(fixture.repo);
    let pid;
    try {
      let proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--json"], bin);
      assert.equal(proc.status, 0, proc.stderr);
      const boundary = openBoundary(fixture, "gate", bin);
      proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer", "approve", "--boundary-token", boundary.token, "--json"], bin);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      pid = output.handoff.pid;
      assert.deepEqual(output.handoff, {
        automatic: true,
        status: "started",
        run_id: fixture.runId,
        gate: "story",
        reason_code: "detached-shepherd-started",
        reason: "Detached interactive shepherd started.",
        action: "watch",
        action_command: `feature-factory factory watch ${fixture.runId}`,
        pid,
        process_ref: "process.json",
        launch_claim_ref: null,
        log: JSON.parse(readFileSync(join(fixture.runDir, "process.json"), "utf8")).log_ref,
        status_command: `feature-factory factory status ${fixture.runId} --json`,
        watch_command: `feature-factory factory watch ${fixture.runId}`,
        recovery_command: null,
      });
      assert.equal(output.gate_accepted, true);
      assert.equal(existsSync(join(fixture.runDir, "process-launch.lock")), false);
    } finally {
      if (pid) await terminateDetachedFixture(fixture.runDir, pid);
      cleanup(fixture.repo);
    }
  });

  for (const mode of ["headless", "autonomous", null]) {
    it(`keeps ${mode || "missing"} durable mode transition-only`, () => {
      const fixture = createFixture(`cli-mode-${mode || "missing"}`, { mode });
      try {
        let proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--json"]);
        assert.equal(proc.status, 0, proc.stderr);
        const boundary = openBoundary(fixture, "gate");
        proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer", "approve", "--boundary-token", boundary.token, "--json"]);
        assert.equal(proc.status, 0, proc.stderr);
        const output = JSON.parse(proc.stdout);
        assert.equal(output.gate_accepted, true);
        assert.equal(output.handoff.reason_code, "run-mode-not-interactive");
        assert.equal(existsSync(join(fixture.runDir, "process.json")), false);
        assert.equal(existsSync(join(fixture.runDir, "process-launch.lock")), false);
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  it("prints accepted recovery-required JSON and exits 2 when a receipt is missing", () => {
    const fixture = createFixture("cli-missing-receipt", { mode: "interactive" });
    try {
      writeJson(join(fixture.runDir, "run.json"), {
        ...readJson(join(fixture.runDir, "run.json")),
        gates: {
          story: {
            status: "approved",
            artifact: "artifacts/story.md",
            question_ref: "gates/story.question.md",
            answer: "approve",
            answered_at: "2026-07-12T12:00:00.000Z",
            approval_source: "human",
            pending_snapshot: {
              question_ref: "gates/story.question.md",
              question_hash: sha256File(join(fixture.runDir, "gates", "story.question.md")),
              artifact_ref: "artifacts/story.md",
              artifact_hash: sha256File(join(fixture.runDir, "artifacts", "story.md")),
              created_at: "2026-07-12T11:59:00.000Z"
            }
          }
        }
      });
      const proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer", "approve", "--json"]);
      assert.equal(proc.status, 2, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.gate_accepted, true);
      assert.equal(output.handoff.reason_code, "approval-receipt-missing");
      assert.equal(output.handoff.pid, null);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("approves with external-driver answer refs", () => {
    const fixture = createFixture("cli-gate");
    try {
      let proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      const boundary = openBoundary(fixture, "gate");

      proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--approval-source", "external-driver", "--boundary-token", boundary.token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(output.gate, "story");
      assert.equal(run.gates.story.status, "approved");
      assert.equal(run.gates.story.approval_source, "external-driver");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts inline human answers", () => {
    const fixture = createFixture("cli-human-gate");
    try {
      assert.equal(runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--json"]).status, 0);
      const boundary = openBoundary(fixture, "gate");
      const proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer", "approve", "--boundary-token", boundary.token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(readJson(join(fixture.runDir, "run.json")).gates.story.approval_source, "human");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects missing and stale approval boundary tokens and recovers with a fresh token", () => {
    const fixture = createFixture("cli-gate-boundary-guards");
    try {
      let proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);

      const approvalArgs = ["factory", "gate-decision", fixture.runId, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer", "approve", "--json"];
      proc = runCli(fixture.repo, approvalArgs);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /lock-protected boundary observation/u);
      assert.equal(readJson(join(fixture.runDir, "run.json")).gates.story.status, "pending");

      const stale = openBoundary(fixture, "gate");
      proc = runCli(fixture.repo, ["factory", "env", "record-created", fixture.runId, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      proc = runCli(fixture.repo, [...approvalArgs.slice(0, -1), "--boundary-token", stale.token, "--json"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /boundary observation is stale/u);
      assert.equal(readJson(join(fixture.runDir, "run.json")).gates.story.status, "pending");

      const fresh = openBoundary(fixture, "gate");
      proc = runCli(fixture.repo, [...approvalArgs.slice(0, -1), "--boundary-token", fresh.token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(readJson(join(fixture.runDir, "run.json")).gates.story.status, "approved");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects decisions with both inline and referenced answers without mutating the gate", () => {
    const fixture = createFixture("cli-ambiguous-gate-answer");
    try {
      const pending = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      assert.equal(pending.status, 0, pending.stderr);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      const proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--answer", "approve", "--approval-source", "autonomous", "--json"]);

      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /requires exactly one of answer_ref or answer/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      assert.equal(existsSync(join(fixture.runDir, "gates", "story.answer")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("writes flag-like answer text verbatim", () => {
    const fixture = createFixture("cli-answer-verbatim");
    try {
      let proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);

      proc = runCli(fixture.repo, ["factory", "answer", "--repo", fixture.repo, fixture.runId, "story", "changes:", "rename", "--answer", "field"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(readFileSync(join(fixture.runDir, "gates", "story.answer"), "utf8"), "changes: rename --answer field\n");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("factory answer remains write-only for interactive runs and never launches", () => {
    const fixture = createFixture("cli-interactive-answer-only", { mode: "interactive" });
    try {
      const pending = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      assert.equal(pending.status, 0, pending.stderr);
      const answered = runCli(fixture.repo, ["factory", "answer", "--json", fixture.runId, "story", "approve"]);
      assert.equal(answered.status, 0, answered.stderr);
      assert.equal(readFileSync(join(fixture.runDir, "gates", "story.answer"), "utf8"), "approve\n");
      assert.equal(existsSync(join(fixture.runDir, "process.json")), false);
      assert.equal(existsSync(join(fixture.runDir, "process-launch.lock")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects empty changes answer text", () => {
    const fixture = createFixture("cli-empty-changes");
    try {
      let proc = runCli(fixture.repo, ["factory", "gate-decision", fixture.runId, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);

      proc = runCli(fixture.repo, ["factory", "answer", "--repo", fixture.repo, fixture.runId, "story", "changes:"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /answer must be exactly approve, stop, or start with changes:/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails unknown factory commands and flag values that look like flags", () => {
    const fixture = createFixture("cli-parser-errors");
    try {
      let proc = runCli(fixture.repo, ["factory", "not-a-command"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /unknown factory command/u);

      proc = runCli(fixture.repo, ["factory", "bad\u001B]0;pwned\u0007"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /bad\\u001B/u);
      assert.doesNotMatch(proc.stderr, /[\u001B\u0007\u009B]/u);

      proc = runCli(fixture.repo, ["factory", "status", "--repo", "--json"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /--repo requires a value/u);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createFixture(runId, options = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cli-gate-simplified-")));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeFileSync(join(runDir, "gates", "story.question.md"), "approve?\n");
  const run = { schema_version: 1, run_id: runId, status: "running", gates: {} };
  if (options.interactive || options.mode) {
    run.mode = options.mode || "interactive";
    run.worktree = join(repo, ".opencode", "worktrees", runId);
    run.branch = runId;
    run.slices = [{ id: "slice", status: "pending", attempts: 0 }];
    mkdirSync(run.worktree, { recursive: true });
  }
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId, worktree: run.worktree };
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function runCli(repo, args, bin) {
  return runSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: bin ? { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` } : process.env });
}

function runBehaviorGateCli(fixture, reasonCode) {
  const cliUrl = new URL("../src/cli.js", import.meta.url).href;
  const evidenceUrl = new URL("../src/process-evidence.js", import.meta.url).href;
  const source = `
    import { runCliCommand } from ${JSON.stringify(cliUrl)};
    import { acquireLaunchClaim, recordDetachedProcessEvidence, transitionLaunchClaimPhase } from ${JSON.stringify(evidenceUrl)};
    import { mkdirSync, writeFileSync } from "node:fs";
    const repo = ${JSON.stringify(fixture.repo)};
    const runDir = ${JSON.stringify(fixture.runDir)};
    const reasonCode = ${JSON.stringify(reasonCode)};
    const metricsPath = ${JSON.stringify(join(fixture.runDir, "matrix-metrics.json"))};
    const metrics = { spawnAttempts: 0, signalAttempts: 0, sleepCalls: [], now: 0, args: [] };
    const persistMetrics = () => writeFileSync(metricsPath, JSON.stringify(metrics));
    const inspectorFn = (pid) => ({
      ok: true,
      inspector: "test-inspector",
      pid,
      start_marker: reasonCode === "process-identity-mismatch" ? "different-start" : "test-start",
      command_name: pid === 9876 ? "opencode" : "node",
      cwd: repo
    });
    const gateDecisionOptions = {
      inspectorFn,
      acquireLaunchClaimFn: (dir, input, opts) => {
        try { return acquireLaunchClaim(dir, input, opts); }
        catch (error) { metrics.acquireError = String(error?.stack || error); persistMetrics(); throw error; }
      },
      readyTimeoutMs: 100,
      clock: () => metrics.now,
      sleep: async (ms) => { metrics.sleepCalls.push(ms); metrics.now += ms; persistMetrics(); },
      processSignalFn: () => { metrics.signalAttempts += 1; persistMetrics(); }
    };
    if (reasonCode === "claim-acquisition-failed") {
      gateDecisionOptions.acquireLaunchClaimFn = () => { throw new Error("injected atomic acquisition failure"); };
    }
    if (reasonCode === "foreground-release-failed") {
      gateDecisionOptions.transitionLaunchClaimPhaseFn = (dir, token, phase, updates, opts) => {
        if (phase === "predecessor-released") throw new Error("injected predecessor release failure");
        return transitionLaunchClaimPhase(dir, token, phase, updates, opts);
      };
    }
    if (["detached-shepherd-started", "launch-spawn-failed", "launch-readiness-failed", "launch-evidence-mismatch"].includes(reasonCode)) {
      gateDecisionOptions.detachedLaunchFn = async (_repo, args, launchOpts) => {
        metrics.spawnAttempts += 1;
        metrics.args = args;
        persistMetrics();
        if (reasonCode === "launch-spawn-failed") throw new Error("injected supervisor spawn failure");
        if (reasonCode === "launch-readiness-failed") return { status: "started", pid: 9876 };
        mkdirSync(runDir + "/processes", { recursive: true });
        writeFileSync(runDir + "/processes/behavior.log", "ready\\n");
        recordDetachedProcessEvidence(runDir, {
          runId: ${JSON.stringify(fixture.runId)},
          executionId: reasonCode === "launch-evidence-mismatch" ? "different-execution" : launchOpts.executionId,
          pid: 9876,
          cwd: repo,
          logRef: "processes/behavior.log",
          inspectorFn
        });
        return { status: "started", pid: 9876 };
      };
    }
    persistMetrics();
    await runCliCommand([
      "factory", "gate-decision", ${JSON.stringify(fixture.runId)}, "brief", "approved",
      "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md",
      "--answer", "approve", "--json"
    ], { gateDecisionOptions });
    persistMetrics();
  `;
  return runSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: { ...process.env },
  });
}

async function createApprovedMatrixFixture(runId) {
  const fixture = createFixture(runId, { interactive: true });
  await transitionGateDecision(fixture.runDir, "brief", { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md" });
  const boundary = await transitionSteeringBoundaryOpened(fixture.runDir, "gate");
  await transitionGateDecision(fixture.runDir, "brief", { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve" }, { boundaryToken: boundary.boundary.token });
  return fixture;
}

async function prepareMatrixCondition(fixture, code) {
  const runFile = join(fixture.runDir, "run.json");
  const mutate = (change) => { const run = readJson(runFile); change(run); writeJson(runFile, run); };
  if (code === "matching-detached-shepherd-live") return writeMatrixProcess(fixture, "running", "matching-live");
  if (code === "run-mode-not-interactive") return mutate((run) => { run.mode = "headless"; });
  if (code === "protected-gate-pending") {
    writeFileSync(join(fixture.runDir, "artifacts", "brief.md"), "brief\n");
    writeFileSync(join(fixture.runDir, "gates", "brief.question.md"), "approve brief?\n");
    return transitionGateDecision(fixture.runDir, "story", { status: "pending", artifact: "artifacts/brief.md", question_ref: "gates/brief.question.md" });
  }
  if (code === "terminal-run") return mutate((run) => { run.status = "completed"; run.terminal_result = { status: "completed", run_id: fixture.runId, pr_url: null, reason: null, summary: "done", artifacts: {} }; });
  if (code === "validated-cancelled") return writeMatrixProcess(fixture, "cancelled", "cancelled");
  if (code === "cancel-pending") return writeMatrixProcess(fixture, "running", "cancel-pending", { cancel: { requested_at: new Date().toISOString(), signal: "SIGTERM", confirmed_at: null, result: "pending", reason: "pending" } });
  if (code === "approval-receipt-missing") return mutate((run) => { delete run.gates.brief.handoff_receipt; });
  if (code === "approval-snapshot-mismatch") return writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "changed\n");
  if (code === "steering-generation-mismatch") return mutate((run) => { run.steering.generation += 1; });
  if (code === "steering-state-not-clean") return transitionSteeringBoundaryOpened(fixture.runDir, "dispatch");
  if (code === "resume-ineligible") return rmSync(fixture.worktree, { recursive: true, force: true });
  if (code === "launch-claim-invalid") { mkdirSync(join(fixture.runDir, "process-launch.lock")); return writeFileSync(join(fixture.runDir, "process-launch.lock", "owner.json"), "malformed claim bytes\n"); }
  if (code === "launch-owner-indeterminate") return writeMatrixClaim(fixture, { hostname: "foreign-host" });
  if (code === "launch-claim-conflict") {
    return acquireLaunchClaim(fixture.runDir, { runId: fixture.runId, executionId: "conflicting-execution", launchKind: "approval-handoff", phase: "spawning", pid: process.pid, cwd: fixture.repo }, { inspectorFn: matrixInspector(fixture) });
  }
  if (code === "process-evidence-invalid") return writeFileSync(join(fixture.runDir, "process.json"), "malformed process bytes\n");
  if (code === "process-identity-mismatch") return writeMatrixProcess(fixture, "running", "mismatch");
  if (code === "prior-process-stopped") return writeMatrixProcess(fixture, "exited", "stopped");
}

function writeMatrixProcess(fixture, state, executionId, overrides = {}) {
  mkdirSync(join(fixture.runDir, "processes"), { recursive: true });
  writeFileSync(join(fixture.runDir, "processes", "behavior.log"), "evidence\n");
  const now = new Date().toISOString();
  writeProcessEvidence(fixture.runDir, { schema_version: 1, kind: "opencode-process", run_id: fixture.runId, execution_id: executionId, pid: 9876, started_at: now, updated_at: now, state, cwd: fixture.repo, identity: { inspector: "test-inspector", start_marker: "test-start", command_name: "opencode" }, log_ref: "processes/behavior.log", cancel: state === "cancelled" ? { requested_at: now, signal: "SIGTERM", confirmed_at: now, result: "cancelled", reason: null } : null, ...overrides });
}

function writeMatrixClaim(fixture, overrides = {}) {
  mkdirSync(join(fixture.runDir, "process-launch.lock"));
  writeJson(join(fixture.runDir, "process-launch.lock", "owner.json"), { schema_version: 1, kind: "opencode-launch-claim", run_id: fixture.runId, execution_id: "claim-execution", launch_kind: "approval-handoff", phase: "spawning", pid: process.pid, hostname: "test-host", acquired_at: new Date().toISOString(), identity: { inspector: "test-inspector", start_marker: "test-start", command_name: "node", cwd: fixture.repo }, approval: null, nonce: "opaque-matrix-token-1234", ...overrides });
}

function matrixInspector(fixture) {
  return (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "node", cwd: fixture.repo });
}

function readMatrixMetrics(fixture) {
  return readJson(join(fixture.runDir, "matrix-metrics.json"));
}

function openBoundary(fixture, kind, bin) {
  const proc = runCli(fixture.repo, ["factory", "boundary-open", fixture.runId, kind, "--json"], bin);
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout).boundary;
}

function installFakeOpencode(repo) {
  const bin = join(repo, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "opencode");
  writeFileSync(script, "#!/usr/bin/env node\nprocess.once(\"SIGTERM\", () => process.exit(0));\n", "utf8");
  chmodSync(script, 0o755);
  return bin;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}

async function terminateDetachedFixture(runDir, pid) {
  const processFile = join(runDir, "process.json");
  await new Promise((resolve, reject) => {
    const watcher = watch(runDir, (event, filename) => {
      if (event !== "rename" || filename !== "process.json") return;
      try {
        const evidence = readJson(processFile);
        assert.equal(evidence.pid, pid, "the terminal sidecar must belong to the started child");
        assert.equal(evidence.state, "exited", "the supervisor must finish log publication before cleanup");
        watcher.close();
        resolve();
      } catch (error) {
        watcher.close();
        reject(error);
      }
    });
    watcher.once("error", reject);
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      watcher.close();
      reject(error);
    }
  });
}
