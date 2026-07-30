// Observe, don't trust.
//
// viso: "A subagent's report is a claim. Before you accept a build/test step you
// re-derive the diff and re-run its named tests yourself, write the observed
// evidence, and let work-reviewer judge that - never the prose."
//
// This module is that sentence, mechanized. It is the reason `factory observe`
// exists as a command rather than as an instruction: in an autonomous run nobody
// checks whether the orchestrator actually re-ran anything.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const EVIDENCE_KEYS = Object.freeze([
  "subject", "run_id", "attempt", "branch", "base_ref", "worktree", "status", "blocked_reason",
  "files_changed", "diff_stat", "diff_observed", "commands", "tests", "commit",
  "observed_by", "review_ready", "claim_reconciliation",
]);

export function git(cwd, args, { runner = spawnSync } = {}) {
  const result = runner("git", args, { cwd, encoding: "utf8", shell: false });
  const status = Number.isInteger(result?.status) ? result.status : null;
  return {
    ok: status === 0,
    status,
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
    argv: ["git", ...args],
  };
}

// Every fact below is re-derived from the repository. A caller-supplied value is
// never substituted for an observation; if git cannot answer, the field is null
// and `diff_observed` is false, which blocks review_ready.
// `options.ref` names what to observe, defaulting to HEAD. A caller that knows the
// subject's branch should pass it: binding to whatever happens to be checked out
// makes the observation depend on the orchestrator's current directory state, and a
// merge legitimately checks out the integration branch in the same worktree.
export function observeWorktree(worktree, baseRef, options = {}) {
  const ref = options.ref ?? "HEAD";
  const commands = [];
  const record = (result) => {
    commands.push({ cmd: result.argv.join(" "), exit: result.status, summary: summarize(result) });
    return result;
  };

  const head = record(git(worktree, ["rev-parse", ref], options));
  const names = record(git(worktree, ["diff", "--name-only", `${baseRef}...${ref}`], options));
  const stat = record(git(worktree, ["diff", "--stat", `${baseRef}...${ref}`], options));

  const observed = head.ok && names.ok && stat.ok;
  return {
    commit: head.ok ? head.stdout.trim() : null,
    files_changed: names.ok ? names.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [],
    diff_stat: stat.ok ? stat.stdout.trim() : null,
    diff_observed: observed,
    commands,
  };
}

// Attack 7: a caller may present any head it likes. Ancestry is asked of git, and
// git's exit codes are read precisely: 0 is "is an ancestor", 1 is "proven not",
// anything else is a failed probe that must not be read as either.
export function observeAncestry(worktree, ancestor, descendant, options = {}) {
  const probe = git(worktree, ["merge-base", "--is-ancestor", ancestor, descendant], options);
  if (probe.ok) return "ancestor";
  if (probe.status === 1) return "not-ancestor";
  return "indeterminate";
}

export function observeTree(worktree, ref, options = {}) {
  const probe = git(worktree, ["rev-parse", `${ref}^{tree}`], options);
  return probe.ok ? probe.stdout.trim() : null;
}

// Attack 1: the test command is run here, by us, and its exit code is recorded
// from the process rather than from anybody's report. `observed: false` means we
// could not run it, which is not the same as a pass.
export function runTests(worktree, command, { runner = spawnSync, skipReason = null } = {}) {
  if (!command) {
    // Finding 1: this used to default skipped_reason to "no test command declared",
    // and deriveReviewReady accepts any nonempty reason - so omitting --test-cmd
    // manufactured its own excuse and produced review_ready: true. viso's rule is
    // "observed green, or explicitly skipped with a reason"; an omission is not an
    // explicit anything. A skip reason now only exists if the caller declared one.
    return { cmd: null, exit: null, observed: false, skipped_reason: skipReason };
  }
  const result = runner(command[0], command.slice(1), { cwd: worktree, encoding: "utf8", shell: false });
  const exit = Number.isInteger(result?.status) ? result.status : null;
  return { cmd: command.join(" "), exit, observed: exit !== null, skipped_reason: null };
}

// viso's rule, verbatim: completed, non-empty files_changed, tests observed and
// passing (or explicitly skipped with a reason), and diff_observed.
export function deriveReviewReady(evidence) {
  if (evidence.status !== "completed") return false;
  if (!Array.isArray(evidence.files_changed) || evidence.files_changed.length === 0) return false;
  if (evidence.diff_observed !== true) return false;
  const tests = evidence.tests ?? {};
  if (tests.observed === true) return tests.exit === 0;
  // A skip is only acceptable when a reason was recorded. Absent tests with no
  // reason is the shape a fabricated pass would take.
  return typeof tests.skipped_reason === "string" && tests.skipped_reason.trim().length > 0;
}

