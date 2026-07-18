import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "./helpers/git-fixture.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { completeSliceBuilderTaskDispatch, prepareSliceBuilderTaskDispatch } from "../src/run-state.js";
import { DURABLE_AUTHORITY_CATALOG, emitDurableRecordMutations } from "./helpers/durable-record-mutations.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const RUN_ID = "cli-write-surface";

describe("cli write surface", () => {
  it("exposes only the exact JSON checked-test execution grammar", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-test-execute-grammar-"));
    try {
      initGitRepo(repo);
      for (const args of [
        ["factory", "test-execute", RUN_ID],
        ["factory", "test-execute", RUN_ID, "--json", "--json"],
        ["factory", "test-execute", RUN_ID, "--json", "--attempts", "1"],
        ["factory", "test-execute", RUN_ID, "--json", "--evidence-ref", "evidence/caller.json"],
        ["factory", "test-execute", RUN_ID, "--json", "--repo", repo],
      ]) {
        const proc = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
        assert.equal(proc.status, 1, args.join(" "));
        assert.equal(proc.stderr, "", args.join(" "));
        const error = JSON.parse(proc.stdout);
        assert.deepEqual(Object.keys(error), ["ok", "error"]);
        assert.deepEqual(Object.keys(error.error), ["code", "message"]);
        assert.equal(error.ok, false);
        assert.match(error.error.message, /requires exactly <run-id> --json/u);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("passes a named start run id as driver config", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-start-run-id-"));
    try {
      initGitRepo(repo);
      const capture = join(repo, "opencode-capture.json");
      const bin = writeFakeOpencode(repo, capture);

      const proc = spawnFactoryStart(repo, ["--run-id", "named-start", "--autonomous", "implement the named feature"], bin, capture);

      assert.equal(proc.status, 0, proc.stderr || proc.stdout);
      const captured = readJson(capture);
      const expectedRepo = realpathSync(repo);
      assert.equal(captured.cwd, expectedRepo);
      assert.deepEqual(captured.args.slice(0, 6), ["run", "--dir", expectedRepo, "--command", "feature", "--agent"]);
      assert.equal(captured.args[6], "feature-factory");
      assert.match(captured.args.at(-1), /^ffpayload-v1:[A-Za-z0-9_-]+$/u);
      const decoded = decodeFeatureCommandPayload(captured.args.at(-1));
      assert.equal(decoded.ok, true);
      const payload = decoded.payload;
      assert.equal(payload.operator_request, "implement the named feature");
      assert.equal(payload.driver.mode, "autonomous");
      assert.equal(payload.driver.run_id, "named-start");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects unsafe or resume start run ids before launching opencode", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-start-run-id-invalid-"));
    try {
      initGitRepo(repo);
      const capture = join(repo, "opencode-capture.json");
      const bin = writeFakeOpencode(repo, capture);

      const unsafe = spawnFactoryStart(repo, ["--run-id", "../bad", "implement"], bin, capture);
      assert.notEqual(unsafe.status, 0, unsafe.stdout || unsafe.stderr);
      assert.match(unsafe.stderr, /--run-id must be a bare safe factory run id/u);
      assert.equal(existsSync(capture), false);

      const resume = spawnFactoryStart(repo, ["--run-id", "named-start", "--headless", "resume named-start"], bin, capture);
      assert.notEqual(resume.status, 0, resume.stdout || resume.stderr);
      assert.match(resume.stderr, /--run-id is only for new runs/u);
      assert.equal(existsSync(capture), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects start dry runs before any launch or repository side effect", () => {
    const modes = [
      ["default foreground", []],
      ["headless", ["--headless"]],
      ["autonomous", ["--autonomous"]],
      ["detached", ["--detached"]],
    ];

    for (const [mode, modeArgs] of modes) {
      const repo = mkdtempSync(join(tmpdir(), `feature-factory-cli-start-dry-run-${mode.replaceAll(" ", "-")}-`));
      try {
        initGitRepo(repo);
        const capture = join(repo, "opencode-capture.json");
        const bin = writeFakeOpencode(repo, capture);
        const gitExclude = join(repo, ".git", "info", "exclude");
        const gitExcludeBefore = readFileSync(gitExclude, "utf8");
        const filesystemBefore = snapshotFixtureTree(repo);
        const gitBefore = snapshotGitBaseline(repo);

        const proc = spawnFactoryStart(repo, ["--dry-run", ...modeArgs, "implement without writes"], bin, capture);

        assert.equal(proc.status, 1, `${mode}: ${proc.stderr || proc.stdout}`);
        assert.equal(proc.stdout, "", mode);
        assert.equal(proc.stderr, "error: factory start --dry-run is unsupported\n", mode);
        assert.equal(existsSync(capture), false, `${mode}: fake OpenCode must not run`);
        assert.equal(existsSync(join(repo, ".opencode", "skills", "feature")), false, `${mode}: repo seed must be absent`);
        assert.equal(existsSync(join(repo, ".opencode", "factory")), false, `${mode}: factory state must be absent`);
        assert.equal(existsSync(join(repo, ".opencode", "worktrees")), false, `${mode}: worktrees must be absent`);
        assert.equal(existsSync(join(repo, ".opencode", "factory", "processes")), false, `${mode}: detached logs must be absent`);
        assert.deepEqual(snapshotFixtureTree(repo), filesystemBefore, `${mode}: filesystem baseline changed`);
        assert.equal(readFileSync(gitExclude, "utf8"), gitExcludeBefore, `${mode}: .git/info/exclude changed`);
        assert.deepEqual(snapshotGitBaseline(repo), gitBefore, `${mode}: git baseline changed`);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it("drives a run through local state transitions without direct run.json edits", async () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-write-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo, ["slice-branch"]);
      const baseCommit = gitOutput(repo, ["rev-parse", "HEAD"]).trim();
      runGit(repo, ["remote", "add", "origin", "https://github.com/jasoncarreira/opencode-feature-factory.git"]);
      runGit(repo, ["config", `url.file://${repo}/.insteadOf`, "https://github.com/jasoncarreira/opencode-feature-factory.git"]);
      const sliceWorktree = join(repo, ".opencode", "worktrees", "slice");
      mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
      runGit(repo, ["worktree", "add", sliceWorktree, "slice-branch"]);
      let reviewedHead;
      runGit(repo, ["checkout", "-b", "feature-branch"]);
      seedRun(runDir);
      writeJson(join(runDir, "run.json"), { ...readJson(join(runDir, "run.json")), base_ref: "main", base_commit: baseCommit, branch: "feature-branch", github_account: "jasoncarreira", pr_mode: "ready" });
      writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted brief\n");
      writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", required_fixes: [] });
      writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE", required_fixes: [] });
      runFactory(repo, ["step", RUN_ID, "spec-writer", "accepted", "--attempts", "1", "--artifact-ref", "artifacts/technical-brief.md", "--review-ref", "reviews/spec-writer.json", "--json"]);

      const steered = JSON.parse(runFactory(repo, ["steer", RUN_ID, "--message", "operator steering", "--json"]).stdout);
      assert.equal(steered.steering.message_chars, 17);
      const consumed = JSON.parse(runFactory(repo, ["steer-consume", RUN_ID, "--ref", steered.steering.ref, "--hash", steered.steering.hash, "--json"]).stdout);
      assert.equal(consumed.steering.trust, "untrusted-operator-data");
      runFactory(repo, ["steer-ack", RUN_ID, "--ref", consumed.steering.ref, "--hash", consumed.steering.hash, "--json"]);
      validateFactory(repo);

      runFactory(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]);
      runFactory(repo, ["step", RUN_ID, "work-decomposer", "accepted", "--attempts", "1", "--artifact-ref", "plan/slices.json", "--review-ref", "reviews/work-decomposer.json", "--json"]);
      validateFactory(repo);
      const costRecorded = JSON.parse(runFactory(repo, ["cost-record", RUN_ID, "--agent", "backend-builder", "--step", "build", "--slice-id", "slice", "--provider", "opencode", "--model", "gpt-5.5", "--source", "usage-log", "--operation", "completion", "--request-id", "req-1", "--input-tokens", "10", "--output-tokens", "5", "--total-tokens", "15", "--cost-total", "0.02", "--currency", "USD", "--recorded-at", "2026-07-08T12:30:00.000Z", "--entry-id", "cli-cost", "--json"]).stdout);
      assert.equal(costRecorded.entry.id, "cli-cost");
      assert.equal(costRecorded.entry.slice_id, "slice");
      assert.equal(costRecorded.cost_summary.total_tokens, 15);
      assert.equal(JSON.parse(runFactory(repo, ["status", RUN_ID, "--json"]).stdout).cost_summary.cost_total, 0.02);
      assert.equal(JSON.parse(runFactory(repo, ["list", "--json"]).stdout)[0].cost_summary.entry_count, 1);
      assert.match(runFactory(repo, ["list"]).stdout, /cost available · 1 entry · 15 tokens · 0\.02 USD/u);
      validateFactory(repo);
      runFactory(repo, ["slice-status", RUN_ID, "slice", "running", "--branch", "slice-branch", "--worktree", ".opencode/worktrees/slice", "--attempts", "1", "--json"]);
      const completionToken = "cli-write-surface-completion";
      const dispatch = await prepareSliceBuilderTaskDispatch(repo, {
        run_id: RUN_ID, slice_id: "slice", attempt: 1, agent: "backend-builder",
      }, { claimDispatch: true, completionToken });
      writeFileSync(join(sliceWorktree, "slice.txt"), "slice bytes\n");
      runGit(sliceWorktree, ["add", "slice.txt"]);
      runGit(sliceWorktree, ["commit", "-m", "slice bytes"]);
      reviewedHead = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]).trim();
      await completeSliceBuilderTaskDispatch(repo, {
        run_id: RUN_ID,
        slice_id: "slice",
        attempt: 1,
        agent: "backend-builder",
        claim_ref: dispatch.dispatch_claim.ref,
        claim_hash: dispatch.dispatch_claim.hash,
        completion_token: completionToken,
      });
      validateFactory(repo);
      assert.match(runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]).stderr, /refuses to replace non-pending slice progress/u);
      assert.match(runFactoryFail(repo, ["slice-status", RUN_ID, "typo", "running", "--branch", "slice-branch", "--worktree", ".opencode/worktrees/typo", "--attempts", "1", "--json"]).stderr, /slice 'typo' not found/u);
      writeJson(join(runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedHead });
      writeJson(join(runDir, "reviews", "slice.json"), { subject: "slice", verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0, required_fixes: [], ownership_ratification: { schema_version: 1, paths: ["slice.txt"] }, remediation_context: { schema_version: 2, fixes: [] }, attempt: 1, reviewed_commit: reviewedHead });
      runFactory(repo, ["slice-status", RUN_ID, "slice", "review", "--evidence-ref", "evidence/slice.json", "--review-ref", "reviews/slice.json", "--json"]);
      assert.deepEqual(readJson(join(runDir, "run.json")).slices[0].effective_paths, ["src/example.js", "slice.txt"]);
      validateFactory(repo);
      runGit(repo, ["merge", "--no-ff", "slice-branch", "-m", "merge slice"]);
      const integrationHead = gitOutput(repo, ["rev-parse", "HEAD"]).trim();
      runFactory(repo, ["slice-merged", RUN_ID, "slice", "--merge-commit", integrationHead, "--json"]);
      validateFactory(repo);

      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      runFactory(repo, ["step", RUN_ID, "story-reader", "accepted", "--attempts", "1", "--artifact-ref", "artifacts/story.md", "--review-ref", "reviews/slice.json", "--json"]);
      validateFactory(repo);
      assert.match(runFactoryFail(repo, ["step", RUN_ID, "unknown-agent", "running", "--attempts", "1", "--json"]).stderr, /step 'unknown-agent' not found/u);

      writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n", "utf8");
      writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "feature-branch", verdict: "GO", attempt: 1, reviewed_head_sha: integrationHead });
      writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "feature-branch", verdict: "PASS", attempt: 1, reviewed_head_sha: integrationHead });
      runFactory(repo, ["verdicts", RUN_ID, "--validator", "GO", "--report", "artifacts/validation-report.md", "--security", "PASS", "--review-ref", "reviews/security-reviewer.json", "--json"]);
      validateFactory(repo);

      writeFileSync(join(runDir, "gates", "pre_pr.question.md"), "approve PR?\n", "utf8");
      runFactory(repo, ["gate-decision", RUN_ID, "pre_pr", "pending", "--artifact", "artifacts/validation-report.md", "--question-ref", "gates/pre_pr.question.md", "--answer-ref", "gates/pre_pr.answer", "--json"]);
      validateFactory(repo);
      runFactory(repo, ["answer", "--json", RUN_ID, "pre_pr", "approve"]);
      const gateBoundary = openBoundary(repo, "gate");
      runFactory(repo, ["gate-decision", RUN_ID, "pre_pr", "approved", "--artifact", "artifacts/validation-report.md", "--question-ref", "gates/pre_pr.question.md", "--answer-ref", "gates/pre_pr.answer", "--approval-source", "external-driver", "--boundary-token", gateBoundary.token, "--json"]);
      validateFactory(repo);

      writeFakeGhForPrOperation(repo);
      const fence = JSON.parse(runFactory(repo, ["pr-fence", RUN_ID, "--json"]).stdout).fence;
      const completed = JSON.parse(runFactory(repo, ["pr-created", RUN_ID, "--fence-token", fence.token, "--json"]).stdout);
      const validation = JSON.parse(runFactory(repo, ["validate", RUN_ID]).stdout);

      assert.equal(completed.status, "completed");
      assert.equal(validation.ok, true, JSON.stringify(validation, null, 2));
      assert.equal(readJson(join(runDir, "run.json")).status, "completed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects every generated plan mutation through slicesSeed and preserves the checked seed/reseed guard", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-plan-mutations-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      seedRun(runDir);
      const record = DURABLE_AUTHORITY_CATALOG.flatMap(({ records }) => records).find(({ id }) => id === "plan-v2-integration-gate");
      const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
      assert.equal(cases.length, 6);
      const planPath = join(runDir, "plan", "slices.json");
      const alternatePath = join(runDir, "plan", "alternate.json");
      writeJson(alternatePath, record.source);
      const beforeSourceRejections = readFileSync(join(runDir, "run.json"), "utf8");
      for (const from of ["plan/alternate.json", alternatePath, `.opencode/factory/${RUN_ID}/plan/slices.json`]) {
        const rejected = runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", from, "--json"]);
        assert.match(rejected.stderr, /--from must be exactly plan\/slices\.json/u, from);
        assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), beforeSourceRejections, from);
      }
      const invalidUtf8 = Buffer.concat([
        Buffer.from('{"slices":[{"id":"B1C","stack":"backend","paths":["src/**"],"depends_on":[],"acceptance":["AC1"],"test_plan":["node --test"]}],"integration_gate":{"required_commands":[{"program":"node","args":["', "utf8"),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"]},{"program":"npm","args":["run","check"]}]}}\n', "utf8"),
      ]);
      writeFileSync(planPath, invalidUtf8);
      const invalidUtf8Rejected = runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]);
      assert.match(invalidUtf8Rejected.stderr, /valid UTF-8/u);
      assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), beforeSourceRejections);
      rmSync(planPath);
      symlinkSync(alternatePath, planPath);
      const symlinkRejected = runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]);
      assert.match(symlinkRejected.stderr, /must not contain symlinks|regular non-symlink/u);
      assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), beforeSourceRejections);
      rmSync(planPath);
      writeJson(join(runDir, "plan", "slices.json"), { slices: record.source.slices });
      const legacyRejected = runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]);
      assert.match(legacyRejected.stderr, /plan\.integration_gate: is required for newly produced and schema-v2 plans/u);
      for (const mutationCase of cases) {
        writeJson(join(runDir, "plan", "slices.json"), mutationCase.record);
        const before = readFileSync(join(runDir, "run.json"), "utf8");
        const rejected = runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]);
        assert.match(rejected.stderr, /plan\.|dependency/u, mutationCase.name);
        assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), before, mutationCase.name);
      }

      writeJson(join(runDir, "plan", "slices.json"), record.source);
      runFactory(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]);
      const seededBytes = readFileSync(join(runDir, "run.json"), "utf8");
      runFactory(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]);
      assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), seededBytes, "byte-identical pending reseed is a checked no-op");
      runFactory(repo, ["slice-status", RUN_ID, "B1C", "running", "--attempts", "1", "--json"]);
      const startedBytes = readFileSync(join(runDir, "run.json"), "utf8");
      assert.match(runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--json"]).stderr, /refuses to replace non-pending slice progress/u);
      assert.match(runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", "plan/slices.json", "--force", "--json"]).stderr, /refuses to replace non-pending slice progress/u);
      assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), startedBytes, "post-start reseed rejection must not mutate run.json");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects blank cost numeric flags without mutating run.json", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-cost-invalid-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo);
      seedRun(runDir);
      const before = readFileSync(join(runDir, "run.json"), "utf8");

      for (const [flag, value] of [["--input-tokens", ""], ["--cost-total", "   "]]) {
        const failed = runFactoryFail(repo, ["cost-record", RUN_ID, "--agent", "backend-builder", flag, value, "--json"]);
        assert.match(failed.stderr, new RegExp(`${flag} must be a finite non-negative number`, "u"));
        assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), before);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("resolves state commands from a managed git worktree cwd without --repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-worktree-cwd-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    const branch = `${RUN_ID}-worktree`;
    const worktree = join(repo, ".opencode", "worktrees", branch);
    try {
      initGitRepo(repo);
      mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
      runGit(repo, ["worktree", "add", "-b", branch, worktree]);
      seedRun(runDir);
      writeJson(join(runDir, "run.json"), { ...readJson(join(runDir, "run.json")), branch, worktree });
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      writeFileSync(join(runDir, "gates", "story.question.md"), "approve story?\n", "utf8");

      const current = JSON.parse(runFactoryFrom(worktree, ["status", RUN_ID, "--json"]).stdout);
      runFactoryFrom(worktree, ["gate-decision", RUN_ID, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      const listed = JSON.parse(runFactoryFrom(worktree, ["list", "--json"]).stdout);

      assert.equal(current.run_id, RUN_ID);
      assert.equal(listed[0].run_id, RUN_ID);
      assert.equal(readJson(join(runDir, "run.json")).gates.story.status, "pending");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function seedRun(runDir) {
  mkdirSync(join(runDir, "plan"), { recursive: true });
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: RUN_ID,
    status: "running",
    branch: "main",
    worktree: resolve(runDir, "../../.."),
    gates: {},
    slices: [],
    steps: [
      { agent: "spec-writer", status: "running", attempts: 0 },
      { agent: "work-decomposer", status: "running", attempts: 0 },
      { agent: "story-reader", status: "running", attempts: 0 },
    ],
  });
  writeJson(join(runDir, "plan", "slices.json"), {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{ id: "slice", stack: "backend", paths: ["src/example.js"], depends_on: [], acceptance: ["works"], test_plan: ["unit"] }],
  });
}


function validateFactory(repo) {
  const validation = JSON.parse(runFactory(repo, ["validate", RUN_ID]).stdout);
  assert.equal(validation.ok, true, JSON.stringify(validation, null, 2));
}

function openBoundary(repo, kind) {
  return JSON.parse(runFactory(repo, ["boundary-open", RUN_ID, kind, "--json"]).stdout).boundary;
}

function runFactoryFail(repo, args) {
  const proc = spawnFactory(repo, args);
  assert.notEqual(proc.status, 0, proc.stdout || proc.stderr);
  return proc;
}

function runFactory(repo, args) {
  const proc = spawnFactory(repo, args);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc;
}

function runFactoryFrom(cwd, args) {
  const proc = spawnSync(process.execPath, [CLI, "factory", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    timeout: 15000,
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc;
}

function spawnFactory(repo, args) {
  const commandArgs = args[0] === "answer"
    ? [CLI, "factory", "answer", "--repo", repo, ...args.slice(1)]
    : args[0] === "pr-created"
      ? [CLI, "factory", ...args]
    : [CLI, "factory", ...args, "--repo", repo];
  return spawnSync(process.execPath, commandArgs, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: `${join(repo, ".opencode", "fake-bin")}:${process.env.PATH || ""}` },
    timeout: 15000,
  });
}

function writeFakeGhForPrOperation(repo) {
  const bin = join(repo, ".opencode", "fake-bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "gh");
  writeFileSync(script, `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv[2] === "auth") process.exit(0);
const run = JSON.parse(readFileSync(join(process.cwd(), ".opencode", "factory", ${JSON.stringify(RUN_ID)}, "run.json"), "utf8"));
const fence = run.steering.pr_fence;
const pr = { html_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/123", number: 123, node_id: "PR_cli_write_surface", draft: fence.draft, body: "<!-- opencode-feature-factory:pr-operation=" + fence.operation_id + " -->", state: "open", merged_at: null, head: { ref: fence.head_ref, sha: fence.head_sha, repo: { full_name: fence.repository } }, base: { ref: fence.base_ref, sha: fence.base_sha, repo: { full_name: fence.repository } } };
process.stdout.write("HTTP/2 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n" + JSON.stringify([pr]));
`, "utf8");
  chmodSync(script, 0o755);
}

function spawnFactoryStart(repo, args, bin, capture) {
  return spawnSync(process.execPath, [CLI, "factory", "start", "--repo", repo, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      FEATURE_FACTORY_CAPTURE: capture,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${bin}:${process.env.PATH || ""}`,
    },
    timeout: 15000,
  });
}

function writeFakeOpencode(repo, capture) {
  const bin = join(repo, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "opencode");
  writeFileSync(script, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.FEATURE_FACTORY_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }, null, 2) + "\\n");
`, "utf8");
  chmodSync(script, 0o755);
  return bin;
}

function initGitRepo(repo, branches = []) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
  for (const branch of branches) runGit(repo, ["branch", branch]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function snapshotFixtureTree(root) {
  const snapshot = {};
  snapshotFixtureDirectory(root, "", snapshot);
  return snapshot;
}

function snapshotFixtureDirectory(root, relative, snapshot) {
  const directory = relative ? join(root, relative) : root;
  for (const name of readdirSync(directory).sort()) {
    if (!relative && name === ".git") continue;
    const childRelative = relative ? join(relative, name) : name;
    const child = join(root, childRelative);
    if (statSync(child).isDirectory()) {
      snapshot[`${childRelative}/`] = "directory";
      snapshotFixtureDirectory(root, childRelative, snapshot);
      continue;
    }
    snapshot[childRelative] = readFileSync(child).toString("base64");
  }
}

function snapshotGitBaseline(repo) {
  return {
    status: gitOutput(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    branches: gitOutput(repo, ["branch", "--format=%(refname:short) %(objectname)"]),
    worktrees: gitOutput(repo, ["worktree", "list", "--porcelain"]),
  };
}

function gitOutput(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout;
}
