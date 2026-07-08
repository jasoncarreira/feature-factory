import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createAttestationIndex, createRunBaseAttestation, hashFile } from "../src/provenance-authority.js";
import { validateRunDir } from "../src/validate.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const RUN_ID = "cli-gate-decision";

describe("cli gate decision routing", () => {
  it("routes approved gate writes through transitionGateDecision", () => {
    const repo = tempRepo();

    try {
      initRepo(repo);
      const runDir = createRun(repo);
      writeFixture(runDir, "artifacts/story.json", "{\n  \"title\": \"Story\"\n}\n");
      writeFixture(runDir, "gates/story.question.json", "{\n  \"question\": \"Approve?\"\n}\n");
      writeFixture(runDir, "gates/story.answer.json", "{\n  \"answer\": \"approve\"\n}\n");
      writePendingGateSnapshot(runDir, "story", "artifacts/story.json", "gates/story.question.json");

      const proc = runGateDecision(repo, [
        "approved",
        "--answer-ref",
        "gates/story.answer.json",
        "--approval-source",
        "external-driver",
      ]);

      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.gate, "story");
      assert.equal(output.attestation_ref, "attestations/gates/story.json");

      const run = readJson(join(runDir, "run.json"));
      const index = readJson(join(runDir, "attestations", "index.json"));
      assert.equal(run.gates.story.status, "approved");
      assert.equal(index.entries.at(-1).type, "gate-decision");
      assert.equal(validateRunDir(runDir, { repoRoot: repo }).ok, true);
    } finally {
      cleanup(repo);
    }
  });

  it("rejects public approved gate decisions with inline answers", () => {
    const repo = tempRepo();

    try {
      initRepo(repo);
      const runDir = createRun(repo);
      writeFixture(runDir, "artifacts/story.json", "{\n  \"title\": \"Story\"\n}\n");
      writeFixture(runDir, "gates/story.question.json", "{\n  \"question\": \"Approve?\"\n}\n");
      writePendingGateSnapshot(runDir, "story", "artifacts/story.json", "gates/story.question.json");
      const originalRun = readJson(join(runDir, "run.json"));

      const proc = runGateDecision(repo, [
        "approved",
        "--answer",
        "approve inline",
        "--approval-source",
        "external-driver",
      ]);

      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /inline --answer is not accepted/u);
      assert.deepEqual(readJson(join(runDir, "run.json")), originalRun);
      assert.equal(existsSync(join(runDir, "attestations", "gates", "story.json")), false);
    } finally {
      cleanup(repo);
    }
  });

  it("rejects public approved gate decisions with forgeable non-external approval sources", () => {
    for (const source of ["human", "autonomous", "override"]) {
      const repo = tempRepo();
      try {
        initRepo(repo);
        const runDir = createRun(repo);
        writeFixture(runDir, "artifacts/story.json", "{\n  \"title\": \"Story\"\n}\n");
        writeFixture(runDir, "gates/story.question.json", "{\n  \"question\": \"Approve?\"\n}\n");
        writeFixture(runDir, "gates/story.answer.json", "{\n  \"answer\": \"approve\"\n}\n");
        writePendingGateSnapshot(runDir, "story", "artifacts/story.json", "gates/story.question.json");
        const originalRun = readJson(join(runDir, "run.json"));

        const proc = runGateDecision(repo, [
          "approved",
          "--answer-ref",
          "gates/story.answer.json",
          "--approval-source",
          source,
        ]);

        assert.notEqual(proc.status, 0, source);
        assert.match(proc.stderr, /--approval-source external-driver/u, source);
        assert.deepEqual(readJson(join(runDir, "run.json")), originalRun, source);
        assert.equal(existsSync(join(runDir, "attestations", "gates", "story.json")), false, source);
      } finally {
        cleanup(repo);
      }
    }
  });
});

function runGateDecision(repo, extraArgs) {
  return spawnSync(process.execPath, [
    CLI,
    "factory",
    "gate-decision",
    RUN_ID,
    "story",
    ...extraArgs,
    "--artifact",
    "artifacts/story.json",
    "--question-ref",
    "gates/story.question.json",
    "--json",
  ], { cwd: repo, encoding: "utf8" });
}

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-cli-gate-"));
}

function initRepo(repo) {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Feature Factory CLI Test"]);
  git(repo, ["config", "user.email", "factory-cli@example.com"]);
  writeFixture(repo, "tracked.txt", "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
}

function createRun(repo) {
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  const featureBranch = "cli-gate-decision-branch";
  const featureWorktree = join(repo, ".opencode", "worktrees", featureBranch);
  mkdirSync(dirname(featureWorktree), { recursive: true });
  git(repo, ["worktree", "add", "-b", featureBranch, featureWorktree, "HEAD"]);
  for (const directory of ["artifacts", "gates", "evidence", "reviews", "attestations"]) {
    mkdirSync(join(runDir, directory), { recursive: true });
  }
  const baseCommit = gitStdout(repo, ["rev-parse", "HEAD"]);
  const baseTree = gitStdout(repo, ["rev-parse", "HEAD^{tree}"]);
  const gitCommonDir = gitStdout(featureWorktree, ["rev-parse", "--git-common-dir"]);
  const gitCommonDirPath = isAbsolute(gitCommonDir) ? gitCommonDir : join(featureWorktree, gitCommonDir);
  const runBase = createRunBaseAttestation({
    run_id: RUN_ID,
    sequence: 1,
    prev_hash: null,
    created_at: "2026-07-07T00:00:00.000Z",
    bindings: {
      repo_root: realpathSync.native(repo),
      run_dir: realpathSync.native(runDir),
      git_common_dir: realpathSync.native(gitCommonDirPath),
      feature_branch: featureBranch,
      feature_worktree: realpathSync.native(featureWorktree),
      base_ref: "main",
      base_commit: baseCommit,
      base_tree: baseTree,
    },
  });

  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: RUN_ID,
    mode: "headless",
    status: "running",
    gates: {
      story: {
        status: "pending",
        artifact: "artifacts/story.json",
        question_ref: "gates/story.question.json",
        answer_ref: "gates/story.answer.json",
      },
    },
    slices: [],
    validator: null,
    security_review: null,
    pr_url: null,
    terminal_result: null,
  });
  writeJson(join(runDir, "attestations", "run-base.json"), runBase);
  writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex([{ ref: "attestations/run-base.json", attestation: runBase }]));
  return runDir;
}

function writeFixture(root, ref, contents) {
  const path = join(root, ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writePendingGateSnapshot(runDir, gateName, artifactRef, questionRef) {
  const runPath = join(runDir, "run.json");
  const run = readJson(runPath);
  run.gates[gateName].pending_snapshot = {
    question_ref: questionRef,
    question_hash: hashFile(join(runDir, questionRef), { mode: "raw" }),
    artifact_ref: artifactRef,
    artifact_hash: hashFile(join(runDir, artifactRef), { mode: "raw" }),
    created_at: "2026-07-07T00:00:00.000Z",
  };
  writeJson(runPath, run);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function gitStdout(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function cleanup(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}
