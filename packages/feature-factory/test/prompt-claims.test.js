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
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"),
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
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"),
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
      writeFileSync(join(repo, ".factory", RUN, "plan", "slices.json"),
        JSON.stringify({ slices: [withoutTestPlan] }));
      return factory(repo, ["slices-seed", RUN, "--now", NOW]);
    },
  },
  {
    id: "agents-may-read-never-write",
    file: "skills/feature/SKILL.md",
    fragment: "A subagent may read —\n`factory status <run-id> --json` to orient itself — and may never write.",
    expect: "allowed",
    matches: /"valid": true/u,
    act(repo) {
      seeded(repo);
      return factory(repo, ["status", RUN, "--json"]);
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
    matches: /every gate must be approved; not approved: story\(absent\), brief\(absent\)/u,
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
      return factory(repo, ["init", RUN, "--worktree", "configured", "--now", NOW]);
    },
  },
  {
    id: "pr-base-override-bypasses-worktree-observation",
    file: "skills/feature/SKILL.md",
    fragment: "`--pr-base <target-branch>` takes precedence and bypasses worktree",
    expect: "allowed",
    matches: /worktree: missing\npr_base: release\/1/u,
    act(repo) {
      return factory(repo, ["init", RUN, "--worktree", "missing", "--pr-base", "release/1", "--now", NOW]);
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
    id: "legacy-status-exposes-null-only-in-json",
    file: "skills/feature/SKILL.md",
    fragment: "For a legacy manifest where `pr_base` is absent or null, stop and",
    expect: "allowed",
    matches: /"pr_base": null/u,
    act(repo) {
      assert.equal(factory(repo, ["init", RUN, "--now", NOW]).ok, true);
      removePrBase(repo);
      const plain = factory(repo, ["status", RUN]);
      assert.equal(plain.out.includes("pr_base:"), false);
      return factory(repo, ["status", RUN, "--json"]);
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
