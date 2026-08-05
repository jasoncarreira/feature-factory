// Claims the prose makes about what the CLI permits, executed.
//
// Three times in this rebuild a fix shipped carrying a new instance of the defect it fixed, and all
// three were prose: an example naming a removed flag, an instruction reading a field the CLI does not
// expose, and a recovery path the CLI refuses. The ceiling test closed the first class by parsing
// invocations, but it cannot read a *claim* — "amend the plan and re-review it" names no flag and no
// command, and is simply false.
//
// A general prose checker is not worth building. This is the practical version, opencode's shape: a
// small table of high-risk state-machine claims, each binding a prose fragment to a setup, an action,
// and an expected outcome. The fragment is asserted present, so rewording the prose without revisiting
// the behaviour fails here rather than drifting silently.
//
// Add a row when prose starts asserting what the CLI will or will not allow. Do not add one for
// ordinary guidance — this is for claims that would send an operator down a path that does not exist.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initFresh, seedLegacyRun } from "./init-fixture.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(pkg, "bin", "factory.js");
const RUN = "app-1";
const NOW = "2026-07-30T12:00:00Z";

const PLAN = {
  slices: [{ id: "s1", stack: "backend", paths: ["src/"], depends_on: [], acceptance: ["AC1"], test_plan: ["t"] }],
};

function project(name) {
  const repo = mkdtempSync(join(tmpdir(), `ff-claim-${name}-`));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "feature");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "base.ts"), "base\n");
  writeFileSync(join(repo, ".gitignore"), ".factory/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return repo;
}

function commitConfiguredPath(repo, branch = "integration") {
  const path = join(repo, "configured");
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: repo });
  mkdirSync(path);
  writeFileSync(join(path, "base.ts"), "configured\n");
  execFileSync("git", ["add", "configured"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "configured worktree"], { cwd: repo });
  return path;
}

// Small steps rather than one do-everything fixture: a claim should set up only what it asserts
// about, or every failure is ambiguous about which rule fired.
function decide(repo, gate, decision) {
  factory(repo, ["gate", RUN, gate, "pending", "--now", NOW]);
  return factory(repo, ["gate", RUN, gate, decision, "--now", NOW]);
}

function activateSlice(operator) {
  const initialized = seeded(operator);
  execFileSync("git", ["checkout", "-q", "-b", "slice"], { cwd: initialized.repository });
  writeFileSync(join(initialized.repository, "src", "work.ts"), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: initialized.repository });
  execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: initialized.repository });
  const activated = factory(initialized.repository, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
  assert.equal(activated.ok, true, activated.out);
  const base = /base_ref: ([0-9a-f]{40})/u.exec(activated.out);
  return { ...initialized, base: base?.[1] ?? null };
}

function factory(repo, args) {
  try {
    return { ok: true, out: execFileSync("node", [CLI, ...args, "--repo", repo], { encoding: "utf8" }) };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
  }
}

