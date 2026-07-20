import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continueFactory, heartbeatStatus, postPrObserve, postPrRemediation, resumeFactory, startHeartbeat, status, stopHeartbeat, writeSteering } from "../src/factory.js";
import { decodeFeatureCommandPayload, encodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { hashValue } from "../src/refs.js";
import { computePrOperationId } from "../src/github.js";
import { completeSpecialBuilderTaskDispatch, prepareSpecialBuilderTaskDispatch, transitionPostPrState } from "../src/run-state.js";

const SHA = "a".repeat(40);
const EMPTY_PATHS_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

describe("post-PR workflow orchestration", () => {
  it("does no GitHub work before next_poll_at and exposes a read-only summary", async () => {
    const fixture = createFixture("post-pr-not-due", { nextPollAt: "2026-07-12T12:01:00.000Z" });
    try {
      let calls = 0;
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:00.000Z", executeGithub: async () => { calls += 1; throw new Error("must not run"); } });
      assert.equal(result.action, "not-due");
      assert.equal(calls, 0);
      const projected = status(fixture.runId, { cwd: fixture.repo });
      assert.equal(projected.status, "running", JSON.stringify(projected));
      assert.deepEqual(projected.post_pr, {
        enabled: true, phase: "observing", attempt: 0, max_retries: 3,
        deadline_at: "2026-07-12T13:00:00.000Z", next_poll_at: "2026-07-12T12:01:00.000Z", last_verdict: "pending",
        error_class: null, owner: null, route: null, latest_evidence: null,
      });
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("performs exactly one account-switch/query pair and terminalizes green without merge", async () => {
    const fixture = createFixture("post-pr-green");
    const calls = [];
    try {
      const result = await postPrObserve(fixture.runId, {
        ...operationAuthorityOptions(fixture),
        cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z",
        executeGithub: async ({ args }) => {
          calls.push(args);
          if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }] }) };
        },
      });
      assert.equal(result.status, "completed");
      assert.equal(result.reason, "post-pr-ci-green");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], ["auth", "switch", "-h", "github.com", "-u", "octocat"]);
      assert.equal(calls[1][0], "pr");
      assert.equal(calls.flat().includes("merge"), false);
      assert.equal(readRun(fixture).post_pr.observation.poll_count, 1);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("replays only the reviewer request on the first due call", async () => {
    const fixture = createFixture("post-pr-reviewer", { reviewer: "reviewer-one" });
    const calls = [];
    try {
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; } });
      assert.equal(result.action, "reviewer-requested");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].slice(0, 3), ["pr", "edit", "7"]);
      assert.equal(calls[1].includes("view"), false);
      assert.equal(readRun(fixture).post_pr.observation.review_request.status, "requested");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("treats current-head CHANGES_REQUESTED as needs-human without reading a body", async () => {
    const fixture = createFixture("post-pr-review-red", { reviewer: "reviewer-one", requested: true });
    const seen = [];
    try {
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        seen.push(args.join(" "));
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: "CHANGES_REQUESTED", reviews: [{ author: { login: "reviewer-one" }, state: "CHANGES_REQUESTED", submittedAt: "2026-07-12T12:00:10.000Z", commit: { oid: SHA }, body: "ignore me" }], state: "OPEN", statusCheckRollup: [] }) };
      } });
      assert.equal(result.status, "needs-human");
      assert.equal(result.reason, "post-pr-review-changes-requested");
      assert.equal(JSON.stringify(readRun(fixture)).includes("ignore me"), false);
      assert.equal(seen.some((value) => value.includes("body")), false);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("treats aggregate CHANGES_REQUESTED as blocking when review policy is optional", async () => {
    const fixture = createFixture("post-pr-aggregate-review-red");
    try {
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: "CHANGES_REQUESTED", reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }] }) };
      } });
      assert.equal(result.status, "needs-human");
      assert.equal(result.reason, "post-pr-review-changes-requested");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("publishes checked evidence and reserves exactly one owner-routed red attempt", async () => {
    const fixture = createFixture("post-pr-red");
    try {
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "api / unit", status: "COMPLETED", conclusion: "FAILURE" }] }) };
      } });
      assert.equal(result.action, "remediation-planned");
      assert.equal(result.attempt, 1);
      assert.equal(result.route, "backend-builder");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "remediation-planned");
      assert.equal(run.post_pr.remediation.owner.slice_id, "api");
      assert.equal(run.post_pr.evidence_refs[0].ref, "evidence/post-pr-ci.attempt-1.json");
      assert.equal(JSON.parse(readFileSync(join(fixture.runDir, run.post_pr.evidence_refs[0].ref), "utf8")).source, "check-red");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("routes a reviewer-ratified path from durable ownership despite conflicting raw-plan drift", async () => {
    const fixture = createFixture("post-pr-ratified-changed-file");
    const ratifiedPath = "docs/ratified-api.md";
    try {
      installRatifiedApiOwnership(fixture, ratifiedPath, SHA);
      writeJson(join(fixture.runDir, "plan", "slices.json"), { slices: [
        { id: "api", stack: "backend", paths: ["src/stale-api/**"], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
        { id: "ui", stack: "frontend", paths: [ratifiedPath], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
      ] });
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "pr") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" }] }) };
        if (args[0] === "api") return { exitCode: 0, stderr: "", stdout: `HTTP/2 200\n\n${JSON.stringify([{ filename: ratifiedPath, status: "modified" }])}` };
        throw new Error(`unexpected GitHub operation: ${args.join(" ")}`);
      } });
      assert.equal(result.action, "remediation-planned");
      assert.equal(result.owner.slice_id, "api");
      assert.equal(result.owner.method, "changed-files");
      assert.equal(result.route, "backend-builder");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("terminalizes exact duplicate durable owners after claiming observation without stranding that action", async () => {
    const fixture = createFixture("post-pr-duplicate-owner");
    try {
      updateRunFile(fixture, (run) => {
        run.slices.push({ id: "ui", stack: "frontend", depends_on: [], declared_paths: ["src/api.js"], effective_paths: ["src/api.js"], status: "pending", attempts: 0 });
      });
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "pr") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" }] }) };
        if (args[0] === "api") return { exitCode: 0, stderr: "", stdout: `HTTP/2 200\n\n${JSON.stringify([{ filename: "src/api.js", status: "modified" }])}` };
        throw new Error(`unexpected GitHub operation: ${args.join(" ")}`);
      } });
      const run = readRun(fixture);
      assert.equal(result.status, "needs-human");
      assert.equal(run.terminal_result.reason, "post-pr-owner-ambiguous");
      assert.equal(run.steering.last_action.kind, "terminal");
      assert.equal(run.steering.action_claim, null);
      assert.equal(run.steering.boundary, null);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("routes the same ratified path through panel attribution and local-red re-attribution", async () => {
    const fixture = createPanelRecoveryFixture("post-pr-ratified-panel", "validator");
    const ratifiedPath = "docs/ratified-api.md";
    const dispatches = [];
    try {
      configurePanelPlan(fixture);
      installRatifiedApiOwnership(fixture, ratifiedPath, fixture.candidate);
      writeJson(join(fixture.runDir, "plan", "slices.json"), { slices: [
        { id: "api", stack: "backend", paths: ["src/stale-api.js"], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
        { id: "ui", stack: "frontend", paths: [ratifiedPath], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
      ] });
      await dispatchWorkflowPanel(fixture, "validator", { verdict: "NO-GO", affected_paths: [ratifiedPath] }, dispatches);
      await dispatchWorkflowPanel(fixture, "security", { verdict: "PASS", affected_paths: [ratifiedPath] }, dispatches);
      await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:07:00.000Z" });
      const run = readRun(fixture);
      assert.deepEqual(dispatches, ["validator", "security"]);
      assert.equal(run.post_pr.phase, "remediation-planned");
      assert.equal(run.post_pr.remediation.owner.slice_id, "api");
      assert.equal(run.post_pr.remediation.route, "backend-builder");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("uses ratified effective ownership through panel-remediation dispatch and completion", async () => {
    const success = createRunStatePanelFixture("panel-special-ratified");
    try {
      const context = await prepareSpecialBuilderTaskDispatch(success.repo, { run_id: success.runId, route: "panel-remediation", agent: "backend-builder" }, { claimDispatch: true, completionToken: "panel-ratified" });
      assert.deepEqual(context.authority.ownership.slices.find((slice) => slice.id === "api").effective_paths, ["src/api/**", success.ratifiedPath]);
      writeRepoFileAndCommit(success.repo, success.ratifiedPath, "ratified panel repair\n", "ratified panel repair");
      const closed = await completeSpecialBuilderTaskDispatch(success.repo, { run_id: success.runId, route: "panel-remediation", agent: "backend-builder", claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: "panel-ratified" });
      assert.equal(closed.owner_slice_id, "api");
    } finally { rmSync(success.repo, { recursive: true, force: true }); }

    const overlap = createRunStatePanelFixture("panel-special-overlap", { overlap: true });
    try {
      const context = await prepareSpecialBuilderTaskDispatch(overlap.repo, { run_id: overlap.runId, route: "panel-remediation", agent: "backend-builder" }, { claimDispatch: true, completionToken: "panel-overlap" });
      writeRepoFileAndCommit(overlap.repo, overlap.ratifiedPath, "ambiguous panel repair\n", "ambiguous panel repair");
      await assert.rejects(completeSpecialBuilderTaskDispatch(overlap.repo, { run_id: overlap.runId, route: "panel-remediation", agent: "backend-builder", claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: "panel-overlap" }), /exactly one unambiguous slice owner/u);
    } finally { rmSync(overlap.repo, { recursive: true, force: true }); }

    const rename = createRunStatePanelFixture("panel-special-rename", { renameSource: true });
    try {
      const context = await prepareSpecialBuilderTaskDispatch(rename.repo, { run_id: rename.runId, route: "panel-remediation", agent: "backend-builder" }, { claimDispatch: true, completionToken: "panel-rename" });
      mkdirSync(join(rename.repo, "docs"), { recursive: true });
      runGit(rename.repo, ["mv", "src/ui/source.js", rename.ratifiedPath]);
      runGit(rename.repo, ["commit", "-m", "rename into ratified lane"]);
      await assert.rejects(completeSpecialBuilderTaskDispatch(rename.repo, { run_id: rename.runId, route: "panel-remediation", agent: "backend-builder", claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: "panel-rename" }), /exactly one unambiguous slice owner/u);
    } finally { rmSync(rename.repo, { recursive: true, force: true }); }
  });

  it("discards a due observer result when steering changes its bound state", async () => {
    const fixture = createFixture("post-pr-steering-race");
    try {
      await assert.rejects(postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        await writeSteering(fixture.runId, "prospective change", { cwd: fixture.repo, now: "2026-07-12T12:00:31.000Z" });
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [] }) };
      } }), /stale|current run state hash mismatch/u);
      const run = readRun(fixture);
      assert.equal(run.post_pr.observation.poll_count, 0);
      assert.ok(run.steering.pending);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("does not publish red evidence after a pre-publication steering race", async () => {
    const fixture = createFixture("post-pr-evidence-race");
    try {
      await assert.rejects(postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "api / unit", status: "COMPLETED", conclusion: "FAILURE" }] }) };
      }, beforeEvidencePublish: async () => writeSteering(fixture.runId, "race before evidence", { cwd: fixture.repo, now: "2026-07-12T12:00:32.000Z" }) }), /stale/u);
      assert.equal(existsSync(join(fixture.runDir, "evidence", "post-pr-ci.attempt-1.json")), false);
      assert.equal(readRun(fixture).post_pr.attempt, 0);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("persists dispatch/action before wait, heartbeats during dispatch, and stops before return", async () => {
    const fixture = createFixture("post-pr-dispatch");
    try {
      runGit(fixture.repo, ["init", "-b", "feature"]);
      runGit(fixture.repo, ["config", "user.email", "test@example.com"]);
      runGit(fixture.repo, ["config", "user.name", "Test"]);
      writeFileSync(join(fixture.repo, ".gitignore"), ".opencode/\n", "utf8");
      writeFileSync(join(fixture.repo, "README.md"), "fixture\n", "utf8");
      runGit(fixture.repo, ["add", ".gitignore", "README.md"]);
      runGit(fixture.repo, ["commit", "-m", "fixture"]);
      const localHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      await observeApiRed(fixture);
      let dispatch;
      let checkedContext;
      const result = await postPrRemediation(fixture.runId, 1, "running", {
        cwd: fixture.repo, now: "2026-07-12T12:01:00.000Z", heartbeatIntervalMs: 1000,
        dispatchRemediation: async (input) => {
          dispatch = input;
          checkedContext = await prepareSpecialBuilderTaskDispatch(fixture.repo, {
            run_id: fixture.runId, route: "post-pr-remediation", agent: "backend-builder",
          });
          const during = heartbeatStatus(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:01:00.000Z" });
          assert.equal(during.phase, "post-pr-remediation");
          assert.equal(during.fresh, true);
          return { status: "returned" };
        },
      });
      assert.equal(result.action, "remediation-returned");
      assert.equal(dispatch.run_id, fixture.runId);
      assert.equal(dispatch.attempt, 1);
      assert.equal(dispatch.role, "backend-builder");
      assert.equal(checkedContext.authority.remediation.failure_evidence_ref, "evidence/post-pr-ci.attempt-1.json");
      assert.match(checkedContext.authority.publication.files["evidence/post-pr-ci.attempt-1.json"].hash, /^sha256:/u);
      assert.equal(checkedContext.target.head, localHead);
      assert.equal(readRun(fixture).post_pr.remediation.dispatch.status, "running");
      assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo }).pid, null);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("terminalizes an unknown started dispatch on restart instead of redispatching", async () => {
    const fixture = createFixture("post-pr-dispatch-unknown");
    try {
      await observeApiRed(fixture);
      await postPrRemediation(fixture.runId, 1, "running", { cwd: fixture.repo, now: "2026-07-12T12:01:00.000Z" });
      await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:02:00.000Z" }), /terminal-run|resume ineligible/u);
      const run = readRun(fixture);
      assert.equal(run.status, "needs-human");
      assert.equal(run.terminal_result.reason, "post-pr-dispatch-start-unknown");
      assert.equal(run.post_pr.terminal_fact.dispatch_id, run.post_pr.remediation.dispatch.id);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("accepts normal ratified-path remediation despite conflicting raw-plan drift", async () => {
    const fixture = createRevalidationFixture("post-pr-checked-revalidating");
    const ratifiedPath = "docs/ratified-remediation.md";
    try {
      installRatifiedApiOwnership(fixture, ratifiedPath, fixture.baseline);
      writeJson(join(fixture.runDir, "plan", "slices.json"), { slices: [
        { id: "api", stack: "backend", paths: ["src/stale-api.js"], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
        { id: "ui", stack: "frontend", paths: [ratifiedPath], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
      ] });
      updateRunFile(fixture, (run) => {
        run.post_pr.phase = "remediation-running";
        Object.assign(run.post_pr.remediation, {
          stage: "running",
          changes: { paths: [], entries: [], tree_hash: null },
          candidate_head_sha: null,
          remediation_evidence_ref: null,
          remediation_evidence_hash: null,
        });
        Object.assign(run.post_pr.remediation.dispatch, { status: "running", returned_at: null });
      });
      runGit(fixture.repo, ["reset", "--hard", fixture.baseline]);
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId, route: "post-pr-remediation", agent: "backend-builder",
      }, { claimDispatch: true, completionToken: "post-pr-revalidating-token" });
      mkdirSync(join(fixture.repo, "docs"), { recursive: true });
      writeFileSync(join(fixture.repo, ratifiedPath), "ratified remediation\n");
      runGit(fixture.repo, ["add", ratifiedPath]);
      runGit(fixture.repo, ["commit", "-m", "ratified remediation"]);
      fixture.candidate = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      await completeSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId, route: "post-pr-remediation", agent: "backend-builder",
        claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "post-pr-revalidating-token",
      });
      const remediationEvidencePath = join(fixture.runDir, "evidence", "post-pr-remediation.attempt-1.json");
      const remediationEvidence = JSON.parse(readFileSync(remediationEvidencePath, "utf8"));
      remediationEvidence.candidate_head_sha = fixture.candidate;
      remediationEvidence.changed_paths = [ratifiedPath];
      remediationEvidence.changes = [{ source: "commit", status: "added", index_status: null, worktree_status: null, path: ratifiedPath, previous_path: null, old_mode: null, new_mode: null }];
      remediationEvidence.diff_hash = hashValue(remediationEvidence.changes);
      remediationEvidence.commands = remediationEvidence.commands.map((command) => ({ ...command, head_sha: fixture.candidate }));
      remediationEvidence.commit = fixture.candidate;
      writeJson(remediationEvidencePath, remediationEvidence);
      await assert.rejects(
        transitionPostPrState(fixture.runDir, structuredClone(readRun(fixture).post_pr)),
        /closed but awaits exact route consumption/u,
        "non-consuming post-PR transitions must not inherit the route-consumer exemption",
      );

      const result = await postPrRemediation(fixture.runId, 1, "revalidating", {
        cwd: fixture.repo,
        remediationEvidenceRef: "evidence/post-pr-remediation.attempt-1.json",
        now: "2026-07-12T12:03:00.000Z",
      });
      const run = readRun(fixture);
      assert.equal(result.action, "revalidating");
      assert.equal(run.post_pr.phase, "revalidating");
      assert.equal(run.post_pr.remediation.candidate_head_sha, fixture.candidate);
      assert.equal(run.special_builder_dispatch, undefined);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("rejects stale canonical/panel bindings before push", async () => {
    const fixture = createRevalidationFixture("post-pr-stale-panel");
    try {
      const refs = writePassingRevalidationArtifacts(fixture, { validatorHead: fixture.baseline });
      await assert.rejects(postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, headSha: fixture.candidate, ...refs }), /validator review must bind/u);
      assert.equal(readRun(fixture).post_pr.phase, "revalidating");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("account-switches every remote/push operation, reconciles push, and creates one fresh epoch", async () => {
    const fixture = createRevalidationFixture("post-pr-push");
    const refs = writePassingRevalidationArtifacts(fixture);
    const accountCalls = [];
    const gitOps = [];
    let remote = fixture.baseline;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", {
        cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async ({ args }) => { accountCalls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; },
        executeGitOperation: async ({ operation }) => {
          gitOps.push(operation);
          if (operation === "remote-head") return { exitCode: 0, stdout: `${remote}\trefs/heads/main\n`, stderr: "" };
          remote = fixture.candidate;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(result.action, "observing");
      assert.equal(result.epoch, 2);
      assert.deepEqual(gitOps, ["remote-head", "fast-forward-push", "remote-head"]);
      assert.equal(accountCalls.length, 3);
      assert.ok(accountCalls.every((args) => args.join(" ") === "auth switch -h github.com -u octocat"));
      const run = readRun(fixture);
      assert.equal(run.post_pr.observation.expected_head_sha, fixture.candidate);
      assert.equal(run.post_pr.remediation.push.remote_after_sha, fixture.candidate);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("durably records account-switch push failure and does not blindly retry", async () => {
    const fixture = createRevalidationFixture("post-pr-push-account-failure");
    const refs = writePassingRevalidationArtifacts(fixture);
    let switches = 0;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async () => { switches += 1; return { exitCode: 1, stdout: "", stderr: "authentication failed" }; } });
      assert.equal(result.action, "terminal");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "needs-human");
      assert.equal(run.terminal_result.reason, "post-pr-account-switch-failed");
      assert.equal(run.post_pr.remediation.push.consecutive_transient_errors, 1);
      assert.equal(run.post_pr.remediation.push.next_retry_at, null);
      await assert.rejects(postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:11:00.000Z" }), /terminal run|requires revalidating/u);
      assert.equal(switches, 1);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("persists transient push backoff and performs no operation before retry time", async () => {
    const fixture = createRevalidationFixture("post-pr-push-transient");
    const refs = writePassingRevalidationArtifacts(fixture); let operations = 0;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }), executeGitOperation: async () => { operations += 1; return { exitCode: 1, stdout: "", stderr: "HTTP 503" }; } });
      assert.equal(result.action, "push-retry");
      assert.equal(result.next_retry_at, "2026-07-12T12:11:00.000Z");
      const replay = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:30.000Z" });
      assert.equal(replay.action, "push-not-due");
      assert.equal(operations, 1);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("T18 push failed by operation and classification", async () => {
    for (const [classification, stderr] of [["permanent", "HTTP 403 permission denied"], ["exhausted", "HTTP 503 unavailable"]]) {
      const fixture = createRevalidationFixture(`post-pr-push-${classification}`); const refs = writePassingRevalidationArtifacts(fixture); const operations = [];
      if (classification === "exhausted") updateRunFile(fixture, (run) => { run.post_pr.policy.max_transient_errors = 1; });
      try {
        const result = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
          executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }), executeGitOperation: async ({ operation }) => { operations.push(operation); return { exitCode: 1, stdout: "", stderr }; } });
        assert.equal(result.status, "needs-human"); assert.equal(result.reason, "post-pr-push-failed");
        const run = readRun(fixture); assert.equal(run.post_pr.terminal_fact.classification, classification); assert.equal(run.post_pr.terminal_fact.operation, "remote-head");
        assert.equal(run.post_pr.remediation.push.next_retry_at, null); assert.deepEqual(operations, ["remote-head"]); assert.equal(operations.includes("force-push"), false);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });

  it("reconciles crash-after-push from remote candidate without pushing twice", async () => {
    const fixture = createRevalidationFixture("post-pr-crash-after-push");
    const refs = writePassingRevalidationArtifacts(fixture); let remote = fixture.baseline; let pushes = 0;
    const common = { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      executeGitOperation: async ({ operation }) => { if (operation === "remote-head") return { exitCode: 0, stdout: `${remote}\trefs/heads/main\n`, stderr: "" }; pushes += 1; remote = fixture.candidate; return { exitCode: 0, stdout: "", stderr: "" }; } };
    try {
      await assert.rejects(postPrRemediation(fixture.runId, 1, "complete", { ...common, headSha: fixture.candidate, ...refs, afterExternalPush: async () => { throw new Error("simulated crash after push"); } }), /simulated crash/u);
      assert.equal(readRun(fixture).post_pr.phase, "push-pending");
      const result = await postPrRemediation(fixture.runId, 1, "complete", common);
      assert.equal(result.action, "observing");
      assert.equal(pushes, 1);
      assert.equal(readRun(fixture).post_pr.observation.epoch, 2);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("terminalizes a remote head that is neither baseline nor candidate without force push", async () => {
    const fixture = createRevalidationFixture("post-pr-remote-diverged");
    const refs = writePassingRevalidationArtifacts(fixture); let pushes = 0;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }), executeGitOperation: async ({ operation }) => { if (operation === "fast-forward-push") pushes += 1; return { exitCode: 0, stdout: `${"f".repeat(40)}\trefs/heads/main\n`, stderr: "" }; } });
      assert.equal(result.status, "needs-human");
      assert.equal(result.reason, "post-pr-remote-head-diverged");
      assert.equal(pushes, 0);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("reconciles validated, push-pending, and remote-confirmed crash rows exactly once", async () => {
    for (const [name, hook, expectedPhase] of [["validated", "afterValidated", "validated"], ["push-pending", "afterPushPending", "push-pending"], ["remote-confirmed", "afterRemoteConfirmed", "remote-confirmed"]]) {
      const fixture = createRevalidationFixture(`post-pr-crash-${name}`); const refs = writePassingRevalidationArtifacts(fixture); let remote = fixture.baseline; let pushes = 0;
      const operations = { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }), executeGitOperation: async ({ operation }) => {
        if (operation === "remote-head") return { exitCode: 0, stdout: `${remote}\trefs/heads/main\n`, stderr: "" };
        pushes += 1; remote = fixture.candidate; return { exitCode: 0, stdout: "", stderr: "" };
      } };
      try {
        await assert.rejects(postPrRemediation(fixture.runId, 1, "complete", { ...operations, headSha: fixture.candidate, ...refs, [hook]: async () => { throw new Error(`crash-${name}`); } }), new RegExp(`crash-${name}`));
        assert.equal(readRun(fixture).post_pr.phase, expectedPhase);
        const result = await postPrRemediation(fixture.runId, 1, "complete", operations);
        assert.equal(result.action, "observing");
        assert.equal(readRun(fixture).post_pr.observation.epoch, 2);
        assert.ok(pushes <= 1);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });

  it("clean-descendant recovery reaches ratified effective ownership despite raw-plan drift", async () => {
    const fixture = createRevalidationFixture("post-pr-adopt-descendant");
    const ratifiedPath = "docs/recovered-descendant.md";
    try {
      await closeRecoverablePostPrDispatch(fixture, { ratifiedPath, candidatePath: ratifiedPath });
      let decisions = 0;
      await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", afterPostPrRecoveryOwnership: ({ kind, lane, paths }) => {
        decisions += 1;
        assert.equal(kind, "descendant");
        assert.deepEqual(lane, { ok: true });
        assert.deepEqual(paths, [ratifiedPath]);
      } });
      const run = readRun(fixture);
      assert.equal(decisions, 1);
      assert.equal(run.status, "running");
      assert.equal(run.post_pr.phase, "committed");
      assert.deepEqual(run.post_pr.remediation.changes.paths, [ratifiedPath]);
      assert.equal(run.post_pr.remediation.candidate_head_sha, fixture.candidate);
      assert.equal(run.special_builder_dispatch, undefined);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("fails closed when a clean closed dispatch is followed by dirty recovery state", async () => {
    const fixture = createRevalidationFixture("post-pr-adopt-dirty");
    const ratifiedPath = "docs/recovered-dirty.md";
    try {
      await closeRecoverablePostPrDispatch(fixture, { ratifiedPath, candidatePath: "src/api.js" });
      const before = readRun(fixture);
      mkdirSync(join(fixture.repo, "docs"), { recursive: true });
      writeFileSync(join(fixture.repo, ratifiedPath), "dirty ratified recovery\n");
      let launches = 0;
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:05:00.000Z", foregroundLaunchFn: async () => { launches += 1; } });
      const run = readRun(fixture);
      assert.equal(result.status, "recovery-required");
      assert.equal(result.reason_code, "post-pr-closed-dispatch-dirty-worktree");
      assert.equal(launches, 0);
      assert.equal(run.status, "running");
      assert.equal(run.post_pr.phase, "remediation-running");
      assert.deepEqual(run.post_pr.remediation, before.post_pr.remediation);
      assert.equal(run.post_pr.remediation.candidate_head_sha, null);
      assert.deepEqual(run.post_pr.remediation.changes.paths, []);
      assert.deepEqual(run.special_builder_dispatch, before.special_builder_dispatch);
      assert.equal(existsSync(join(fixture.runDir, run.special_builder_dispatch.closure_ref)), true);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("adopts bound failure evidence after a failure-recording crash", async () => {
    const fixture = createFixture("post-pr-failure-recording");
    try {
      await observeApiRed(fixture);
      updateRunFile(fixture, (run) => { run.post_pr.phase = "failure-recording"; });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      assert.equal(readRun(fixture).post_pr.phase, "remediation-planned");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("deterministically regenerates missing failure-recording evidence instead of blocking", async () => {
    const fixture = createFixture("post-pr-regenerate-evidence");
    try {
      await observeApiRed(fixture);
      const before = readRun(fixture); const binding = before.post_pr.evidence_refs[0];
      updateRunFile(fixture, (run) => { run.post_pr.phase = "failure-recording"; });
      rmSync(join(fixture.runDir, binding.ref));
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      assert.equal(fileHash(join(fixture.runDir, binding.ref)), binding.hash);
      assert.equal(readRun(fixture).post_pr.phase, "remediation-planned");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("adopts matching deterministic failure evidence left unbound by a crash", async () => {
    const fixture = createFixture("post-pr-adopt-unbound");
    try {
      await observeApiRed(fixture);
      updateRunFile(fixture, (run) => { run.post_pr.phase = "observing"; run.post_pr.attempt = 0; run.post_pr.remediation = null; run.post_pr.evidence_refs = []; });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "remediation-planned");
      assert.equal(run.post_pr.attempt, 1);
      assert.equal(run.post_pr.remediation.failure_evidence_ref, "evidence/post-pr-ci.attempt-1.json");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("exhausts against the exact latest local failure and publishes all ref/hash bindings", async () => {
    const fixture = createRevalidationFixture("post-pr-exhaustion");
    try {
      updateRunFile(fixture, (run) => { run.max_retries = 1; });
      const failure = { run_id: fixture.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: fixture.candidate, failure_fingerprint: `sha256:${"9".repeat(64)}`, affected_paths: ["src/api.js"], panel: "validator" };
      writeJson(join(fixture.runDir, "evidence", "post-pr-local-failure.attempt-2.json"), failure);
      const result = await postPrRemediation(fixture.runId, 1, "failed", { cwd: fixture.repo, failureEvidenceRef: "evidence/post-pr-local-failure.attempt-2.json", now: "2026-07-12T12:10:00.000Z" });
      assert.equal(result.status, "blocked");
      const run = readRun(fixture);
      assert.equal(run.terminal_result.reason, "post-pr-retry-exhausted");
      assert.equal(run.post_pr.evidence_refs.at(-1).ref, "evidence/post-pr-local-failure.attempt-2.json");
      assert.equal(JSON.parse(readFileSync(join(fixture.runDir, run.post_pr.continuation_review.ref), "utf8")).head_sha, fixture.candidate);
      assert.equal(run.terminal_result.artifacts.latest_failure_hash, fileHash(join(fixture.runDir, "evidence", "post-pr-local-failure.attempt-2.json")));
      assert.equal(run.terminal_result.artifacts.continuation_review_hash, run.post_pr.continuation_review.hash);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("re-attributes structured test-only panel failure to test-verifier and fails closed for unowned security block", async () => {
    const fixture = createRevalidationFixture("post-pr-panel-reattribution");
    try {
      writeJson(join(fixture.runDir, "evidence", "panel-failure-2.json"), { run_id: fixture.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: fixture.candidate, failure_fingerprint: `sha256:${"7".repeat(64)}`, affected_paths: ["test/api.test.js"], panel: "validator" });
      const result = await postPrRemediation(fixture.runId, 1, "failed", { cwd: fixture.repo, failureEvidenceRef: "evidence/panel-failure-2.json", now: "2026-07-12T12:10:00.000Z" });
      assert.equal(result.route, "test-verifier");
      assert.equal(readRun(fixture).post_pr.remediation.owner.kind, "integration");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }

    const security = createRevalidationFixture("post-pr-security-reattribution");
    try {
      writeJson(join(security.runDir, "evidence", "security-failure-2.json"), { run_id: security.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: security.candidate, failure_fingerprint: `sha256:${"6".repeat(64)}`, affected_paths: ["test/api.test.js"], panel: "security" });
      await assert.rejects(postPrRemediation(security.runId, 1, "failed", { cwd: security.repo, failureEvidenceRef: "evidence/security-failure-2.json", now: "2026-07-12T12:10:00.000Z" }), /human ownership reconciliation/u);
      assert.equal(readRun(security).post_pr.phase, "revalidating");
    } finally { rmSync(security.repo, { recursive: true, force: true }); }
  });

  it("P01 passing panels with one production owner publish, bind, and validate in order", async () => assertPassingPanelWorkflow("p01", ["src/api.js"]));
  it("P02 passing panels with test CI owner publish, bind, and validate in order", async () => assertPassingPanelWorkflow("p02", ["test/api.test.js"]));
  it("P03 validator NO-GO reserves exactly one production-owner remediation", async () => assertRedPanelWorkflow("p03", { validatorVerdict: "NO-GO", securityVerdict: "PASS", paths: ["src/api.js"], route: "backend-builder", ownerKind: "slice" }));
  it("P04 validator NO-GO reserves exactly one test-verifier remediation", async () => assertRedPanelWorkflow("p04", { validatorVerdict: "NO-GO", securityVerdict: "PASS", paths: ["test/api.test.js"], route: "test-verifier", ownerKind: "integration" }));
  it("P05 security BLOCK reserves exactly one production-owner remediation", async () => assertRedPanelWorkflow("p05", { validatorVerdict: "GO", securityVerdict: "BLOCK", paths: ["src/api.js"], route: "backend-builder", ownerKind: "slice" }));
  it("P06 dual red panels create one combined reservation", async () => assertRedPanelWorkflow("p06", { validatorVerdict: "NO-GO", securityVerdict: "BLOCK", paths: ["src/api.js"], route: "backend-builder", ownerKind: "slice", panel: "combined" }));
  it("P07 security BLOCK without slice owner terminalizes without binding or reservation", async () => assertAttributionWorkflow("p07", { validatorPaths: ["test/api.test.js"], securityPaths: ["test/api.test.js"], securityVerdict: "BLOCK", category: "security-block-without-slice-owner", panel: "security", hash: "227d01439b737014689e36a67684c31b2ebb5bfa22028d8d25daa2154c8380c9" }));
  it("P08 different production owners terminalize owner-conflict", async () => assertAttributionWorkflow("p08", { validatorPaths: ["src/api.js"], securityPaths: ["src/ui.js"], category: "owner-conflict", panel: "combined", hash: "c9f977b393149f7f2e8d3610db7c98e65f101595531f09adc9143a6f93d8a6d8" }));
  it("P09 production and test owners terminalize owner-conflict", async () => assertAttributionWorkflow("p09", { validatorPaths: ["src/api.js"], securityPaths: ["test/api.test.js"], category: "owner-conflict", panel: "combined", hash: "2f976d81ca6cdbeec8123186abfdb21687e092b0b59c0793f4b87f5bfd8c31b9" }));
  it("P10 internally mixed paths terminalize mixed-owner", async () => assertAttributionWorkflow("p10", { securityPaths: ["src/api.js", "test/api.test.js"], category: "mixed-owner", panel: "security", hash: "2f976d81ca6cdbeec8123186abfdb21687e092b0b59c0793f4b87f5bfd8c31b9" }));
  it("P11 unowned production path terminalizes unowned-path", async () => assertAttributionWorkflow("p11", { securityPaths: ["config/runtime.json"], category: "unowned-path", panel: "security", hash: "4def1fdb847720b875f333f663cd3dd7d82419c37375c93b412ef00c6d3801d4" }));
  it("P12 missing and empty paths publish then terminalize exact categories", async () => { await assertAttributionWorkflow("p12-missing", { omitSecurityPaths: true, category: "missing-paths", panel: "security", hash: EMPTY_PATHS_HASH }); await assertAttributionWorkflow("p12-empty", { securityPaths: [], category: "empty-paths", panel: "security", hash: EMPTY_PATHS_HASH }); });
  it("P13 malformed path content publishes then terminalizes invalid-paths", async () => assertAttributionWorkflow("p13", { securityPaths: ["src/api.js", "../escape"], category: "invalid-paths", panel: "security", hash: EMPTY_PATHS_HASH }));
  it("P14 stale published panel identity terminalizes metadata-unsafe without dispatch or binding", async () => assertStalePanelWorkflow("p14"));

  it("P25 malformed panel runner result is metadata-unsafe", async () => {
    const classValue = new (class PanelResult { constructor(verdict) { this.verdict = verdict; } })("GO");
    const crossRealm = (await import("node:vm")).runInNewContext('({ verdict: "GO" })');
    const revoked = Proxy.revocable({ verdict: "GO" }, {}); revoked.revoke();
    const throwingToJson = { verdict: "GO", toJSON() { throw new Error("must not run"); } };
    // The exhaustive malformed-result inventory (exotic objects, proxies,
    // cross-realm values, descriptor traps) lives in
    // test/post-pr-panel-metadata.test.js against classifyPanelResult. These
    // rows prove one wiring path per issue category, plus one on the second
    // panel.
    const cases = [
      ["non-object", null],
      ["missing-verdict", {}],
      ["unexpected-result-keys", { verdict: "GO", extra: true }],
      ["invalid-verdict", { verdict: "WRONG" }],
    ];
    const tasks = [...cases.map(([issue, supplied]) => ({ activity: "validator", issue, supplied })), { activity: "security", issue: "non-object", supplied: null }];
    await runRowsConcurrently(tasks, async ({ activity, issue, supplied }) => {
      const result = supplied;
      const fixture = createPanelRecoveryFixture(`p25-${activity}-${issue}-${Math.random().toString(16).slice(2)}`, activity);
      let dispatches = 0; let terminalChecks = 0;
      try {
        const beforeSideEffects = panelSideEffectCounters(fixture, activity);
        await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => {
          dispatches += 1;
          return { started: true, exit_code: 0, signal: null, result };
        }, beforePostPrTerminal: ({ run: terminalRun }) => { terminalChecks += 1; assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo }).pid, null); assert.equal(terminalRun.steering.last_action.kind, "terminal"); assert.equal(terminalRun.steering.last_action.outcome, "started"); } }), /terminal-run|resume ineligible/u);
        const run = readRun(fixture); const job = run.post_pr.remediation.revalidation.jobs[activity];
        assert.equal(run.status, "needs-human");
        assert.equal(run.terminal_result.reason, "post-pr-metadata-unsafe");
        assert.deepEqual(run.post_pr.terminal_fact, { schema_version: 1, kind: "panel-runner-result-malformed", observed_at: "2026-07-12T12:05:00.000Z", attempt: 1, activity,
          dispatch_id: job.dispatch_id, candidate_head_sha: fixture.candidate, issue });
        for (const ref of fixedPanelRefs(activity)) assert.equal(existsSync(join(fixture.runDir, ref)), false);
        assert.equal(job.status, "running");
        assert.equal(run.post_pr.attempt, 1);
        assert.equal(activity === "validator" ? run.post_pr.remediation.revalidation.jobs.security : undefined, undefined);
        assert.deepEqual(panelSideEffectCounters(fixture, activity), beforeSideEffects);
        await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, executePostPrRecoveryJob: async () => { dispatches += 1; } }), /terminal-run|resume ineligible/u);
        assert.equal(dispatches, 1); assert.equal(terminalChecks, 1); assert.deepEqual(panelSideEffectCounters(fixture, activity), beforeSideEffects);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    });

    for (const [label, overrides, pattern] of [
      ["token", { terminalActionTokenOverride: "wrong-terminal-token" }, /terminal action/u],
      ["generation", { terminalActionGenerationOverride: 99 }, /terminal action/u],
      ["state-hash", { terminalExpectedHashOverride: `sha256:${"f".repeat(64)}` }, /stale run\.json transition|state hash mismatch/u],
    ]) {
      const fixture = createPanelRecoveryFixture(`p25-terminal-${label}`, "validator"); const before = panelSideEffectCounters(fixture, "validator");
      try {
        await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", ...overrides,
          executePostPrRecoveryJob: async () => ({ started: true, exit_code: 0, signal: null, result: null }) }), pattern);
        assert.equal(readRun(fixture).status, "running"); assert.deepEqual(panelSideEffectCounters(fixture, "validator"), before);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
    const heartbeatFixture = createPanelRecoveryFixture("p25-terminal-heartbeat", "validator"); const heartbeatBefore = panelSideEffectCounters(heartbeatFixture, "validator");
    try {
      await assert.rejects(resumeFactory(heartbeatFixture.runId, { cwd: heartbeatFixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z",
        executePostPrRecoveryJob: async () => ({ started: true, exit_code: 0, signal: null, result: null }),
        terminalExpectedHashAfterHook: true,
        beforePostPrTerminal: async () => { await startHeartbeat(heartbeatFixture.runId, { phase: "post-pr-validator", intervalMs: 1000 }, { cwd: heartbeatFixture.repo }); } }), /inactive heartbeat/u);
      assert.equal(readRun(heartbeatFixture).status, "running"); assert.deepEqual(panelSideEffectCounters(heartbeatFixture, "validator"), heartbeatBefore);
    } finally { await stopHeartbeat(heartbeatFixture.runId, {}, { cwd: heartbeatFixture.repo }).catch(() => {}); rmSync(heartbeatFixture.repo, { recursive: true, force: true }); }

    for (const activity of ["validator", "security"]) {
      const verdict = activity === "validator" ? "GO" : "PASS";
      const inherited = Object.assign(Object.create({ result: { verdict, affected_paths: ["src/api.js"] } }), { started: true, exit_code: 0, signal: null });
      const outerProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("proxy trap must not run"); } });
      const unknownReturns = [{ started: true, exit_code: 0, signal: null }, inherited, { started: true, exit_code: 1, signal: null, result: { verdict } }, { started: true, exit_code: 0, signal: "SIGTERM", result: { verdict } }, outerProxy];
      for (const returned of unknownReturns) {
        const fixture = createPanelRecoveryFixture(`p25-unknown-${activity}-${Math.random().toString(16).slice(2)}`, activity); let dispatches = 0; let terminalChecks = 0;
        try {
          const before = panelSideEffectCounters(fixture, activity);
          await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => { dispatches += 1; return returned; }, beforePostPrTerminal: () => { terminalChecks += 1; assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo }).pid, null); } }), /terminal-run|resume ineligible/u);
          const run = readRun(fixture); const job = run.post_pr.remediation.revalidation.jobs[activity]; assert.equal(run.terminal_result.reason, "post-pr-dispatch-start-unknown");
          assert.deepEqual(run.post_pr.terminal_fact, { schema_version: 1, kind: "dispatch-start-unknown", observed_at: "2026-07-12T12:05:00.000Z", attempt: 1, activity, dispatch_id: job.dispatch_id, dispatch_started_at: job.started_at, candidate_head_sha: fixture.candidate, outcome: "return-unknown" });
          assert.ok(fixedPanelRefs(activity).every((ref) => !existsSync(join(fixture.runDir, ref))));
          assert.equal(job.status, "running"); assert.equal(localReservationCount(run), 0); if (activity === "validator") assert.equal(run.post_pr.remediation.revalidation.jobs.security, undefined); assert.deepEqual(panelSideEffectCounters(fixture, activity), before);
          await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, executePostPrRecoveryJob: async () => { dispatches += 1; } }), /terminal-run|resume ineligible/u);
          assert.equal(dispatches, 1); assert.equal(terminalChecks, 1); assert.deepEqual(panelSideEffectCounters(fixture, activity), before);
        } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
      }
      const accessorFixture = createPanelRecoveryFixture(`p25-accessor-${activity}`, activity); const accessorOuter = { started: true, exit_code: 0, signal: null };
      Object.defineProperty(accessorOuter, "result", { get() { throw new Error("result getter must not run"); } });
      try {
        const before = panelSideEffectCounters(accessorFixture, activity);
        await assert.rejects(resumeFactory(accessorFixture.runId, { cwd: accessorFixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => accessorOuter }), /terminal-run|resume ineligible/u);
        const run = readRun(accessorFixture); assert.equal(run.post_pr.terminal_fact.issue, "non-object"); assert.equal(run.post_pr.terminal_fact.activity, activity); assert.deepEqual(panelSideEffectCounters(accessorFixture, activity), before);
        await assert.rejects(resumeFactory(accessorFixture.runId, { cwd: accessorFixture.repo, dryRun: true }), /terminal-run|resume ineligible/u); assert.deepEqual(panelSideEffectCounters(accessorFixture, activity), before);
      } finally { rmSync(accessorFixture.repo, { recursive: true, force: true }); }
    }

    for (const activity of ["validator", "security"]) {
      for (const affected of [undefined, "src/api.js", [], ["../escape"]]) {
        const fixture = createPanelRecoveryFixture(`p25-attribution-${activity}-${Math.random().toString(16).slice(2)}`, activity);
        try {
          const verdict = activity === "validator" ? "GO" : "PASS";
          const panel = affected === undefined ? { verdict } : { verdict, affected_paths: affected };
          await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z",
            executePostPrRecoveryJob: async () => ({ started: true, exit_code: 0, signal: null, result: panel }) }), /terminal-run|resume ineligible/u);
          const run = readRun(fixture);
          assert.equal(run.terminal_result.reason, "post-pr-panel-attribution-unsafe");
          assert.equal(run.post_pr.terminal_fact.affected_paths_hash, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
          assert.ok(fixedPanelRefs(activity).every((ref) => existsSync(join(fixture.runDir, ref))));
          assert.equal(run.post_pr.remediation.revalidation.jobs[activity].status, "running");
        } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
      }
    }
  });

  // The exhaustive affected-value shape and exact-limit inventory lives in
  // test/post-pr-panel-metadata.test.js, directly against the exported pure
  // seams. These rows prove the wiring only: one row per attribution category
  // flows into the exact terminal fact through the full workflow, on both
  // panels for the ownership categories.
  it("P25 affected-value categories wire into terminal attribution facts through both panels", async () => {
    const rows = [
      { label: "absent", make: () => undefined, omit: true, category: "missing-paths", hash: EMPTY_PATHS_HASH },
      { label: "null", make: () => null, category: "invalid-paths", hash: EMPTY_PATHS_HASH },
      { label: "empty-array", make: () => [], category: "empty-paths", hash: EMPTY_PATHS_HASH },
      { label: "mixed-array", make: () => ["src/api.js", "test/api.test.js"], category: "mixed-owner", hash: "2f976d81ca6cdbeec8123186abfdb21687e092b0b59c0793f4b87f5bfd8c31b9" },
      { label: "path-byte-limit", make: () => ["a".repeat(4096)], category: "unowned-path", hash: "58850230e822043b8c75a23c51fa30686e3c6826d6a671773e6189308a33dde6" },
      { label: "array-length-limit", make: () => new Array(4096).fill("src/api.js"), success: true },
    ];
    const tasks = [
      ...rows.map((row) => ({ activity: "validator", row })),
      { activity: "security", row: rows[3] },
      { activity: "security", row: rows[5] },
    ];
    await runRowsConcurrently(tasks, async ({ activity, row }) => {
      if (row.success) await assertAffectedWorkflowSuccess(activity, row.label, row.make());
      else await assertAffectedWorkflowTerminal(activity, row.label, row.make(), row);
    });
  });

  for (const [name, activity] of [
    ["P15 canonical durable-running pre-start crash is return-unknown", "canonical"],
    ["P16 canonical returned-before-publication crash is never rerun", "canonical"],
    ["P19 validator absent-result crash points are return-unknown", "validator"],
    ["P22 security absent-result crash points are return-unknown", "security"],
  ]) it(name, async () => {
    const fixture = createPanelRecoveryFixture(`crash-${name.slice(0, 3).toLowerCase()}`, activity === "canonical" ? "validator" : activity); let dispatches = 0;
    try {
      updateRunFile(fixture, (run) => {
        const jobs = run.post_pr.remediation.revalidation.jobs;
        if (activity === "canonical") { jobs.canonical = panelJob("canonical", "running"); delete jobs.validator; Object.assign(run.post_pr.remediation.revalidation, { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null }); rmSync(join(fixture.runDir, "evidence", "post-pr-canonical.attempt-1.json"), { force: true }); }
        else jobs[activity] = panelJob(activity, "running");
      });
      await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => { dispatches += 1; } }), /terminal-run|resume ineligible/u);
      assert.equal(readRun(fixture).terminal_result.reason, "post-pr-dispatch-start-unknown"); assert.equal(dispatches, 0);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("P17 canonical published-unbound evidence binds without rerun", async () => {
    const fixture = createPanelRecoveryFixture("crash-p17", "validator");
    try {
      updateRunFile(fixture, (run) => { run.post_pr.remediation.revalidation.jobs.canonical = panelJob("canonical", "running"); delete run.post_pr.remediation.revalidation.jobs.validator; Object.assign(run.post_pr.remediation.revalidation, { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null }); });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => { throw new Error("must not rerun"); } });
      assert.equal(result.status, "dry-run"); assert.equal(readRun(fixture).post_pr.remediation.revalidation.jobs.canonical.status, "bound");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("canonical red published-unbound recovery binds and reaches local-red remediation", async () => {
    const fixture = createPanelRecoveryFixture("crash-canonical-red", "validator");
    try {
      updateRunFile(fixture, (run) => {
        run.post_pr.remediation.revalidation.jobs.canonical = panelJob("canonical", "running");
        delete run.post_pr.remediation.revalidation.jobs.validator;
        Object.assign(run.post_pr.remediation.revalidation, { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null });
      });
      const canonicalPath = join(fixture.runDir, "evidence", "post-pr-canonical.attempt-1.json");
      const canonical = JSON.parse(readFileSync(canonicalPath, "utf8"));
      canonical.verdict = "red";
      writeJson(canonicalPath, canonical);
      const first = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => { throw new Error("must not rerun"); } });
      assert.equal(first.status, "dry-run");
      assert.equal(readRun(fixture).post_pr.remediation.revalidation.jobs.canonical.verdict, "red");
      assert.equal(readRun(fixture).post_pr.remediation.revalidation.canonical_verdict, "red");
      const second = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:06:00.000Z" });
      assert.equal(second.status, "dry-run");
      assert.equal(readRun(fixture).post_pr.phase, "remediation-planned");
      assert.equal(readRun(fixture).post_pr.remediation.reason_code, "local-red");
      assert.equal(readRun(fixture).post_pr.attempt, 2);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("canonical red normal publication persists red and reaches local-red remediation", async () => {
    const fixture = createPanelRecoveryFixture("canonical-red-normal", "validator");
    try {
      updateRunFile(fixture, (run) => {
        run.post_pr.remediation.revalidation.jobs.canonical = panelJob("canonical", "planned");
        delete run.post_pr.remediation.revalidation.jobs.validator;
        Object.assign(run.post_pr.remediation.revalidation, { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null });
      });
      rmSync(join(fixture.runDir, "evidence", "post-pr-canonical.attempt-1.json"), { force: true });
      const first = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => ({ started: true, exit_code: 1, signal: null, result: { verdict: "red" } }) });
      assert.equal(first.status, "dry-run");
      const published = readRun(fixture);
      assert.equal(published.post_pr.remediation.revalidation.jobs.canonical.verdict, "red");
      assert.equal(published.post_pr.remediation.revalidation.canonical_verdict, "red");
      assert.equal(JSON.parse(readFileSync(join(fixture.runDir, published.post_pr.remediation.revalidation.canonical_evidence_ref), "utf8")).verdict, "red");
      await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:06:00.000Z" });
      assert.equal(readRun(fixture).post_pr.remediation.reason_code, "local-red");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("legacy top-level-only canonical fail recovers to local-red without emitting fail state", async () => {
    const fixture = createPanelRecoveryFixture("canonical-fail-legacy", "validator");
    try {
      const canonicalPath = join(fixture.runDir, "evidence", "post-pr-canonical.attempt-1.json");
      const legacy = JSON.parse(readFileSync(canonicalPath, "utf8"));
      legacy.verdict = "fail";
      writeJson(canonicalPath, legacy);
      const legacyBytes = readFileSync(canonicalPath, "utf8");
      updateRunFile(fixture, (run) => {
        const revalidation = run.post_pr.remediation.revalidation;
        delete revalidation.jobs;
        Object.assign(revalidation, {
          canonical_evidence_hash: fileHash(canonicalPath), canonical_verdict: "fail",
          validator_review_ref: null, validator_review_hash: null, validator_verdict: null,
          security_review_ref: null, security_review_hash: null, security_verdict: null,
        });
      });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      const recovered = readRun(fixture);
      assert.equal(recovered.post_pr.phase, "remediation-planned");
      assert.equal(recovered.post_pr.remediation.reason_code, "local-red");
      assert.equal(recovered.post_pr.remediation.revalidation.canonical_verdict, null);
      assert.deepEqual(recovered.post_pr.remediation.revalidation.jobs, {});
      assert.equal(readFileSync(canonicalPath, "utf8"), legacyBytes, "legacy evidence bytes remain unchanged");
      const localEvidence = JSON.parse(readFileSync(join(fixture.runDir, recovered.post_pr.remediation.failure_evidence_ref), "utf8"));
      assert.equal(localEvidence.verdict, "red");
      assert.equal(JSON.stringify(recovered).includes('"verdict":"fail"'), false);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("P18 canonical bound replay preserves one successor transition", async () => {
    const fixture = createPanelRecoveryFixture("crash-p18", "validator"); let dispatches = 0;
    try {
      await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => { dispatches += 1; return { started: true, exit_code: 0, signal: null, result: { verdict: "GO", affected_paths: ["src/api.js"] } }; } });
      assert.equal(dispatches, 1); assert.equal(readRun(fixture).post_pr.remediation.revalidation.jobs.validator.status, "bound"); assert.ok(readRun(fixture).post_pr.remediation.revalidation.jobs.security);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("P20 validator report-only publication crash is metadata-unsafe", async () => {
    const fixture = createPanelRecoveryFixture("crash-p20", "validator");
    try {
      updateRunFile(fixture, (run) => { run.post_pr.remediation.revalidation.jobs.validator = panelJob("validator", "running"); });
      writeFileSync(join(fixture.runDir, "artifacts", "post-pr-validator.attempt-1.md"), "partial\n");
      await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" }), /terminal-run|resume ineligible/u);
      assert.equal(readRun(fixture).terminal_result.reason, "post-pr-metadata-unsafe");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  for (const [name, activity] of [["P21 validator complete publication binds and plans security once", "validator"], ["P23 security published-unbound review binds and evaluates once", "security"]]) it(name, async () => {
    const fixture = createPanelRecoveryFixture(`crash-${name.slice(0, 3).toLowerCase()}`, activity);
    try {
      updateRunFile(fixture, (run) => { run.post_pr.remediation.revalidation.jobs[activity] = panelJob(activity, "running"); });
      writeRecoveryPanelArtifact(fixture, activity);
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run"); assert.equal(readRun(fixture).post_pr.remediation.revalidation.jobs[activity].status, "bound");
      if (activity === "validator") assert.ok(readRun(fixture).post_pr.remediation.revalidation.jobs.security);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("P24 missing-panel binding and replay permutation matrix", async () => {
    const fixture = createPanelRecoveryFixture("crash-p24", "security");
    try {
      updateRunFile(fixture, (run) => { run.post_pr.remediation.revalidation.jobs.security = panelJob("security", "running"); }); writeRecoveryPanelArtifact(fixture, "security");
      await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:06:00.000Z" });
      assert.equal(result.status, "dry-run"); assert.equal(readRun(fixture).post_pr.phase, "validated");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("builds a hash-bound new-PR continuation without mutating the parent and rejects tampering", async () => {
    const fixture = createRevalidationFixture("post-pr-continuation");
    try {
      updateRunFile(fixture, (run) => { run.max_retries = 1; });
      writeJson(join(fixture.runDir, "evidence", "post-pr-local-failure.attempt-2.json"), { run_id: fixture.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: fixture.candidate, failure_fingerprint: `sha256:${"8".repeat(64)}`, affected_paths: ["src/api.js"] });
      await postPrRemediation(fixture.runId, 1, "failed", { cwd: fixture.repo, failureEvidenceRef: "evidence/post-pr-local-failure.attempt-2.json", now: "2026-07-12T12:10:00.000Z" });
      const parentBefore = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const parent = readRun(fixture);
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: parent.post_pr.continuation_review.ref, runId: "post-pr-continuation-child", newPr: true, dryRun: true, now: "2026-07-12T12:11:00.000Z" });
      assert.doesNotThrow(() => decodeFeatureCommandPayload(encodeFeatureCommandPayload(result.payload)));
      assert.equal(result.payload.continuation.post_pr.disposition, "leave-unchanged");
      assert.equal(result.payload.continuation.post_pr.evidence_ref, "evidence/post-pr-local-failure.attempt-2.json");
      assert.equal(result.payload.continuation.post_pr.head_sha, fixture.candidate);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), parentBefore);
      writeFileSync(join(fixture.runDir, parent.post_pr.continuation_review.ref), "{}\n");
      assert.throws(() => continueFactory(fixture.runId, { cwd: fixture.repo, review: parent.post_pr.continuation_review.ref, runId: "post-pr-continuation-tampered", newPr: true, dryRun: true }), /hash mismatch|invalid evidence\/review bindings/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), parentBefore);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });
});

async function observeApiRed(fixture) {
  return postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
    if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "api / unit", status: "COMPLETED", conclusion: "FAILURE" }] }) };
  } });
}

function createFixture(runId, { nextPollAt = "2026-07-12T12:00:00.000Z", reviewer = null, requested = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "post-pr-workflow-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeFileSync(join(runDir, "plan", "slices.json"), `${JSON.stringify({ slices: [{ id: "api", stack: "backend", paths: ["src/api.js"], depends_on: [], acceptance: ["API works"], test_plan: ["node --test"] }] })}\n`);
  const review = reviewer ? { required: true, reviewer_login: reviewer, source: "driver" } : { required: false, reviewer_login: null, source: "none" };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schema_version: 1, run_id: runId, status: "running", max_retries: 3, github_account: "octocat", branch: "feature", worktree: repo, base_ref: "main", base_commit: SHA, pr_url: "https://github.com/acme/widgets/pull/7", pr_mode: "ready", gates: {},
    slices: [{ id: "api", stack: "backend", depends_on: [], declared_paths: ["src/api.js"], effective_paths: ["src/api.js"], status: "pending", attempts: 0 }],
    post_pr: { schema_version: 1, policy: { enabled: true, wait_ms: 3600000, initial_poll_ms: 30000, max_poll_ms: 120000, check_start_grace_ms: 300000, max_transient_errors: 12, review }, phase: "observing", attempt: 0,
      observation: { epoch: 1, expected_head_sha: SHA, started_at: "2026-07-12T12:00:00.000Z", deadline_at: "2026-07-12T13:00:00.000Z", next_poll_at: nextPollAt, poll_count: 0, unchanged_count: 0, current_interval_ms: 30000, consecutive_transient_errors: 0, last_observed_at: null, last_fingerprint: null, last_check_verdict: "not_started", last_review_verdict: reviewer ? "pending" : "not_required", last_verdict: "pending", last_error: null, review_request: reviewer ? { status: requested ? "requested" : "pending", attempts: requested ? 1 : 0, requested_at: requested ? "2026-07-12T11:59:00.000Z" : null } : null, snapshot: null },
      remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null,
      pr_operation: { operation_id: computePrOperationId({ base_commit: SHA, branch: "feature", created_at: "2026-07-12T12:00:00.000Z", repository: "acme/widgets", run_id: runId }), repository: "acme/widgets", created_at: "2026-07-12T12:00:00.000Z", head_ref: "feature", head_sha: SHA, base_ref: "main", base_sha: SHA, draft: false, pr_url: "https://github.com/acme/widgets/pull/7", pr_number: 7, pr_node_id: "PR_workflow" } },
  }, null, 2)}\n`);
  return { repo, runDir, runId };
}

function operationAuthorityOptions(fixture) {
  return {
    repoRoot: fixture.repo,
    gitFn(_cwd, args) {
      if (args.join(" ") === "config --get remote.origin.url") return { ok: true, status: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
      if (args[0] === "ls-remote") {
        const ref = args[3].slice("refs/heads/".length);
        return { ok: true, status: 0, stdout: `${SHA}\trefs/heads/${ref}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") return { ok: true, status: 0, stdout: `${SHA}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { ok: true, status: 0, stdout: "feature\n", stderr: "" };
      if (args[0] === "status") return { ok: true, status: 0, stdout: "", stderr: "" };
      if (args[0] === "merge-base") return { ok: true, status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected git authority command: ${args.join(" ")}`);
    },
    observePrOperation(identity) {
      return { disposition: "open", reason: null, pull_request: { pr_url: "https://github.com/acme/widgets/pull/7", pr_number: 7, pr_node_id: "PR_workflow", repository: "acme/widgets", draft: false, body: "", state: "open", merged_at: null, head_ref: "feature", head_sha: identity.head_sha, head_repository: "acme/widgets", base_ref: "main", base_sha: SHA, base_repository: "acme/widgets" } };
    },
  };
}

// The base/candidate git history is identical for every revalidation fixture, so
// it is built once and copied per fixture; nine git subprocesses become one
// recursive copy. Tests receive only copies — the template repo is never mutated.
let revalidationGitTemplate = null;

function revalidationTemplate() {
  if (!revalidationGitTemplate) {
    const repo = mkdtempSync(join(tmpdir(), "post-pr-revalidation-template-"));
    runGit(repo, ["init", "-b", "main"]); runGit(repo, ["config", "user.email", "test@example.com"]); runGit(repo, ["config", "user.name", "Test"]);
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src", "api.js"), "export const value = 1;\n"); writeFileSync(join(repo, ".gitignore"), ".opencode/\n"); runGit(repo, ["add", "src/api.js", ".gitignore"]); runGit(repo, ["commit", "-m", "base"]);
    const baseline = gitOutput(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "src", "api.js"), "export const value = 2;\n"); runGit(repo, ["add", "src/api.js"]); runGit(repo, ["commit", "-m", "candidate"]);
    const candidate = gitOutput(repo, ["rev-parse", "HEAD"]);
    revalidationGitTemplate = { repo, baseline, candidate };
  }
  return revalidationGitTemplate;
}

after(() => { if (revalidationGitTemplate) rmSync(revalidationGitTemplate.repo, { recursive: true, force: true }); });

function createRevalidationFixture(runId) {
  const template = revalidationTemplate();
  const repo = mkdtempSync(join(tmpdir(), "post-pr-revalidation-"));
  cpSync(template.repo, repo, { recursive: true });
  const { baseline, candidate } = template;
  const runDir = join(repo, ".opencode", "factory", runId); mkdirSync(join(runDir, "plan"), { recursive: true }); mkdirSync(join(runDir, "evidence")); mkdirSync(join(runDir, "reviews")); mkdirSync(join(runDir, "artifacts"));
  writeFileSync(join(runDir, "plan", "slices.json"), `${JSON.stringify({ slices: [{ id: "api", stack: "backend", paths: ["src/api.js"], depends_on: [], acceptance: ["API works"], test_plan: ["node --test"] }] })}\n`);
  writeFileSync(join(runDir, "evidence", "post-pr-ci.attempt-1.json"), "{}\n");
  const owner = { kind: "slice", slice_id: "api", stack: "backend", path_b64url: null, method: "check-slice-id" };
  const failureEvidenceRef = "evidence/post-pr-ci.attempt-1.json"; const failureHash = fileHash(join(runDir, failureEvidenceRef));
  const dispatch = { schema_version: 1, kind: "post-pr-remediation-dispatch", run_id: runId, attempt: 1, dispatch_id: "dispatch-1", role: "backend-builder", subject: "api", lane: "slice", owner, failed_head_sha: baseline, baseline_head_sha: baseline, failure_evidence: { ref: failureEvidenceRef, hash: failureHash } };
  const changes = [{ status: "modified", path: "src/api.js", previous_path: null }];
  const remediationEvidence = { kind: "post-pr-remediation", run_id: runId, attempt: 1, dispatch_id: "dispatch-1", dispatch_hash: hashValue(dispatch), baseline_head_sha: baseline, candidate_head_sha: candidate, route: "backend-builder", lane: "slice", owner, failure_evidence_ref: failureEvidenceRef, failure_evidence_hash: failureHash, review_ready: true, commands: [{ program: "node", args: ["--test"], exit_code: 0, head_sha: candidate }], commit: candidate, changed_paths: ["src/api.js"], changes, diff_hash: hashValue(changes) };
  writeJson(join(runDir, "evidence", "post-pr-remediation.attempt-1.json"), remediationEvidence);
  const remediationHash = fileHash(join(runDir, "evidence", "post-pr-remediation.attempt-1.json"));
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: runId, status: "running", max_retries: 3, github_account: "octocat", branch: "main", worktree: repo, pr_url: "https://github.com/acme/widgets/pull/7", pr_mode: "ready", gates: {},
    slices: [{ id: "api", stack: "backend", depends_on: [], declared_paths: ["src/api.js"], effective_paths: ["src/api.js"], status: "pending", attempts: 0 }],
    post_pr: { schema_version: 1, policy: { enabled: true, wait_ms: 3600000, initial_poll_ms: 30000, max_poll_ms: 120000, check_start_grace_ms: 300000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } }, phase: "revalidating", attempt: 1,
      observation: { epoch: 1, expected_head_sha: baseline, started_at: "2026-07-12T12:00:00.000Z", deadline_at: "2026-07-12T13:00:00.000Z", next_poll_at: "2026-07-12T12:01:00.000Z", poll_count: 1, unchanged_count: 0, current_interval_ms: 30000, consecutive_transient_errors: 0, last_observed_at: "2026-07-12T12:00:30.000Z", last_fingerprint: `sha256:${"1".repeat(64)}`, last_check_verdict: "red", last_review_verdict: "not_required", last_verdict: "red", last_error: null, review_request: null, snapshot: null },
      remediation: { schema_version: 1, attempt: 1, reason_code: "check-red", failure_fingerprint: `sha256:${"2".repeat(64)}`, failed_head_sha: baseline, failure_evidence_ref: failureEvidenceRef, failure_evidence_hash: failureHash, owner, route: "backend-builder", lane: "slice", stage: "revalidating", baseline_head_sha: baseline, dispatch: { id: "dispatch-1", status: "returned", role: "backend-builder", subject: "api", started_at: "2026-07-12T12:01:00.000Z", returned_at: "2026-07-12T12:02:00.000Z" }, changes: { paths: ["src/api.js"], tree_hash: `sha256:${"3".repeat(64)}` }, candidate_head_sha: candidate, remediation_evidence_ref: "evidence/post-pr-remediation.attempt-1.json", remediation_evidence_hash: remediationHash, revalidation: { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null, validator_review_ref: null, validator_review_hash: null, validator_verdict: null, security_review_ref: null, security_review_hash: null, security_verdict: null }, push: { status: "not-ready", remote_before_sha: null, local_head_sha: null, remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null } },
      evidence_refs: [{ ref: "evidence/post-pr-ci.attempt-1.json", hash: failureHash }], continuation_review: null, terminal_fact: null },
  });
  return { repo, runDir, runId, baseline, candidate };
}

function writePassingRevalidationArtifacts(fixture, { validatorHead = fixture.candidate } = {}) {
  writeJson(join(fixture.runDir, "evidence", "post-pr-canonical.attempt-1.json"), { kind: "post-pr-canonical", run_id: fixture.runId, attempt: 1, head_sha: fixture.candidate, command: { program: "npm", args: ["run", "check"] }, verdict: "pass" });
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.attempt-1.md"), "GO\n");
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.attempt-1.json"), { kind: "implementation-validator", run_id: fixture.runId, attempt: 1, head_sha: validatorHead, fresh: true, verdict: "GO", report: "artifacts/validation-report.attempt-1.md", affected_paths: ["src/api.js"] });
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.attempt-1.json"), { kind: "security-reviewer", run_id: fixture.runId, attempt: 1, head_sha: fixture.candidate, fresh: true, verdict: "PASS", affected_paths: ["src/api.js"] });
  return { testEvidenceRef: "evidence/post-pr-canonical.attempt-1.json", validatorReportRef: "artifacts/validation-report.attempt-1.md", validatorReviewRef: "reviews/implementation-validator.attempt-1.json", securityReviewRef: "reviews/security-reviewer.attempt-1.json" };
}

function createPanelRecoveryFixture(runId, activity) {
  const fixture = createRevalidationFixture(runId);
  const canonicalRef = "evidence/post-pr-canonical.attempt-1.json";
  writeJson(join(fixture.runDir, canonicalRef), { kind: "post-pr-canonical", run_id: fixture.runId, attempt: 1, head_sha: fixture.candidate, command: { program: "npm", args: ["run", "check"] }, verdict: "pass" });
  updateRunFile(fixture, (run) => {
    const revalidation = run.post_pr.remediation.revalidation;
    Object.assign(revalidation, { canonical_evidence_ref: canonicalRef, canonical_evidence_hash: fileHash(join(fixture.runDir, canonicalRef)), canonical_verdict: "pass", jobs: {
      canonical: panelJob("canonical", "bound", canonicalRef, fileHash(join(fixture.runDir, canonicalRef)), "pass"),
    } });
    if (activity === "security") {
      const reportRef = "artifacts/post-pr-validator.attempt-1.md"; const reviewRef = "reviews/post-pr-validator.attempt-1.json";
      writeFileSync(join(fixture.runDir, reportRef), "# Post-PR validator report\n\n```json\n{}\n```\n");
      writeJson(join(fixture.runDir, reviewRef), { schema_version: 1, kind: "post-pr-validator-review", activity: "validator", run_id: fixture.runId, attempt: 1, dispatch_id: "validator-1", head_sha: fixture.candidate, fresh: true, verdict: "GO", affected_paths: ["src/api.js"], report: { ref: reportRef, hash: fileHash(join(fixture.runDir, reportRef)) }, started_at: "2026-07-12T12:03:00.000Z", completed_at: "2026-07-12T12:04:00.000Z" });
      Object.assign(revalidation, { validator_review_ref: reviewRef, validator_review_hash: fileHash(join(fixture.runDir, reviewRef)), validator_verdict: "GO" });
      revalidation.jobs.validator = panelJob("validator", "bound", reviewRef, revalidation.validator_review_hash, "GO");
    }
    revalidation.jobs[activity] = panelJob(activity, "planned");
  });
  return fixture;
}

function panelJob(activity, status, ref = null, hash = null, verdict = null) {
  return { dispatch_id: `${activity}-1`, status, action_token: status === "running" ? `token-${activity}` : null, steering_generation: status === "running" ? 0 : null, started_at: ["running", "bound"].includes(status) ? "2026-07-12T12:03:00.000Z" : null,
    returned_at: status === "bound" ? "2026-07-12T12:04:00.000Z" : null, result_ref: ref, result_hash: hash, verdict, transient_error_count: 0, next_retry_at: null, last_error: null };
}

function fixedPanelRefs(activity) { return activity === "validator" ? ["artifacts/post-pr-validator.attempt-1.md", "reviews/post-pr-validator.attempt-1.json"] : ["reviews/post-pr-security.attempt-1.json"]; }

async function assertPassingPanelWorkflow(id, paths) {
  const fixture = createPanelRecoveryFixture(id, "validator"); const dispatches = [];
  try {
    configurePanelPlan(fixture);
    await dispatchWorkflowPanel(fixture, "validator", { verdict: "GO", affected_paths: paths }, dispatches);
    let run = readRun(fixture); assert.deepEqual(dispatches, ["validator"]); assert.equal(run.post_pr.remediation.revalidation.jobs.validator.status, "bound"); assert.equal(run.post_pr.remediation.revalidation.jobs.security.status, "planned");
    assert.ok(fixedPanelRefs("validator").every((ref) => existsSync(join(fixture.runDir, ref)))); assert.equal(existsSync(join(fixture.runDir, fixedPanelRefs("security")[0])), false);
    await dispatchWorkflowPanel(fixture, "security", { verdict: "PASS", affected_paths: paths }, dispatches);
    run = readRun(fixture); assert.deepEqual(dispatches, ["validator", "security"]); assert.equal(run.post_pr.remediation.revalidation.jobs.security.status, "bound"); assert.ok(existsSync(join(fixture.runDir, fixedPanelRefs("security")[0])));
    await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:07:00.000Z" });
    run = readRun(fixture); assert.equal(run.post_pr.phase, "validated"); assert.equal(run.post_pr.attempt, 1); assert.equal(localReservationCount(run), 0);
    const stable = fullWorkflowCounters(fixture); await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:08:00.000Z" }); assert.deepEqual(fullWorkflowCounters(fixture), stable); assert.deepEqual(dispatches, ["validator", "security"]);
  } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
}

async function assertRedPanelWorkflow(id, { validatorVerdict, securityVerdict, paths, route, ownerKind, panel }) {
  const fixture = createPanelRecoveryFixture(id, "validator"); const dispatches = [];
  try {
    configurePanelPlan(fixture);
    await dispatchWorkflowPanel(fixture, "validator", { verdict: validatorVerdict, affected_paths: paths }, dispatches);
    await dispatchWorkflowPanel(fixture, "security", { verdict: securityVerdict, affected_paths: paths }, dispatches);
    assert.deepEqual(dispatches, ["validator", "security"]); assert.equal(readRun(fixture).post_pr.remediation.revalidation.jobs.security.status, "bound");
    await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:07:00.000Z" });
    const run = readRun(fixture); assert.equal(run.post_pr.phase, "remediation-planned"); assert.equal(run.post_pr.attempt, 2); assert.equal(run.post_pr.remediation.route, route); assert.equal(run.post_pr.remediation.owner.kind, ownerKind); assert.equal(localReservationCount(run), 1);
    const evidence = JSON.parse(readFileSync(join(fixture.runDir, "evidence", "post-pr-local-failure.attempt-2.json"), "utf8")); assert.equal(evidence.panel, panel || (validatorVerdict === "NO-GO" ? "validator" : "security"));
    const stable = fullWorkflowCounters(fixture); await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:08:00.000Z" }); assert.deepEqual(fullWorkflowCounters(fixture), stable); assert.deepEqual(dispatches, ["validator", "security"]);
  } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
}

async function assertAttributionWorkflow(id, { validatorPaths = ["src/api.js"], securityPaths = ["src/api.js"], securityVerdict = "PASS", omitSecurityPaths = false, category, panel, hash }) {
  const fixture = createPanelRecoveryFixture(id, "security"); let dispatches = 0; let terminalChecks = 0;
  try {
    configurePanelPlan(fixture); setBoundValidator(fixture, { verdict: "GO", paths: validatorPaths }); const beforeReservations = localReservationCount(readRun(fixture));
    const result = omitSecurityPaths ? { verdict: securityVerdict } : { verdict: securityVerdict, affected_paths: securityPaths };
    await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async (envelope) => {
      dispatches += 1; assert.equal(envelope.activity, "security"); assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:05:00.000Z" }).fresh, true); return { started: true, exit_code: 0, signal: null, result };
    }, beforePostPrTerminal: () => { terminalChecks += 1; assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo }).pid, null); } }), /terminal-run|resume ineligible/u);
    const run = readRun(fixture); assert.equal(run.terminal_result.reason, "post-pr-panel-attribution-unsafe"); assert.deepEqual(run.post_pr.terminal_fact, { schema_version: 1, kind: "panel-attribution-unsafe", observed_at: "2026-07-12T12:05:00.000Z", attempt: 1, candidate_head_sha: fixture.candidate, panel, category, affected_paths_hash: hash });
    assert.ok(existsSync(join(fixture.runDir, fixedPanelRefs("security")[0]))); assert.equal(run.post_pr.remediation.revalidation.jobs.security.status, "running"); assert.equal(localReservationCount(run), beforeReservations); assert.equal(dispatches, 1); assert.equal(terminalChecks, 1);
    const stable = fullWorkflowCounters(fixture); await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, executePostPrRecoveryJob: async () => { dispatches += 1; } }), /terminal-run|resume ineligible/u); assert.deepEqual(fullWorkflowCounters(fixture), stable); assert.equal(dispatches, 1);
  } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
}

async function assertStalePanelWorkflow(id) {
  const fixture = createPanelRecoveryFixture(id, "security"); let dispatches = 0;
  try {
    configurePanelPlan(fixture); updateRunFile(fixture, (run) => { run.post_pr.remediation.revalidation.jobs.security = panelJob("security", "running"); });
    writeRecoveryPanelArtifact(fixture, "security"); const ref = fixedPanelRefs("security")[0]; const artifact = JSON.parse(readFileSync(join(fixture.runDir, ref), "utf8")); artifact.head_sha = fixture.baseline; writeJson(join(fixture.runDir, ref), artifact);
    const before = fullWorkflowCounters(fixture); await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async () => { dispatches += 1; } }), /terminal-run|resume ineligible/u);
    const run = readRun(fixture); assert.equal(run.terminal_result.reason, "post-pr-metadata-unsafe"); assert.equal(run.post_pr.remediation.revalidation.jobs.security.status, "running"); assert.equal(localReservationCount(run), 0); assert.equal(dispatches, 0);
    const stable = fullWorkflowCounters(fixture); assert.equal(stable.publications, before.publications); await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true }), /terminal-run|resume ineligible/u); assert.deepEqual(fullWorkflowCounters(fixture), stable);
  } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
}

async function dispatchWorkflowPanel(fixture, activity, result, dispatches) {
  const response = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: activity === "validator" ? "2026-07-12T12:05:00.000Z" : "2026-07-12T12:06:00.000Z", executePostPrRecoveryJob: async (envelope) => {
    dispatches.push(envelope.activity); assert.equal(envelope.activity, activity); assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo, now: activity === "validator" ? "2026-07-12T12:05:00.000Z" : "2026-07-12T12:06:00.000Z" }).fresh, true); return { started: true, exit_code: 0, signal: null, result };
  } });
  assert.equal(response.status, "dry-run"); assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo }).pid, null);
}

function configurePanelPlan(fixture) {
  writeJson(join(fixture.runDir, "plan", "slices.json"), { slices: [
    { id: "api", stack: "backend", paths: ["src/api.js"], depends_on: [], acceptance: ["API works"], test_plan: ["node --test"] },
    { id: "ui", stack: "frontend", paths: ["src/ui.js"], depends_on: [], acceptance: ["UI works"], test_plan: ["node --test"] },
  ] });
  updateRunFile(fixture, (run) => {
    run.slices = [
      { id: "api", stack: "backend", depends_on: [], declared_paths: ["src/api.js"], effective_paths: ["src/api.js"], status: "pending", attempts: 0 },
      { id: "ui", stack: "frontend", depends_on: [], declared_paths: ["src/ui.js"], effective_paths: ["src/ui.js"], status: "pending", attempts: 0 },
    ];
  });
}

function installRatifiedApiOwnership(fixture, ratifiedPath, reviewedCommit) {
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  const evidenceRef = "evidence/api-slice.json";
  const reviewRef = "reviews/api-slice.json";
  writeJson(join(fixture.runDir, evidenceRef), { subject: "api", attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  writeJson(join(fixture.runDir, reviewRef), {
    subject: "api", attempt: 1, verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0, required_fixes: [], reviewed_commit: reviewedCommit,
    ownership_ratification: { schema_version: 1, paths: [ratifiedPath] }, remediation_context: { schema_version: 2, fixes: [] },
  });
  const evidenceHash = fileHash(join(fixture.runDir, evidenceRef));
  const reviewHash = fileHash(join(fixture.runDir, reviewRef));
  const attemptReview = { attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit,
    diff_base_commit: reviewedCommit, ratified_paths: [ratifiedPath], verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0 };
  updateRunFile(fixture, (run) => {
    const api = run.slices.find((slice) => slice.id === "api");
    Object.assign(api, { declared_paths: ["src/api.js"], effective_paths: ["src/api.js", ratifiedPath], status: "merged", attempts: 1, attempt_reviews: [attemptReview],
      evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, merge_commit: reviewedCommit });
  });
}

async function closeRecoverablePostPrDispatch(fixture, { ratifiedPath, candidatePath }) {
  installRatifiedApiOwnership(fixture, ratifiedPath, fixture.baseline);
  writeJson(join(fixture.runDir, "plan", "slices.json"), { slices: [
    { id: "api", stack: "backend", paths: ["src/stale-api.js"], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
    { id: "ui", stack: "frontend", paths: [ratifiedPath], depends_on: [], acceptance: ["stale"], test_plan: ["node --test"] },
  ] });
  updateRunFile(fixture, (run) => {
    run.post_pr.phase = "remediation-running";
    Object.assign(run.post_pr.remediation, { stage: "running", candidate_head_sha: null, remediation_evidence_ref: null, remediation_evidence_hash: null, changes: { paths: [], entries: [], tree_hash: null } });
    Object.assign(run.post_pr.remediation.dispatch, { status: "running", returned_at: null });
  });
  runGit(fixture.repo, ["reset", "--hard", fixture.baseline]);
  const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId, route: "post-pr-remediation", agent: "backend-builder",
  }, { claimDispatch: true, completionToken: `recover-${fixture.runId}` });
  if (candidatePath === ratifiedPath) {
    mkdirSync(join(fixture.repo, "docs"), { recursive: true });
    writeFileSync(join(fixture.repo, ratifiedPath), "ratified descendant recovery\n");
    runGit(fixture.repo, ["add", ratifiedPath]);
    runGit(fixture.repo, ["commit", "-m", "ratified recovery"]);
  } else {
    runGit(fixture.repo, ["reset", "--hard", fixture.candidate]);
  }
  fixture.candidate = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  await completeSpecialBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId, route: "post-pr-remediation", agent: "backend-builder",
    claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
    completion_token: `recover-${fixture.runId}`,
  });
}

function createRunStatePanelFixture(runId, { overlap = false, renameSource = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "panel-special-"));
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, ".gitignore"), ".opencode/\n");
  writeFileSync(join(repo, "README.md"), "panel fixture\n");
  if (renameSource) {
    mkdirSync(join(repo, "src", "ui"), { recursive: true });
    writeFileSync(join(repo, "src", "ui", "source.js"), "rename source\n");
  }
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "panel fixture"]);
  const head = gitOutput(repo, ["rev-parse", "HEAD"]);
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const directory of ["plan", "evidence", "reviews", "artifacts"]) mkdirSync(join(runDir, directory), { recursive: true });
  const ratifiedPath = "docs/panel-ratified.md";
  const plannedSlices = [
    { id: "api", stack: "backend", paths: ["src/api/**"], depends_on: [], acceptance: ["api"], test_plan: ["node --test"] },
    { id: "ui", stack: "frontend", paths: overlap ? [ratifiedPath] : ["src/ui/**"], depends_on: [], acceptance: ["ui"], test_plan: ["node --test"] },
  ];
  writeJson(join(runDir, "plan", "slices.json"), { slices: plannedSlices });
  const slices = plannedSlices.map((planned) => {
    const ratifiedPaths = planned.id === "api" ? [ratifiedPath] : [];
    const evidenceRef = `evidence/${planned.id}.json`;
    const reviewRef = `reviews/${planned.id}.json`;
    writeJson(join(runDir, evidenceRef), { subject: planned.id, attempt: 1, status: "pass", review_ready: true, head_sha: head });
    writeJson(join(runDir, reviewRef), { subject: planned.id, attempt: 1, reviewed_commit: head, verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0, required_fixes: [], ownership_ratification: { schema_version: 1, paths: ratifiedPaths }, remediation_context: { schema_version: 2, fixes: [] } });
    const evidenceHash = fileHash(join(runDir, evidenceRef));
    const reviewHash = fileHash(join(runDir, reviewRef));
    const effectivePaths = [...planned.paths, ...ratifiedPaths];
    return { id: planned.id, stack: planned.stack, depends_on: [], declared_paths: [...planned.paths], effective_paths: effectivePaths, status: "merged", attempts: 1,
      attempt_reviews: [{ attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: head, diff_base_commit: head, ratified_paths: ratifiedPaths, verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0 }],
      evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: head, merge_commit: head };
  });
  const reportRef = "artifacts/validation-report.md";
  const validatorRef = "reviews/implementation-validator.json";
  const securityRef = "reviews/security-reviewer.json";
  writeFileSync(join(runDir, reportRef), "NO-GO\n");
  writeJson(join(runDir, validatorRef), { subject: "main", attempt: 1, verdict: "NO-GO", reviewed_head_sha: head, required_fixes: ["repair"] });
  writeJson(join(runDir, securityRef), { subject: "main", attempt: 1, verdict: "BLOCK", reviewed_head_sha: head, required_fixes: ["harden"] });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: runId, status: "running", branch: "main", worktree: repo, gates: {}, steps: [], slices,
    validator: { verdict: "NO-GO", report: reportRef, review_ref: validatorRef, report_hash: fileHash(join(runDir, reportRef)), review_hash: fileHash(join(runDir, validatorRef)), reviewed_head_sha: head },
    security_review: { verdict: "BLOCK", review_ref: securityRef, review_hash: fileHash(join(runDir, securityRef)), reviewed_head_sha: head },
  });
  return { repo, runDir, runId, ratifiedPath, head };
}

function writeRepoFileAndCommit(repo, relativePath, contents, message) {
  mkdirSync(join(repo, relativePath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(repo, relativePath), contents);
  runGit(repo, ["add", relativePath]);
  runGit(repo, ["commit", "-m", message]);
  return gitOutput(repo, ["rev-parse", "HEAD"]);
}

function setBoundValidator(fixture, { verdict, paths }) {
  const ref = fixedPanelRefs("validator")[1]; const review = JSON.parse(readFileSync(join(fixture.runDir, ref), "utf8")); review.verdict = verdict; review.affected_paths = paths; writeJson(join(fixture.runDir, ref), review); const hash = fileHash(join(fixture.runDir, ref));
  updateRunFile(fixture, (run) => { const revalidation = run.post_pr.remediation.revalidation; revalidation.validator_review_hash = hash; revalidation.validator_verdict = verdict; Object.assign(revalidation.jobs.validator, { result_hash: hash, verdict }); });
}

function localReservationCount(run) { return run.post_pr.evidence_refs.filter((binding) => /post-pr-local-failure/u.test(binding.ref)).length; }
function fullWorkflowCounters(fixture) { const run = readRun(fixture); return { publications: [...fixedPanelRefs("validator"), ...fixedPanelRefs("security")].filter((ref) => existsSync(join(fixture.runDir, ref))).length,
  bound: ["canonical", "validator", "security"].filter((activity) => run.post_pr.remediation.revalidation.jobs?.[activity]?.status === "bound").length,
  attempt: run.post_pr.attempt, reservations: localReservationCount(run), phase: run.post_pr.phase, evidence: run.post_pr.evidence_refs.length }; }

async function assertAffectedWorkflowTerminal(activity, label, affected, { omit = false, category, hash }) {
  const fixture = createPanelRecoveryFixture(`affected-${activity}-${label}`, activity); let dispatches = 0; let terminalChecks = 0;
  try {
    configurePanelPlan(fixture); const before = fullWorkflowCounters(fixture); const verdict = activity === "validator" ? "GO" : "PASS"; const result = omit ? { verdict } : { verdict, affected_paths: affected };
    await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z", executePostPrRecoveryJob: async (envelope) => {
      dispatches += 1; assert.equal(envelope.activity, activity); assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:05:00.000Z" }).fresh, true); return { started: true, exit_code: 0, signal: null, result };
    }, beforePostPrTerminal: () => { terminalChecks += 1; assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo }).pid, null); } }), /terminal-run|resume ineligible/u, `${activity}:${label}`);
    const run = readRun(fixture); assert.equal(run.terminal_result.reason, "post-pr-panel-attribution-unsafe", `${activity}:${label}`); assert.deepEqual(run.post_pr.terminal_fact, { schema_version: 1, kind: "panel-attribution-unsafe", observed_at: "2026-07-12T12:05:00.000Z", attempt: 1, candidate_head_sha: fixture.candidate, panel: activity, category, affected_paths_hash: hash }, `${activity}:${label}`);
    assert.ok(fixedPanelRefs(activity).every((ref) => existsSync(join(fixture.runDir, ref))), `${activity}:${label}:publication`); const artifact = JSON.parse(readFileSync(join(fixture.runDir, fixedPanelRefs(activity).at(-1)), "utf8")); assert.equal(Object.hasOwn(artifact, "affected_paths"), category !== "missing-paths", `${activity}:${label}:affected publication`);
    assert.equal(run.post_pr.remediation.revalidation.jobs[activity].status, "running"); assert.equal(localReservationCount(run), 0); if (activity === "validator") assert.equal(run.post_pr.remediation.revalidation.jobs.security, undefined);
    assert.equal(dispatches, 1); assert.equal(terminalChecks, 1); const after = fullWorkflowCounters(fixture); assert.equal(after.bound, before.bound); assert.equal(after.reservations, before.reservations);
    await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, executePostPrRecoveryJob: async () => { dispatches += 1; } }), /terminal-run|resume ineligible/u); assert.deepEqual(fullWorkflowCounters(fixture), after); assert.equal(dispatches, 1);
  } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
}

async function assertAffectedWorkflowSuccess(activity, label, affected) {
  const fixture = createPanelRecoveryFixture(`affected-success-${activity}-${label}`, activity); const dispatches = [];
  try {
    configurePanelPlan(fixture); const verdict = activity === "validator" ? "GO" : "PASS";
    await dispatchWorkflowPanel(fixture, activity, { verdict, affected_paths: affected }, dispatches); let run = readRun(fixture); assert.equal(run.post_pr.remediation.revalidation.jobs[activity].status, "bound"); assert.equal(localReservationCount(run), 0);
    if (activity === "validator") {
      assert.equal(run.post_pr.remediation.revalidation.jobs.security.status, "planned"); await dispatchWorkflowPanel(fixture, "security", { verdict: "PASS", affected_paths: ["src/api.js"] }, dispatches); assert.deepEqual(dispatches, ["validator", "security"]);
    }
    await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:07:00.000Z" }); run = readRun(fixture); assert.equal(run.post_pr.phase, "validated"); assert.equal(localReservationCount(run), 0);
    const stable = fullWorkflowCounters(fixture); await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:08:00.000Z" }); assert.deepEqual(fullWorkflowCounters(fixture), stable); assert.equal(dispatches.filter((value) => value === activity).length, 1);
  } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
}


function panelSideEffectCounters(fixture, activity) {
  const run = readRun(fixture); const jobs = run.post_pr.remediation.revalidation.jobs;
  return { publications: fixedPanelRefs(activity).filter((ref) => existsSync(join(fixture.runDir, ref))).length,
    bindings: ["canonical", "validator", "security"].filter((name) => jobs[name]?.status === "bound").length,
    successor_planned: activity === "validator" && jobs.security !== undefined,
    attempt: run.post_pr.attempt,
    reservations: run.post_pr.evidence_refs.filter((binding) => /post-pr-local-failure/u.test(binding.ref)).length };
}

function writeRecoveryPanelArtifact(fixture, activity) {
  const run = readRun(fixture); const job = run.post_pr.remediation.revalidation.jobs[activity];
  const base = { schema_version: 1, activity, run_id: fixture.runId, attempt: 1, dispatch_id: job.dispatch_id, head_sha: fixture.candidate, fresh: true,
    verdict: activity === "validator" ? "GO" : "PASS", affected_paths: ["src/api.js"] };
  if (activity === "validator") {
    const reportRef = "artifacts/post-pr-validator.attempt-1.md"; const reportPayload = { schema_version: 1, kind: "post-pr-validator-report", ...Object.fromEntries(Object.entries(base).filter(([key]) => key !== "schema_version")), started_at: job.started_at, completed_at: "2026-07-12T12:04:00.000Z" };
    writeFileSync(join(fixture.runDir, reportRef), `# Post-PR validator report\n\n\`\`\`json\n${JSON.stringify(reportPayload, null, 2)}\n\`\`\`\n`);
    writeJson(join(fixture.runDir, "reviews", "post-pr-validator.attempt-1.json"), { schema_version: 1, kind: "post-pr-validator-review", ...Object.fromEntries(Object.entries(base).filter(([key]) => key !== "schema_version")), report: { ref: reportRef, hash: fileHash(join(fixture.runDir, reportRef)) }, started_at: job.started_at, completed_at: "2026-07-12T12:04:00.000Z" });
  } else writeJson(join(fixture.runDir, "reviews", "post-pr-security.attempt-1.json"), { schema_version: 1, kind: "post-pr-security-review", ...Object.fromEntries(Object.entries(base).filter(([key]) => key !== "schema_version")), started_at: job.started_at, completed_at: "2026-07-12T12:04:00.000Z" });
}

// Rows operate on fully independent fixture repos, so a bounded worker pool is
// safe; the limit caps concurrent run-dir trees and open file descriptors.
async function runRowsConcurrently(rows, task, limit = 8) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (index < rows.length) {
      const row = rows[index];
      index += 1;
      await task(row);
    }
  }));
}

function runGit(repo, args) { const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(proc.status, 0, proc.stderr); }
function gitOutput(repo, args) { const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(proc.status, 0, proc.stderr); return proc.stdout.trim(); }
function fileHash(file) { return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`; }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function updateRunFile(fixture, mutate) { const run = readRun(fixture); mutate(run); writeJson(join(fixture.runDir, "run.json"), run); }

function readRun(fixture) { return JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")); }
