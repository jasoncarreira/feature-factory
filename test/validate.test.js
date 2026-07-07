import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { REDACTED_PROVENANCE_VALUE } from "../src/provenance.js";
import {
  createAttestationIndex,
  createDirectReviewedCommitAttestation,
  createGateDecisionAttestation,
  createMergeChainAttestation,
  createPrCreatedAttestation,
  createReviewApprovalAttestation,
  createRunBaseAttestation,
  gitDiffHash,
  hashFile,
  hashValue,
} from "../src/provenance-authority.js";
import { SAFE_GIT_POLICY } from "../src/safe-git.js";
import { validateFactoryLock, validateHeartbeatState, validateRun, validateRunDir, validateSlicesPlan, ValidationError } from "../src/validate.js";

describe("validateRun", () => {
  it("accepts a running run with a pending gate", () => {
    assert.equal(validateRun(runningRun()).run_id, "app-123");
  });

  it("accepts runs without review_tier for backward compatibility", () => {
    assert.equal(validateRun(runningRun()).status, "running");
  });

  it("accepts valid review_tier metadata and tolerates extra fields", () => {
    const run = validateRun({
      ...runningRun(),
      review_tier: {
        ...reviewTier(),
        extra_field: { ignored: true },
      },
    });

    assert.equal(run.review_tier.selected, "standard");
  });

  it("accepts optional GitHub account metadata", () => {
    const run = validateRun({ ...runningRun(), github_account: "jasoncarreira" });

    assert.equal(run.github_account, "jasoncarreira");
  });

  it("accepts redacted diagnostic factory provenance and pending gate snapshots", () => {
    const run = validateRun({
      ...runningRun(),
      factory_provenance: {
        created_with: diagnosticProvenanceSnapshot({
          event: "run-created",
          provenance: { tool: "opencode", auth_state: REDACTED_PROVENANCE_VALUE, nested: [REDACTED_PROVENANCE_VALUE] },
        }),
        last_resumed_with: diagnosticProvenanceSnapshot({ event: "run-resumed", provenance: { tool: "opencode", mode: "headless" } }),
        resume_count: 1,
      },
      gates: {
        story: {
          status: "pending",
          pending_snapshot: pendingSnapshot(),
        },
      },
    });

    assert.equal(run.factory_provenance.resume_count, 1);
    assert.equal(run.factory_provenance.created_with.diagnostic_only, true);
    assert.equal(run.gates.story.pending_snapshot.question_hash, SAMPLE_HASH_A);
    assert.equal(
      validateRun({
        ...runningRun(),
        factory_provenance: {
          created_with: diagnosticProvenanceSnapshot({ event: "run-created" }),
          last_resumed_with: null,
          resume_count: 0,
        },
      }).factory_provenance.last_resumed_with,
      null,
    );
  });

  it("rejects raw token-shaped diagnostic provenance values", () => {
    const tokenCases = [
      ["ghp", `ghp_${"A".repeat(36)}`],
      ["github_pat", `github_pat_${"A".repeat(24)}_${"B".repeat(32)}`],
      ["gho", `gho_${"A".repeat(36)}`],
      ["ghu", `ghu_${"A".repeat(36)}`],
      ["ghs", `ghs_${"A".repeat(36)}`],
      ["ghr", `ghr_${"A".repeat(36)}`],
      ["sk-proj", `sk-proj_${"A".repeat(48)}`],
      ["sk", `sk-${"A".repeat(48)}`],
      ["xoxb", `xoxb_${"A".repeat(12)}-${"B".repeat(12)}`],
      ["xoxp", `xoxp_${"A".repeat(12)}-${"B".repeat(12)}`],
      ["xoxa", `xoxa_${"A".repeat(12)}-${"B".repeat(12)}`],
      ["glpat", `glpat-${"A".repeat(32)}`],
      ["bearer", `Bearer ${"A".repeat(32)}.${"B".repeat(12)}`],
      ["jwt", `${"A".repeat(12)}.${"B".repeat(12)}.${"C".repeat(12)}`],
      ["aws", `AKIA${"A".repeat(16)}`],
      ["credential-url", "https://user:password@example.com/repo.git"],
      ["high-entropy", "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-+=/"],
    ];

    for (const [name, rawValue] of tokenCases) {
      assert.throws(
        () => validateRun({ ...runningRun(), factory_provenance: factoryProvenance({ provenance: { observed: rawValue } }) }),
        (error) =>
          error instanceof ValidationError &&
          error.message.includes("run.factory_provenance.created_with.provenance.observed") &&
          error.message.includes("must be redacted"),
        `expected ${name} token value to be rejected`,
      );
    }
  });

  it("rejects invalid factory provenance and pending snapshot shapes", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), factory_provenance: { created_with: "opencode feature-factory", resume_count: 0 } }),
      (error) => error instanceof ValidationError && error.message.includes("run.factory_provenance.created_with: must be an object"),
    );
    assert.throws(
      () =>
        validateRun({
          ...runningRun(),
          factory_provenance: {
            created_with: diagnosticProvenanceSnapshot({ diagnostic_only: false, provenance: { token: "secret" } }),
            last_resumed_with: "opencode feature-factory resume",
            resume_count: -1,
            token: "secret",
          },
        }),
      (error) =>
        error instanceof ValidationError &&
        error.message.includes("run.factory_provenance.created_with.diagnostic_only") &&
        error.message.includes("run.factory_provenance.created_with.provenance.token") &&
        error.message.includes("run.factory_provenance.last_resumed_with") &&
        error.message.includes("run.factory_provenance.resume_count") &&
        error.message.includes("run.factory_provenance.token"),
    );
    assert.throws(
      () =>
        validateRun({
          ...runningRun(),
          gates: {
            story: {
              status: "pending",
              pending_snapshot: pendingSnapshot({ artifact_hash: "not-a-hash" }),
            },
          },
        }),
      (error) => error instanceof ValidationError && error.message.includes("run.gates.story.pending_snapshot.artifact_hash"),
    );
  });

  it("rejects empty GitHub account metadata", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), github_account: "   " }),
      (error) => error instanceof ValidationError && error.message.includes("run.github_account"),
    );
  });

  it("accepts an explicit light review tier", () => {
    const run = validateRun({
      ...runningRun(),
      review_tier: reviewTier({
        selected: "light",
        source: "explicit",
        risk_reasons: [],
        rationale: "User explicitly selected the light tier for a low-risk change.",
      }),
    });

    assert.equal(run.review_tier.selected, "light");
  });

  it("requires terminal_result for terminal statuses", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), status: "blocked", terminal_result: null }),
      (error) => error instanceof ValidationError && error.message.includes("run.terminal_result"),
    );
  });

  it("requires terminal_result to match run id and status", () => {
    assert.throws(
      () =>
        validateRun({
          ...runningRun(),
          status: "needs-human",
          terminal_result: {
            status: "completed",
            run_id: "other",
            reason: "missing product decision",
          },
        }),
      (error) => error instanceof ValidationError && error.message.includes("must match run.status") && error.message.includes("must match run.run_id"),
    );
  });

  it("rejects invalid gate status", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), gates: { story: { status: "waiting" } } }),
      (error) => error instanceof ValidationError && error.message.includes("run.gates.story.status"),
    );
  });

  it("rejects non-object review_tier values", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), review_tier: "light" }),
      (error) => error instanceof ValidationError && error.message.includes("run.review_tier: must be an object"),
    );
  });

  it("rejects invalid review_tier selected, source, and risk values", () => {
    assert.throws(
      () =>
        validateRun({
          ...runningRun(),
          review_tier: reviewTier({
            selected: "fast",
            source: "manual",
            risk_reasons: ["unknown_reason"],
          }),
        }),
      (error) =>
        error instanceof ValidationError &&
        error.message.includes("run.review_tier.selected") &&
        error.message.includes("run.review_tier.source") &&
        error.message.includes("run.review_tier.risk_reasons[0]"),
    );
  });

  it("rejects missing review_tier rationale", () => {
    const { rationale, ...reviewTierWithoutRationale } = reviewTier();

    assert.throws(
      () => validateRun({ ...runningRun(), review_tier: reviewTierWithoutRationale }),
      (error) => error instanceof ValidationError && error.message.includes("run.review_tier.rationale"),
    );
  });

  it("rejects empty review_tier rationale", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), review_tier: reviewTier({ rationale: "   " }) }),
      (error) => error instanceof ValidationError && error.message.includes("run.review_tier.rationale"),
    );
  });
});