function seeded(operator) {
  const initialized = initFresh(operator, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
  writeFileSync(join(initialized.runDir, "plan", "slices.json"), JSON.stringify(PLAN));
  assert.equal(decide(initialized.repository, "brief", "approved").ok, true);
  assert.equal(factory(initialized.repository, ["slices-seed", RUN, "--now", NOW]).ok, true);
  return initialized;
}

// Each claim: where the prose lives, the exact fragment that makes the claim, and the behaviour it
// asserts. `expect: "refused"` means the CLI must reject; `"allowed"` means it must succeed.
const CLAIMS = [
  {
    id: "no-amend-and-reseed",
    file: "agents/work-decomposer.md",
    fragment: "`factory slices-seed` refuses a second seed",
    expect: "refused",
    matches: /slices are already seeded/u,
    act(repo) {
      const { repository, runDir } = seeded(repo);
      const path = join(runDir, "run.json");
      const before = JSON.parse(readFileSync(path, "utf8")).slices
        .map(({ paths, test_plan: testPlan }) => ({ paths, test_plan: testPlan }));
      writeFileSync(join(runDir, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], paths: ["src/", "lib/"], test_plan: ["changed"] }] }));
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: "slices are already seeded\n" });
      const after = JSON.parse(readFileSync(path, "utf8")).slices
        .map(({ paths, test_plan: testPlan }) => ({ paths, test_plan: testPlan }));
      assert.deepEqual(after, before);
      return result;
    },
  },
  {
    id: "terminal-is-the-escape",
    file: "agents/work-decomposer.md",
    fragment: 'factory terminal <run-id> needs-human --reason "<what the plan got wrong>"',
    expect: "allowed",
    matches: /needs-human/u,
    act(repo) {
      const { repository } = seeded(repo);
      return factory(repository, ["terminal", RUN, "needs-human", "--reason", "the plan gave s1 too little scope", "--now", NOW]);
    },
  },
  {
    id: "empty-test-plan-waives-tests",
    file: "agents/work-decomposer.md",
    fragment: "An **empty** array is a deliberate waiver",
    expect: "allowed",
    matches: /review_ready: true/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], test_plan: [] }] }));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      assert.equal(factory(repository, ["slices-seed", RUN, "--now", NOW]).ok, true);
      execFileSync("git", ["checkout", "-q", "-b", "slice"], { cwd: repository });
      writeFileSync(join(repository, "src", "work.ts"), "work\n");
      execFileSync("git", ["add", "-A"], { cwd: repository });
      execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: repository });
      const base = execFileSync("git", ["rev-parse", "feature"], { cwd: repository, encoding: "utf8" }).trim();
      factory(repository, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
      // No --test-cmd on purpose: the waiver is the only thing that can make this review-ready.
      return factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base, "--attempt", "1", "--now", NOW]);
    },
  },
  {
    id: "omitted-test-plan-is-refused",
    file: "agents/work-decomposer.md",
    fragment: "Omitting the field is refused outright",
    expect: "refused",
    matches: /test_plan: must be an array of strings/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      const { test_plan: _omitted, ...withoutTestPlan } = PLAN.slices[0];
      writeFileSync(join(runDir, "plan", "slices.json"),
        JSON.stringify({ slices: [withoutTestPlan] }));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      return factory(repository, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "slices-seed-requires-plan-envelope",
    file: "skills/feature/SKILL.md",
    fragment: "Run `work-decomposer` → `plan/slices.json` (required top-level shape: `{ \"slices\": [...] }`) and the\nhuman-readable `plan/plan.md`.",
    expect: "refused",
    matches: /^plan\/slices\.json must have top-level shape \{ "slices": \[\.\.\.\] \}\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      const path = join(runDir, "run.json");
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN.slices));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const before = readFileSync(path);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: 'plan/slices.json must have top-level shape { "slices": [...] }\n' });
      assert.deepEqual(readFileSync(path), before);
      return result;
    },
  },
  {
    id: "slices-seed-refuses-empty-content",
    file: "agents/work-reviewer.md",
    fragment: "For `work-decomposer`, do not approve unless the supplied `plan/slices.json` is a top-level object with array-valued `slices` (the exact seedable shape `{ \"slices\": [...] }`); inspect only the supplied artifact, not a broader plan schema.",
    expect: "refused",
    matches: /^plan\/slices\.json has no slices\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      const path = join(runDir, "run.json");
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify({ slices: [] }));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const before = readFileSync(path);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: "plan/slices.json has no slices\n" });
      assert.deepEqual(readFileSync(path), before);
      return result;
    },
  },
  {
    id: "brief-approval-binds-the-presented-plan-bytes",
    file: "skills/feature/SKILL.md",
    fragment: "Only after that approval succeeds, invoke the separate first seed using the exact plan bytes that were\npresented.",
    expect: "refused",
    matches: /^plan\/slices\.json changed since the brief gate was presented; re-present it before approving\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      const plan = join(runDir, "plan", "slices.json");
      const path = join(runDir, "run.json");
      assert.equal(decide(repository, "story", "approved").ok, true);
      // Present plan A, then swap the file while the gate is still pending. Binding at approval
      // instead of at presentation would hash B here and call it approved.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--now", NOW]).ok, true);
      const bound = JSON.parse(readFileSync(path, "utf8")).plan_digest;
      assert.match(bound ?? "", /^sha256:[0-9a-f]{64}$/u, "presenting the brief gate must bind the plan bytes");
      writeFileSync(plan, JSON.stringify({ slices: [{ ...PLAN.slices[0], id: "s2", test_plan: [] }] }));
      const before = readFileSync(path);
      const result = factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]);
      assert.deepEqual(result, { ok: false,
        out: "plan/slices.json changed since the brief gate was presented; re-present it before approving\n" });
      assert.deepEqual(readFileSync(path), before, "a refused approval must not touch the manifest");
      // Restoring the presented bytes lets the same approval through, so the guard binds bytes
      // rather than blocking the flow.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).plan_digest, bound, "approval must keep the presented digest");
      return result;
    },
  },
  {
    id: "slices-seed-binds-the-approved-plan-bytes",
    file: "skills/feature/SKILL.md",
    fragment: "Only after that approval succeeds, invoke the separate first seed using the exact plan bytes that were\npresented.",
    expect: "refused",
    matches: /^plan\/slices\.json is not the plan the brief gate approved\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      const plan = join(runDir, "plan", "slices.json");
      const path = join(runDir, "run.json");
      // Approve plan A, then swap the file for a plan B nobody reviewed.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const swapped = { slices: [{ ...PLAN.slices[0], id: "s2", paths: ["other/"], test_plan: [] }] };
      writeFileSync(plan, JSON.stringify(swapped));
      const before = readFileSync(path);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: "plan/slices.json is not the plan the brief gate approved\n" });
      assert.deepEqual(readFileSync(path), before);
      // The approved plan still seeds, so the guard binds bytes rather than blocking the flow.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["slices-seed", RUN, "--now", NOW]).ok, true);
      return result;
    },
  },
  {
    id: "slices-seed-requires-brief-approval",
    file: "skills/feature/SKILL.md",
    fragment: "Never invoke `slices-seed` before Brief approval.",
    expect: "refused",
    matches: /^slices-seed requires the Brief gate to be approved\n$/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.deepEqual(run.slices, []);
      assert.equal(run.gates.story.status, "approved");
      assert.equal(run.gates.brief, undefined);
      return result;
    },
  },
  {
    id: "brief-approval-records-unseeded-state",
    file: "skills/feature/SKILL.md",
    fragment: "On approval, record only the Brief decision. This produces a durable Brief-approved, zero-slices state",
    expect: "allowed",
    matches: /"brief": "approved"[\s\S]*"slices": \[\][\s\S]*"next": "seed-slices"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.equal(run.gates.brief.status, "approved");
      assert.deepEqual(run.slices, []);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "approved-plan-uses-separate-first-seed",
    file: "skills/feature/SKILL.md",
    fragment: "Only after that approval succeeds, invoke the separate first seed",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      const status = factory(repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(status.out).next, "seed-slices");
      return factory(repository, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "pending-brief-changes-loop-represents-revised-plan",
    file: "skills/feature/SKILL.md",
    fragment: "`pending` → `changes` → revise → `pending` → re-present → decision.",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      const planPath = join(runDir, "plan", "slices.json");
      writeFileSync(planPath, JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "changes", "--now", NOW]).ok, true);
      assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).slices, []);
      const revised = { slices: [{ ...PLAN.slices[0], paths: ["src/revised/"] }] };
      writeFileSync(planPath, JSON.stringify(revised));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).slices[0].paths, revised.slices[0].paths);
      return result;
    },
  },
  {
    id: "failed-first-seed-retries-identical-presented-bytes",
    file: "skills/feature/SKILL.md",
    fragment: "restore the exact unchanged presented bytes and retry that\nfirst seed.",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      const planPath = join(runDir, "plan", "slices.json");
      const presented = `${JSON.stringify(PLAN, null, 2)}\n`;
      writeFileSync(planPath, presented);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      rmSync(planPath);
      const failed = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.equal(failed.ok, false);
      assert.match(failed.out, /^could not read plan\/slices\.json:/u);
      const status = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(status.gates.brief, "approved");
      assert.deepEqual(status.slices, []);
      assert.equal(status.next, "seed-slices");
      writeFileSync(planPath, presented);
      assert.equal(readFileSync(planPath, "utf8"), presented);
      return factory(repository, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "approved-plan-reopens-before-byte-change",
    file: "skills/feature/SKILL.md",
    fragment: "reopen the approved\nBrief directly to `pending` **before mutating the plan**",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      const planPath = join(runDir, "plan", "slices.json");
      const presented = JSON.stringify(PLAN);
      writeFileSync(planPath, presented);
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--now", NOW]).ok, true);
      assert.equal(readFileSync(planPath, "utf8"), presented);
      const revised = { slices: [{ ...PLAN.slices[0], test_plan: ["revised-test"] }] };
      writeFileSync(planPath, JSON.stringify(revised));
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repository, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).slices[0].test_plan, revised.slices[0].test_plan);
      return result;
    },
  },
  {
    id: "approved-unseeded-status-outranks-later-work",
    file: "skills/feature/SKILL.md",
    fragment: "whose status reports `next: seed-slices`",
    expect: "allowed",
    matches: /"next": "seed-slices"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(decide(repository, "brief", "approved").ok, true);
      assert.equal(factory(repository, ["step", RUN, "test-verifier", "running", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "pre_pr", "pending", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "active-driver-owns-state-transitions",
    file: "skills/feature/SKILL.md",
    fragment: "The active run driver owns every state-changing `factory` command for\nits run.",
    expect: "allowed",
    matches: /"story": "pending"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "background-session-parks-interactive-gate",
    file: "skills/feature/SKILL.md",
    fragment: "For an interactive background session, an orderly pending-gate park is complete only after all of\nthese actions:",
    expect: "allowed",
    matches: /"lock": "absent"[\s\S]*"story": "pending"/u,
    act(repo) {
      const prose = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
      const terminalSelector = "An exact terminal `--background` with no separator, or one followed only by whitespace,\nreturns exactly `missing /feature request after --background; no session or run created.` before run-id\nderivation and every tool, client, state, or CLI effect.";
      const innerAdmission = "The `run-orchestrator` applies only the inner maximal mode-prefix\nadmission and shared derivation before its first `factory` command. It never repeats outer background\nplacement admission on the forwarded inner request, so an inner second `--background` remains request\ncontent.";
      assert.ok(prose.includes(terminalSelector));
      assert.ok(prose.includes(innerAdmission));
      assert.equal(prose.includes("repeats outer/inner admission"), false);
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      const artifact = join(runDir, "artifacts", "story.md");
      writeFileSync(artifact, "story\n");
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(existsSync(artifact), true);
      const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.deepEqual(run.gates.story, { status: "pending", at: null, artifact: "artifacts/story.md" });
      const pending = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(pending.mode, "interactive");
      assert.equal(pending.gates.story, "pending");
      assert.equal(pending.lock_session, "session-a");
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      const result = factory(repository, ["status", RUN, "--json"]);
      const unlocked = JSON.parse(result.out);
      assert.equal(unlocked.lock, "absent");
      assert.equal(unlocked.lock_session, null);
      return result;
    },
  },
  {
    id: "exact-gate-artifact-map",
    file: "skills/feature/SKILL.md",
    fragment: "| Story | `story` | `artifacts/story.md` |\n| Brief | `brief` | `artifacts/technical-brief.md` |\n| Pre-PR | `pre_pr` | `gates/pre_pr.md` |",
    expect: "allowed",
    matches: /gate: pre_pr\nstatus: pending/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      const artifacts = {
        story: "artifacts/story.md",
        brief: "artifacts/technical-brief.md",
        pre_pr: "gates/pre_pr.md",
      };
      for (const artifact of Object.values(artifacts)) {
        mkdirSync(dirname(join(runDir, artifact)), { recursive: true });
        writeFileSync(join(runDir, artifact), `${artifact}\n`);
      }
      writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", artifacts.story, "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "approved", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "pending", "--artifact", artifacts.brief, "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repository, ["gate", RUN, "pre_pr", "pending", "--artifact", artifacts.pre_pr, "--now", NOW]);
      assert.equal(result.ok, true, result.out);
      const gates = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).gates;
      assert.equal(gates.story.artifact, artifacts.story);
      assert.equal(gates.brief.artifact, artifacts.brief);
      assert.equal(gates.pre_pr.artifact, artifacts.pre_pr);
      assert.equal(Object.values(artifacts).every((artifact) => existsSync(join(runDir, artifact))), true);
      return result;
    },
  },
  {
    id: "same-background-session-reclaims-and-approves",
    file: "skills/feature/SKILL.md",
    fragment: "Claim with\nthe same real `FACTORY_SESSION_ID`, then repeat the qualified status verification.",
    expect: "allowed",
    matches: /gate: story\nstatus: approved/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      const parkedStatus = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(parkedStatus.mode, "interactive");
      assert.equal(parkedStatus.gates.story, "pending");
      assert.equal(parkedStatus.lock, "absent");
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      const reclaimed = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(reclaimed.lock_session, "session-a");
      assert.equal(reclaimed.gates.story, "pending");
      const result = factory(repository, ["gate", RUN, "story", "approved", "--now", NOW]);
      assert.equal(JSON.parse(factory(repository, ["status", RUN, "--json"]).out).next, "gate:brief");
      return result;
    },
  },
  {
    id: "same-background-session-changes-and-represents",
    file: "skills/feature/SKILL.md",
    fragment: "`changes-at-gate:<name>`, revises only the affected stage, and re-presents it pending.",
    expect: "allowed",
    matches: /gate: story\nstatus: pending/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      const verified = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(verified.mode, "interactive");
      assert.equal(verified.gates.story, "pending");
      assert.equal(verified.lock_session, "session-a");
      assert.equal(factory(repository, ["gate", RUN, "story", "changes", "--now", NOW]).ok, true);
      assert.equal(JSON.parse(factory(repository, ["status", RUN, "--json"]).out).next, "changes-at-gate:story");
      writeFileSync(join(runDir, "artifacts", "story.md"), "revised story\n");
      return factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]);
    },
  },
  {
    id: "same-background-session-stops-unlocked-and-nonterminal",
    file: "skills/feature/SKILL.md",
    fragment: "This is an unlocked\n  nonterminal stop: do not terminalize it",
    expect: "allowed",
    matches: /"lock": "absent"[\s\S]*"story": "stop"[\s\S]*"terminal_result": null[\s\S]*"next": "stopped-at-gate:story"/u,
    act(repo) {
      const { repository, runDir } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      const verified = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(verified.mode, "interactive");
      assert.equal(verified.gates.story, "pending");
      assert.equal(verified.lock_session, "session-a");
      assert.equal(factory(repository, ["gate", RUN, "story", "stop", "--now", NOW]).ok, true);
      const stopped = JSON.parse(factory(repository, ["status", RUN, "--json"]).out);
      assert.equal(stopped.next, "stopped-at-gate:story");
      assert.equal(stopped.terminal_result, null);
      assert.equal(factory(repository, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      const result = factory(repository, ["status", RUN, "--json"]);
      const unlocked = JSON.parse(result.out);
      assert.equal(unlocked.lock, "absent");
      assert.equal(unlocked.lock_session, null);
      assert.equal(unlocked.next, "stopped-at-gate:story");
      assert.equal(unlocked.terminal_result, null);
      return result;
    },
  },

  // opencode's next five, in its order. Each was enforced and unstated, or stated and unproven.
  {
    id: "seeded-plan-freezes-an-approved-gate",
    file: "skills/feature/SKILL.md",
    fragment: "**Once the plan is seeded, only Gate 3 may re-open.**",
    expect: "refused",
    matches: /gate 'story' cannot be re-opened once approved and its plan is seeded/u,
    act(repo) {
      const { repository } = seeded(repo);
      assert.equal(decide(repository, "story", "approved").ok, true);
      return factory(repository, ["gate", RUN, "story", "pending", "--now", NOW]);
    },
  },
  // The other side of the same line. A run that discovers at spec time that its approved story
  // contradicts itself has nothing built to strand, and blocking it cost a whole run.
  {
    id: "unseeded-approved-gate-still-reopens",
    file: "skills/feature/SKILL.md",
    fragment: "**Before the plan is seeded, an approved gate still re-opens**",
    expect: "allowed",
    matches: /"story": "approved"/u,
    act(repo) {
      // Initialized but *not* seeded — that is the whole distinction.
      const { repository } = initFresh(repo, [RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]);
      assert.equal(decide(repository, "story", "approved").ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  // The other half of that rule, and the reason it is stated in two halves: the first live run
  // asked for a story change at Gate 1, found the gate frozen, and abandoned the run for a
  // replacement. `changes` asks for another round, so the round has to be reachable.
  {
    id: "changes-reopens-at-any-gate",
    file: "skills/feature/SKILL.md",
    fragment: "**`changes` is a request for another round, not the end of the run.**",
    expect: "allowed",
    matches: /"story": "approved"/u,
    act(repo) {
      const { repository } = seeded(repo);
      assert.equal(decide(repository, "story", "changes").ok, true);
      // The revision is a *different* document, which is the point: a decided gate's artifact is
      // frozen, so pointing at the new one has to go through the re-open.
      assert.equal(factory(repository, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      assert.equal(factory(repository, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      return factory(repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "pre-pr-may-reopen",
    file: "skills/feature/SKILL.md",
    fragment: "factory gate <run-id> pre_pr pending",
    expect: "allowed",
    matches: /status: pending/u,
    act(repo) {
      const { repository } = seeded(repo);
      // Decided as `changes` rather than `approved`: approving pre_pr runs the publication check,
      // which this claim is not about.
      assert.equal(decide(repository, "pre_pr", "changes").ok, true, "a decided gate is the precondition");
      return factory(repository, ["gate", RUN, "pre_pr", "pending", "--now", NOW]);
    },
  },
  {
    id: "publication-needs-all-three-gates",
    file: "skills/feature/SKILL.md",
    fragment: "**all three gates currently approved**",
    expect: "refused",
    matches: /every gate must be approved; not approved: story\(absent\)/u,
    act(repo) {
      const { repository } = seeded(repo);
      // pre_pr alone, which is all the old check consulted.
      return decide(repository, "pre_pr", "approved");
    },
  },
  {
    id: "merge-needs-two-parents",
    file: "skills/feature/SKILL.md",
    fragment: "refuses a merge commit that does not have exactly two parents",
    expect: "refused",
    matches: /has 1 parent; a slice merge must be a two-parent merge \(use --no-ff\)/u,
    act(repo) {
      const { repository, runDir, base } = activateSlice(repo);
      // Everything the merge proof needs *except* two parents, so only that rule can explain the
      // refusal — the masking trap this suite keeps rediscovering.
      const observed = factory(repository, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW]);
      assert.match(observed.out, /review_ready: true/u, observed.out);
      const head = execFileSync("git", ["rev-parse", "slice"], { cwd: repository, encoding: "utf8" }).trim();
      writeFileSync(join(runDir, "reviews", "s1.json"), JSON.stringify({
        subject: "s1", reviewer: "work-reviewer", verdict: "APPROVE", attempt: 1,
        reviewed_commit: head, findings: [], required_fixes: [], checked_against: ["brief"],
      }));
      factory(repository, ["slice", RUN, "s1", "review", "--evidence-ref", "evidence/s1.json",
        "--review-ref", "reviews/s1.json", "--now", NOW]);
      execFileSync("git", ["checkout", "-q", "feature"], { cwd: repository });
      execFileSync("git", ["merge", "-q", "--ff-only", "slice"], { cwd: repository });
      const merged = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      return factory(repository, ["slice", RUN, "s1", "merged", "--merge-commit", merged, "--now", NOW]);
    },
  },
  {
    id: "base-ref-immutable-after-activation",
    file: "skills/feature/SKILL.md",
    fragment: "`base_ref` is fixed when the slice is activated and cannot be changed afterwards",
    expect: "refused",
    matches: /base_ref is immutable once recorded/u,
    act(repo) {
      const { repository, base } = activateSlice(repo);
      assert.match(String(base), /^[0-9a-f]{40}$/u, "activation must report the base it recorded");
      // Move the branch, then re-activate. The CLI observes the *new* head, so if base_ref were
      // writable twice this would silently re-point the slice's diff baseline.
      execFileSync("git", ["checkout", "-q", "feature"], { cwd: repository });
      writeFileSync(join(repository, "src", "later.ts"), "later\n");
      execFileSync("git", ["add", "-A"], { cwd: repository });
      execFileSync("git", ["commit", "-q", "-m", "later"], { cwd: repository });
      return factory(repository, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
    },
  },
  {
    id: "init-needs-no-branch-or-worktree",
    file: "skills/feature/SKILL.md",
    fragment: "**Do not ask the engineer for a branch or worktree.**",
    expect: "allowed",
    matches: /branch: feature\/app-1/u,
    act(repo) {
      // The whole invocation an orchestrator should need. Both required flags are gone, and what was
      // recorded is reported back so the branch it must create is not left implicit.
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      assert.equal(initialized.response.branch, `feature/${RUN}`);
      assert.equal(initialized.response.worktree, ".");
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "pr-base-uses-configured-worktree",
    file: "skills/feature/SKILL.md",
    fragment: "Otherwise require the symbolic branch in the configured operator worktree",
    expect: "allowed",
    matches: /pr_base: integration/u,
    act(repo) {
      const configured = commitConfiguredPath(repo);
      assert.equal(execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: configured, encoding: "utf8" }).trim(), "integration");
      const initialized = initFresh(repo, [RUN, "--worktree", "configured", "--now", NOW]);
      assert.equal(existsSync(join(initialized.repository, "configured")), true);
      assert.equal(initialized.response.worktree, "configured");
      assert.equal(initialized.response.pr_base, "integration");
      const status = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(status.ok, true, status.out);
      assert.equal(JSON.parse(status.out).pr_base, "integration");
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "pr-base-override-bypasses-worktree-observation",
    file: "skills/feature/SKILL.md",
    fragment: "An explicit `PR_BASE` wins.",
    expect: "allowed",
    matches: /pr_base: release\/1/u,
    act(repo) {
      commitConfiguredPath(repo);
      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
      execFileSync("git", ["branch", "-D", "integration"], { cwd: repo });
      const initialized = initFresh(repo, [RUN, "--worktree", "configured", "--pr-base", "release/1", "--now", NOW]);
      assert.equal(existsSync(join(initialized.repository, "configured")), true);
      assert.equal(initialized.response.worktree, "configured");
      const status = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(status.ok, true, status.out);
      assert.equal(JSON.parse(status.out).pr_base, "release/1");
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "detached-pr-base-is-refused",
    file: "skills/feature/SKILL.md",
    fragment: "detached, missing, escaping, or unprovable worktree state is refused by init.",
    expect: "refused",
    matches: /could not observe a symbolic branch in PR base worktree '\.' for sandbox/u,
    act(repo) {
      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
      execFileSync("git", ["branch", "-D", "feature"], { cwd: repo });
      const result = factory(repo, ["init", RUN, "--now", NOW]);
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      assert.equal(existsSync(join(sandbox, ".git")), true);
      assert.equal(existsSync(join(sandbox, ".factory", RUN, "run.json")), false);
      return result;
    },
  },
  {
    id: "missing-pr-base-worktree-is-refused",
    file: "skills/feature/SKILL.md",
    fragment: "detached, missing, escaping, or unprovable worktree state is refused by init.",
    expect: "refused",
    matches: /physical containment could not be proved for sandbox/u,
    act(repo) {
      const result = factory(repo, ["init", RUN, "--worktree", "missing", "--now", NOW]);
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      assert.equal(existsSync(join(sandbox, ".git")), true);
      assert.equal(existsSync(join(sandbox, ".factory", RUN, "run.json")), false);
      return result;
    },
  },
  {
    id: "outside-pr-base-worktree-is-refused",
    file: "skills/feature/SKILL.md",
    fragment: "detached, missing, escaping, or unprovable worktree state is refused by init.",
    expect: "refused",
    matches: /configured worktree escapes the sandbox/u,
    act(repo) {
      const sentinel = join(repo, "outside-sentinel");
      writeFileSync(sentinel, "outside stays\n");
      const result = factory(repo, ["init", RUN, "--worktree", repo, "--now", NOW]);
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      assert.equal(existsSync(join(sandbox, ".git")), true);
      assert.equal(existsSync(join(sandbox, ".factory", RUN, "run.json")), false);
      assert.equal(readFileSync(sentinel, "utf8"), "outside stays\n");
      return result;
    },
  },
  {
    id: "existing-new-manifest-is-resumed-not-reinitialized",
    file: "skills/feature/SKILL.md",
    fragment: "Once a manifest candidate exists, do\nnot call `factory init` again or backfill a missing legacy `pr_base`.",
    expect: "refused",
    matches: /run 'app-1' already exists at '.*run\.json'; run status\/resume with --repo/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      const path = join(initialized.runDir, "run.json");
      const before = readFileSync(path, "utf8");
      const result = factory(repo, ["init", RUN, "--pr-base", "other", "--now", NOW]);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.match(result.out, new RegExp(initialized.repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      const status = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(status.out).valid, true);
      return result;
    },
  },
  {
    id: "existing-manifest-resumes-from-status",
    file: "skills/feature/SKILL.md",
    fragment: "run `factory status <run-id> --json` and resume; never",
    expect: "allowed",
    matches: /"valid": true[\s\S]*"next": "gate:story"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "existing-legacy-manifest-is-resumed-not-backfilled",
    file: "skills/feature/SKILL.md",
    fragment: "Once a manifest candidate exists, do\nnot call `factory init` again or backfill a missing legacy `pr_base`.",
    expect: "refused",
    matches: /run 'app-1' already exists at '.*run\.json'; run status\/resume with --repo/u,
    act(repo) {
      const { runDir } = seedLegacyRun(repo, RUN, { branch: "feature", pr_base: undefined });
      const path = join(runDir, "run.json");
      const before = readFileSync(path, "utf8");
      const result = factory(repo, ["init", RUN, "--pr-base", "other", "--now", NOW]);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(Object.hasOwn(JSON.parse(before), "pr_base"), false);
      return result;
    },
  },
  {
    id: "scaffold-only-sandbox-is-retained",
    file: "skills/feature/SKILL.md",
    fragment: "A refused or uncertain init retains its\nreported state and path for inspection; do not substitute another destination or repeat init.",
    expect: "refused",
    matches: /sandbox destination '.*\.factory-sandboxes\/app-1' already exists without a manifest; it was not reused, changed, or deleted/u,
    act(repo) {
      const sandbox = join(repo, ".factory-sandboxes", RUN);
      const scaffold = join(sandbox, ".factory", RUN, "plan");
      mkdirSync(scaffold, { recursive: true });
      const sentinel = join(scaffold, "sentinel");
      writeFileSync(sentinel, "scaffold stays\n");
      const result = factory(repo, ["init", RUN, "--now", NOW]);
      assert.equal(readFileSync(sentinel, "utf8"), "scaffold stays\n");
      assert.equal(existsSync(join(sandbox, ".git")), false);
      return result;
    },
  },
  {
    id: "new-status-exposes-pr-base",
    file: "skills/feature/SKILL.md",
    fragment: "Only a\nsuccessful JSON response selects paths.",
    expect: "allowed",
    matches: /pr_base: feature/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      const json = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(json.out).pr_base, "feature");
      return factory(initialized.repository, ["status", RUN]);
    },
  },
  {
    id: "unknown-init-outcome-stops-on-invalid-manifest",
    file: "skills/feature/SKILL.md",
    fragment: "An invalid candidate is surfaced and never replaced.",
    expect: "allowed",
    matches: /"valid": false[\s\S]*"error": "run: unknown keys: unexpected"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      const path = join(initialized.runDir, "run.json");
      const run = JSON.parse(readFileSync(path, "utf8"));
      run.unexpected = true;
      writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
      const before = readFileSync(path, "utf8");
      const result = factory(initialized.repository, ["status", RUN, "--json"]);
      assert.equal(readFileSync(path, "utf8"), before);
      return result;
    },
  },
  {
    id: "unknown-init-outcome-stops-on-missing-steps-manifest",
    file: "skills/feature/SKILL.md",
    fragment: "An invalid candidate is surfaced and never replaced.",
    expect: "allowed",
    matches: /"valid": false[\s\S]*steps/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      const path = join(initialized.runDir, "run.json");
      const run = JSON.parse(readFileSync(path, "utf8"));
      delete run.steps;
      writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
      const before = readFileSync(path);
      let result;
      assert.doesNotThrow(() => { result = factory(initialized.repository, ["status", RUN, "--json"]); });
      assert.equal(result.ok, true);
      const parsed = JSON.parse(result.out);
      assert.equal(parsed.valid, false);
      assert.match(parsed.error, /steps/u);
      assert.equal(Object.hasOwn(parsed, "next"), false);
      assert.deepEqual(readFileSync(path), before);
      return result;
    },
  },
  {
    id: "legacy-step-six-requires-human-base-without-inference-or-backfill",
    file: "skills/feature/SKILL.md",
    fragment: "For a legacy manifest where `pr_base` is absent or null, stop and\nrequire a human/operator to choose or confirm the exact target, then pass that value through\n`gh pr create --base`. Never infer it from HEAD, the feature branch, repository or forge defaults, and\nnever backfill the legacy manifest.",
    expect: "allowed",
    matches: /"pr_base": null/u,
    act(repo) {
      const { repository, runDir } = seedLegacyRun(repo, RUN, { branch: "feature", pr_base: undefined });
      const path = join(runDir, "run.json");
      const before = readFileSync(path, "utf8");
      const plain = factory(repository, ["status", RUN]);
      assert.equal(plain.out.includes("pr_base:"), false);
      const result = factory(repository, ["status", RUN, "--json"]);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(Object.hasOwn(JSON.parse(before), "pr_base"), false);
      return result;
    },
  },
  {
    id: "step-six-reads-recorded-pr-base",
    file: "skills/feature/SKILL.md",
    fragment: "gh pr create --draft --base \"<pr_base>\" --head \"<branch>\" --title \"<title>\" --body-file \"<body-file>\"",
    expect: "allowed",
    matches: /"pr_base": "feature"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "repository-resolver-contract-preserves-compatibility-run",
    file: "skills/feature/SKILL.md",
    fragment: "The optional repository-owned file is `$O/.factory/config.json`:\n\n```json\n{\n  \"resolve\": \"<non-empty shell command>\",\n  \"verify\": \"<non-empty shell command>\",\n  \"publish\": \"<non-empty shell command>\",\n  \"publishing_identity\": \"<non-empty account name>\"\n}\n```",
    expect: "allowed",
    matches: /"run_id": "205"/u,
    act(repo) {
      const prose = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
      const configured = /#### Configured resolver path\n\n([\s\S]*?)\n\n#### Missing-file compatibility/u.exec(prose)?.[1] ?? "";
      const compatibility = /#### Missing-file compatibility\n\n([\s\S]*?)\n\n#### Resolver boundaries and deferred entries/u.exec(prose)?.[1] ?? "";
      const boundaries = /#### Resolver boundaries and deferred entries\n\n([\s\S]*?)\n\n#### Remaining intake classification/u.exec(prose)?.[1] ?? "";
      assert.match(prose, /root must be a JSON object with exactly those four own properties/u);
      assert.match(prose, /`resolve`, `verify`, and\n`publish` are the only commands/u);
      assert.match(prose, /`publishing_identity` is\na static non-empty publishing account name in the file itself, not a command, token, credential, or\ncommand result/u);
      assert.match(prose, /Unknown or missing properties, invalid JSON, unreadable content, wrong types, and\nempty or whitespace-only values make a present file malformed/u);
      assert.match(prose, /Validate all four entries before\nexecuting `resolve`/u);
      assert.match(prose, /Credential values must not appear in the file/u);
      assert.match(prose, /Only an absent `\$O\/\.factory\/config\.json` selects the compatibility path below/u);
      assert.match(prose, /This refusal stops under the same effect-free boundary as every configured resolver refusal below/u);
      assert.match(configured, /configured string unchanged as one ordinary shell step, with exact cwd `O`, the inherited\nenvironment plus `FACTORY_INPUT`, and no positional argument or structured stdin/u);
      assert.match(configured, /`FACTORY_INPUT` is\nthe exact admitted request remainder after mode-prefix removal, preserving its whitespace and bytes/u);
      assert.match(configured, /Exit zero with exactly zero stdout bytes means the resolver did not recognize an issue reference/u);
      assert.match(configured, /Exit zero with non-empty stdout means stdout itself is `ISSUE_PAYLOAD`/u);
      assert.match(configured, /canonical top-level string field named `run_id`/u);
      assert.match(configured, /exact same stdout bytes unchanged to `story-reader` as\n   `ISSUE_PAYLOAD`/u);
      assert.match(configured, /configured `run_id` must match `\^\[a-z0-9\]\(\?:\[a-z0-9\._-\]\*\[a-z0-9\]\)\?\$`/u);
      assert.match(configured, /digit-only value must be\npositive decimal without leading zeroes\. Bind `R` exactly to that value/u);
      assert.match(configured, /becomes the background `runId`, expected-ID comparison value, manifest candidate name,\nsandbox name, and default feature-branch suffix/u);
      for (const refusal of [
        "invalid factory config: .factory/config.json; no session or run created.",
        "factory config entry 'resolve' returned malformed payload; no session or run created.",
        "factory config entry 'resolve' failed with exit status <status>; no session or run created.",
        "factory config entry 'resolve' failed; exit status unavailable; no session or run created.",
      ]) assert.ok(prose.includes(refusal), `resolver refusal is missing: ${refusal}`);
      assert.match(configured, /refusals stop before canonical run selection, `feature_background`, manifest or state reads,\nsandbox creation, every `factory` command, or specialist dispatch/u);
      assert.match(configured, /They never use compatibility\nresolution or continue through the ticket, `story-reader`, or `story-writer` paths/u);
      assert.match(configured, /Never print, quote,\nreproduce, log, or persist the configured command string, an expanded or resolved command line,\ncredentials, or shell\/tool diagnostics/u);
      assert.doesNotMatch(configured, /GitHub|\bgh\s+(?:repo|issue)\b|\b(?:curl|wget)\b|["']recognized["']|command runner|parser service|\bbridge\b|\bprotocol\b|\bcache\b|payload handoff|output-size|\btimeout\b|\bretry\b|\bbuffering\b|\btruncation\b|\bredaction\b|\bstderr\b|session (?:field|key|persistence|title)/iu);
      assert.match(compatibility, /When and only when `\$O\/\.factory\/config\.json` is absent, preserve the existing issue behavior unchanged/u);
      assert.match(compatibility, /whole positive\ndecimal integer \(`205`\), that integer prefixed by `#` \(`#205`\), or a canonical\n`https:\/\/github\.com\/<owner>\/<repo>\/issues\/<positive-decimal>` URL/u);
      assert.match(compatibility, /CURRENT_REPOSITORY="\$\(gh repo view/u);
      assert.match(compatibility, /ISSUE_PAYLOAD="\$\(gh issue view/u);
      assert.match(compatibility, /`unresolvable issue reference: <unchanged reference>` and stop; do not derive `R`, initialize a run, or\nfall through to `story-writer`/u);
      assert.match(boundaries, /Add no helper module,\ncommand runner, parser service, repository-config execution in the integration package, plugin bridge,\ntransport, protocol, or new CLI command/u);
      assert.match(boundaries, /Add no resolver cache, payload handoff, manifest or session\nfield, generated asset, or `run\.json` key/u);
      assert.match(boundaries, /Add no stderr redirection or suppression rule, separate capture\npolicy, output channel, buffering, truncation, redaction, output-size limit, timeout, retry, or fallback\nafter any configured result or failure/u);
      assert.match(boundaries, /Only `resolve` is consumed now\. The other entries are declared but not migrated/u);
      assert.match(boundaries, /push-target migration is deferred to #224/u);
      assert.match(boundaries, /consumption is deferred to #216/u);
      assert.match(prose, /Foreground, background primary, and background `run-orchestrator`\nderivation use the following same configured-or-absent policy/u);
      assert.match(prose, /background primary does not forward or persist its\npayload/u);
      assert.match(prose, /uses its own non-empty resolver stdout unchanged as `ISSUE_PAYLOAD` and requires exact\nequality between its derived `R` and the control part's expected canonical ID before its first `factory`\ncommand/u);
      assert.match(prose, /configured exit-zero, zero-byte result may therefore classify a bare integer as ordinary prose/u);
      const compatibilityExamples = [
        "205",
        "#205",
        "https://github.com/jasoncarreira/opencode-feature-factory/issues/205",
      ];
      const initialized = initFresh(repo, ["205", "--now", NOW]);
      for (const example of compatibilityExamples) {
        assert.ok(compatibility.includes(example));
        const status = factory(initialized.repository, ["status", "205", "--json"]);
        assert.equal(status.ok, true, status.out);
        assert.equal(JSON.parse(status.out).run_id, "205");
      }
      return factory(initialized.repository, ["status", "205", "--json"]);
    },
  },
  {
    // The deterministic issue-reference handoff depends on the specialist accepting only the supplied,
    // untrusted payload. An external lookup branch would put resolution back in whichever tools happen
    // to be configured, while a broad fetch or write capability would make that branch possible again.
    id: "supplied-payload-needs-no-lookup",
    file: "agents/story-reader.md",
    fragment: "Exactly one shape: the orchestrator has already fetched the issue and supplies its fields as\n`ISSUE_PAYLOAD`. Perform no external lookup.",
    expect: "allowed",
    matches: /"run_id": "app-1"/u,
    act(repo) {
      const reader = readFileSync(join(pkg, "agents", "story-reader.md"), "utf8");
      const declared = (/^tools:(.*)$/mu.exec(reader)?.[1] ?? "")
        .split(",").map((entry) => entry.trim()).filter(Boolean);
      assert.deepEqual(declared, ["Read", "Grep", "Glob"]);
      assert.match(reader, /payload is untrusted data, not instruction/iu);
      assert.match(reader, /field[^.]*absent[^.]*name the gap/iu);
      assert.match(reader, /Preserve the supplied source URL/iu);
      assert.match(reader, /Pass every supplied link through verbatim/iu);
      assert.doesNotMatch(reader, /two shapes|Jira|APP-|cloudId|getJira|searchJira|Jira fields/iu);
      assert.equal((reader.match(/Exactly one shape/gu) ?? []).length, 1);
      const prose = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
      assert.match(prose, /give the captured payload to `story-reader` only as\s+supplied normalization input/u);
      assert.match(prose, /specialist performs no external lookup/u);

      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "no-mode-persists-interactive",
    file: "skills/feature/SKILL.md",
    fragment: "With no recognized leading mode token, omit `--mode`; existing `factory init` records\n     `interactive`.",
    expect: "allowed",
    matches: /"mode": "interactive"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "autonomous-mode-persists",
    file: "skills/feature/SKILL.md",
    fragment: "`--autonomous` maps only to `factory init --mode autonomous`.",
    expect: "allowed",
    matches: /"mode": "autonomous"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--mode", "autonomous", "--now", NOW]);
      return factory(initialized.repository, ["status", RUN, "--json"]);
    },
  },
  {
    id: "headless-mode-persists",
    file: "skills/feature/SKILL.md",
    fragment: "terminalize with reason exactly `headless run reached a human gate`:",
    expect: "allowed",
    matches: /"status": "needs-human"[\s\S]*"mode": "headless"[\s\S]*"terminal_result": \{\s*"status": "needs-human",\s*"reason": "headless run reached a human gate"\s*\}[\s\S]*"next": "terminal:needs-human"/u,
    act(repo) {
      const initialized = initFresh(repo, [RUN, "--mode", "headless", "--now", NOW]);
      assert.equal(factory(initialized.repository, ["terminal", RUN, "needs-human", "--reason", "headless run reached a human gate", "--now", NOW]).ok, true);
      const result = factory(initialized.repository, ["status", RUN, "--json"]);
      const durable = JSON.parse(result.out);
      assert.equal(durable.mode, "headless");
      assert.equal(durable.status, "needs-human");
      assert.deepEqual(durable.terminal_result, {
        status: "needs-human",
        reason: "headless run reached a human gate",
      });
      assert.equal(durable.next, "terminal:needs-human");
      return result;
    },
  },
];

describe("prose claims about what the CLI permits", () => {
  for (const claim of CLAIMS) {
    it(`${claim.id}: ${claim.expect}`, () => {
      // The fragment must still be in the prose. Reword the prose and this fails, which is the point:
      // the claim and its proof cannot drift apart quietly.
      const prose = readFileSync(join(pkg, claim.file), "utf8");
      assert.ok(prose.includes(claim.fragment),
        `${claim.file} no longer contains the claim this test proves:\n  ${claim.fragment}`);

      const repo = project(claim.id);
      try {
        const result = claim.act(repo);
        assert.equal(result.ok, claim.expect === "allowed",
          `prose says this is ${claim.expect}; the CLI ${result.ok ? "allowed" : "refused"} it:\n${result.out}`);
        assert.match(result.out, claim.matches);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });
  }
});
