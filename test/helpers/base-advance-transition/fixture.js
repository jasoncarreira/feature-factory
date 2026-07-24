import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDeliveryEnvelope } from "../delivery-envelope-fixture.js";
import { runFixtureGit } from "../git-fixture.js";

const NOW = "2026-07-23T12:00:00.000Z";

export function createBaseAdvanceTransitionFixture(name) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `base-advance-transition-${name}-`)));
  const remote = join(root, "origin.git");
  const publisher = join(root, "publisher");
  const repo = join(root, "repo");
  const runId = `run-${name}`;
  const worktree = join(repo, ".opencode", "worktrees", runId);
  const runDir = join(repo, ".opencode", "factory", runId);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  git(root, ["clone", remote, publisher]);
  writeFileSync(join(publisher, "state.txt"), "base\n");
  git(publisher, ["add", "state.txt"]);
  commit(publisher, "base");
  git(publisher, ["push", "origin", "main"]);
  git(root, ["clone", remote, repo]);
  const canonicalUrl = `https://github.com/example/${runId}.git`;
  git(repo, ["remote", "set-url", "origin", canonicalUrl]);
  git(repo, ["config", `url.file://${remote}.insteadOf`, canonicalUrl]);
  git(repo, ["config", "protocol.file.allow", "always"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  const base = output(repo, ["rev-parse", "HEAD"]);
  mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
  git(repo, ["worktree", "add", "-b", runId, worktree, base]);
  mkdirSync(runDir, { recursive: true });
  const run = {
    schema_version: 1,
    run_id: runId,
    mode: "headless",
    status: "running",
    created_at: NOW,
    updated_at: NOW,
    heartbeat_at: null,
    base_ref: "main",
    base_commit: base,
    branch: runId,
    worktree,
    github_account: "octocat",
    pr_mode: "ready",
    pr_url: null,
    max_parallel_slices: 1,
    max_retries: 3,
    review_tier: "standard",
    gates: {},
    slices: [],
    steps: [],
    terminal_result: null,
  };
  writeJson(join(runDir, "run.json"), run);

  return {
    root,
    remote,
    publisher,
    repo,
    runId,
    runDir,
    worktree,
    base,
    run,
    advance(contents = `advance-${name}\n`) {
      writeFileSync(join(publisher, "state.txt"), contents);
      git(publisher, ["add", "state.txt"]);
      commit(publisher, `advance ${name}`);
      git(publisher, ["push", "origin", "main"]);
      return output(publisher, ["rev-parse", "HEAD"]);
    },
    readRun() {
      return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    },
    writeRun(value) {
      writeJson(join(runDir, "run.json"), value);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function installRepresentativeAuthorityInventory(fixture) {
  const candidate = `${fixture.runId}-candidate`;
  const candidateWorktree = join(fixture.repo, ".opencode", "worktrees", candidate);
  git(fixture.repo, ["worktree", "add", "-b", candidate, candidateWorktree, fixture.base]);
  writeFileSync(join(candidateWorktree, "candidate.txt"), "candidate committed bytes\n");
  git(candidateWorktree, ["add", "candidate.txt"]);
  commit(candidateWorktree, "candidate commit");
  const candidateHead = output(candidateWorktree, ["rev-parse", "HEAD"]);
  writeFileSync(join(candidateWorktree, "staged.txt"), "candidate staged bytes\n");
  writeFileSync(join(candidateWorktree, "untracked.txt"), "candidate untracked bytes\n");
  git(candidateWorktree, ["add", "staged.txt"]);

  for (const directory of ["artifacts", "dispatch", "evidence", "gates", "plan", "processes", "reviews", "steering"]) {
    mkdirSync(join(fixture.runDir, directory), { recursive: true });
  }
  writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "accepted story bytes\n");
  writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "accepted technical brief bytes\n");
  writeFileSync(join(fixture.runDir, "gates", "story.question.md"), "approve the story?\n");
  writeFileSync(join(fixture.runDir, "gates", "story.answer.consumed-1"), "approve\n");
  writeFileSync(join(fixture.runDir, "processes", "opencode.log"), "exited process log bytes\n");
  writeFileSync(join(fixture.runDir, "steering", "consumed-history.json"), "settled steering bytes\n");

  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{
      id: "candidate", stack: "backend", paths: ["candidate.txt", "staged.txt", "untracked.txt"], depends_on: [],
      acceptance: ["candidate remains preserved"], test_plan: ["npm run check"],
    }],
  });
  writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
  writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", attempt: 1, verdict: "APPROVE" });
  writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE" });

  const evidenceRef = "evidence/candidate.attempt-1.json";
  const reviewRef = "reviews/candidate.attempt-1.json";
  writeJson(join(fixture.runDir, evidenceRef), {
    subject: "candidate", attempt: 1, status: "pass", review_ready: true, head_sha: candidateHead,
    ownership_disclosure: [],
  });
  writeJson(join(fixture.runDir, reviewRef), {
    subject: "candidate", attempt: 1, reviewed_commit: candidateHead, verdict: "REJECT", convergence: "converging",
    late_discovery_strike: false, remaining_fix_count: 1, required_fixes: ["retain candidate unchanged"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: {
      schema_version: 2,
      fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["candidate.txt"], fix_owner: "candidate" }],
    },
  });

  const claimStem = createHash("sha256").update(`${fixture.runId}\0candidate\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  const completionToken = "candidate-completion-token";
  const contextHash = hashBytes("candidate dispatch context");
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: fixture.runId, slice_id: "candidate", attempt: 1,
    agent: "backend-builder", branch: candidate, worktree: candidateWorktree, head: fixture.base, context_hash: contextHash,
    completion_token_hash: hashBytes(completionToken), claimed_at: NOW, closure_ref: closureRef,
  });
  const claimHash = hashFile(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash,
    run_id: fixture.runId, slice_id: "candidate", attempt: 1, agent: "backend-builder", branch: candidate,
    worktree: candidateWorktree, head: fixture.base, completion_head: candidateHead, context_hash: contextHash,
    completion_token: completionToken, returned_at: NOW,
  });
  const dispatch = {
    dispatch_claim_ref: claimRef,
    dispatch_claim_hash: claimHash,
    dispatch_closure_ref: closureRef,
    dispatch_closure_hash: hashFile(join(fixture.runDir, closureRef)),
  };
  const attemptReview = {
    attempt: 1, evidence_ref: evidenceRef, evidence_hash: hashFile(join(fixture.runDir, evidenceRef)),
    review_ref: reviewRef, review_hash: hashFile(join(fixture.runDir, reviewRef)), reviewed_commit: candidateHead,
    diff_base_commit: fixture.base, ratified_paths: [], verdict: "REJECT", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 1,
    ...dispatch,
  };

  const steeringRef = "steering/consumed-history.json";
  const run = {
    ...fixture.readRun(),
    heartbeat_at: NOW,
    gates: {
      story: {
        status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer.consumed-1", answered_at: NOW, answer: "approve", approval_source: "external-driver",
      },
    },
    slices: [{
      id: "candidate", stack: "backend", depends_on: [], declared_paths: [...plan.slices[0].paths], effective_paths: [...plan.slices[0].paths],
      status: "review", attempts: 1, branch: candidate, worktree: candidateWorktree, authorized_baseline_commit: fixture.base,
      evidence_ref: evidenceRef, evidence_hash: attemptReview.evidence_hash, review_ref: reviewRef,
      review_hash: attemptReview.review_hash, reviewed_commit: candidateHead, attempt_reviews: [attemptReview], dispatch_required: true, ...dispatch,
    }],
    steps: [
      {
        agent: "spec-writer", status: "accepted", attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
        acceptance: {
          artifact_ref: "artifacts/technical-brief.md", artifact_hash: hashFile(join(fixture.runDir, "artifacts", "technical-brief.md")),
          review_ref: "reviews/spec-writer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "spec-writer.json")),
        },
      },
      {
        agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
          review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
        },
      },
    ],
    steering: {
      schema_version: 1, generation: 3, pending: null, uncheckpointed: null, boundary: null, action_claim: null,
      last_action: { kind: "dispatch", token: "settled-token", generation: 3, outcome: "closed", claimed_at: NOW, resolved_at: NOW },
      pr_fence: null,
      history: [{
        event: "acknowledged", id: "history", ref: steeringRef, hash: hashFile(join(fixture.runDir, steeringRef)), message_chars: 22,
        created_at: NOW, consumed_at: NOW, acknowledged_at: NOW, outcome: "applied-prospectively",
      }],
    },
  };
  fixture.writeRun(run);
  writeJson(join(fixture.runDir, "heartbeat.json"), {
    schema_version: 1, run_id: fixture.runId, phase: "settled", pid: null, interval_ms: 30_000, last_tick_at: NOW,
  });
  writeJson(join(fixture.runDir, "factory.lock"), { schema_version: 1, run_id: fixture.runId, session_owner: "settled", updated_at: NOW });
  writeJson(join(fixture.runDir, "process.json"), {
    schema_version: 1, kind: "opencode-process", run_id: fixture.runId, execution_id: "settled-execution", pid: 4242,
    started_at: NOW, updated_at: NOW, state: "exited", cwd: fixture.repo,
    identity: { inspector: "test-inspector", start_marker: "start-1", command_name: "opencode" },
    log_ref: "processes/opencode.log", cancel: null,
  });

  return {
    candidate,
    candidateWorktree,
    candidateHead,
    candidateFiles: ["candidate.txt", "staged.txt", "untracked.txt"],
    protectedRunPaths: [
      "artifacts/story.md", "artifacts/technical-brief.md", claimRef, closureRef, evidenceRef, "factory.lock",
      "gates/story.answer.consumed-1", "gates/story.question.md", "heartbeat.json", "plan/slices.json", "process.json",
      "processes/opencode.log", reviewRef, "reviews/spec-writer.json", "reviews/work-decomposer.json", steeringRef,
    ].sort(),
  };
}

export function captureRepresentativeAuthorityInventory(fixture, inventory) {
  return {
    run_files: Object.fromEntries(inventory.protectedRunPaths.map((path) => [path, readFileSync(join(fixture.runDir, path)).toString("base64")])),
    candidate: {
      ref: output(fixture.repo, ["rev-parse", `refs/heads/${inventory.candidate}`]),
      commit: output(inventory.candidateWorktree, ["rev-parse", "HEAD"]),
      symbolic_head: output(inventory.candidateWorktree, ["symbolic-ref", "HEAD"]),
      index: output(inventory.candidateWorktree, ["ls-files", "--stage"]),
      status: output(inventory.candidateWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
      files: Object.fromEntries(inventory.candidateFiles.map((path) => [path, readFileSync(join(inventory.candidateWorktree, path)).toString("base64")])),
    },
  };
}

export function git(cwd, args) {
  const result = runFixtureGit(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

export function output(cwd, args) {
  return git(cwd, args).stdout.trim();
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(path) {
  return hashBytes(readFileSync(path));
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function commit(cwd, message) {
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}
