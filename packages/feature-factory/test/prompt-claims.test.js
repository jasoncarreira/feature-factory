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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return repo;
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
  writeFileSync(join(repo, ".claude", "factory", RUN, "plan", "slices.json"), JSON.stringify(PLAN));
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
      writeFileSync(join(repo, ".claude", "factory", RUN, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], paths: ["src/", "lib/"] }] }));
      return factory(repo, ["slices-seed", RUN, "--now", NOW]);
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
      writeFileSync(join(repo, ".claude", "factory", RUN, "plan", "slices.json"),
        JSON.stringify({ slices: [{ ...PLAN.slices[0], test_plan: [] }] }));
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
      writeFileSync(join(repo, ".claude", "factory", RUN, "plan", "slices.json"),
        JSON.stringify({ slices: [withoutTestPlan] }));
      return factory(repo, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "agents-may-read-never-write",
    file: "skill/SKILL.md",
    fragment: "A subagent may read —\n`factory status <run-id> --json` to orient itself — and may never write.",
    expect: "allowed",
    matches: /"valid": true/u,
    act(repo) {
      seeded(repo);
      return factory(repo, ["status", RUN, "--json"]);
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
