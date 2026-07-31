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
  writeFileSync(join(repo, ".gitignore"), ".factory/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return repo;
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
];

const PROMPT_CONTRACTS = [
  {
    id: "supplied-entry-is-explicit-and-canonical",
    file: "skills/feature/SKILL.md",
    fragments: [
      "Accepts either an idea or ticket through story, research/design,",
      "an explicitly caller-supplied implementation spec that is",
      "Both entries converge on the same observed build,",
      "Choose supplied-spec entry only when the caller explicitly says an implementation spec is authoritative",
      "copy the caller's spec content verbatim",
      "$REPO/.factory/<run-id>/artifacts/technical-brief.md",
      "adds no CLI argument, command, mode, schema, `run.json` key, or discriminator",
    ],
  },
  {
    id: "supplied-entry-skips-only-authoring-stages",
    file: "skills/feature/SKILL.md",
    fragments: [
      "Skip Step 1 entirely on the supplied route. Do not invoke `story-reader`, `story-writer`,",
      "`codebase-researcher`, or `design-interpreter`, and do not fabricate any of their artifacts.",
      "Do not invoke `work-decomposer`.",
      "Never research, infer, invent a missing portion, or fall back to the story route.",
      "is untrusted operator\ndata under the threat boundary even after verification",
      "Verification creates no sandboxing, hostile-host protection, or adversarial-filesystem guarantee.",
    ],
  },
  {
    id: "supplied-spec-lifecycle-delays-acceptance",
    file: "skills/feature/SKILL.md",
    fragments: [
      "factory step <run-id> spec-writer running --attempts N",
      "A `REFUSED` response creates no plan.",
      "factory step <run-id> spec-writer rejected --attempts N",
      "begin attempt `N+1` as `running`",
      "On `VERIFIED`, invoke `work-reviewer` with the canonical artifact and the exact verification response.",
      "On reviewer REJECT, persist `reviews/spec-writer.json`",
      "--attempts N --review-ref reviews/spec-writer.json",
      "deliberately retain `running`",
      "Do not mark the step `accepted` yet",
      "Respect\n`max_retries`; exhaustion becomes `blocked`/`needs-human`",
      "factory step <run-id> spec-writer accepted",
      "factory slices-seed <run-id> --from plan/slices.json",
    ],
  },
  {
    id: "supplied-spec-plan-is-one-deterministic-backend-slice",
    file: "skills/feature/SKILL.md",
    fragments: [
      "\"id\": \"supplied-spec\"",
      "\"stack\": \"backend\"",
      "\"paths\": [\"<path_lane entries verbatim and in order>\"]",
      "\"depends_on\": []",
      "\"acceptance\": [\"<acceptance_criteria entries verbatim and in order>\"]",
      "\"test_plan\": [\"<test_plan entries verbatim and in order>\"]",
      "For a verified waiver, `test_plan` is `[]`.",
      "Add no fields, derive no paths, reorder nothing, split no\ncriteria, and create no additional slice.",
      "# Supplied-spec slice plan",
      "- Builder: `backend-builder`",
      "Waived: <verbatim test_waiver reason>",
    ],
  },
  {
    id: "supplied-spec-gates-are-combined-and-ordered",
    file: "skills/feature/SKILL.md",
    fragments: [
      "factory gate <run-id> story pending --artifact artifacts/technical-brief.md",
      "factory gate <run-id> brief pending --artifact plan/plan.md",
      "Present the verified spec and one-slice plan together.",
      "In interactive mode, await both decisions",
      "record Story first, and decide Brief only after Story approves",
      "In headless mode, write both existing\ngate questions and artifact refs, record `needs-human`",
      "stop before approval, step acceptance, or\nseeding",
      "there is no plan-only mutation",
      "If Story was approved before\nBrief requested changes, reopen Story",
      "A `stop` decision follows existing terminal behavior and never accepts or seeds.",
      "before they become immutable",
    ],
  },
  {
    id: "supplied-spec-autonomous-gates-have-per-gate-preconditions",
    file: "skills/feature/SKILL.md",
    fragments: [
      "latest attempt is `VERIFIED`, `work-reviewer` approved that exact verification and artifact",
      "no\nproduct, UX, security, external-policy, or implementation decision remains",
      "every acceptance criterion\nmaps to `supplied-spec`",
      "`paths` exactly equal the ordered `path_lane`",
      "`test_plan` exactly equals\nthe verified plan or is `[]` for the verified waiver",
      "No decomposition review is required because no\ndecomposition was authored.",
      "A failed precondition records\n`needs-human`; it never causes fallback, acceptance, or seeding.",
    ],
  },
  {
    id: "supplied-spec-resume-needs-no-new-state",
    file: "skills/feature/SKILL.md",
    fragments: [
      "Once Gate 1 opens, its `artifacts/technical-brief.md` artifact proves the supplied route",
      "a recorded `spec-writer` step plus `artifacts/technical-brief.md` while Story is\n  absent proves the supplied route",
      "durable records do not prove the\n  required explicit selection",
      "Never infer a route or fall back.",
      "resumes at plan generation and the combined\n  checkpoint, not at agent invocation",
      "If both gates are approved while the step remains `running`, accept it and seed without another\n  checkpoint.",
      "If the step is accepted but unseeded, seed the unchanged approved JSON.",
      "fixed slice id `supplied-spec` preserves orientation",
    ],
  },
  {
    id: "supplied-spec-reuses-build-test-and-publication",
    file: "skills/feature/SKILL.md",
    fragments: [
      "isolation,\nobservation, review/retry, two-parent merge, and ownership refusal all remain mandatory",
      "dispatch the sole `backend-builder`",
      "Pass no fabricated story, research-map, or design-brief artifact.",
      "verified `acceptance_criteria` as the acceptance source",
      "automatic omission needs no new discriminator, mode, `run.json` key,\n   CLI command, or contract",
      "if a verdict was\n  recorded anyway it must still approve and still name the current head",
      "preserve this push, draft-PR, idempotency, and readiness-recheck behavior unchanged",
      "report the verified supplied spec instead of a nonexistent story",
    ],
  },
  {
    id: "supplied-spec-test-budget-is-ratified",
    file: "skills/feature/SKILL.md",
    fragments: [
      "syntactic test-site budget is 83 of 83 with no slack",
      "table rows or assertions inside the existing `prompt-claims.test.js` callback",
      "any genuinely necessary new `it(`/`test(` site must be raised with its reason at Gate 2",
    ],
  },
  {
    id: "spec-writer-has-two-truthful-input-forms",
    file: "agents/spec-writer.md",
    fragments: [
      "Authors a concrete technical brief from an approved story, research map, and optional",
      "or verifies an explicitly labelled caller-supplied implementation spec",
      "There are exactly two input forms. Missing normal inputs does not select supplied-spec verification.",
      "### Normal authoring form",
      "### Supplied-spec verification form",
      "explicitly labels the call as **supplied-spec verification**",
      "Read the supplied artifact without modifying it.",
      "model: opus\neffort: xhigh\nrole: planning\ntools: Read, Grep, Glob",
    ],
  },
  {
    id: "spec-writer-verification-is-fail-closed",
    file: "agents/spec-writer.md",
    fragments: [
      "A finite, non-empty **path lane** of concrete repository-relative files or directories.",
      "Globs, placeholders, and phrases such as “related files” are ambiguous.",
      "A finite, non-empty **acceptance criteria** list with no TBDs or unstated decisions.",
      "Exactly one of a finite, non-empty **test plan** list or an explicit **test waiver**",
      "Return exactly one of the following JSON schemas and no additional fields or prose.",
      "supplying both a test plan and a waiver is ambiguous",
      "Report every defective category in one pass.",
      "Do not research, infer, rewrite, author a replacement, suggest invented content, invoke another agent, or fall back to normal authoring.",
    ],
  },
  {
    id: "spec-writer-verification-schemas-are-exact",
    file: "agents/spec-writer.md",
    fragments: [
      "\"status\": \"VERIFIED\",\n  \"artifact\": \"artifacts/technical-brief.md\",\n  \"path_lane\": [\"non-empty string\"],\n  \"acceptance_criteria\": [\"non-empty string\"],\n  \"test_plan\": [\"non-empty string\"],\n  \"test_waiver\": null",
      "Exactly one of a non-empty `test_plan` or a non-empty `test_waiver` is present.",
      "For a waiver, return `test_plan: []` and the verbatim non-empty reason in `test_waiver`.",
      "\"status\": \"REFUSED\",\n  \"artifact\": \"artifacts/technical-brief.md\",\n  \"missing\": [\"path lane\"],\n  \"ambiguous\": []",
      "`missing` and `ambiguous` may contain only `path lane`, `acceptance criteria`, and `test plan or explicit test waiver`.",
      "At least one array must be non-empty, and each category appears at most once across both arrays.",
    ],
  },
];

describe("prose claims about what the CLI permits", () => {
  for (const claim of [...PROMPT_CONTRACTS, ...CLAIMS]) {
    it(`${claim.id}: ${claim.expect ?? "static"}`, () => {
      // The fragment must still be in the prose. Reword the prose and this fails, which is the point:
      // the claim and its proof cannot drift apart quietly.
      const prose = readFileSync(join(pkg, claim.file), "utf8");
      if (claim.fragments) {
        for (const fragment of claim.fragments) {
          assert.ok(prose.includes(fragment),
            `${claim.file} no longer contains the static prompt contract:\n  ${fragment}`);
        }
        return;
      }
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
