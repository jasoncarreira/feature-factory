import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync as runSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

describe("cli gate-decision", () => {
  it("returns the exact started envelope after interactive approval readiness", () => {
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
      if (pid) try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
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
  const repo = mkdtempSync(join(tmpdir(), "cli-gate-simplified-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeFileSync(join(runDir, "gates", "story.question.md"), "approve?\n");
  const run = { schema_version: 1, run_id: runId, status: "running", gates: {} };
  if (options.interactive) {
    run.mode = "interactive";
    run.worktree = join(repo, ".opencode", "worktrees", runId);
    run.branch = runId;
    run.slices = [{ id: "slice", status: "pending", attempts: 0 }];
    mkdirSync(run.worktree, { recursive: true });
  }
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId };
}

function runCli(repo, args, bin) {
  return runSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: bin ? { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` } : process.env });
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
  writeFileSync(script, "#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n", "utf8");
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(repo, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt === 19) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