describe("validateHeartbeatState", () => {
  it("accepts a heartbeat sidecar with a known phase contract", () => {
    assert.equal(validateHeartbeatState(heartbeatState()).run_id, "heartbeat-liveness");
    assert.equal(validateHeartbeatState(heartbeatState({ status: "running", phase: "security-reviewer" })).status, "running");
  });

  it("accepts stopping and stopped lifecycle states", () => {
    assert.equal(
      validateHeartbeatState(heartbeatState({ status: "stopping", stop_requested_at: "2026-07-06T00:00:06.000Z" })).status,
      "stopping",
    );
    assert.equal(
      validateHeartbeatState(
        heartbeatState({
          status: "stopped",
          stop_requested_at: "2026-07-06T00:00:06.000Z",
          stopped_at: "2026-07-06T00:00:07.000Z",
          stop_reason: "heartbeat completed cleanly",
        }),
      ).status,
      "stopped",
    );
  });

  it("rejects stopping or stopped sidecars without lifecycle stop fields", () => {
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ status: "stopping", stop_requested_at: undefined })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.stop_requested_at"),
    );
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ status: "stopped", stopped_at: undefined })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.stopped_at"),
    );
  });

  it("rejects active sidecars with stop_reason but no stop lifecycle transition", () => {
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ status: "running", stop_reason: "handoff" })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.stop_reason"),
    );
  });

  it("rejects unknown phases", () => {
    assert.throws(
      () => validateHeartbeatState(heartbeatState({ phase: "gate-review" })),
      (error) => error instanceof ValidationError && error.message.includes("heartbeat.phase"),
    );
  });
});

