import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "./helpers/git-fixture.js";
import { acceptCurrentWholeStoryTests, approveCurrentPrePrGate, installCurrentWholeStoryAuthority } from "./helpers/current-whole-story-fixture.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const PR_URL = "https://github.com/jasoncarreira/opencode-feature-factory/pull/99";

describe("cli pr-created", () => {
  it("records the universal successor tuple using only run id and fence token", async () => {
    const fixture = await createFixture("cli-pr-created");
    try {
      const result = establishAndRecord(fixture);
      assert.equal(result.proc.status, 0, result.proc.stderr);
      const run = readJson(fixture.runPath);
      assert.equal(run.status, "completed");
      assert.deepEqual(pick(run.terminal_result, ["pr_url", "pr_number", "pr_node_id", "repository", "operation_id", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]), {
        pr_url: PR_URL, pr_number: 99, pr_node_id: "PR_cli_operation", repository: "jasoncarreira/opencode-feature-factory",
        operation_id: result.fence.operation_id, head_ref: "feature-branch", head_sha: fixture.head, base_ref: "main", base_sha: fixture.base, draft: false,
      });
      const observations = readObservations(fixture);
      assert.equal(observations.length, 2);
      for (const observation of observations) {
        assert.equal(observation.args[0], "api");
        assert.equal(observation.gh_config_dir, join(homedir(), ".config", "opencode-feature-factory", "gh", "jasoncarreira"));
        assert.equal(observation.gh_host, "github.com");
        assert.deepEqual(observation.auth_environment, {
          GH_TOKEN: null,
          GITHUB_TOKEN: null,
          GH_ENTERPRISE_TOKEN: null,
          GITHUB_ENTERPRISE_TOKEN: null,
        });
      }
    } finally { cleanup(fixture.repo); }
  });

  it("rejects every removed caller PR metadata flag", () => {
    for (const [flag, value] of [["--pr-url", PR_URL], ["--pr-number", "99"], ["--repository", "jasoncarreira/opencode-feature-factory"], ["--head-sha", "a".repeat(40)], ["--draft", null], ["--no-draft", null]]) {
      const args = ["factory", "pr-created", "run", "--fence-token", "safe-token"];
      args.push(flag); if (value !== null) args.push(value);
      const proc = runCli(process.cwd(), args);
      assert.notEqual(proc.status, 0, flag);
      assert.match(proc.stderr, new RegExp(`does not support ${flag}`), flag);
    }
  });

  it("retains the fence for absent, ambiguous, unknown, and closed-unmerged observations", async () => {
    for (const [disposition, reason] of [["absent", null], ["ambiguous", null], ["unknown", null], ["closed", "pr-operation-closed-unmerged"]]) {
      const fixture = await createFixture(`cli-${disposition}`, disposition);
      try {
        const fence = establish(fixture);
        const proc = record(fixture, fence.token);
        assert.notEqual(proc.status, 0, disposition);
        const run = readJson(fixture.runPath);
        assert.equal(run.steering.pr_fence.token, fence.token);
        assert.equal(run.terminal_result?.reason ?? null, reason);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("denies missing and invalid persisted accounts before spawning the fenced observer", async () => {
    for (const [label, account] of [["missing-account", null], ["invalid-account", "invalid!"]]) {
      const fixture = await createFixture(label);
      try {
        const fence = establish(fixture);
        const run = readJson(fixture.runPath);
        if (account === null) delete run.github_account;
        else run.github_account = account;
        writeJson(fixture.runPath, run);

        const proc = record(fixture, fence.token);
        assert.notEqual(proc.status, 0, label);
        assert.equal(readJson(fixture.runPath).steering.pr_fence.token, fence.token);
        assert.deepEqual(readObservations(fixture), []);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("records a found PR during clear and clears only complete absence", async () => {
    const found = await createFixture("clear-found", "open");
    try {
      const fence = establish(found);
      const proc = runCli(found.repo, ["factory", "pr-fence", found.runId, "--clear", "--fence-token", fence.token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(readJson(found.runPath).status, "completed");
    } finally { cleanup(found.repo); }

    const absent = await createFixture("clear-absent", "absent");
    try {
      const fence = establish(absent);
      const proc = runCli(absent.repo, ["factory", "pr-fence", absent.runId, "--clear", "--fence-token", fence.token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(readJson(absent.runPath).steering.pr_fence, null);
    } finally { cleanup(absent.repo); }
  });

  it("rejects local/worktree/origin movement after fencing without consuming the fence", async () => {
    const fixture = await createFixture("stale-head");
    try {
      const fence = establish(fixture);
      writeFileSync(join(fixture.repo, "README.md"), "changed\n");
      runGit(fixture.repo, ["add", "README.md"]); runGit(fixture.repo, ["commit", "-m", "move head"]);
      const proc = record(fixture, fence.token);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /completed checked execution claim no longer matches current authority|reviewed_head_sha values must equal the current integration head|local, worktree, and origin head equality/u);
      assert.equal(readJson(fixture.runPath).steering.pr_fence.token, fence.token);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects identity-less fences through pr-created and clear without mutation or observation", async () => {
    for (const command of ["pr-created", "clear"]) {
      const fixture = await createFixture(`invalid-${command}`);
      try {
        const fence = establish(fixture);
        const run = readJson(fixture.runPath);
        for (const key of ["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]) delete run.steering.pr_fence[key];
        writeJson(fixture.runPath, run);
        const before = readFileSync(fixture.runPath);
        const args = command === "clear" ? ["factory", "pr-fence", fixture.runId, "--clear", "--fence-token", fence.token, "--json"] : ["factory", "pr-created", fixture.runId, "--fence-token", fence.token, "--json"];
        const proc = runCli(fixture.repo, args);
        assert.notEqual(proc.status, 0);
        assert.match(proc.stderr, /pr_fence.*must all be present|invalid run state/u);
        assert.deepEqual(readFileSync(fixture.runPath), before);
        assert.deepEqual(readObservations(fixture), []);
      } finally { cleanup(fixture.repo); }
    }
  });
});

async function createFixture(runId, disposition = "open") {
  const repo = mkdtempSync(join(tmpdir(), "cli-pr-operation-"));
  initGit(repo);
  const base = gitOutput(repo, ["rev-parse", "HEAD"]);
  runGit(repo, ["checkout", "-b", "feature-branch"]);
  const head = gitOutput(repo, ["rev-parse", "HEAD"]);
  runGit(repo, ["remote", "add", "origin", "https://github.com/jasoncarreira/opencode-feature-factory.git"]);
  runGit(repo, ["config", `url.file://${repo}/.insteadOf`, "https://github.com/jasoncarreira/opencode-feature-factory.git"]);
  const runDir = join(repo, ".opencode", "factory", runId); const runPath = join(runDir, "run.json");
  for (const dir of ["artifacts", "evidence", "reviews"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "feature-branch", attempt: 1, verdict: "GO", reviewed_head_sha: head });
  writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "feature-branch", attempt: 1, verdict: "PASS", reviewed_head_sha: head });
  const authority = installCurrentWholeStoryAuthority({
    runDir,
    runId,
    head,
    slices: [{ id: "slice", stack: "backend", paths: ["slice.txt"], depends_on: [], acceptance: ["slice works"], test_plan: ["node --test"] }],
  });
  writeJson(runPath, { schema_version: 1, run_id: runId, status: "running", base_ref: "main", base_commit: base, branch: "feature-branch", worktree: repo, github_account: "jasoncarreira", pr_mode: "ready", pr_url: null,
    gates: {}, slices: authority.slices, steps: authority.steps,
    validator: { verdict: "GO", report: "artifacts/validation-report.md", report_hash: hashFile(join(runDir, "artifacts", "validation-report.md")), review_ref: "reviews/implementation-validator.json", review_hash: hashFile(join(runDir, "reviews", "implementation-validator.json")), reviewed_head_sha: head },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: hashFile(join(runDir, "reviews", "security-reviewer.json")), reviewed_head_sha: head }, terminal_result: null });
  await acceptCurrentWholeStoryTests(runDir, head);
  await approveCurrentPrePrGate(runDir);
  writeFakeGh(repo, disposition);
  return { repo, runDir, runPath, runId, base, head };
}

function writeFakeGh(repo, disposition) {
  const bin = join(repo, ".opencode", "fake-bin"); mkdirSync(bin, { recursive: true }); const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path"); const args=process.argv.slice(2);
const root=path.join(process.cwd(),".opencode","factory"); const name=fs.readdirSync(root).find(n=>fs.existsSync(path.join(root,n,"run.json"))); const runDir=path.join(root,name); const run=JSON.parse(fs.readFileSync(path.join(runDir,"run.json"),"utf8")); const f=run.steering.pr_fence;
fs.appendFileSync(path.join(runDir,"gh-observations.jsonl"),JSON.stringify({args,gh_config_dir:process.env.GH_CONFIG_DIR??null,gh_host:process.env.GH_HOST??null,auth_environment:{GH_TOKEN:process.env.GH_TOKEN??null,GITHUB_TOKEN:process.env.GITHUB_TOKEN??null,GH_ENTERPRISE_TOKEN:process.env.GH_ENTERPRISE_TOKEN??null,GITHUB_ENTERPRISE_TOKEN:process.env.GITHUB_ENTERPRISE_TOKEN??null}})+"\\n");
if(args[0]!=="api")process.exit(2);
if(${JSON.stringify(disposition)}==="unknown"){process.stdout.write("malformed");process.exit(0);} const p={html_url:${JSON.stringify(PR_URL)},number:99,node_id:"PR_cli_operation",draft:f.draft,body:"<!-- opencode-feature-factory:pr-operation="+f.operation_id+" -->",state:${JSON.stringify(disposition)}==="closed"?"closed":"open",merged_at:null,head:{ref:f.head_ref,sha:f.head_sha,repo:{full_name:f.repository}},base:{ref:f.base_ref,sha:f.base_sha,repo:{full_name:f.repository}}}; const body=${JSON.stringify(disposition)}==="absent"?[]:${JSON.stringify(disposition)}==="ambiguous"?[p,{...p,html_url:"https://github.com/jasoncarreira/opencode-feature-factory/pull/100",number:100,node_id:"PR_other"}]:[p]; process.stdout.write("HTTP/2 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n"+JSON.stringify(body));
`); chmodSync(gh, 0o755);
}

function establish(fixture) { const proc = runCli(fixture.repo, ["factory", "pr-fence", fixture.runId, "--json"]); assert.equal(proc.status, 0, proc.stderr); return readJson(fixture.runPath).steering.pr_fence; }
function record(fixture, token) { return runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--fence-token", token, "--json"]); }
function establishAndRecord(fixture) { const fence = establish(fixture); return { fence, proc: record(fixture, fence.token) }; }
function runCli(repo, args) { return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${join(repo, ".opencode", "fake-bin")}:${process.env.PATH}`, GH_CONFIG_DIR: "/ambient/global-gh", GH_TOKEN: "ambient-gh-token", GITHUB_TOKEN: "ambient-github-token", GH_ENTERPRISE_TOKEN: "ambient-gh-enterprise-token", GITHUB_ENTERPRISE_TOKEN: "ambient-github-enterprise-token" } }); }
function initGit(repo) { runGit(repo, ["init", "-b", "main"]); runGit(repo, ["config", "user.email", "test@example.com"]); runGit(repo, ["config", "user.name", "Test"]); writeFileSync(join(repo, ".gitignore"), ".opencode/\n"); writeFileSync(join(repo, "README.md"), "test\n"); runGit(repo, ["add", ".gitignore", "README.md"]); runGit(repo, ["commit", "-m", "init"]); }
function runGit(repo, args) { const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); assert.equal(proc.status, 0, proc.stderr || proc.stdout); }
function gitOutput(repo, args) { const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); assert.equal(proc.status, 0, proc.stderr || proc.stdout); return proc.stdout.trim(); }
function hashFile(file) { return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`; }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function readObservations(fixture) { const path = join(fixture.runDir, "gh-observations.jsonl"); return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; }
function pick(value, keys) { return Object.fromEntries(keys.map((key) => [key, value[key]])); }
function cleanup(repo) { rmSync(repo, { recursive: true, force: true }); }
