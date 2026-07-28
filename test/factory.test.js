import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CleanupRunChangedError,
  CleanupRunUnexpectedError,
  cleanupRunLocked,
  cleanupRun,
  collectCleanupTargets,
  latestRunId,
  listRuns,
  openSteeringBoundary,
  persistFactoryRunCreatedEnv,
  persistFactoryRunResumeEnv,
  recordCostUsage,
  seedFactorySlices,
  seedRepoSkill,
  status,
  validateState,
  watchRun,
  writeGateAnswer,
  writeSteering,
} from "../src/factory.js";
import { acquireLaunchFence, releaseLaunchFence } from "../src/process-evidence.js";
import { hashValue } from "../src/refs.js";
import { checkWorktreeIdentity } from "../src/worktrees.js";
import { completeSliceBuilderTaskDispatch, prepareSliceBuilderTaskDispatch, transitionRunSlice, transitionSliceMerged } from "../src/run-state.js";
import { createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("factory public state operations", { concurrency: false }, () => {
  it("lists and reads runs without authority proofs", () => {
    const fixture = createFixture("public-run");
    try {
      const listed = listRuns({ cwd: fixture.repo });
      const current = status(fixture.runId, { cwd: fixture.repo });
      assert.equal(listed[0].run_id, fixture.runId);
      assert.equal(listed[0].cost_summary, null);
      assert.equal(current.run_id, fixture.runId);
      assert.equal(current.status, "running");
      assert.equal(current.cost_summary, null);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("routes oversized slices-seed through the public factory orchestration path", async () => {
    const fixture = createFixture("public-checkpoint-route");
    try {
      mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
      const plan = oversizedFactoryPlan();
      writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(
        join(fixture.runDir, "reviews", "work-decomposer.json"),
        oversizedFactoryReview(plan, hashFile(join(fixture.runDir, "plan", "slices.json"))),
      );
      const runFile = join(fixture.runDir, "run.json");
      const run = readJson(runFile);
      run.slices = [];
      run.steps = [{
        agent: "work-decomposer", status: "accepted", attempts: 1,
        artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
          review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
        },
      }];
      run.terminal_result = null;
      writeJson(runFile, run);
      const opened = await openSteeringBoundary(fixture.runId, "terminal", {
        cwd: fixture.repo,
        now: "2026-07-19T12:59:00.000Z",
        token: "checkpoint-terminal",
      });

      const result = await seedFactorySlices(fixture.runId, {
        cwd: fixture.repo,
        from: "plan/slices.json",
        boundaryToken: opened.boundary.token,
        now: "2026-07-19T13:00:00.000Z",
      });

      assert.equal(result.route, "checkpoint");
      assert.equal(result.checkpoint_routing.checkpoint_count, 2);
      assert.equal(result.run.status, "blocked");
      assert.deepEqual(result.run.slices, []);
      assert.equal(result.run.steps[0].status, "accepted");
      assert.equal(result.run.terminal_result.reason, "oversized-plan-checkpoint-routing-required");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("completes the parked issue-103-reseed shared-test lifecycle without a plan amendment", async () => {
    const fixture = createIssue103ReseedFixture();
    try {
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const acceptedPlanBytes = readFileSync(planPath);
      const acceptedPlanHash = hashFile(planPath);
      const declaredPaths = ["src/**"];

      await transitionRunSlice(fixture.runDir, "reseed", {
        status: "running",
        attempts: 1,
        branch: fixture.sliceBranch,
        worktree: fixture.sliceWorktree,
      });
      const completionToken = "issue-103-reseed-completion";
      const dispatch = await prepareSliceBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId,
        slice_id: "reseed",
        attempt: 1,
        agent: "backend-builder",
      }, { claimDispatch: true, completionToken });

      for (const path of fixture.sharedPaths) {
        writeFileSync(join(fixture.sliceWorktree, path), `reviewed ${path}\n`);
      }
      runGit(fixture.sliceWorktree, ["add", "--", ...fixture.sharedPaths]);
      runGit(fixture.sliceWorktree, ["commit", "-m", "finish parked issue-103 reseed"]);
      const reviewedCommit = branchHead(fixture.repo, fixture.sliceBranch);
      await completeSliceBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId,
        slice_id: "reseed",
        attempt: 1,
        agent: "backend-builder",
        claim_ref: dispatch.dispatch_claim.ref,
        claim_hash: dispatch.dispatch_claim.hash,
        completion_token: completionToken,
      });

      const rationales = new Map(fixture.sharedPaths.map((path) => [path, `The parked issue-103 reseed requires updating ${path}.`]));
      writeJson(join(fixture.runDir, "evidence", "reseed.json"), {
        subject: "reseed",
        attempt: 1,
        status: "pass",
        review_ready: true,
        head_sha: reviewedCommit,
        ownership_disclosure: fixture.sharedPaths.map((path) => ({ path, rationale: rationales.get(path) })),
      });
      const familyEvidence = writeVerificationArtifactReceipt({
        runDir: fixture.runDir,
        runId: fixture.runId,
        plan: fixture.plan,
        sliceId: "reseed",
        attempt: 1,
        reviewedCommit,
        artifactId: "fixture-artifact-1",
        evidenceRef: "evidence/reseed-family.json",
        result: { type: "verification-result", outcome: "pass", summary: "Verify reseed behavior passed" },
      });
      const review = createSliceReviewRecord({ subject: "reseed", attempt: 1, reviewedCommit });
      review.ownership_ratification = { schema_version: 2, kind: "factory-derived-modified-extension" };
      review.invariant_family_ledger = passingInvariantFamilyLedger({
        plan: fixture.plan,
        sliceId: "reseed",
        reviewedCommit,
        evidenceRef: familyEvidence.ref,
        evidenceHash: familyEvidence.hash,
      });
      writeJson(join(fixture.runDir, "reviews", "reseed.json"), review);

      const published = await transitionRunSlice(fixture.runDir, "reseed", {
        status: "review",
        attempts: 1,
        evidence_ref: "evidence/reseed.json",
        review_ref: "reviews/reseed.json",
      });
      assert.deepEqual(published.slice.attempt_reviews[0].modified_extensions, fixture.sharedPaths.map((path) => ({
        kind: "modified-extension",
        path,
        rationale: rationales.get(path),
        authority: "unowned",
      })));
      assert.deepEqual(published.slice.effective_paths, [...declaredPaths, ...fixture.sharedPaths]);

      runGit(fixture.repo, ["merge", "--no-ff", fixture.sliceBranch, "-m", "merge parked issue-103 reseed"]);
      const mergeCommit = branchHead(fixture.repo, "main");
      const merged = await transitionSliceMerged(fixture.runDir, "reseed", { merge_commit: mergeCommit });
      assert.equal(merged.slice.status, "merged");
      assert.deepEqual(merged.slice.effective_paths, [...declaredPaths, ...fixture.sharedPaths]);
      assert.deepEqual(merged.slice.declared_paths, declaredPaths);

      const finalRun = readJson(join(fixture.runDir, "run.json"));
      assert.deepEqual(readFileSync(planPath), acceptedPlanBytes);
      assert.equal(hashFile(planPath), acceptedPlanHash);
      assert.deepEqual(finalRun.slices[0].declared_paths, declaredPaths);
      for (const key of ["integration_amendment", "merged_slice_repair", "special_builder_dispatch"]) {
        assert.equal(Object.hasOwn(finalRun, key), false, key);
      }
      assert.equal(finalRun.steps.some(({ agent }) => /amendment/u.test(agent)), false, "no amendment writer step was invoked");
      assert.equal(readdirSync(fixture.runDir, { recursive: true }).some((path) => /amendment/u.test(path)), false, "no amendment sidecar was written");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps pending steering read-only and redacted across public projections", async () => {
    const fixture = createFixture("public-steering");
    const rawSteering = "raw operator steering must remain in its pending file";
    const logs = [];
    const originalLog = console.log;
    let timer = null;
    try {
      const queued = await writeSteering(fixture.runId, rawSteering, {
        cwd: fixture.repo,
        now: "2026-07-08T12:00:00.000Z",
        id: "public-read-only",
      });
      const before = snapshotPendingSteering(fixture);
      const current = status(fixture.runId, { cwd: fixture.repo });
      const listed = listRuns({ cwd: fixture.repo })[0];
      const validation = validateState(fixture.runId, { cwd: fixture.repo });

      console.log = (value) => logs.push(String(value));
      timer = watchRun(fixture.runId, { cwd: fixture.repo, intervalMs: 60000 });
      assert.equal(logs.length, 1, "watch must emit its first projection synchronously");
      const watched = JSON.parse(logs[0]);
      clearInterval(timer);
      timer = null;
      await new Promise((resolve) => setTimeout(resolve, 10));

      for (const projection of [current, listed, watched]) {
        assert.deepEqual(projection.steering.pending, queued.steering);
        assert.deepEqual(Object.keys(projection.steering.pending).sort(), ["created_at", "hash", "id", "message_chars", "ref"]);
        assert.equal(projection.steering.consumed_count, 0);
        assert.equal(projection.steering.latest_consumed, null);
      }
      const pendingCheck = validation.runs[0].checks.find((check) => check.name === "run.steering.pending.ref");
      assert.equal(validation.ok, true);
      assert.equal(pendingCheck?.ok, true);
      assert.equal(pendingCheck?.details.ref, queued.steering.ref);

      for (const output of [current, listed, validation, watched, logs]) {
        assert.equal(JSON.stringify(output).includes(rawSteering), false);
      }
      assertPendingSteeringUnchanged(fixture, before);
    } finally {
      if (timer) clearInterval(timer);
      console.log = originalLog;
      cleanup(fixture.repo);
    }
  });

  it("records cost usage and exposes public summaries in status and list", async () => {
    const fixture = createFixture("cost-run");
    try {
      const recorded = await recordCostUsage(fixture.runId, {
        agent: "backend-builder",
        step: "build",
        provider: "opencode",
        model: "gpt-5.5",
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cost_total: 0.02,
        cost_currency: "USD",
      }, { cwd: fixture.repo, now: "2026-07-08T12:30:00.000Z", entryId: "cost-1" });

      const run = readJson(join(fixture.runDir, "run.json"));
      const current = status(fixture.runId, { cwd: fixture.repo });
      const listed = listRuns({ cwd: fixture.repo })[0];

      assert.equal(recorded.entry.id, "cost-1");
      assert.equal(recorded.entry.run_id, fixture.runId);
      assert.equal(run.cost_attribution.entries.length, 1);
      assert.equal(current.cost_summary.status, "available");
      assert.equal(current.cost_summary.entry_count, 1);
      assert.equal(current.cost_summary.total_tokens, 15);
      assert.equal(listed.cost_summary.cost_total, 0.02);
      assert.equal(listed.cost_summary.cost_currency, "USD");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not coerce missing cost metadata to zero", async () => {
    const fixture = createFixture("cost-partial");
    try {
      const recorded = await recordCostUsage(fixture.runId, {
        agent: "backend-builder",
        input_tokens: 7,
      }, { cwd: fixture.repo, now: "2026-07-08T12:30:00.000Z", entryId: "cost-partial-1" });

      const current = status(fixture.runId, { cwd: fixture.repo });

      assert.equal(recorded.entry.status, "partial");
      assert.equal(Object.hasOwn(recorded.entry, "cost_total"), false);
      assert.equal(Object.hasOwn(recorded.entry, "output_tokens"), false);
      assert.equal(Object.hasOwn(current.cost_summary, "cost_total"), false);
      assert.deepEqual(recorded.entry.missing, ["cost_currency", "cost_total", "model", "provider"]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("breaks latest-run timestamp ties by run id", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-latest-run-"));
    try {
      createFixture("alpha", { repo, updatedAt: "2026-07-08T12:00:00.000Z" });
      createFixture("zulu", { repo, updatedAt: "2026-07-08T12:00:00.000Z" });

      assert.equal(latestRunId({ cwd: repo }), "zulu");
      assert.deepEqual(listRuns({ cwd: repo }).map((run) => run.run_id), ["zulu", "alpha"]);
    } finally {
      cleanup(repo);
    }
  });

  it("writes gate answers after pending snapshot freshness checks", () => {
    const fixture = createFixture("gate-answer", { gate: true });
    try {
      const result = writeGateAnswer(fixture.runId, "story", "approve", { cwd: fixture.repo });
      assert.equal(result.answer, "approve");
      assert.equal(readFileSync(join(fixture.runDir, "gates", "story.answer"), "utf8"), "approve\n");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects malformed gate answers before writing anything", () => {
    const fixture = createFixture("gate-answer-invalid", { gate: true });
    try {
      for (const [label, answer] of [["empty changes body", "changes:   "], ["bare changes", "changes:"], ["unknown verb", "maybe"], ["empty", "   "]]) {
        assert.throws(
          () => writeGateAnswer(fixture.runId, "story", answer, { cwd: fixture.repo }),
          /answer must be exactly approve, stop, or start with changes:/u,
          label,
        );
      }
      assert.equal(existsSync(join(fixture.runDir, "gates", "story.answer")), false, "rejected answers must not write an answer file");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("validates schema and advisory consistency", () => {
    const fixture = createFixture("validate-run", { gate: true });
    try {
      const result = validateState(fixture.runId, { cwd: fixture.repo });
      assert.equal(result.ok, true);
      assert.equal(result.runs[0].checks.some((check) => check.name === "run.schema"), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records the exact observed CLI identity at creation and resume without adding authority", async () => {
    const fixture = createFixture("env-run");
    const creationIdentity = {
      source: "/opt/feature-factory/bin/feature-factory-created",
      version: "7.8.9-created",
      hash: `sha256:${"a".repeat(64)}`,
    };
    const resumeIdentity = {
      source: "/opt/feature-factory/bin/feature-factory-resumed",
      version: "8.9.10-resumed",
      hash: `sha256:${"b".repeat(64)}`,
    };
    try {
      const initialKeys = Object.keys(readJson(join(fixture.runDir, "run.json")));
      const created = await persistFactoryRunCreatedEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z", runtimeIdentity: { cli: creationIdentity } });
      const resumed = await persistFactoryRunResumeEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T13:00:00.000Z", runtimeIdentity: { cli: resumeIdentity } });
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(created.resume_count, 0);
      assert.equal(resumed.resume_count, 1);
      assert.equal(run.debug_snapshot.last_resumed_with.event, "run-resumed");
      assert.deepEqual(created.created_with.env.cli_identity, creationIdentity);
      assert.deepEqual(resumed.created_with.env.cli_identity, creationIdentity);
      assert.deepEqual(resumed.last_resumed_with.env.cli_identity, resumeIdentity);
      assert.deepEqual(run.debug_snapshot.created_with.env.cli_identity, creationIdentity);
      assert.deepEqual(run.debug_snapshot.last_resumed_with.env.cli_identity, resumeIdentity);
      assert.deepEqual(Object.keys(creationIdentity), ["source", "version", "hash"]);
      assert.deepEqual(Object.keys(resumeIdentity), ["source", "version", "hash"]);
      assert.deepEqual(Object.keys(run).filter((key) => !initialKeys.includes(key)).sort(), ["debug_snapshot", "provenance"]);
      assert.equal(Object.hasOwn(run, "cli_identity"), false);
      const topLevelAuthority = JSON.stringify(Object.fromEntries(Object.entries(run).filter(([key]) => key !== "debug_snapshot")));
      const provenanceAuthority = JSON.stringify(run.provenance);
      for (const value of Object.values(resumeIdentity)) {
        assert.equal(topLevelAuthority.includes(value), false, `top-level authority contains resume identity value ${value}`);
        assert.equal(provenanceAuthority.includes(value), false, `provenance authority contains resume identity value ${value}`);
      }
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps composite opaque CLI identity bytes out of persisted run snapshots", async () => {
    const fixture = createFixture("env-redaction-run");
    const sourceSecret = "Q7M4Z9N2C8V5B1X6L3K0P7R2T9Y4U8I5";
    const versionSecret = "N8R2K7M4Q9V5X1C6L3P0T8Y2U7I4O9A5";
    const hash = `sha256:${"c".repeat(64)}`;
    try {
      await persistFactoryRunCreatedEnv(fixture.runId, {
        cwd: fixture.repo,
        runtimeIdentity: {
          cli: {
            source: `/tmp/home ${sourceSecret}/feature-factory`,
            version: `feature-factory 1.2.3 ${versionSecret}`,
            hash,
          },
        },
      });
      const run = readJson(join(fixture.runDir, "run.json"));
      const serialized = JSON.stringify(run);

      assert.deepEqual(run.debug_snapshot.created_with.env.cli_identity, {
        source: "[redacted]",
        version: "[redacted]",
        hash,
      });
      assert.doesNotMatch(serialized, new RegExp(`${sourceSecret}|${versionSecret}`, "u"));
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("resolves bare run ids under the factory root before same-name repo paths", () => {
    const fixture = createFixture("shadow-run");
    try {
      const shadow = join(fixture.repo, fixture.runId);
      mkdirSync(shadow, { recursive: true });
      writeJson(join(shadow, "run.json"), { schema_version: 1, run_id: "shadow-outside", status: "blocked", terminal_result: { status: "blocked", run_id: "shadow-outside", reason: "outside" } });

      assert.equal(status(fixture.runId, { cwd: fixture.repo }).run_id, fixture.runId);
      assert.throws(
        () => status(shadow, { cwd: fixture.repo }),
        /inside \.opencode\/factory/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("emits a removed event when a watched run disappears", async () => {
    const fixture = createFixture("watch-removed");
    const logs = [];
    const originalLog = console.log;
    console.log = (value) => logs.push(value);
    try {
      const timer = watchRun(fixture.runId, { cwd: fixture.repo, intervalMs: 10 });
      rmSync(fixture.runDir, { recursive: true, force: true });
      await waitFor(() => logs.some((line) => JSON.parse(line).status === "removed"), { timeoutMs: 10000 });
      if (timer) clearInterval(timer);
    } finally {
      console.log = originalLog;
      cleanup(fixture.repo);
    }
  });

  it("does not clobber locally edited seeded feature skills", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      writeFileSync(skill, "local edit\n", "utf8");

      seedRepoSkill(repo);

      assert.equal(readFileSync(skill, "utf8"), "local edit\n");
    } finally {
      cleanup(repo);
    }
  });

  it("repairs recognized stale seeded feature skills when seed metadata is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-stale-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSkill = "older packaged skill\n";
      const staleSchema = "older packaged schema\n";
      writeFileSync(skill, staleSkill, "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      rmSync(seedHash, { force: true });

      const warnings = captureWarnings(() => seedRepoSkill(repo, {
        knownSeedHashes: {
          "SKILL.md": new Set([sha256(staleSkill)]),
          "SCHEMA.md": new Set([sha256(staleSchema)]),
        },
      }));

      assert.equal(readFileSync(skill, "utf8"), currentSkill);
      assert.equal(readFileSync(schema, "utf8"), currentSchema);
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
      assert.match(warnings.join("\n"), /refreshed stale repo-seeded feature skill file\(s\): SKILL\.md, SCHEMA\.md/u);
    } finally {
      cleanup(repo);
    }
  });

  it("repairs recognized stale seeded feature skills when seed metadata is empty", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-empty-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSkill = "older packaged skill from empty metadata\n";
      const staleSchema = "older packaged schema from empty metadata\n";
      writeFileSync(skill, staleSkill, "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      writeFileSync(seedHash, "", "utf8");

      seedRepoSkill(repo, {
        knownSeedHashes: {
          "SKILL.md": new Set([sha256(staleSkill)]),
          "SCHEMA.md": new Set([sha256(staleSchema)]),
        },
      });

      assert.equal(readFileSync(skill, "utf8"), currentSkill);
      assert.equal(readFileSync(schema, "utf8"), currentSchema);
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
    } finally {
      cleanup(repo);
    }
  });

  it("repairs recognized stale seeded feature skills when seed metadata is invalid", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-invalid-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSkill = "older packaged skill from invalid metadata\n";
      const staleSchema = "older packaged schema from invalid metadata\n";
      writeFileSync(skill, staleSkill, "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      writeFileSync(seedHash, "{\n", "utf8");

      seedRepoSkill(repo, {
        knownSeedHashes: {
          "SKILL.md": new Set([sha256(staleSkill)]),
          "SCHEMA.md": new Set([sha256(staleSchema)]),
        },
      });

      assert.equal(readFileSync(skill, "utf8"), currentSkill);
      assert.equal(readFileSync(schema, "utf8"), currentSchema);
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
    } finally {
      cleanup(repo);
    }
  });

  it("preserves unrecognized local seeded feature edits with empty metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-local-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSchema = "older packaged schema alongside local edit\n";
      writeFileSync(skill, "local edit\n", "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      writeFileSync(seedHash, "{}\n", "utf8");

      const warnings = captureWarnings(() => seedRepoSkill(repo, {
        knownSeedHashes: {
          "SCHEMA.md": new Set([sha256(staleSchema)]),
        },
      }));

      assert.equal(readFileSync(skill, "utf8"), "local edit\n");
      assert.equal(readFileSync(schema, "utf8"), currentSchema);
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
      assert.match(warnings.join("\n"), /preserved locally edited seeded skill file\(s\): SKILL\.md/u);

      seedRepoSkill(repo);

      assert.equal(readFileSync(skill, "utf8"), "local edit\n");
    } finally {
      cleanup(repo);
    }
  });

  it("leaves unrelated feature skill files unchanged and absent from seed metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-unrelated-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const notes = join(dest, "NOTES.md");
      writeFileSync(notes, "operator notes\n", "utf8");
      writeJson(seedHash, {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
        "NOTES.md": sha256("old notes\n"),
      });

      seedRepoSkill(repo);

      assert.equal(readFileSync(notes, "utf8"), "operator notes\n");
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
    } finally {
      cleanup(repo);
    }
  });

  it("rejects symlinked repo-seeded feature skill parent and skill directories", () => {
    for (const attack of ["opencode", "parent", "skill"])
      assertRejectsSeedSymlinkAttack(attack, ({ repo, outside }) => {
        if (attack === "opencode") {
          symlinkSync(outside, join(repo, ".opencode"));
        } else if (attack === "parent") {
          mkdirSync(join(repo, ".opencode"), { recursive: true });
          symlinkSync(outside, join(repo, ".opencode", "skills"));
        } else {
          mkdirSync(join(repo, ".opencode", "skills"), { recursive: true });
          symlinkSync(outside, join(repo, ".opencode", "skills", "feature"));
        }
      }, ({ outside }) => {
        assert.equal(existsSync(join(outside, "SKILL.md")), false);
        assert.equal(existsSync(join(outside, "SCHEMA.md")), false);
      });
  });

  it("rejects symlinked repo-seeded feature skill target files", () => {
    for (const file of ["SKILL.md", "SCHEMA.md"])
      assertRejectsSeedSymlinkAttack(file, ({ repo, outside }) => {
        const dest = seedRepoSkill(repo);
        const outsideFile = join(outside, file);
        writeFileSync(outsideFile, "outside original\n", "utf8");
        rmSync(join(dest, file), { force: true });
        symlinkSync(outsideFile, join(dest, file));
      }, ({ outside }) => {
        assert.equal(readFileSync(join(outside, file), "utf8"), "outside original\n");
      });
  });

  it("rejects symlinked repo-seeded feature skill seed metadata", () => {
    assertRejectsSeedSymlinkAttack("seed-hash", ({ repo, outside }) => {
      const dest = seedRepoSkill(repo);
      const outsideFile = join(outside, ".seed-hash");
      writeFileSync(outsideFile, "outside metadata\n", "utf8");
      rmSync(join(dest, ".seed-hash"), { force: true });
      symlinkSync(outsideFile, join(dest, ".seed-hash"));
    }, ({ outside }) => {
      assert.equal(readFileSync(join(outside, ".seed-hash"), "utf8"), "outside metadata\n");
    });
  });

  it("cleans terminal run state, branches, and registered worktrees", async () => {
    const fixture = createFixture("cleanup-run", { terminal: true, git: true });
    try {
      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });
      assert.equal(result.removed_run_dir, true);
      assert.equal(result.deleted_branches.includes("cleanup-run"), true);
      assert.equal(result.removed_worktrees.length, 1);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("skips unmerged branch deletion by default for completed runs", async () => {
    const fixture = createFixture("cleanup-unmerged", { terminal: true, git: true });
    try {
      commitInWorktree(join(fixture.repo, ".opencode", "worktrees", fixture.runId), "feature.txt", "feature\n");
      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo });
      assert.equal(branchExists(fixture.repo, fixture.runId), true);
      assert.equal(result.deleted_branches.includes(fixture.runId), false);
      assert.equal(result.skipped_branches.some((item) => item.branch === fixture.runId && /not fully merged|not merged/u.test(item.reason)), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("force deletes unmerged branches when requested", async () => {
    const fixture = createFixture("cleanup-force-unmerged", { terminal: true, git: true });
    try {
      commitInWorktree(join(fixture.repo, ".opencode", "worktrees", fixture.runId), "feature.txt", "feature\n");
      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });
      assert.equal(branchExists(fixture.repo, fixture.runId), false);
      assert.equal(result.deleted_branches.includes(fixture.runId), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("skips cleanup worktrees that do not match the recorded branch", async () => {
    const fixture = createFixture("cleanup-branch-mismatch", { terminal: true, git: true });
    try {
      const runFile = join(fixture.runDir, "run.json");
      writeJson(runFile, { ...readJson(runFile), branch: "different-branch" });

      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });

      assert.equal(result.removed_worktrees.length, 0);
      assert.equal(result.skipped_worktrees.some((item) => /branch-mismatch/u.test(item.reason)), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses cleanup while heartbeat liveness is fresh without force", async () => {
    const fixture = createFixture("cleanup-fresh-heartbeat", { terminal: true });
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), {
        schema_version: 1,
        run_id: fixture.runId,
        phase: "cleanup",
        pid: process.pid,
        interval_ms: 30000,
        last_tick_at: new Date().toISOString(),
      });

      await assert.rejects(
        cleanupRun(fixture.runId, { cwd: fixture.repo }),
        /fresh heartbeat/u,
      );
      assert.equal(existsSync(join(fixture.runDir, "run.json")), true);

      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });
      assert.equal(result.removed_run_dir, true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses direct cleanup while launch coordination holds the external fence", async () => {
    const fixture = createFixture("cleanup-launch-fence", { terminal: true });
    const aliasRepo = `${fixture.repo}-alias`;
    symlinkSync(fixture.repo, aliasRepo, "dir");
    const aliasRunDir = join(aliasRepo, ".opencode", "factory", fixture.runId);
    const fence = acquireLaunchFence(aliasRunDir, "launch");
    try {
      assert.equal(fence.acquired, true);
      await assert.rejects(
        cleanupRun(fixture.runId, { cwd: fixture.repo, force: true }),
        /active launch coordination/u,
      );
      assert.equal(existsSync(join(fixture.runDir, "run.json")), true);
    } finally {
      assert.equal(releaseLaunchFence(fence), true);
      rmSync(aliasRepo, { recursive: true, force: true });
      cleanup(fixture.repo);
    }
  });

  it("refuses forced public and locked cleanup before touching active or unknown checked execution claims", async () => {
    for (const state of ["active", "unknown"]) {
      for (const entry of ["cleanupRun", "cleanupRunLocked", "cli"]) {
        const fixture = createFixture(`cleanup-checked-${state}-${entry.toLowerCase()}`, { git: true });
        try {
          const snapshot = installCheckedExecutionClaim(fixture, state);
          let error;
          let launchFenceCalls = 0;
          if (entry === "cleanupRun") {
            error = await captureRejected(() => cleanupRun(fixture.runId, {
              cwd: fixture.repo,
              force: true,
              acquireLaunchFence() {
                launchFenceCalls += 1;
                return { acquired: false };
              },
            }));
          } else if (entry === "cleanupRunLocked") {
            error = captureThrown(() => cleanupRunLocked(fixture.runDir, readJson(snapshot.runFile), {
              mode: "single-run",
              repo: fixture.repo,
              force: true,
            }));
          } else {
            const proc = spawnSync(process.execPath, [CLI_PATH, "factory", "cleanup", fixture.runId, "--force", "--json"], {
              cwd: fixture.repo,
              encoding: "utf8",
            });
            assert.notEqual(proc.status, 0, `${state} CLI cleanup must fail closed`);
            error = new Error(`${proc.stderr}\n${proc.stdout}`);
          }

          assert.equal(error?.code === "TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED"
            || /trusted out-of-band operator\/process reconciliation is required/u.test(error?.message || ""), true, `${state} ${entry}`);
          assert.equal(launchFenceCalls, 0, `${state} cleanup must reject before launch-fence acquisition`);
          assert.deepEqual(readFileSync(snapshot.runFile), snapshot.runBytes, `${state} ${entry} run.json`);
          assert.deepEqual(readFileSync(snapshot.receiptFile), snapshot.receiptBytes, `${state} ${entry} receipt`);
          assert.deepEqual(readFileSync(snapshot.heartbeatFile), snapshot.heartbeatBytes, `${state} ${entry} heartbeat`);
          assert.equal(existsSync(snapshot.worktree), true, `${state} ${entry} worktree`);
          assert.equal(branchHead(fixture.repo, fixture.runId), snapshot.branchHead, `${state} ${entry} branch`);
          assert.deepEqual(readdirSync(fixture.runDir).sort(), snapshot.runEntries, `${state} ${entry} run directory`);
          assert.deepEqual(readdirSync(join(fixture.repo, ".opencode", "worktrees")).sort(), snapshot.worktreeEntries, `${state} ${entry} cleanup staging`);
        } finally {
          cleanup(fixture.repo);
        }
      }
    }
  });

  it("retains normal cleanup for completed checked execution claims", async () => {
    const fixture = createFixture("cleanup-checked-completed", { git: true });
    try {
      installCheckedExecutionClaim(fixture, "completed");

      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });

      assert.equal(result.removed_run_dir, true);
      assert.deepEqual(result.deleted_branches, [fixture.runId]);
      assert.equal(result.removed_worktrees.length, 1);
      assert.equal(existsSync(fixture.runDir), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("validates direct locked cleanup input before inspecting checked execution claims", () => {
    const fixture = createFixture("cleanup-checked-malformed-direct", { git: true });
    try {
      const snapshot = installCheckedExecutionClaim(fixture, "active");
      const malformed = readJson(snapshot.runFile);
      malformed.steps.push(structuredClone(malformed.steps.find((step) => step.agent === "test-verifier")));

      assert.throws(() => cleanupRunLocked(fixture.runDir, malformed, {
        mode: "single-run",
        repo: fixture.repo,
        force: true,
      }), /active or unknown checked test execution/u);
      assert.deepEqual(readFileSync(snapshot.runFile), snapshot.runBytes);
      assert.deepEqual(readFileSync(snapshot.receiptFile), snapshot.receiptBytes);
      assert.deepEqual(readFileSync(snapshot.heartbeatFile), snapshot.heartbeatBytes);
      assert.equal(existsSync(snapshot.worktree), true);
      assert.equal(branchHead(fixture.repo, fixture.runId), snapshot.branchHead);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("collects the same deduplicated run and slice targets used by single-run cleanup", () => {
    const run = {
      branch: "run-branch",
      worktree: "/repo/.opencode/worktrees/run-branch",
      slices: [
        { id: "one", branch: "slice-branch", worktree: "/repo/.opencode/worktrees/slice-branch" },
        { id: "duplicate", branch: "run-branch", worktree: "/repo/.opencode/worktrees/run-branch" },
      ],
    };

    assert.deepEqual(collectCleanupTargets(run), {
      worktrees: [
        { branch: "run-branch", worktree: "/repo/.opencode/worktrees/run-branch" },
        { branch: "slice-branch", slice_id: "one", worktree: "/repo/.opencode/worktrees/slice-branch" },
      ],
      branches: ["run-branch", "slice-branch"],
    });
  });

  it("removes sweep targets in canonical order and deletes branches only by CAS", () => {
    const fixture = createFixture("cleanup-sweep-order", { terminal: true, git: true });
    try {
      runGit(fixture.repo, ["branch", "zeta"]);
      runGit(fixture.repo, ["branch", "alpha"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), slices: [{ branch: "zeta" }, { branch: "alpha" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const events = [];
      const commands = [];

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner(commands),
        phaseHook: (phase, detail) => events.push(`${phase}:${detail.branch || detail.physical_path || detail.path}`),
      });

      assert.deepEqual(cleanupResult.worktrees.map((item) => item.outcome), ["removed"]);
      assert.deepEqual(cleanupResult.branches.map((item) => item.name), ["alpha", fixture.runId, "zeta"]);
      assert.deepEqual(cleanupResult.branches.map((item) => item.outcome), ["deleted", "deleted", "deleted"]);
      assert.equal(cleanupResult.run_dir.outcome, "removed");
      assert.deepEqual(commands.filter((args) => args[0] === "update-ref"), [
        ["update-ref", "-d", "refs/heads/alpha", expectedHeads.alpha],
        ["update-ref", "-d", `refs/heads/${fixture.runId}`, expectedHeads[fixture.runId]],
        ["update-ref", "-d", "refs/heads/zeta", expectedHeads.zeta],
      ]);
      assert.equal(events[0].startsWith("before-worktree-remove:"), true);
      assert.equal(events[1].startsWith("after-worktree-final-validation:"), true);
      assert.deepEqual(events.slice(2, 8), [
        "before-branch-delete:alpha",
        "after-branch-final-validation:alpha",
        `before-branch-delete:${fixture.runId}`,
        `after-branch-final-validation:${fixture.runId}`,
        "before-branch-delete:zeta",
        "after-branch-final-validation:zeta",
      ]);
      assert.equal(events[8], `before-run-dir-remove:${fixture.runDir}`);
      assert.equal(events[9], `after-run-dir-final-validation:${fixture.runDir}`);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reports changed evidence when registered worktree identity changes before mutation", () => {
    const fixture = createFixture("cleanup-sweep-mutated-worktree", { terminal: true, git: true });
    try {
      const runFile = join(fixture.runDir, "run.json");
      const run = readJson(runFile);
      const expectedHeads = { [fixture.runId]: branchHead(fixture.repo, fixture.runId) };
      const commands = [];

      assert.throws(() => cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner(commands),
        phaseHook: (phase) => {
          if (phase === "before-worktree-remove") {
            commitInWorktree(run.worktree, "changed-after-authorization.txt", "changed\n");
          }
        },
      }), CleanupRunChangedError);

      assert.equal(existsSync(run.worktree), true);
      assert.equal(commands.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses branch CAS when a new registered worktree checks out the branch", () => {
    const fixture = createFixture("cleanup-sweep-unexpected-checkout", { terminal: true, git: true });
    const unexpectedWorktree = join(fixture.repo, ".opencode", "worktrees", "unexpected-checkout");
    try {
      runGit(fixture.repo, ["branch", "target-branch"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), slices: [{ branch: "target-branch" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const commands = [];

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner(commands),
        phaseHook: (phase, detail) => {
          if (phase === "before-branch-delete" && detail.branch === "target-branch") {
            runGit(fixture.repo, ["worktree", "add", unexpectedWorktree, "target-branch"]);
          }
        },
      });

      const target = cleanupResult.branches.find((item) => item.name === "target-branch");
      assert.equal(target.outcome, "failed");
      assert.equal(branchExists(fixture.repo, "target-branch"), true);
      assert.equal(commands.some((args) => args[0] === "update-ref" && args[2] === "refs/heads/target-branch"), false);
      assert.equal(cleanupResult.run_dir.outcome, "retained");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("retains sweep state after worktree failure, skips its branch, and continues independent branches", () => {
    const fixture = createFixture("cleanup-sweep-worktree-failure", { terminal: true, git: true });
    try {
      runGit(fixture.repo, ["branch", "independent"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), slices: [{ branch: "independent" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const runner = recordingGitRunner([], (args) => args[0] === "worktree" && args[1] === "remove");

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: runner,
      });

      assert.equal(cleanupResult.worktrees[0].outcome, "failed");
      assert.equal(cleanupResult.worktrees[0].physical_path, realpathSync(run.worktree));
      assert.deepEqual(cleanupResult.branches.map(({ name, outcome }) => ({ name, outcome })), [
        { name: fixture.runId, outcome: "not-attempted" },
        { name: "independent", outcome: "deleted" },
      ]);
      assert.deepEqual(cleanupResult.run_dir, {
        path: fixture.runDir,
        outcome: "retained",
        reason_code: "RETAINED_AFTER_PARTIAL_FAILURE",
      });
      assert.equal(existsSync(runFile), true);
      assert.equal(existsSync(run.worktree), true);
      assert.deepEqual(readdirSync(join(fixture.repo, ".opencode", "worktrees")).filter((entry) => entry.includes("cleanup-worktree")), []);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("continues branch CAS deletion after a failure and retains the run directory", () => {
    const fixture = createFixture("cleanup-sweep-cas-failure", { terminal: true, git: false });
    try {
      initGitRepo(fixture.repo, "unused-worktree");
      runGit(fixture.repo, ["branch", "alpha"]);
      runGit(fixture.repo, ["branch", "zeta"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), branch: "zeta", worktree: null, slices: [{ branch: "alpha" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const runner = recordingGitRunner([], (args) => args[0] === "update-ref" && args[2] === "refs/heads/alpha");

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: runner,
      });

      assert.deepEqual(cleanupResult.branches.map(({ name, outcome }) => ({ name, outcome })), [
        { name: "alpha", outcome: "failed" },
        { name: "zeta", outcome: "deleted" },
      ]);
      assert.equal(cleanupResult.run_dir.outcome, "retained");
      assert.equal(branchExists(fixture.repo, "alpha"), true);
      assert.equal(branchExists(fixture.repo, "zeta"), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reports run-directory removal failure after all sweep targets succeed", () => {
    const fixture = createFixture("cleanup-sweep-run-dir-failure", { terminal: true });
    try {
      const runFile = join(fixture.runDir, "run.json");
      const cleanupResult = cleanupRunLocked(fixture.runDir, readJson(runFile), {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: {},
        fetchedBaseRef: "main",
        removeRunDir: () => { throw new Error("injected failure"); },
      });

      assert.deepEqual(cleanupResult.run_dir, {
        path: fixture.runDir,
        outcome: "failed",
        reason_code: "FAILED_CLEANUP_RUN_DIR",
      });
      assert.equal(existsSync(runFile), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reports the quarantine path when run-directory restoration is blocked", () => {
    const fixture = createFixture("cleanup-sweep-run-dir-restore-failure", { terminal: true });
    const quarantine = join(realpathSync(dirname(fixture.runDir)), ".retained-run-quarantine");
    try {
      const runFile = join(fixture.runDir, "run.json");
      const cleanupResult = cleanupRunLocked(fixture.runDir, readJson(runFile), {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: {},
        fetchedBaseRef: "main",
        quarantinePath: (_path, kind) => kind === "run" ? quarantine : _path,
        removeRunDir() {
          mkdirSync(fixture.runDir);
          writeFileSync(join(fixture.runDir, "replacement"), "replacement\n");
          assert.equal(existsSync(fixture.runDir), true);
          throw new Error("injected failure after replacement");
        },
      });

      assert.equal(cleanupResult.run_dir.path, quarantine);
      assert.equal(cleanupResult.run_dir.outcome, "failed");
      assert.equal(existsSync(join(quarantine, "run.json")), true);
      assert.equal(existsSync(join(fixture.runDir, "run.json")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("restores quarantined worktrees after each post-move failure boundary", () => {
    for (const boundary of ["moved-validation", "authorization", "removal"]) {
      const fixture = createFixture(`cleanup-sweep-worktree-restore-${boundary}`, { terminal: true, git: true });
      try {
        const runFile = join(fixture.runDir, "run.json");
        const run = readJson(runFile);
        const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
        let authorizationChecks = 0;
        const options = {
          mode: "sweep",
          repo: fixture.repo,
          ...sweepPathEvidence(fixture),
          expectedRunHash: hashFile(runFile),
          expectedBranchHeads: expectedHeads,
          fetchedBaseRef: "main",
          gitRunner: recordingGitRunner([], (args) => boundary === "removal" && args[0] === "worktree" && args[1] === "remove"),
          checkWorktreeIdentity: (repo, path, expected) => boundary === "moved-validation" && path.includes(".cleanup-worktree-")
            ? { ok: false, reason: "injected moved validation failure" }
            : checkWorktreeIdentity(repo, path, expected),
          assertMutationAuthorized() {
            authorizationChecks += 1;
            if (boundary === "authorization" && authorizationChecks === 2) throw new Error("injected authorization failure");
          },
        };

        let result;
        try {
          result = cleanupRunLocked(fixture.runDir, run, options);
        } catch (error) {
          assert.equal(boundary, "authorization");
          assert.ok(error instanceof CleanupRunUnexpectedError);
          result = error.cleanup;
        }
        assert.equal(result.worktrees[0].physical_path, realpathSync(run.worktree), boundary);
        assert.equal(existsSync(run.worktree), true, boundary);
        assert.deepEqual(readdirSync(join(fixture.repo, ".opencode", "worktrees")).filter((entry) => entry.includes(".cleanup-worktree-")), [], boundary);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("preserves R51 partial evidence when an unexpected failure follows mutation", () => {
    const fixture = createFixture("cleanup-sweep-unexpected", { terminal: true, git: false });
    try {
      initGitRepo(fixture.repo, "unrelated-worktree");
      runGit(fixture.repo, ["branch", "alpha"]);
      runGit(fixture.repo, ["branch", "zeta"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), branch: "zeta", worktree: null, slices: [{ branch: "alpha" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));

      const error = captureThrown(() => cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        ...sweepPathEvidence(fixture),
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner([]),
        phaseHook: (phase, detail) => {
          if (phase === "before-branch-delete" && detail.branch === "zeta") throw new Error("injected unexpected failure");
        },
      }));

      assert.equal(error instanceof CleanupRunUnexpectedError, true);
      assert.equal(error.code, "FAILED_CLEANUP_UNEXPECTED");
      assert.equal(error.cause?.message, "injected unexpected failure");
      assert.deepEqual(error.cleanup.branches.map(({ name, outcome }) => ({ name, outcome })), [
        { name: "alpha", outcome: "deleted" },
        { name: "zeta", outcome: "failed" },
      ]);
      assert.deepEqual(error.cleanup.run_dir, {
        path: fixture.runDir,
        outcome: "retained",
        reason_code: "RETAINED_AFTER_PARTIAL_FAILURE",
      });
      assert.equal(branchExists(fixture.repo, "alpha"), false);
      assert.equal(branchExists(fixture.repo, "zeta"), true);
      assert.equal(existsSync(runFile), true);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function oversizedFactoryPlan() {
  const testPlan = Array.from({ length: 6 }, (_, index) => `test api ${index + 1}`);
  const plan = {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }], timeout_ms: 600_000 },
    slices: [{
      id: "api",
      stack: "backend",
      paths: ["src/api.js"],
      depends_on: [],
      acceptance: ["accept api"],
      test_plan: testPlan,
    }],
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{
        id: "api-unit",
        slice_id: "api",
        invariant_families: [
          { id: "api-family-1", description: "API family 1" },
          { id: "api-family-2", description: "API family 2" },
        ],
        obligations: testPlan.map((_, index) => ({
          id: `api-obligation-${index + 1}`,
          description: `API obligation ${index + 1}`,
          invariant_family_id: `api-family-${(index % 2) + 1}`,
          verification_artifact_id: `api-artifact-${index + 1}`,
        })),
        verification_artifacts: testPlan.map((entry, index) => ({
          id: `api-artifact-${index + 1}`,
          test_plan_index: index,
          test_plan_entry: entry,
          timeout_ms: 600_000,
        })),
      }],
    },
  };
  const unit = plan.delivery_envelope.delivery_units[0];
  const acceptanceRow = { id: "acceptance-000001", source_slice_id: "api", source_index: 0, text: "accept api" };
  const checkpoints = unit.invariant_families.map((family, index) => {
    const obligations = unit.obligations.filter((obligation) => obligation.invariant_family_id === family.id);
    const artifactIds = new Set(obligations.map((obligation) => obligation.verification_artifact_id));
    const artifacts = unit.verification_artifacts.filter((artifact) => artifactIds.has(artifact.id));
    return {
      id: `checkpoint-${String(index + 1).padStart(3, "0")}`,
      ordinal: index + 1,
      prerequisite_checkpoint_id: index === 0 ? null : `checkpoint-${String(index).padStart(3, "0")}`,
      acceptance_ids: [acceptanceRow.id],
      brief_scope: {
        title: `Deliver ${family.description}`,
        source_delivery_unit_id: unit.id,
        source_slice_id: "api",
        source_slice_dependencies: [],
        stack: "backend",
        paths: ["src/api.js"],
        acceptance: [acceptanceRow.text],
        invariant_family: structuredClone(family),
        obligations: structuredClone(obligations),
        verification_artifacts: structuredClone(artifacts),
      },
      child_plan: {
        integration_gate: structuredClone(plan.integration_gate),
        slices: [{
          id: "api",
          stack: "backend",
          paths: ["src/api.js"],
          depends_on: [],
          acceptance: [acceptanceRow.text],
          test_plan: artifacts.map((artifact) => artifact.test_plan_entry),
        }],
        delivery_envelope: {
          schema_version: 1,
          delivery_units: [{
            id: unit.id,
            slice_id: "api",
            invariant_families: [structuredClone(family)],
            obligations: structuredClone(obligations),
            verification_artifacts: artifacts.map((artifact, artifactIndex) => ({ ...structuredClone(artifact), test_plan_index: artifactIndex })),
          }],
        },
      },
    };
  });
  const assignment = (checkpoint) => ({
    checkpoint_id: checkpoint.id,
    invariant_family_id: checkpoint.brief_scope.invariant_family.id,
    obligation_ids: checkpoint.brief_scope.obligations.map((obligation) => obligation.id),
    verification_artifact_ids: checkpoint.brief_scope.verification_artifacts.map((artifact) => artifact.id),
    test_plan_entries: checkpoint.brief_scope.verification_artifacts.map((artifact) => artifact.test_plan_entry),
  });
  plan.delivery_envelope.checkpoint_plan = {
    schema_version: 1,
    kind: "delivery-checkpoint-plan",
    acceptance_inventory: [acceptanceRow],
    acceptance_mappings: [{
      acceptance_id: acceptanceRow.id,
      policy: "shared-repeat",
      checkpoint_ids: checkpoints.map((checkpoint) => checkpoint.id),
      assignments: checkpoints.map(assignment),
    }],
    checkpoints,
  };
  return plan;
}

function oversizedFactoryReview(plan, planHash) {
  const checkpointPlan = plan.delivery_envelope.checkpoint_plan;
  const identityFields = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    review_ref: "reviews/work-decomposer.json",
  };
  const reviewIdentity = { ...identityFields, identity_hash: checkpointCanonicalHash(identityFields) };
  const acceptanceById = new Map(checkpointPlan.acceptance_inventory.map((row) => [row.id, row]));
  const mappingById = new Map(checkpointPlan.acceptance_mappings.map((row) => [row.acceptance_id, row]));
  const summaries = checkpointPlan.checkpoints.map((checkpoint) => {
    const projection = {
      acceptance_ids: checkpoint.acceptance_ids,
      acceptance_inventory: checkpoint.acceptance_ids.map((id) => acceptanceById.get(id)),
      acceptance_mappings: checkpoint.acceptance_ids.map((id) => mappingById.get(id)),
    };
    return {
      checkpoint_id: checkpoint.id,
      ordinal: checkpoint.ordinal,
      brief_scope_hash: checkpointCanonicalHash(checkpoint.brief_scope),
      child_plan_hash: checkpointCanonicalHash(checkpoint.child_plan),
      acceptance_mapping_hash: checkpointCanonicalHash(projection),
    };
  });
  const admissionProbe = {
    schema_version: 1,
    kind: "delivery-plan-admission-probe",
    status: "valid",
    decision: "checkpoint",
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    reasons: ["checkpoint:mixed-invariant-families:unit=api-unit:families=2:obligations=6"],
    checkpoint_plan_hash: checkpointCanonicalHash(checkpointPlan),
    checkpoints: summaries,
  };
  return {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    verdict: "APPROVE-CHECKPOINT",
    required_fixes: [],
    admission_probe: admissionProbe,
    review_identity: reviewIdentity,
    checkpoint_dispositions: summaries.map((summary) => ({
      schema_version: 1,
      kind: "checkpoint-child-decomposition-review",
      subject: "work-decomposer",
      attempt: 1,
      verdict: "APPROVE",
      required_fixes: [],
      checkpoint_id: summary.checkpoint_id,
      checkpoint_ordinal: summary.ordinal,
      reviewed_plan_ref: "plan/slices.json",
      reviewed_plan_hash: summary.child_plan_hash,
      child_plan_hash: summary.child_plan_hash,
      brief_scope_hash: summary.brief_scope_hash,
      acceptance_mapping_hash: summary.acceptance_mapping_hash,
      parent_review_identity: reviewIdentity,
    })),
  };
}

function checkpointCanonicalHash(value) {
  const canonical = (input) => Array.isArray(input)
    ? input.map(canonical)
    : input !== null && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]))
      : input;
  return `sha256:${createHash("sha256").update(`${JSON.stringify(canonical(value), null, 2)}\n`).digest("hex")}`;
}

function createIssue103ReseedFixture() {
  const repo = mkdtempSync(join(tmpdir(), "factory-issue-103-reseed-"));
  const runId = "issue-103-reseed";
  const sliceBranch = `${runId}--reseed`;
  const sharedPaths = ["test/factory-continue.test.js", "test/factory.test.js"];
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".opencode/\n");
  for (const path of sharedPaths) writeFileSync(join(repo, path), `baseline ${path}\n`);
  runGit(repo, ["add", ".gitignore", "--", ...sharedPaths]);
  runGit(repo, ["commit", "-m", "seed parked issue-103 shared tests"]);
  runGit(repo, ["branch", sliceBranch]);

  const runDir = join(repo, ".opencode", "factory", runId);
  const sliceWorktree = join(repo, ".opencode", "worktrees", "reseed");
  for (const directory of ["artifacts", "plan", "reviews", "evidence"]) mkdirSync(join(runDir, directory), { recursive: true });
  mkdirSync(dirname(sliceWorktree), { recursive: true });
  runGit(repo, ["worktree", "add", sliceWorktree, sliceBranch]);

  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{
      id: "reseed",
      stack: "backend",
      paths: ["src/**"],
      depends_on: [],
      acceptance: ["Complete the parked issue-103 shared-test reseed"],
      test_plan: ["node --test test/factory.test.js test/factory-continue.test.js"],
    }],
  });
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "Accepted parked issue-103 reseed brief.\n");
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", required_fixes: [] });
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE", required_fixes: [] });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    branch: "main",
    worktree: repo,
    gates: {},
    slices: [{
      id: "reseed",
      stack: "backend",
      depends_on: [],
      declared_paths: ["src/**"],
      effective_paths: ["src/**"],
      status: "pending",
      attempts: 0,
    }],
    steps: [{
      agent: "spec-writer",
      status: "accepted",
      attempts: 1,
      artifact_ref: "artifacts/technical-brief.md",
      review_ref: "reviews/spec-writer.json",
      acceptance: {
        artifact_ref: "artifacts/technical-brief.md",
        artifact_hash: hashFile(join(runDir, "artifacts", "technical-brief.md")),
        review_ref: "reviews/spec-writer.json",
        review_hash: hashFile(join(runDir, "reviews", "spec-writer.json")),
      },
    }, {
      agent: "work-decomposer",
      status: "accepted",
      attempts: 1,
      artifact_ref: "plan/slices.json",
      review_ref: "reviews/work-decomposer.json",
      acceptance: {
        artifact_ref: "plan/slices.json",
        artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
        review_ref: "reviews/work-decomposer.json",
        review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
      },
    }],
  });
  return { repo, runDir, runId, sliceBranch, sliceWorktree, sharedPaths, plan };
}

function createFixture(runId, { gate = false, terminal = false, git = false, repo = mkdtempSync(join(tmpdir(), "factory-simplified-")), updatedAt = undefined } = {}) {
  if (git) initGitRepo(repo, runId);
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeFileSync(join(runDir, "gates", "story.question.md"), "approve?\n");
  const run = {
    schema_version: 1,
    run_id: runId,
    status: terminal ? "completed" : "running",
    updated_at: updatedAt,
    branch: git ? runId : null,
    worktree: git ? join(repo, ".opencode", "worktrees", runId) : null,
    pr_url: terminal ? "https://github.com/jasoncarreira/opencode-feature-factory/pull/1" : undefined,
    gates: gate ? {
      story: {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
        pending_snapshot: {
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates", "story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts", "story.md")),
          answer_ref: "gates/story.answer",
          created_at: "2026-07-08T12:00:00.000Z",
        },
      },
    } : {},
    terminal_result: terminal ? {
      status: "completed",
      run_id: runId,
      pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/1",
      pr_number: 1,
      repository: "jasoncarreira/opencode-feature-factory",
      draft: false,
      reason: null,
      summary: "done",
      artifacts: {},
    } : null,
  };
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId };
}

function installCheckedExecutionClaim(fixture, state) {
  const runFile = join(fixture.runDir, "run.json");
  const receiptFile = join(fixture.runDir, "evidence", "test-verifier.attempt-1.json");
  const heartbeatFile = join(fixture.runDir, "heartbeat.json");
  mkdirSync(dirname(receiptFile), { recursive: true });
  writeJson(receiptFile, { sentinel: `${state} receipt bytes must survive refused cleanup` });
  if (state !== "completed") writeFileSync(heartbeatFile, "malformed heartbeat bytes must not be observed\n");
  const claim = {
    schema_version: 1,
    kind: "checked-test-execution-claim",
    state,
    nonce: "123e4567-e89b-42d3-a456-426614174000",
    run_id: fixture.runId,
    attempt: 1,
    plan_ref: "plan/slices.json",
    plan_hash: `sha256:${"1".repeat(64)}`,
    head_sha: branchHead(fixture.repo, fixture.runId),
    receipt_ref: "evidence/test-verifier.attempt-1.json",
    claimed_at: "2026-07-17T12:00:00.000Z",
    ...(state === "completed" ? {
      completed_at: "2026-07-17T12:00:01.000Z",
      status: "pass",
      receipt_hash: hashFile(receiptFile),
    } : {}),
    ...(state === "unknown" ? {
      failed_at: "2026-07-17T12:00:01.000Z",
      reason: "process-outcome-indeterminate",
    } : {}),
  };
  const run = readJson(runFile);
  run.steps = [{
    agent: "test-verifier",
    status: "running",
    attempts: 1,
    ...(state === "completed" ? { evidence_ref: claim.receipt_ref } : {}),
    execution_claim: claim,
    execution_claim_hash: hashValue(claim),
  }];
  writeJson(runFile, run);
  return {
    runFile,
    runBytes: readFileSync(runFile),
    receiptFile,
    receiptBytes: readFileSync(receiptFile),
    heartbeatFile,
    heartbeatBytes: state === "completed" ? null : readFileSync(heartbeatFile),
    worktree: run.worktree,
    branchHead: branchHead(fixture.repo, fixture.runId),
    runEntries: readdirSync(fixture.runDir).sort(),
    worktreeEntries: readdirSync(join(fixture.repo, ".opencode", "worktrees")).sort(),
  };
}

function initGitRepo(repo, branch) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
  mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
  runGit(repo, ["worktree", "add", "-b", branch, join(repo, ".opencode", "worktrees", branch)]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function commitInWorktree(worktree, file, content) {
  writeFileSync(join(worktree, file), content);
  runGit(worktree, ["add", file]);
  runGit(worktree, ["commit", "-m", `add ${file}`]);
}

function branchExists(repo, branch) {
  const proc = spawnSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return proc.status === 0;
}

function branchHead(repo, branch) {
  const proc = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function recordingGitRunner(commands, shouldFail = () => false) {
  return (repo, args) => {
    commands.push([...args]);
    if (shouldFail(args)) return { ok: false, status: 1, stdout: "", stderr: "injected failure" };
    const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    return { ok: proc.status === 0, status: proc.status, stdout: proc.stdout || "", stderr: proc.stderr || "" };
  };
}

function captureThrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected function to throw");
}

async function captureRejected(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected function to reject");
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function snapshotPendingSteering(fixture) {
  const runFile = join(fixture.runDir, "run.json");
  const run = readJson(runFile);
  const steeringDir = join(fixture.runDir, "steering");
  assert.ok(run.steering?.pending, "fixture must have pending steering metadata");
  return {
    runText: readFileSync(runFile, "utf8"),
    pending: run.steering.pending,
    history: run.steering.history,
    pendingText: readFileSync(join(fixture.runDir, run.steering.pending.ref), "utf8"),
    files: readdirSync(steeringDir).sort(),
  };
}

function assertPendingSteeringUnchanged(fixture, before) {
  const runFile = join(fixture.runDir, "run.json");
  const run = readJson(runFile);
  const files = readdirSync(join(fixture.runDir, "steering")).sort();

  assert.equal(readFileSync(runFile, "utf8"), before.runText);
  assert.deepEqual(run.steering.pending, before.pending);
  assert.deepEqual(run.steering.history, before.history);
  assert.equal(readFileSync(join(fixture.runDir, before.pending.ref), "utf8"), before.pendingText);
  assert.deepEqual(files, before.files);
  assert.equal(files.some((file) => file.startsWith("consumed-")), false);
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sweepPathEvidence(fixture) {
  const worktreeRoot = join(fixture.repo, ".opencode", "worktrees");
  const runDirStat = lstatSync(fixture.runDir);
  const run = readJson(join(fixture.runDir, "run.json"));
  const expectedWorktrees = [];
  let expectedWorktreeRoot = { state: "missing", logical_path: worktreeRoot, physical_path: null, device: null, inode: null };
  if (existsSync(worktreeRoot)) {
    const worktreeRootStat = lstatSync(worktreeRoot);
    expectedWorktreeRoot = {
      state: "valid",
      logical_path: worktreeRoot,
      physical_path: realpathSync(worktreeRoot),
      device: String(worktreeRootStat.dev),
      inode: String(worktreeRootStat.ino),
    };
  }
  if (run.worktree && existsSync(run.worktree)) {
    const worktreeStat = lstatSync(run.worktree);
    expectedWorktrees.push({
      recorded_path: run.worktree,
      physical_path: realpathSync(run.worktree),
      device: String(worktreeStat.dev),
      inode: String(worktreeStat.ino),
      branch: run.branch,
      head: branchHead(fixture.repo, run.branch),
      state: "verified",
    });
  }
  return {
    expectedWorktreeRoot,
    expectedWorktrees,
    expectedRunDirectory: {
      kind: "directory",
      logical_path: fixture.runDir,
      physical_path: realpathSync(fixture.runDir),
      device: String(runDirStat.dev),
      inode: String(runDirStat.ino),
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function assertRejectsSeedSymlinkAttack(name, arrange, assertAfter = () => {}) {
  const repo = mkdtempSync(join(tmpdir(), `factory-seed-symlink-${name}-`));
  const outside = mkdtempSync(join(tmpdir(), `factory-seed-symlink-outside-${name}-`));
  try {
    arrange({ repo, outside });

    assert.throws(
      () => seedRepoSkill(repo),
      /symlink/u,
    );
    assertAfter({ repo, outside });
  } finally {
    cleanup(repo);
    cleanup(outside);
  }
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`timed out after ${timeoutMs}ms`);
}