describe("validateFactoryLock", () => {
  it("accepts a factory lock with a heartbeat owner capability", () => {
    assert.equal(validateFactoryLock(factoryLock()).heartbeat_owner, "heartbeat-owner-capability");
  });

  it("rejects factory locks without a heartbeat owner capability", () => {
    assert.throws(
      () => validateFactoryLock(factoryLock({ heartbeat_owner: "   " })),
      (error) => error instanceof ValidationError && error.message.includes("factory_lock.heartbeat_owner"),
    );
  });
});

describe("validateRunDir", () => {
  it("validates factory.lock when present", () => {
    const runDir = tempRunDir("heartbeat-liveness-lock");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun({ run_id: "heartbeat-liveness" }));
    writeJson(join(runDir, "factory.lock"), factoryLock({ run_id: "heartbeat-liveness" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState());

    const result = validateRunDir(runDir);

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 3);
    cleanupTemp(runDir);
  });

  it("validates heartbeat.json when present", () => {
    const runDir = tempRunDir("heartbeat-liveness");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun({ run_id: "heartbeat-liveness" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState());

    const result = validateRunDir(runDir);

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 2);
    cleanupTemp(runDir);
  });

  it("still rejects terminal runs without a valid terminal_result when heartbeat.json is present", () => {
    const runDir = tempRunDir("heartbeat-liveness-terminal");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), { ...runningRun({ run_id: "heartbeat-liveness", status: "blocked" }), terminal_result: null });
    writeJson(
      join(runDir, "heartbeat.json"),
      heartbeatState({
        status: "stopped",
        phase: "remediation",
        stop_requested_at: "2026-07-06T00:00:06.000Z",
        stopped_at: "2026-07-06T00:00:07.000Z",
        stop_reason: "run reached a terminal state",
      }),
    );

    const result = validateRunDir(runDir);

    assert.equal(result.ok, false);
    assert.equal(result.checks[0].errors[0].path, "run.terminal_result");
    cleanupTemp(runDir);
  });

  it("keeps legacy structurally readable runs valid when they assert no provenance-sensitive state", () => {
    const runDir = tempRunDir("legacy-readable");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun({ gates: { story: { status: "pending" } }, slices: [] }));

    const result = validateRunDir(runDir);

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 1);
    cleanupTemp(runDir);
  });

  it("rejects PR URLs without an accepted pr-created attestation", () => {
    const fixture = buildPrAuthorityRun({ includePrCreated: false });

    const result = validateRunDir(fixture.runDir);
    const errors = joinCheckErrors(result);

    assert.equal(result.ok, false);
    assert.match(errors, /PR URL requires an accepted pr-created attestation/u);
    cleanupRepo(fixture.repoRoot);
  });

  it("accepts PR URLs that match the latest accepted pr-created attestation", () => {
    const fixture = buildPrAuthorityRun();

    const result = validateRunDir(fixture.runDir);

    assert.equal(result.ok, true, joinCheckErrors(result));
    assert.equal(result.checks.some((check) => check.name === "run.provenance.pr-created" && check.ok), true);
    cleanupRepo(fixture.repoRoot);
  });

  it("rejects terminal_result PR URLs that mismatch the accepted pr-created attestation", () => {
    const fixture = buildPrAuthorityRun({ terminalPrUrl: "https://github.com/example/repo/pull/999" });

    const result = validateRunDir(fixture.runDir);
    const errors = joinCheckErrors(result);

    assert.equal(result.ok, false);
    assert.match(errors, /run\.terminal_result\.pr_url/u);
    assert.match(errors, /accepted PR URL/u);
    cleanupRepo(fixture.repoRoot);
  });

  it("fails run-base-only branch/worktree/base claims without an accepted run-base attestation", () => {
    const runDir = tempRunDir("run-base-only-claims");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    mkdirSync(join(runDir, "reviews"), { recursive: true });
    mkdirSync(join(runDir, "attestations"), { recursive: true });
    mkdirSync(join(runDir, "gates"), { recursive: true });
    writeJson(
      join(runDir, "run.json"),
      runningRun({
        branch: "feature-branch",
        worktree: ".opencode/worktrees/feature-branch",
        base_ref: "refs/heads/main",
        base_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        gates: { story: { status: "pending" } },
        slices: [],
      }),
    );

    const result = validateRunDir(runDir);
    const errors = result.checks.flatMap((check) => check.errors || []).map((error) => `${error.path}: ${error.message}`).join("\n");

    assert.equal(result.ok, false);
    assert.match(errors, /accepted run-base attestation|attestations\/index\.json/u);
    cleanupTemp(runDir);
  });

  it("fails approved gates that lack accepted provenance attestations", () => {
    const runDir = tempRunDir("approved-gate-without-attestation");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "run.json"),
      runningRun({
        gates: {
          story: {
            status: "approved",
            artifact: "artifacts/story.md",
            question_ref: "artifacts/story-question.md",
            approval_source: "autonomous",
          },
        },
        slices: [],
      }),
    );

    const result = validateRunDir(runDir);
    const errors = result.checks.flatMap((check) => check.errors || []).map((error) => `${error.path}: ${error.message}`).join("\n");

    assert.equal(result.ok, false);
    assert.match(errors, /run\.gates\.story\.status/u);
    assert.match(errors, /accepted gate-decision attestation|root is missing/u);
    cleanupTemp(runDir);
  });

  it("does not treat forged factory.lock as provenance proof for approved gates", () => {
    const runDir = tempRunDir("approved-gate-forged-factory-lock");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "run.json"),
      runningRun({
        run_id: "approved-gate-forged-factory-lock",
        gates: {
          story: {
            status: "approved",
            artifact: "artifacts/story.md",
            question_ref: "gates/story.question.md",
            approval_source: "autonomous",
          },
        },
        slices: [],
      }),
    );
    writeJson(
      join(runDir, "factory.lock"),
      factoryLock({
        run_id: "approved-gate-forged-factory-lock",
        heartbeat_owner: "forged-owner-capability",
        session_owner: "forged-session",
      }),
    );

    const result = validateRunDir(runDir);
    const errors = result.checks.flatMap((check) => check.errors || []).map((error) => `${error.path}: ${error.message}`).join("\n");

    assert.equal(result.ok, false);
    assert.match(errors, /run\.gates\.story\.status/u);
    assert.match(errors, /accepted gate-decision attestation|root is missing/u);
    cleanupTemp(runDir);
  });
});