// A claim that disagrees with observation is a finding, not the truth. The
// disagreement is recorded rather than resolved: the reviewer judges it.
export function reconcileClaim(claim, observation) {
  if (claim === null || claim === undefined) return { claimed: false, mismatches: [] };
  const mismatches = [];
  const compare = (field, claimed, observed) => {
    if (claimed === undefined || claimed === null) return;
    if (Array.isArray(claimed) && Array.isArray(observed)) {
      const claimedSet = [...claimed].sort().join("\n");
      const observedSet = [...observed].sort().join("\n");
      if (claimedSet !== observedSet) mismatches.push({ field, claimed, observed });
      return;
    }
    if (claimed !== observed) mismatches.push({ field, claimed, observed });
  };
  compare("commit", claim.commit, observation.commit);
  compare("files_changed", claim.files_changed, observation.files_changed);
  compare("status", claim.status, observation.status);
  // The important one: a claimed passing test against an observed failure or an
  // unobserved run.
  if (claim.tests?.exit !== undefined && claim.tests.exit !== null) {
    compare("tests.exit", claim.tests.exit, observation.tests?.exit ?? null);
  }
  return { claimed: true, mismatches };
}

// Attack 5: a slice may only change paths it declared. Ownership is decided on the
// observed file list, never on the builder's report of what it touched.
export function unownedPaths(filesChanged, declaredPaths) {
  if (!Array.isArray(declaredPaths) || declaredPaths.length === 0) return [...filesChanged];
  return filesChanged.filter((file) => !declaredPaths.some((declared) => coversPath(declared, file)));
}

function coversPath(declared, file) {
  const normalizedDeclared = declared.replace(/\/+$/u, "");
  if (file === normalizedDeclared) return true;
  // A directory declaration covers its subtree; a prefix that is not a path
  // boundary does not, so "src/app" must not cover "src/application/x".
  return file.startsWith(`${normalizedDeclared}/`);
}

// Privileged control-plane paths are refused for every slice regardless of what it
// declared: a builder that edits the factory's own state is not doing the work it
// was dispatched for.
const PRIVILEGED_PREFIXES = Object.freeze([".claude/factory", ".opencode/factory", ".git"]);
const PRIVILEGED_EXACT = Object.freeze([".gitignore", "package.json", "package-lock.json"]);

export function privilegedPaths(filesChanged) {
  return filesChanged.filter((file) => PRIVILEGED_PREFIXES.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
    || PRIVILEGED_EXACT.includes(file));
}

export function buildEvidence({ subject, runId, attempt, branch, baseRef, worktree, status, blockedReason = null, claim = null, testCommand = null, skipReason = null, options = {} }) {
  const observation = observeWorktree(worktree, baseRef, options);
  const tests = runTests(worktree, testCommand, { ...options, skipReason });
  const evidence = {
    subject,
    // Finding 2: evidence carried no run identity, so a record from another run with a
    // matching subject was accepted and merged.
    run_id: runId ?? null,
    attempt,
    branch,
    base_ref: baseRef,
    worktree,
    status,
    blocked_reason: blockedReason,
    files_changed: observation.files_changed,
    diff_stat: observation.diff_stat,
    diff_observed: observation.diff_observed,
    commands: observation.commands,
    tests,
    commit: observation.commit,
    observed_by: "orchestrator",
    review_ready: false,
    claim_reconciliation: { claimed: false, mismatches: [] },
  };
  evidence.review_ready = deriveReviewReady(evidence);
  evidence.claim_reconciliation = reconcileClaim(claim, evidence);
  // A claim that disagrees with what we observed cannot be review-ready: the
  // disagreement is itself the finding.
  if (evidence.claim_reconciliation.mismatches.length > 0) evidence.review_ready = false;
  return evidence;
}

export function resolveWorktree(repo, worktree) {
  const absolute = resolve(repo, worktree);
  const rel = relative(resolve(repo), absolute);
  if (rel.startsWith("..") || rel.startsWith(sep) || !existsSync(absolute)) return null;
  return absolute;
}

function summarize(result) {
  const text = (result.ok ? result.stdout : result.stderr).trim().split("\n")[0] ?? "";
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export const EVIDENCE_DIR = "evidence";
export const evidenceRef = (subject) => join(EVIDENCE_DIR, `${subject}.json`);
