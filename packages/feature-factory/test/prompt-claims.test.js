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

function addWorktree(repo, branch = "integration") {
  const path = join(repo, "configured");
  execFileSync("git", ["branch", branch], { cwd: repo });
  execFileSync("git", ["worktree", "add", "-q", path, branch], { cwd: repo });
  return path;
}

function removePrBase(repo) {
  const path = join(repo, ".factory", RUN, "run.json");
  const run = JSON.parse(readFileSync(path, "utf8"));
  delete run.pr_base;
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

// Small steps rather than one do-everything fixture: a claim should set up only what it asserts
// about, or every failure is ambiguous about which rule fired.
function decide(repo, gate, decision) {
  factory(repo, ["gate", RUN, gate, "pending", "--now", NOW]);
  return factory(repo, ["gate", RUN, gate, decision, "--now", NOW]);
}

function activateSlice(repo) {
  seeded(repo);
  execFileSync("git", ["checkout", "-q", "-b", "slice"], { cwd: repo });
  writeFileSync(join(repo, "src", "work.ts"), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: repo });
  const activated = factory(repo, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
  assert.equal(activated.ok, true, activated.out);
  const base = /base_ref: ([0-9a-f]{40})/u.exec(activated.out);
  return base?.[1] ?? null;
}

function factory(repo, args) {
  try {
    return { ok: true, out: execFileSync("node", [CLI, ...args, "--repo", repo], { encoding: "utf8" }) };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
  }
}

function seeded(repo) {
  assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
  writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"), JSON.stringify(PLAN));
  assert.equal(decide(repo, "brief", "approved").ok, true);
  assert.equal(factory(repo, ["slices-seed", RUN, "--now", NOW]).ok, true);
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
      seeded(repo);
      const path = join(repo, ".factory", RUN, "run.json");
      const before = JSON.parse(readFileSync(path, "utf8")).slices
        .map(({ paths, test_plan: testPlan }) => ({ paths, test_plan: testPlan }));
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], paths: ["src/", "lib/"], test_plan: ["changed"] }] }));
      const result = factory(repo, ["slices-seed", RUN, "--now", NOW]);
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
      seeded(repo);
      return factory(repo, ["terminal", RUN, "needs-human", "--reason", "the plan gave s1 too little scope", "--now", NOW]);
    },
  },
  {
    id: "empty-test-plan-waives-tests",
    file: "agents/work-decomposer.md",
    fragment: "An **empty** array is a deliberate waiver",
    expect: "allowed",
    matches: /review_ready: true/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], test_plan: [] }] }));
      assert.equal(decide(repo, "brief", "approved").ok, true);
      assert.equal(factory(repo, ["slices-seed", RUN, "--now", NOW]).ok, true);
      execFileSync("git", ["checkout", "-q", "-b", "slice"], { cwd: repo });
      writeFileSync(join(repo, "src", "work.ts"), "work\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: repo });
      const base = execFileSync("git", ["rev-parse", "feature"], { cwd: repo, encoding: "utf8" }).trim();
      factory(repo, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
      // No --test-cmd on purpose: the waiver is the only thing that can make this review-ready.
      return factory(repo, ["observe", RUN, "s1", "--worktree", ".", "--base", base, "--attempt", "1", "--now", NOW]);
    },
  },
  {
    id: "omitted-test-plan-is-refused",
    file: "agents/work-decomposer.md",
    fragment: "Omitting the field is refused outright",
    expect: "refused",
    matches: /test_plan: must be an array of strings/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      const { test_plan: _omitted, ...withoutTestPlan } = PLAN.slices[0];
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"),
        JSON.stringify({ slices: [withoutTestPlan] }));
      assert.equal(decide(repo, "brief", "approved").ok, true);
      return factory(repo, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "slices-seed-requires-plan-envelope",
    file: "skills/feature/SKILL.md",
    fragment: "Run `work-decomposer` → `plan/slices.json` (required top-level shape: `{ \"slices\": [...] }`) and the\nhuman-readable `plan/plan.md`.",
    expect: "refused",
    matches: /^plan\/slices\.json must have top-level shape \{ "slices": \[\.\.\.\] \}\n$/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      const path = join(repo, ".factory", RUN, "run.json");
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"), JSON.stringify(PLAN.slices));
      assert.equal(decide(repo, "brief", "approved").ok, true);
      const before = readFileSync(path);
      const result = factory(repo, ["slices-seed", RUN, "--now", NOW]);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      const path = join(repo, ".factory", RUN, "run.json");
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"), JSON.stringify({ slices: [] }));
      assert.equal(decide(repo, "brief", "approved").ok, true);
      const before = readFileSync(path);
      const result = factory(repo, ["slices-seed", RUN, "--now", NOW]);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      const plan = join(repo, ".factory", RUN, "plan", "slices.json");
      const path = join(repo, ".factory", RUN, "run.json");
      assert.equal(decide(repo, "story", "approved").ok, true);
      // Present plan A, then swap the file while the gate is still pending. Binding at approval
      // instead of at presentation would hash B here and call it approved.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repo, ["gate", RUN, "brief", "pending", "--now", NOW]).ok, true);
      const bound = JSON.parse(readFileSync(path, "utf8")).plan_digest;
      assert.match(bound ?? "", /^sha256:[0-9a-f]{64}$/u, "presenting the brief gate must bind the plan bytes");
      writeFileSync(plan, JSON.stringify({ slices: [{ ...PLAN.slices[0], id: "s2", test_plan: [] }] }));
      const before = readFileSync(path);
      const result = factory(repo, ["gate", RUN, "brief", "approved", "--now", NOW]);
      assert.deepEqual(result, { ok: false,
        out: "plan/slices.json changed since the brief gate was presented; re-present it before approving\n" });
      assert.deepEqual(readFileSync(path), before, "a refused approval must not touch the manifest");
      // Restoring the presented bytes lets the same approval through, so the guard binds bytes
      // rather than blocking the flow.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repo, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      const plan = join(repo, ".factory", RUN, "plan", "slices.json");
      const path = join(repo, ".factory", RUN, "run.json");
      // Approve plan A, then swap the file for a plan B nobody reviewed.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(decide(repo, "brief", "approved").ok, true);
      const swapped = { slices: [{ ...PLAN.slices[0], id: "s2", paths: ["other/"], test_plan: [] }] };
      writeFileSync(plan, JSON.stringify(swapped));
      const before = readFileSync(path);
      const result = factory(repo, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(result, { ok: false, out: "plan/slices.json is not the plan the brief gate approved\n" });
      assert.deepEqual(readFileSync(path), before);
      // The approved plan still seeds, so the guard binds bytes rather than blocking the flow.
      writeFileSync(plan, JSON.stringify(PLAN));
      assert.equal(factory(repo, ["slices-seed", RUN, "--now", NOW]).ok, true);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repo, "story", "approved").ok, true);
      const result = factory(repo, ["slices-seed", RUN, "--now", NOW]);
      const run = JSON.parse(readFileSync(join(repo, ".factory", RUN, "run.json"), "utf8"));
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repo, "story", "approved").ok, true);
      assert.equal(decide(repo, "brief", "approved").ok, true);
      const run = JSON.parse(readFileSync(join(repo, ".factory", RUN, "run.json"), "utf8"));
      assert.equal(run.gates.brief.status, "approved");
      assert.deepEqual(run.slices, []);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "approved-plan-uses-separate-first-seed",
    file: "skills/feature/SKILL.md",
    fragment: "Only after that approval succeeds, invoke the separate first seed",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repo, "story", "approved").ok, true);
      assert.equal(decide(repo, "brief", "approved").ok, true);
      const status = factory(repo, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(status.out).next, "seed-slices");
      return factory(repo, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "pending-brief-changes-loop-represents-revised-plan",
    file: "skills/feature/SKILL.md",
    fragment: "`pending` → `changes` → revise → `pending` → re-present → decision.",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      assert.equal(decide(repo, "story", "approved").ok, true);
      const planPath = join(repo, ".factory", RUN, "plan", "slices.json");
      writeFileSync(planPath, JSON.stringify(PLAN));
      assert.equal(factory(repo, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "brief", "changes", "--now", NOW]).ok, true);
      assert.deepEqual(JSON.parse(readFileSync(join(repo, ".factory", RUN, "run.json"), "utf8")).slices, []);
      const revised = { slices: [{ ...PLAN.slices[0], paths: ["src/revised/"] }] };
      writeFileSync(planPath, JSON.stringify(revised));
      assert.equal(factory(repo, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repo, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(JSON.parse(readFileSync(join(repo, ".factory", RUN, "run.json"), "utf8")).slices[0].paths, revised.slices[0].paths);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      assert.equal(decide(repo, "story", "approved").ok, true);
      const planPath = join(repo, ".factory", RUN, "plan", "slices.json");
      const presented = `${JSON.stringify(PLAN, null, 2)}\n`;
      writeFileSync(planPath, presented);
      assert.equal(decide(repo, "brief", "approved").ok, true);
      rmSync(planPath);
      const failed = factory(repo, ["slices-seed", RUN, "--now", NOW]);
      assert.equal(failed.ok, false);
      assert.match(failed.out, /^could not read plan\/slices\.json:/u);
      const status = JSON.parse(factory(repo, ["status", RUN, "--json"]).out);
      assert.equal(status.gates.brief, "approved");
      assert.deepEqual(status.slices, []);
      assert.equal(status.next, "seed-slices");
      writeFileSync(planPath, presented);
      assert.equal(readFileSync(planPath, "utf8"), presented);
      return factory(repo, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "approved-plan-reopens-before-byte-change",
    file: "skills/feature/SKILL.md",
    fragment: "reopen the approved\nBrief directly to `pending` **before mutating the plan**",
    expect: "allowed",
    matches: /seeded: 1/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      assert.equal(decide(repo, "story", "approved").ok, true);
      const planPath = join(repo, ".factory", RUN, "plan", "slices.json");
      const presented = JSON.stringify(PLAN);
      writeFileSync(planPath, presented);
      assert.equal(factory(repo, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "brief", "pending", "--now", NOW]).ok, true);
      assert.equal(readFileSync(planPath, "utf8"), presented);
      const revised = { slices: [{ ...PLAN.slices[0], test_plan: ["revised-test"] }] };
      writeFileSync(planPath, JSON.stringify(revised));
      assert.equal(factory(repo, ["gate", RUN, "brief", "pending", "--artifact", "artifacts/technical-brief.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repo, ["slices-seed", RUN, "--now", NOW]);
      assert.deepEqual(JSON.parse(readFileSync(join(repo, ".factory", RUN, "run.json"), "utf8")).slices[0].test_plan, revised.slices[0].test_plan);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"), JSON.stringify(PLAN));
      assert.equal(decide(repo, "story", "approved").ok, true);
      assert.equal(decide(repo, "brief", "approved").ok, true);
      assert.equal(factory(repo, ["step", RUN, "test-verifier", "running", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "pre_pr", "pending", "--now", NOW]).ok, true);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "active-driver-owns-state-transitions",
    file: "skills/feature/SKILL.md",
    fragment: "The active run driver owns every state-changing `factory` command for\nits run.",
    expect: "allowed",
    matches: /"story": "pending"/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "interactive-child-session-a-handoff",
    file: "skills/feature/SKILL.md",
    fragment: "For an interactive child, an orderly pending-gate handoff is complete only after all of these actions:",
    expect: "allowed",
    matches: /"lock": "absent"[\s\S]*"story": "pending"/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      const artifact = join(repo, ".factory", RUN, "artifacts", "story.md");
      writeFileSync(artifact, "story\n");
      assert.equal(factory(repo, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(existsSync(artifact), true);
      const run = JSON.parse(readFileSync(join(repo, ".factory", RUN, "run.json"), "utf8"));
      assert.deepEqual(run.gates.story, { status: "pending", at: null, artifact: "artifacts/story.md" });
      const pending = JSON.parse(factory(repo, ["status", RUN, "--json"]).out);
      assert.equal(pending.mode, "interactive");
      assert.equal(pending.gates.story, "pending");
      assert.equal(pending.lock_session, "session-a");
      assert.equal(factory(repo, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      const result = factory(repo, ["status", RUN, "--json"]);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      const runDir = join(repo, ".factory", RUN);
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
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", artifacts.story, "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "approved", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "brief", "pending", "--artifact", artifacts.brief, "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "brief", "approved", "--now", NOW]).ok, true);
      const result = factory(repo, ["gate", RUN, "pre_pr", "pending", "--artifact", artifacts.pre_pr, "--now", NOW]);
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
    id: "fresh-session-b-approves",
    file: "skills/feature/SKILL.md",
    fragment: "`approve` runs `factory gate \"$R\" \"$GATE\" approved --repo \"$RUN_REPO\"`.",
    expect: "allowed",
    matches: /gate: story\nstatus: approved/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repo, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      const parentStatus = JSON.parse(factory(repo, ["status", RUN, "--json"]).out);
      assert.equal(parentStatus.mode, "interactive");
      assert.equal(parentStatus.gates.story, "pending");
      assert.equal(parentStatus.lock, "absent");
      assert.equal(factory(repo, ["lock", RUN, "claim", "--session", "session-b", "--now", NOW]).ok, true);
      const childStatus = JSON.parse(factory(repo, ["status", RUN, "--json"]).out);
      assert.equal(childStatus.lock_session, "session-b");
      assert.equal(childStatus.gates.story, "pending");
      const result = factory(repo, ["gate", RUN, "story", "approved", "--now", NOW]);
      assert.equal(JSON.parse(factory(repo, ["status", RUN, "--json"]).out).next, "gate:brief");
      return result;
    },
  },
  {
    id: "fresh-session-b-changes-and-represents",
    file: "skills/feature/SKILL.md",
    fragment: "`changes-at-gate:<name>`, revises only the affected stage, and re-presents it pending.",
    expect: "allowed",
    matches: /gate: story\nstatus: pending/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repo, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["lock", RUN, "claim", "--session", "session-b", "--now", NOW]).ok, true);
      const verified = JSON.parse(factory(repo, ["status", RUN, "--json"]).out);
      assert.equal(verified.mode, "interactive");
      assert.equal(verified.gates.story, "pending");
      assert.equal(verified.lock_session, "session-b");
      assert.equal(factory(repo, ["gate", RUN, "story", "changes", "--now", NOW]).ok, true);
      assert.equal(JSON.parse(factory(repo, ["status", RUN, "--json"]).out).next, "changes-at-gate:story");
      writeFileSync(join(repo, ".factory", RUN, "artifacts", "story.md"), "revised story\n");
      return factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]);
    },
  },
  {
    id: "fresh-session-b-stops-unlocked-and-nonterminal",
    file: "skills/feature/SKILL.md",
    fragment: "This is an unlocked\n  nonterminal stop: do not terminalize it",
    expect: "allowed",
    matches: /"lock": "absent"[\s\S]*"story": "stop"[\s\S]*"terminal_result": null[\s\S]*"next": "stopped-at-gate:story"/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      writeFileSync(join(repo, ".factory", RUN, "artifacts", "story.md"), "story\n");
      assert.equal(factory(repo, ["lock", RUN, "claim", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["lock", RUN, "release", "--session", "session-a", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["lock", RUN, "claim", "--session", "session-b", "--now", NOW]).ok, true);
      const verified = JSON.parse(factory(repo, ["status", RUN, "--json"]).out);
      assert.equal(verified.mode, "interactive");
      assert.equal(verified.gates.story, "pending");
      assert.equal(verified.lock_session, "session-b");
      assert.equal(factory(repo, ["gate", RUN, "story", "stop", "--now", NOW]).ok, true);
      const stopped = JSON.parse(factory(repo, ["status", RUN, "--json"]).out);
      assert.equal(stopped.next, "stopped-at-gate:story");
      assert.equal(stopped.terminal_result, null);
      assert.equal(factory(repo, ["lock", RUN, "release", "--session", "session-b", "--now", NOW]).ok, true);
      const result = factory(repo, ["status", RUN, "--json"]);
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
      seeded(repo);
      assert.equal(decide(repo, "story", "approved").ok, true);
      return factory(repo, ["gate", RUN, "story", "pending", "--now", NOW]);
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
      assert.equal(factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW]).ok, true);
      assert.equal(decide(repo, "story", "approved").ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      return factory(repo, ["status", RUN, "--json"]);
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
      seeded(repo);
      assert.equal(decide(repo, "story", "changes").ok, true);
      // The revision is a *different* document, which is the point: a decided gate's artifact is
      // frozen, so pointing at the new one has to go through the re-open.
      assert.equal(factory(repo, ["gate", RUN, "story", "pending", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      assert.equal(factory(repo, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW]).ok, true);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "pre-pr-may-reopen",
    file: "skills/feature/SKILL.md",
    fragment: "factory gate <run-id> pre_pr pending",
    expect: "allowed",
    matches: /status: pending/u,
    act(repo) {
      seeded(repo);
      // Decided as `changes` rather than `approved`: approving pre_pr runs the publication check,
      // which this claim is not about.
      assert.equal(decide(repo, "pre_pr", "changes").ok, true, "a decided gate is the precondition");
      return factory(repo, ["gate", RUN, "pre_pr", "pending", "--now", NOW]);
    },
  },
  {
    id: "publication-needs-all-three-gates",
    file: "skills/feature/SKILL.md",
    fragment: "**all three gates currently approved**",
    expect: "refused",
    matches: /every gate must be approved; not approved: story\(absent\)/u,
    act(repo) {
      seeded(repo);
      // pre_pr alone, which is all the old check consulted.
      return decide(repo, "pre_pr", "approved");
    },
  },
  {
    id: "merge-needs-two-parents",
    file: "skills/feature/SKILL.md",
    fragment: "refuses a merge commit that does not have exactly two parents",
    expect: "refused",
    matches: /has 1 parent; a slice merge must be a two-parent merge \(use --no-ff\)/u,
    act(repo) {
      const base = activateSlice(repo);
      // Everything the merge proof needs *except* two parents, so only that rule can explain the
      // refusal — the masking trap this suite keeps rediscovering.
      const observed = factory(repo, ["observe", RUN, "s1", "--worktree", ".", "--base", base,
        "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW]);
      assert.match(observed.out, /review_ready: true/u, observed.out);
      const head = execFileSync("git", ["rev-parse", "slice"], { cwd: repo, encoding: "utf8" }).trim();
      writeFileSync(join(repo, ".factory", RUN, "reviews", "s1.json"), JSON.stringify({
        subject: "s1", reviewer: "work-reviewer", verdict: "APPROVE", attempt: 1,
        reviewed_commit: head, findings: [], required_fixes: [], checked_against: ["brief"],
      }));
      factory(repo, ["slice", RUN, "s1", "review", "--evidence-ref", "evidence/s1.json",
        "--review-ref", "reviews/s1.json", "--now", NOW]);
      execFileSync("git", ["checkout", "-q", "feature"], { cwd: repo });
      execFileSync("git", ["merge", "-q", "--ff-only", "slice"], { cwd: repo });
      const merged = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      return factory(repo, ["slice", RUN, "s1", "merged", "--merge-commit", merged, "--now", NOW]);
    },
  },
  {
    id: "base-ref-immutable-after-activation",
    file: "skills/feature/SKILL.md",
    fragment: "`base_ref` is fixed when the slice is activated and cannot be changed afterwards",
    expect: "refused",
    matches: /base_ref is immutable once recorded/u,
    act(repo) {
      const base = activateSlice(repo);
      assert.match(String(base), /^[0-9a-f]{40}$/u, "activation must report the base it recorded");
      // Move the branch, then re-activate. The CLI observes the *new* head, so if base_ref were
      // writable twice this would silently re-point the slice's diff baseline.
      execFileSync("git", ["checkout", "-q", "feature"], { cwd: repo });
      writeFileSync(join(repo, "src", "later.ts"), "later\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "later"], { cwd: repo });
      return factory(repo, ["slice", RUN, "s1", "running", "--worktree", ".", "--branch", "slice", "--now", NOW]);
    },
  },
  {
    id: "init-needs-no-branch-or-worktree",
    file: "skills/feature/SKILL.md",
    fragment: "**Do not ask the engineer for a branch or a worktree.**",
    expect: "allowed",
    matches: /branch: feature\/app-1\nworktree: \./u,
    act(repo) {
      // The whole invocation an orchestrator should need. Both required flags are gone, and what was
      // recorded is reported back so the branch it must create is not left implicit.
      return factory(repo, ["init", RUN, "--now", NOW]);
    },
  },
  {
    id: "pr-base-uses-configured-worktree",
    file: "skills/feature/SKILL.md",
    fragment: "By default, `pr_base` is the symbolic branch checked out in that configured worktree",
    expect: "allowed",
    matches: /worktree: configured\npr_base: integration/u,
    act(repo) {
      addWorktree(repo);
      const initialized = factory(repo, ["init", RUN, "--worktree", "configured", "--now", NOW]);
      assert.equal(initialized.ok, true, initialized.out);
      const status = factory(repo, ["status", RUN, "--json"]);
      assert.equal(status.ok, true, status.out);
      assert.equal(JSON.parse(status.out).pr_base, "integration");
      return initialized;
    },
  },
  {
    id: "pr-base-override-bypasses-worktree-observation",
    file: "skills/feature/SKILL.md",
    fragment: "`--pr-base <target-branch>` takes precedence and bypasses worktree",
    expect: "allowed",
    matches: /worktree: missing\npr_base: release\/1/u,
    act(repo) {
      const initialized = factory(repo, ["init", RUN, "--worktree", "missing", "--pr-base", "release/1", "--now", NOW]);
      assert.equal(initialized.ok, true, initialized.out);
      const status = factory(repo, ["status", RUN, "--json"]);
      assert.equal(status.ok, true, status.out);
      assert.equal(JSON.parse(status.out).pr_base, "release/1");
      return initialized;
    },
  },
  {
    id: "detached-pr-base-is-refused",
    file: "skills/feature/SKILL.md",
    fragment: "Without an override, a detached, missing, or outside-repository configured worktree is",
    expect: "refused",
    matches: /could not observe a symbolic branch in PR base worktree '\.'; pass --pr-base <branch> explicitly/u,
    act(repo) {
      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
      const result = factory(repo, ["init", RUN, "--now", NOW]);
      assert.equal(existsSync(join(repo, ".factory", RUN)), false);
      return result;
    },
  },
  {
    id: "missing-pr-base-worktree-is-refused",
    file: "skills/feature/SKILL.md",
    fragment: "Without an override, a detached, missing, or outside-repository configured worktree is",
    expect: "refused",
    matches: /PR base worktree 'missing' is not observable/u,
    act(repo) {
      const result = factory(repo, ["init", RUN, "--worktree", "missing", "--now", NOW]);
      assert.equal(existsSync(join(repo, ".factory", RUN)), false);
      return result;
    },
  },
  {
    id: "outside-pr-base-worktree-is-refused",
    file: "skills/feature/SKILL.md",
    fragment: "Without an override, a detached, missing, or outside-repository configured worktree is",
    expect: "refused",
    matches: /PR base worktree '\.\.' is not observable/u,
    act(repo) {
      const result = factory(repo, ["init", RUN, "--worktree", "..", "--now", NOW]);
      assert.equal(existsSync(join(repo, ".factory", RUN)), false);
      return result;
    },
  },
  {
    id: "existing-new-manifest-is-resumed-not-reinitialized",
    file: "skills/feature/SKILL.md",
    fragment: "do not call `factory init` again.",
    expect: "refused",
    matches: /run 'app-1' already exists; run 'factory status app-1 --json' and resume/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      const path = join(repo, ".factory", RUN, "run.json");
      const before = readFileSync(path, "utf8");
      const result = factory(repo, ["init", RUN, "--pr-base", "other", "--now", NOW]);
      assert.equal(readFileSync(path, "utf8"), before);
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
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "existing-legacy-manifest-is-resumed-not-backfilled",
    file: "skills/feature/SKILL.md",
    fragment: "existing manifest is never replaced,",
    expect: "refused",
    matches: /run 'app-1' already exists; run 'factory status app-1 --json' and resume/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      const path = removePrBase(repo);
      const before = readFileSync(path, "utf8");
      const result = factory(repo, ["init", RUN, "--pr-base", "other", "--now", NOW]);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(Object.hasOwn(JSON.parse(before), "pr_base"), false);
      return result;
    },
  },
  {
    id: "scaffold-only-init-is-retryable",
    file: "skills/feature/SKILL.md",
    fragment: "A scaffold-only run directory without\n`run.json` is retryable.",
    expect: "allowed",
    matches: /pr_base: feature/u,
    act(repo) {
      mkdirSync(join(repo, ".factory", RUN, "plan"), { recursive: true });
      return factory(repo, ["init", RUN, "--now", NOW]);
    },
  },
  {
    id: "new-status-exposes-pr-base",
    file: "skills/feature/SKILL.md",
    fragment: "resolve the unknown create outcome with",
    expect: "allowed",
    matches: /pr_base: feature/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      const json = factory(repo, ["status", RUN, "--json"]);
      assert.equal(JSON.parse(json.out).pr_base, "feature");
      return factory(repo, ["status", RUN]);
    },
  },
  {
    id: "unknown-init-outcome-stops-on-invalid-manifest",
    file: "skills/feature/SKILL.md",
    fragment: "an invalid manifest means stop and surface it without overwriting it.",
    expect: "allowed",
    matches: /"valid": false[\s\S]*"error": "run: unknown keys: unexpected"/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      const path = join(repo, ".factory", RUN, "run.json");
      const run = JSON.parse(readFileSync(path, "utf8"));
      run.unexpected = true;
      writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
      const before = readFileSync(path, "utf8");
      const result = factory(repo, ["status", RUN, "--json"]);
      assert.equal(readFileSync(path, "utf8"), before);
      return result;
    },
  },
  {
    id: "unknown-init-outcome-stops-on-missing-steps-manifest",
    file: "skills/feature/SKILL.md",
    fragment: "an invalid manifest means stop and surface it without overwriting it.",
    expect: "allowed",
    matches: /"valid": false[\s\S]*steps/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      const path = join(repo, ".factory", RUN, "run.json");
      const run = JSON.parse(readFileSync(path, "utf8"));
      delete run.steps;
      writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
      const before = readFileSync(path);
      let result;
      assert.doesNotThrow(() => { result = factory(repo, ["status", RUN, "--json"]); });
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
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      const path = removePrBase(repo);
      const before = readFileSync(path, "utf8");
      const plain = factory(repo, ["status", RUN]);
      assert.equal(plain.out.includes("pr_base:"), false);
      const result = factory(repo, ["status", RUN, "--json"]);
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
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "github-issue-forms-select-one-cli-run",
    file: "skills/feature/SKILL.md",
    fragment: "Recognize an issue reference only when the entire remainder is exactly one of\n   these standalone forms: a positive decimal integer (`205`), that integer prefixed by `#` (`#205`),\n   or a canonical `https://github.com/<owner>/<repo>/issues/<positive-decimal>` URL.",
    expect: "allowed",
    matches: /"run_id": "205"/u,
    act(repo) {
      const prose = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
      assert.match(prose, /A recognized GitHub issue URL is issue input and is removed\s+from design-source consideration\./u);
      assert.match(prose, /`unresolvable issue reference: <unchanged reference>` and stop; do not derive `R`, initialize a run, or\s+fall through to `story-writer`\./u);
      assert.match(prose, /For all three issue forms, `R` is the resolved issue's canonical positive decimal `number`/u);
      const references = [
        "205",
        "#205",
        "https://github.com/jasoncarreira/opencode-feature-factory/issues/205",
      ];
      const runIds = references.map((reference) => {
        const match = /^(?:#?([1-9]\d*)|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/([1-9]\d*))$/u
          .exec(reference);
        assert.ok(match, `issue reference was not recognized: ${reference}`);
        return match[1] ?? match[2];
      });
      assert.deepEqual(runIds, ["205", "205", "205"]);
      const initialized = factory(repo, ["init", runIds[0], "--now", NOW]);
      assert.equal(initialized.ok, true, initialized.out);
      for (const runId of runIds) {
        const status = factory(repo, ["status", runId, "--json"]);
        assert.equal(status.ok, true, status.out);
        assert.equal(JSON.parse(status.out).run_id, "205");
      }
      return factory(repo, ["status", runIds.at(-1), "--json"]);
    },
  },
  {
    // The handoff the intake depends on. Resolving the reference deterministically is worthless if the
    // specialist it hands the payload to then does its own lookup: the resolution would go back to
    // whichever tools happen to be configured, which is the nondeterminism this whole change removes.
    //
    // What this proves, stated exactly, because an earlier version of this comment overstated it:
    // `story-reader` declares no forge tool and no general fetch capability, so it cannot retrieve a
    // GitHub issue by any route. Grant it bash, webfetch or a forge tool and this fails.
    //
    // What it does NOT prove: that no lookup happens at all. The agent necessarily keeps its Atlassian
    // tools for the Jira-key branch, and a test cannot show they go uncalled when a payload arrives.
    // That half rests on the prompt, which is why the prompt must not contradict itself — the lead
    // instruction routes on which input was handed over instead of unconditionally saying "pull it",
    // and the fragment below is what fails if the no-lookup rule is reworded away.
    id: "supplied-payload-needs-no-lookup",
    file: "agents/story-reader.md",
    fragment: "as `ISSUE_PAYLOAD`. Then **perform no external lookup at all**: no Jira call, no forge call, nothing.",
    expect: "allowed",
    matches: /"run_id": "app-1"/u,
    act(repo) {
      const reader = readFileSync(join(pkg, "agents", "story-reader.md"), "utf8");
      const declared = (/^tools:(.*)$/mu.exec(reader)?.[1] ?? "")
        .split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
      assert.ok(declared.length > 0, "story-reader must declare its tools");
      for (const capable of ["bash", "webfetch", "write", "edit"]) {
        assert.ok(!declared.includes(capable),
          `story-reader must not declare ${capable}; it could fetch or mutate an issue with it`);
      }
      for (const tool of declared) {
        assert.ok(!tool.includes("github") && !tool.includes("gitlab"),
          `story-reader must not declare a forge tool (${tool}); the orchestrator owns the fetch`);
      }
      // The lead instruction must route on which input arrived. Unconditional "pull it" contradicted
      // the payload branch, and a contradictory prompt makes behaviour depend on which sentence wins.
      const lead = reader.slice(reader.indexOf("# Story reader"), reader.indexOf("## Inputs"));
      assert.match(lead, /which of the two inputs below you were handed/u,
        "the lead instruction must route on the input, not command a pull");
      assert.doesNotMatch(lead, /A Jira ticket already exists for this work\. Pull it/u,
        "the unconditional pull instruction must not return");
      // The other half of the contract: the skill must hand the payload over as normalization input
      // rather than as a key to resolve, or the specialist has nothing to normalize.
      const prose = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
      assert.match(prose, /give the captured payload to `story-reader` only as\s+supplied normalization input/u);

      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "no-mode-persists-interactive",
    file: "skills/feature/SKILL.md",
    fragment: "With no recognized leading mode token, omit `--mode`; existing `factory init` records\n     `interactive`.",
    expect: "allowed",
    matches: /"mode": "interactive"/u,
    act(repo) {
      const initialized = factory(repo, ["init", RUN, "--now", NOW]);
      assert.equal(initialized.ok, true, initialized.out);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "autonomous-mode-persists",
    file: "skills/feature/SKILL.md",
    fragment: "`--autonomous` maps only to `factory init --mode autonomous`.",
    expect: "allowed",
    matches: /"mode": "autonomous"/u,
    act(repo) {
      const initialized = factory(repo, ["init", RUN, "--mode", "autonomous", "--now", NOW]);
      assert.equal(initialized.ok, true, initialized.out);
      return factory(repo, ["status", RUN, "--json"]);
    },
  },
  {
    id: "headless-mode-persists",
    file: "skills/feature/SKILL.md",
    fragment: "terminalize with reason exactly `headless run reached a human gate`:",
    expect: "allowed",
    matches: /"status": "needs-human"[\s\S]*"mode": "headless"[\s\S]*"terminal_result": \{\s*"status": "needs-human",\s*"reason": "headless run reached a human gate"\s*\}[\s\S]*"next": "terminal:needs-human"/u,
    act(repo) {
      const initialized = factory(repo, ["init", RUN, "--mode", "headless", "--now", NOW]);
      assert.equal(initialized.ok, true, initialized.out);
      assert.equal(factory(repo, ["terminal", RUN, "needs-human", "--reason", "headless run reached a human gate", "--now", NOW]).ok, true);
      const result = factory(repo, ["status", RUN, "--json"]);
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