describe("validateSlicesPlan", () => {
  it("accepts an acyclic slice plan", () => {
    assert.equal(validateSlicesPlan(slicePlan()).slices.length, 2);
  });

  it("rejects unknown dependencies", () => {
    assert.throws(
      () => validateSlicesPlan({ slices: [{ ...slicePlan().slices[0], depends_on: ["missing"] }] }),
      (error) => error instanceof ValidationError && error.message.includes("unknown dependency 'missing'"),
    );
  });

  it("rejects dependency cycles", () => {
    assert.throws(
      () =>
        validateSlicesPlan({
          slices: [
            { ...slicePlan().slices[0], depends_on: ["fe-screen"] },
            { ...slicePlan().slices[1], depends_on: ["be-api"] },
          ],
        }),
      (error) => error instanceof ValidationError && error.message.includes("dependency cycle"),
    );
  });
});

function runningRun(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "app-123",
    mode: "headless",
    status: "running",
    updated_at: "2026-07-05T00:00:00.000Z",
    gates: {
      story: {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      },
    },
    slices: [
      {
        id: "be-api",
        stack: "backend",
        depends_on: [],
        status: "running",
      },
    ],
    ...overrides,
  };
}

function heartbeatState(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "heartbeat-liveness",
    token: "hb-token-1",
    phase: "builder-wave",
    status: "active",
    pid: 4242,
    started_at: "2026-07-06T00:00:00.000Z",
    last_tick_at: "2026-07-06T00:00:05.000Z",
    interval_ms: 5000,
    deadline_at: "2026-07-06T00:00:10.000Z",
    ...overrides,
  };
}

function factoryLock(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "heartbeat-liveness",
    heartbeat_owner: "heartbeat-owner-capability",
    session_owner: "session-1",
    updated_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

function reviewTier(overrides = {}) {
  return {
    selected: "standard",
    source: "default",
    risk_reasons: ["workflow_or_release"],
    rationale: "Workflow changes default to the standard tier unless riskier signals are present.",
    ...overrides,
  };
}

const SAMPLE_HASH_A = `sha256:${"a".repeat(64)}`;
const SAMPLE_HASH_B = `sha256:${"b".repeat(64)}`;

function pendingSnapshot(overrides = {}) {
  return {
    question_ref: "gates/story.question.md",
    question_hash: SAMPLE_HASH_A,
    artifact_ref: "artifacts/story.md",
    artifact_hash: SAMPLE_HASH_B,
    created_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function factoryProvenance({ event = "run-created", provenance = { tool: "opencode feature-factory", version: "test" } } = {}) {
  return {
    created_with: diagnosticProvenanceSnapshot({ event, provenance }),
    resume_count: 0,
  };
}

function diagnosticProvenanceSnapshot(overrides = {}) {
  return {
    collected_at: "2026-07-05T00:00:00.000Z",
    event: "run-created",
    diagnostic_only: true,
    provenance: {
      tool: "opencode feature-factory",
      version: "test",
    },
    ...overrides,
  };
}

function slicePlan() {
  return {
    slices: [
      {
        id: "be-api",
        stack: "backend",
        paths: ["src/server/api/"],
        depends_on: [],
        acceptance: ["AC1"],
        test_plan: ["npm test -- api.feature.test"],
      },
      {
        id: "fe-screen",
        stack: "frontend",
        paths: ["src/ui/feature/"],
        depends_on: ["be-api"],
        acceptance: ["AC2"],
        test_plan: ["npm test -- feature-screen.test"],
      },
    ],
  };
}

function tempRunDir(name) {
  return join(mkdtempSync(join(tmpdir(), `${name}-`)), name);
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFixture(root, relativePath, content) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function cleanupTemp(runDir) {
  rmSync(join(runDir, ".."), { recursive: true, force: true });
}

function cleanupRepo(repoRoot) {
  rmSync(repoRoot, { recursive: true, force: true });
}

function buildPrAuthorityRun(options = {}) {
  const runId = options.runId || "pr-authority";
  const prUrl = options.prUrl || "https://github.com/example/repo/pull/123";
  const terminalPrUrl = options.terminalPrUrl ?? prUrl;
  const repoRoot = mkdtempSync(join(tmpdir(), "validate-pr-authority-repo-"));
  mkdirSync(join(repoRoot, ".opencode", "worktrees"), { recursive: true });
  mkdirSync(join(repoRoot, ".opencode", "factory"), { recursive: true });

  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Feature Factory Validate Test"]);
  git(repoRoot, ["config", "user.email", "factory-validate@example.com"]);
  writeFixture(repoRoot, "base.txt", "base\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "base"]);

  const baseRef = "refs/heads/main";
  const baseCommit = head(repoRoot);
  const baseTree = tree(repoRoot, "HEAD");
  const featureBranch = "feature-branch";
  const featureWorktree = join(repoRoot, ".opencode", "worktrees", featureBranch);
  git(repoRoot, ["worktree", "add", "-b", featureBranch, featureWorktree, "HEAD"]);
  writeFixture(featureWorktree, "feature.txt", "feature\n");
  git(featureWorktree, ["add", "."]);
  git(featureWorktree, ["commit", "-m", "feature commit"]);

  const headCommit = head(featureWorktree);
  const headTree = tree(featureWorktree, "HEAD");
  const gitCommonDir = realpathSync.native(resolve(featureWorktree, gitStdout(featureWorktree, ["rev-parse", "--git-common-dir"]).trim()));
  const runDir = join(repoRoot, ".opencode", "factory", runId);
  for (const directory of ["evidence", "artifacts", "reviews", "attestations", "gates"]) {
    mkdirSync(join(runDir, directory), { recursive: true });
  }

  const runBase = createRunBaseAttestation({
    run_id: runId,
    sequence: 1,
    prev_hash: null,
    created_at: isoAt(1),
    bindings: {
      repo_root: repoRoot,
      run_dir: runDir,
      git_common_dir: gitCommonDir,
      feature_branch: featureBranch,
      feature_worktree: realpathSync.native(featureWorktree),
      base_ref: baseRef,
      base_commit: baseCommit,
      base_tree: baseTree,
    },
  });

  const directEvidenceRef = "evidence/direct-reviewed-commit.json";
  writeJson(join(runDir, directEvidenceRef), { commit: headCommit, base_commit: baseCommit });
  const reviewRef = "reviews/direct-reviewed-commit.json";
  writeJson(join(runDir, reviewRef), { subject: "feature-direct", reviewer: "work-reviewer", verdict: "APPROVE" });
  const guard = {
    status: "clean",
    safe_git_policy: SAFE_GIT_POLICY,
    worktree: realpathSync.native(featureWorktree),
    head_commit: headCommit,
    head_tree: headTree,
    dirty_paths: [],
    hidden_index_paths: [],
  };
  const reviewHash = hashFile(join(runDir, reviewRef));
  const guardHash = hashValue(guard);
  const directCommit = createDirectReviewedCommitAttestation({
    run_id: runId,
    sequence: 2,
    prev_hash: runBase.attestation_hash,
    created_at: isoAt(2),
    bindings: {
      entry_id: "feature-direct",
      purpose: "validation-fix",
      commit: headCommit,
      parent_commit: baseCommit,
      tree: headTree,
      diff_hash: gitDiffHash(featureWorktree, baseCommit, headCommit),
      evidence_ref: directEvidenceRef,
      evidence_hash: hashFile(join(runDir, directEvidenceRef)),
      producing_role: "backend-builder",
      review_hash: reviewHash,
      guard_result_hash: guardHash,
    },
  });
  const reviewApproval = createReviewApprovalAttestation({
    run_id: runId,
    sequence: 3,
    prev_hash: directCommit.attestation_hash,
    created_at: isoAt(3),
    bindings: {
      subject_type: "direct_commit",
      subject: "feature-direct",
      reviewer: "work-reviewer",
      verdict: "APPROVE",
      review_ref: reviewRef,
      review_hash: reviewHash,
      evidence_ref: directEvidenceRef,
      evidence_hash: hashFile(join(runDir, directEvidenceRef)),
      subject_commit: headCommit,
      subject_tree: headTree,
      guard_result_hash: guardHash,
      guard,
    },
  });
  const mergeChain = createMergeChainAttestation({
    run_id: runId,
    sequence: 4,
    prev_hash: reviewApproval.attestation_hash,
    created_at: isoAt(4),
    bindings: {
      feature_branch: featureBranch,
      base_attestation_ref: "attestations/run-base.json",
      base_attestation_hash: runBase.attestation_hash,
      base_commit: baseCommit,
      head_commit: headCommit,
      head_tree: headTree,
      entries: [
        {
          type: "direct_reviewed_commit",
          commit: headCommit,
          direct_commit_attestation_ref: "attestations/direct-commits/feature-direct.json",
          direct_commit_attestation_hash: directCommit.attestation_hash,
          review_attestation_ref: "attestations/reviews/direct-reviewed-commit.approval.json",
          review_attestation_hash: reviewApproval.attestation_hash,
        },
      ],
    },
  });

  const prePrArtifactRef = "artifacts/pre_pr.md";
  const prePrQuestionRef = "gates/pre_pr.question.md";
  const prePrAnswerRef = "gates/pre_pr.answer";
  writeFixture(runDir, prePrArtifactRef, "pre-pr artifact\n");
  writeFixture(runDir, prePrQuestionRef, "approve pre-pr?\n");
  writeFixture(runDir, prePrAnswerRef, "approve\n");
  const prePrGate = createGateDecisionAttestation({
    run_id: runId,
    sequence: 5,
    prev_hash: mergeChain.attestation_hash,
    created_at: isoAt(5),
    bindings: {
      gate: "pre_pr",
      decision: "approved",
      approval_source: "autonomous",
      question_ref: prePrQuestionRef,
      question_hash: hashFile(join(runDir, prePrQuestionRef)),
      artifact_ref: prePrArtifactRef,
      artifact_hash: hashFile(join(runDir, prePrArtifactRef)),
      answer_ref: prePrAnswerRef,
      answer_hash: hashFile(join(runDir, prePrAnswerRef)),
    },
  });

  const prBodyRef = "artifacts/pr-body.md";
  writeFixture(runDir, prBodyRef, "PR body\n");
  const remoteObservation = {
    pr_url: prUrl,
    pr_number: 123,
    provider: "github",
    repository: "example/repo",
    remote: "origin",
    github_account: "jasoncarreira",
    head_branch: featureBranch,
    head_commit: headCommit,
    head_tree: headTree,
    base_ref: baseRef,
    base_commit: baseCommit,
    base_tree: baseTree,
    draft: true,
  };
  const prCreated = createPrCreatedAttestation({
    run_id: runId,
    sequence: 6,
    prev_hash: prePrGate.attestation_hash,
    created_at: isoAt(6),
    bindings: {
      ...remoteObservation,
      pr_body_ref: prBodyRef,
      pr_body_hash: hashFile(join(runDir, prBodyRef)),
      run_base_attestation_ref: "attestations/run-base.json",
      run_base_attestation_hash: runBase.attestation_hash,
      merge_chain_attestation_ref: "attestations/merge-chain.json",
      merge_chain_attestation_hash: mergeChain.attestation_hash,
      pre_pr_gate_attestation_ref: "attestations/gates/pre_pr.json",
      pre_pr_gate_attestation_hash: prePrGate.attestation_hash,
      remote_observation: remoteObservation,
    },
  });

  const records = [
    { ref: "attestations/run-base.json", attestation: runBase },
    { ref: "attestations/direct-commits/feature-direct.json", attestation: directCommit },
    { ref: "attestations/reviews/direct-reviewed-commit.approval.json", attestation: reviewApproval },
    { ref: "attestations/merge-chain.json", attestation: mergeChain },
    { ref: "attestations/gates/pre_pr.json", attestation: prePrGate },
  ];
  if (options.includePrCreated !== false) records.push({ ref: "attestations/pr-created.json", attestation: prCreated });
  for (const record of records) writeJson(join(runDir, record.ref), record.attestation);
  writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex(records));
  writeJson(join(runDir, "run.json"), {
    ...runningRun({
      run_id: runId,
      status: "completed",
      github_account: "jasoncarreira",
      base_ref: baseRef,
      base_commit: baseCommit,
      branch: featureBranch,
      worktree: relative(repoRoot, featureWorktree).split("\\").join("/"),
      gates: { story: { status: "pending" } },
      slices: [],
    }),
    pr_url: prUrl,
    terminal_result: {
      status: "completed",
      run_id: runId,
      pr_url: terminalPrUrl,
      reason: null,
      summary: "Draft PR created.",
      artifacts: {},
    },
  });

  return { repoRoot, runDir };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitStdout(cwd, args) {
  return git(cwd, args);
}

function head(cwd) {
  return gitStdout(cwd, ["rev-parse", "HEAD"]).trim();
}

function tree(cwd, rev) {
  return gitStdout(cwd, ["rev-parse", `${rev}^{tree}`]).trim();
}

function joinCheckErrors(result) {
  return result.checks
    .flatMap((check) => check.errors || [])
    .map((error) => `${error.path}: ${error.message}`)
    .join("\n");
}

function isoAt(second) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}
