#!/usr/bin/env node
// Every mutating command uses a checked transition and atomic compare-and-swap rename.
// Initialization alone creates run.json through atomic no-clobber publication.
// The orchestrator calls this CLI instead of writing control-plane state directly.
// Flags are declared per command; unknown options fail rather than becoming missing fields.
// Schema validation surrounds every state write.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { nextAction, readRun, readRunUnchecked } from "../state/index.js";
import { transition } from "../state/transition.js";
import { buildEvidence, evidenceRef, git, observeAncestry, observeWorktree, privilegedPaths, proveInitContainment, resolveWorktree, unownedPaths } from "../observe/index.js";
import { assertPublicationReady, assertReviewBinding, observeMergeProof, readEvidence, readReview, readValidatorReview } from "../observe/review.js";
import { writeProtectedJsonAtomic } from "../core/atomic-write.js";
import { dispatchInitPublication } from "./init-publication.js";
import { CONTROL_PLANE, SCHEMA_VERSION, GATE_NAMES, GATE_STATUSES, MODES, SLICE_STATUSES, STEP_STATUSES, TERMINAL_STATUSES, validateRun } from "../state/schema.js";
import {
  claimSessionLock, inspectSessionLock, refreshSessionLock, releaseSessionLock, SessionLockHeldError,
} from "../state/session-lock.js";

export const COMMANDS = Object.freeze({
  init: Object.freeze(["--repo", "--branch", "--worktree", "--pr-base", "--issue", "--mode", "--max-parallel-slices", "--max-retries", "--now", "--json"]),
  status: Object.freeze(["--repo", "--json"]),
  // No --force: `lock <id> steal` is the same operation with a name that says what it
  // does, and two spellings of "take someone else's lock" is one too many.
  lock: Object.freeze(["--repo", "--session", "--branch", "--ttl-ms", "--now", "--json"]),
  heartbeat: Object.freeze(["--repo", "--session", "--now", "--json"]),
  gate: Object.freeze(["--repo", "--artifact", "--now", "--json"]),
  step: Object.freeze(["--repo", "--attempts", "--review-ref", "--evidence-ref", "--now", "--json"]),
  terminal: Object.freeze(["--repo", "--reason", "--now", "--json"]),
  "slices-seed": Object.freeze(["--repo", "--from", "--now", "--json"]),
  slice: Object.freeze(["--repo", "--attempts", "--worktree", "--branch", "--evidence-ref", "--review-ref", "--merge-commit", "--now", "--json"]),
  // No --skip-tests-reason: whether a slice needs tests is ratified in its test_plan at
  // seeding, not asserted at observation time by the party being observed.
  observe: Object.freeze(["--repo", "--worktree", "--base", "--attempt", "--test-cmd", "--repository-verify", "--claim", "--status", "--blocked-reason", "--now", "--json"]),
  validator: Object.freeze(["--repo", "--report", "--now", "--json"]),
  pr: Object.freeze(["--repo", "--url", "--now", "--json"]),
});

const BOOLEAN_FLAGS = new Set(["--json", "--repository-verify"]);
const INIT_OPERATIONS = Object.freeze({
  cwd: () => process.cwd(), resolvePath: resolve, joinPath: join,
  realpath: realpathSync, lstat: lstatSync, mkdir: mkdirSync, readdir: readdirSync,
  runGit: git, prove: proveInitContainment, publish: dispatchInitPublication,
});

class CliError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CliError";
  }
}

export async function run(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return usage();
  if (!Object.hasOwn(COMMANDS, command)) throw new CliError(`unknown command '${command}' (try --help)`);
  const { positional, flags } = parse(command, rest);
  const handler = HANDLERS[command];
  return handler(positional, flags);
}

function parse(command, args) {
  const allowed = COMMANDS[command];
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!allowed.includes(arg)) throw new CliError(`unknown option '${arg}' for '${command}'`);
    if (BOOLEAN_FLAGS.has(arg)) {
      flags[key(arg)] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`${arg} requires a value`);
    flags[key(arg)] = value;
    index += 1;
  }
  return { positional, flags };
}

const key = (flag) => flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());

function planDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Read when the gate is *presented*, not when it is approved. Approval-time hashing left a window:
// present plan A, edit plan/slices.json to plan B while the gate is still pending, approve, and the
// approval hashes B - so the digest proved the seed matched what the approval command read rather
// than what a human was shown. Presenting is the moment the plan is put in front of somebody, and
// the skill already says to reopen the gate to `pending` before mutating the plan, so a legitimate
// revision re-presents and re-binds. A presentation with no plan file is refused: the plan is the
// artifact that gate exists to review.
function presentedPlanDigest(runDir) {
  try {
    return planDigest(readFileSync(join(runDir, "plan/slices.json")));
  } catch (error) {
    throw new CliError(`could not read plan/slices.json to bind the brief presentation: ${error.message}`);
  }
}

// `pending` binds the presented bytes. `approved` keeps that binding and refuses if the file has
// moved since, so the window between presentation and decision is closed rather than re-hashed.
// Any other decision clears it: nothing is bound until a plan is presented again.
function briefDigestFor(decision, state, runDir) {
  if (decision === "pending") return presentedPlanDigest(runDir);
  if (decision !== "approved") return null;
  if (!state.plan_digest) throw new CliError("the brief gate was not presented; move it to pending first");
  if (state.plan_digest !== presentedPlanDigest(runDir)) {
    throw new CliError("plan/slices.json changed since the brief gate was presented; re-present it before approving");
  }
  return state.plan_digest;
}

function runDirFor(flags, runId) {
  if (!runId) throw new CliError("a <run-id> is required");
  return join(resolve(flags.repo ?? process.cwd()), CONTROL_PLANE, runId);
}

// The integration branch's worktree and currently observed head. Three call sites asked
// this in four lines each with slightly different wording. The branch is named explicitly
// rather than observed as HEAD: recording a merge legitimately runs with a different
// branch checked out, and binding to whatever happens to be there makes the observation
// depend on the orchestrator's directory state.
//
// `commit` may be null — an unobservable head is a different refusal at each call site,
// so the decision stays with the caller rather than being flattened here.
function integrationHead(repo, run) {
  const worktree = resolveWorktree(repo, run.worktree);
  if (!worktree) throw new CliError(`integration worktree '${run.worktree}' is not observable`);
  return { worktree, commit: observeWorktree(worktree, run.branch, { ref: run.branch }).commit };
}

class RepositoryConfigError extends Error {}

function requireIntegrationWorktree(repo, run, suppliedWorktree) {
  let repository;
  let committed;
  let supplied;
  try {
    repository = realpathSync(resolve(repo));
    const committedPath = resolveWorktree(repository, run.worktree);
    const suppliedPath = resolveWorktree(repository, suppliedWorktree);
    committed = committedPath ? realpathSync(committedPath) : null;
    supplied = suppliedPath ? realpathSync(suppliedPath) : null;
  } catch {
    committed = null;
    supplied = null;
  }
  if (!repository || !committed || !supplied || committed !== supplied
    || resolveWorktree(repository, committed) !== committed || resolveWorktree(repository, supplied) !== supplied) {
    throw new CliError(`integration worktree mismatch: committed '${run.worktree}' resolves to '${committed ?? "unobservable"}', supplied '${suppliedWorktree}' resolves to '${supplied ?? "unobservable"}'`);
  }
  const branch = git(committed, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const observedBranch = branch.ok && branch.stdout.trim() ? branch.stdout.trim() : "detached HEAD";
  if (observedBranch !== run.branch) {
    throw new CliError(`integration worktree must have branch '${run.branch}' checked out; observed ${observedBranch}`);
  }
  const head = git(committed, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tip = git(committed, ["rev-parse", "--verify", `refs/heads/${run.branch}^{commit}`]);
  const headSha = head.ok ? head.stdout.trim() : "";
  const tipSha = tip.ok ? tip.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/u.test(headSha) || !/^[0-9a-f]{40}$/u.test(tipSha) || headSha !== tipSha) {
    throw new CliError(`integration HEAD must equal the current recorded branch tip for '${run.branch}'`);
  }
  return { worktree: committed, head: headSha };
}

function readRepositoryVerify(worktree, { optional = false } = {}) {
  let bytes;
  try {
    bytes = readFileSync(join(worktree, ".factory.json"), "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new RepositoryConfigError("invalid .factory.json");
  }
  let config;
  try {
    config = JSON.parse(bytes);
  } catch {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  const keys = ["publish", "publishing_identity", "resolve", "verify"];
  if (!config || typeof config !== "object" || Array.isArray(config)
    || JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(keys)
    || keys.some((keyName) => typeof config[keyName] !== "string" || !config[keyName].trim())) {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  return config.verify;
}

function branchPoint(run) {
  const base = run.slices.find((slice) => Array.isArray(slice.depends_on) && slice.depends_on.length === 0)?.base_ref;
  if (!/^[0-9a-f]{40}$/u.test(base ?? "")) throw new CliError("first seeded root slice has no immutable 40-character base_ref");
  return base;
}

async function writeObservedEvidence({ runDir, runId, subject, attempt, branch, baseRef, worktree, status, blockedReason, claim, testCommand, skipReason, shellCommand }) {
  const evidence = buildEvidence({
    subject, attempt, branch, baseRef, worktree, status, blockedReason, claim, runId,
    testCommand, skipReason, shellCommand,
  });
  const ancestry = observeAncestry(worktree, baseRef, "HEAD");
  if (ancestry !== "ancestor") {
    evidence.review_ready = false;
    evidence.blocked_reason = evidence.blocked_reason ?? `base ${baseRef} is ${ancestry} of HEAD`;
  }
  await writeProtectedJsonAtomic(runDir, evidenceRef(subject), evidence);
  return { evidence, ancestry };
}

function classifyRepositoryVerifyEvidence(runDir, runId, head, verifyCommand) {
  let evidence;
  try {
    evidence = readEvidence(runDir, evidenceRef("test-verifier"), { runId });
  } catch {
    return { kind: "unknown", evidence: null };
  }
  if (evidence.subject !== "test-verifier" || evidence.run_id !== runId
    || evidence.commit !== head || evidence.tests?.cmd !== verifyCommand) {
    return { kind: "unknown", evidence };
  }
  if (evidence.tests.observed === true && evidence.tests.exit === 0 && evidence.review_ready === true) {
    return { kind: "green", evidence };
  }
  return { kind: "failed", evidence };
}

function repositoryVerifyRefusal(mergeCommit, evidence) {
  if (evidence.tests?.observed === true && Number.isInteger(evidence.tests.exit) && evidence.tests.exit !== 0) {
    return `factory config entry 'verify' failed after recorded merge ${mergeCommit} with exit status ${evidence.tests.exit}; merged slice remains recorded; stop before advancing.`;
  }
  if (evidence.tests?.exit === null || evidence.tests?.observed !== true) {
    return `factory config entry 'verify' failed after recorded merge ${mergeCommit}; exit status unavailable; merged slice remains recorded; stop before advancing.`;
  }
  return `factory config entry 'verify' was not review_ready after recorded merge ${mergeCommit}: ${evidence.blocked_reason ?? "review readiness was not established"}; merged slice remains recorded; stop before advancing.`;
}

function mergedPayload(runId, sliceId, row) {
  return { run_id: runId, slice: sliceId, status: row.status, attempts: row.attempts, base_ref: row.base_ref, merge_commit: row.merge_commit };
}

async function verifyRecordedMerge({ repo, runDir, runId, mergeCommit }) {
  const run = readRun(runDir);
  const integration = requireIntegrationWorktree(repo, run, run.worktree);
  if (integration.head !== mergeCommit) {
    throw new CliError(`integration HEAD must equal recorded merge ${mergeCommit} before repository verification`);
  }
  const baseRef = branchPoint(run);
  let verifyCommand;
  try {
    verifyCommand = readRepositoryVerify(integration.worktree, { optional: true });
  } catch (error) {
    if (error instanceof RepositoryConfigError) {
      throw new CliError(`factory config entry 'verify' unavailable after recorded merge ${mergeCommit}: invalid .factory.json; merged slice remains recorded; stop before advancing.`);
    }
    throw error;
  }
  if (verifyCommand === null) return null;
  const { evidence } = await writeObservedEvidence({
    runDir, runId, subject: "test-verifier", attempt: 1, branch: run.branch,
    baseRef, worktree: integration.worktree, status: "completed",
    blockedReason: null, claim: null, testCommand: verifyCommand, skipReason: null, shellCommand: true,
  });
  const classified = classifyRepositoryVerifyEvidence(runDir, runId, integration.head, verifyCommand);
  if (classified.kind !== "green") throw new CliError(repositoryVerifyRefusal(mergeCommit, evidence));
  return evidence;
}

const HANDLERS = {
  async validator([runId], flags) {
    if (!flags.report) throw new CliError("factory validator requires --report");
    const runDir = runDirFor(flags, runId);
    const repo = resolve(flags.repo ?? process.cwd());
    const at = stamp(flags);
    // Neither the verdict nor the head is an argument any more. Both come from the
    // validator's own record, which must name the integration head as observed right now —
    // otherwise a report about one commit could be recorded as a verdict on another.
    const head = integrationHead(repo, readRun(runDir));
    const review = readValidatorReview(runDir, head.commit);
    const next = await transition(runDir, {
      participants: [{ familyId: "verdict", mode: "record" }],
      apply: (state) => ({
        ...state,
        updated_at: at,
        validator: {
          verdict: review.verdict,
          report: flags.report,
          // Attack 4: the verdict names the head it judged, so a later consumer can
          // refuse it once that head moves.
          reviewed_head: review.reviewed_commit,
          loops: (state.validator?.loops ?? 0) + (state.validator ? 1 : 0),
        },
      }),
    });
    return emit(flags, { run_id: runId, verdict: next.validator.verdict, reviewed_head: next.validator.reviewed_head, loops: next.validator.loops });
  },

  async pr([runId], flags) {
    if (!flags.url) throw new CliError("factory pr requires --url");
    const runDir = runDirFor(flags, runId);
    const repo = resolve(flags.repo ?? process.cwd());
    const run = readRun(runDir);
    const at = stamp(flags);

    // Re-asked rather than assumed from Gate 3's approval: between the two the head can
    // move, a slice can regress, and a gate can be re-opened, and `pr` is where the record
    // becomes permanent. The rules live in one place, including the requirement that all
    // three gates are approved *now* — this handler used to check pre_pr on its own, which
    // is how a re-opened Story gate went unnoticed.
    const reobservers = new Map();
    reobservers.set("verdict", async ({ nextState }) => {
      assertPublicationReady({
        runDir, state: nextState, runId,
        observeHead: () => integrationHead(repo, nextState).commit,
      });
    });

    const next = await transition(runDir, {
      participants: [{ familyId: "verdict", mode: "publish" }],
      reobservers,
      apply: (state) => {
        // Attacks 9 and 10: recording the same PR twice is the crash-replay path and
        // must be idempotent; recording a different one is a second PR and is refused
        // by the verdict contract.
        if (state.pr_url === flags.url) return { ...state, updated_at: at };
        return { ...state, updated_at: at, pr_url: flags.url };
      },
    });
    return emit(flags, { run_id: runId, pr_url: next.pr_url, idempotent: run.pr_url === flags.url });
  },

  async ["slices-seed"]([runId], flags) {
    const runDir = runDirFor(flags, runId);
    const from = flags.from ?? "plan/slices.json";
    let bytes;
    try {
      bytes = readFileSync(join(runDir, from));
    } catch (error) {
      throw new CliError(`could not read ${from}: ${error.message}`);
    }
    let plan;
    try {
      plan = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new CliError(`could not read ${from}: ${error.message}`);
    }
    if (!Array.isArray(plan?.slices)) throw new CliError(`${from} must have top-level shape { "slices": [...] }`);
    if (plan.slices.length === 0) throw new CliError(`${from} has no slices`);
    const at = stamp(flags);
    const next = await transition(runDir, {
      participants: [{ familyId: "slices", mode: "seed" }],
      apply: (state) => {
        if (state.slices.length > 0) throw new Error("slices are already seeded");
        // The gate approved bytes, not a filename. Without this the ordering fix is prose: a plan
        // revised after approval seeds unreviewed `paths` and `test_plan`, immutable from here, an
        // empty test_plan among them. Absent digest refuses rather than waves through - re-approving
        // the brief gate records one, and the gate may re-open while the plan is unseeded.
        // Guarded on approval so the gates contract keeps its own refusal when the gate is not
        // approved at all; this one answers "approved, but is this what was approved".
        if (state.gates.brief?.status === "approved") {
          if (!state.plan_digest) throw new Error("the brief gate approved no plan digest; re-approve it before seeding");
          if (state.plan_digest !== planDigest(bytes)) throw new Error(`${from} is not the plan the brief gate approved`);
        }
        if (state.gates.brief?.status !== "approved") throw new Error("slices-seed requires the Brief gate to be approved");
        return {
          ...state,
          updated_at: at,
          slices: plan.slices.map((slice) => ({
            id: slice.id,
            stack: slice.stack,
            depends_on: slice.depends_on ?? [],
            status: "pending",
            worktree: null,
            branch: null,
            attempts: 1,
            // The ratification point: the gate approved these paths and this test plan,
            // so they are the set every later merge is judged against and the decision
            // about whether this slice may ship without an observed test run.
            //
            // Stored with NO default. `test_plan ?? []` turned an omitted field into the
            // approved-empty exemption, so a plan that never mentioned tests silently
            // waived them - the CLI defeating the schema rule that was supposed to make
            // that impossible. The schema rejects a missing or non-array value.
            paths: slice.paths,
            test_plan: slice.test_plan,
            evidence_ref: null,
            review_ref: null,
            merge_commit: null,
          })),
        };
      },
    });
    return emit(flags, { run_id: runId, seeded: next.slices.length, slices: next.slices.map((slice) => slice.id) });
  },

  async slice([runId, sliceId, status], flags) {
    if (!SLICE_STATUSES.includes(status)) throw new CliError(`status must be one of ${SLICE_STATUSES.join(" | ")}`);
    const runDir = runDirFor(flags, runId);
    const repo = resolve(flags.repo ?? process.cwd());
    const at = stamp(flags);

    // The branch point is observed rather than supplied, so a stale or convenient base
    // cannot be passed in.
    //
    // A boundary re-observation was added here and reverted: it guarded the window
    // between this read and the commit, but only a second writer of the integration ref
    // can open that window, and there is one orchestrator issuing sequential commands.
    // The parallelism in a wave is between builders, not between writers of the control
    // plane. It bought a retry failure path on correct runs for a race the design does
    // not have. If concurrent orchestrators on one run ever become real, it comes back.
    let observedBase = null;
    if (status === "running") {
      const current = readRun(runDir);
      const head = integrationHead(repo, current);
      if (!head.commit) throw new CliError(`could not observe the head of '${current.branch}' to bind the slice base`);
      observedBase = head.commit;
    }
    if (status === "merged" && !flags.mergeCommit) throw new CliError("recording a merge requires --merge-commit");

    if (status === "merged") {
      const current = readRun(runDir);
      const existing = current.slices.find((slice) => slice.id === sliceId);
      if (!existing) throw new CliError(`unknown slice '${sliceId}'`);
      if (existing.status === "merged") {
        if (flags.mergeCommit !== existing.merge_commit) {
          throw new CliError(`slice '${sliceId}' is already recorded at immutable merge_commit ${existing.merge_commit}`);
        }
        const integration = requireIntegrationWorktree(repo, current, current.worktree);
        if (integration.head !== existing.merge_commit) {
          throw new CliError(`recorded merge ${existing.merge_commit} replay cannot reconcile the current integration head; do not re-execute factory config entry 'verify'.`);
        }
        let verifyCommand;
        try {
          verifyCommand = readRepositoryVerify(integration.worktree, { optional: true });
        } catch (error) {
          if (error instanceof RepositoryConfigError) {
            throw new CliError(`factory config entry 'verify' unavailable after recorded merge ${existing.merge_commit}: invalid .factory.json; merged slice remains recorded; stop before advancing.`);
          }
          throw error;
        }
        if (verifyCommand !== null) {
          const classified = classifyRepositoryVerifyEvidence(runDir, runId, integration.head, verifyCommand);
          if (classified.kind === "failed") throw new CliError(repositoryVerifyRefusal(existing.merge_commit, classified.evidence));
          if (classified.kind === "unknown") {
            throw new CliError(`post-merge verify outcome is unknown for recorded merge ${existing.merge_commit}; merged slice remains recorded; terminalize needs-human without re-executing factory config entry 'verify'.`);
          }
        }
        return emit(flags, mergedPayload(runId, sliceId, existing));
      }
    }

    // For a merge, the contract's reobserve hook demands freshly observed paths.
    // The observer is supplied here and runs inside the transition.
    const reobservers = new Map();
    if (status === "merged") {
      reobservers.set("slices", async (slice) => {
        const worktree = resolveWorktree(repo, slice.worktree ?? "");
        if (!worktree) return { diff_observed: false, unowned: [], privileged: [] };
        const run = readRun(runDir);
        // Observe the slice's own branch, not the worktree's current HEAD: recording
        // a merge legitimately happens with the integration branch checked out.
        if (!slice.branch) throw new Error(`slice '${slice.id}' cannot merge without a recorded branch`);
        // Diff from the slice's recorded branch point, not from the integration head:
        // by merge time the integration branch contains the slice, so that diff is
        // empty and ownership would pass vacuously.
        if (!slice.base_ref) throw new Error(`slice '${slice.id}' cannot merge without a recorded base_ref`);
        const observation = observeWorktree(worktree, slice.base_ref, { ref: slice.branch });

        // Attack 3: the approval must have judged the commit being merged. Read the
        // slice's own head from git rather than trusting anything recorded.
        // Finding 2: `observe` wrote evidence that nothing consumed, so a merge could
        // be recorded with no observed diff and no test run at all - the whole
        // observe-don't-trust mechanism was a write-only side effect. Evidence is now
        // required, must be review_ready, and must describe this slice at this attempt
        // against this base and this head.
        if (!slice.evidence_ref) throw new Error(`slice '${slice.id}' cannot merge without an evidence_ref`);
        const evidence = readEvidence(runDir, slice.evidence_ref, { runId });
        if (evidence.subject !== slice.id) {
          throw new Error(`evidence '${slice.evidence_ref}' describes '${evidence.subject}', not '${slice.id}'`);
        }
        if (evidence.review_ready !== true) {
          throw new Error(`slice '${slice.id}' evidence is not review_ready${evidence.blocked_reason ? `: ${evidence.blocked_reason}` : ""}`);
        }
        if (evidence.attempt !== slice.attempts) {
          throw new Error(`evidence '${slice.evidence_ref}' is for attempt ${evidence.attempt}, slice is at attempt ${slice.attempts}`);
        }
        if (evidence.base_ref !== slice.base_ref) {
          throw new Error(`evidence '${slice.evidence_ref}' observed base ${String(evidence.base_ref).slice(0, 12)}, slice base is ${String(slice.base_ref).slice(0, 12)}`);
        }
        if (!slice.review_ref) throw new Error(`slice '${slice.id}' cannot merge without a review_ref`);
        const review = readReview(runDir, slice.review_ref);
        assertReviewBinding({
          review, ref: slice.review_ref, observedHead: observation.commit,
          subject: slice.id, attempt: slice.attempts,
        });
        if (evidence.commit !== observation.commit) {
          throw new Error(`evidence '${slice.evidence_ref}' observed ${String(evidence.commit).slice(0, 12)} but the slice head is ${String(observation.commit).slice(0, 12)}`);
        }

        // Attack 2: the merge proof, observed in the integration worktree.
        //
        // Finding 1: the proof validated a caller-supplied object without checking it
        // landed on the integration branch, so a synthetic two-parent merge, or an older
        // valid merge after the branch advanced, both passed. An orchestrator that
        // captured the sha before merging, or reused a stale variable, produces exactly
        // that. The recorded merge must be the branch's current tip.
        const tip = integrationHead(repo, run);
        if (!tip.commit) throw new Error(`could not observe the head of '${run.branch}'`);
        if (tip.commit !== flags.mergeCommit) {
          throw new Error(`merge commit ${String(flags.mergeCommit).slice(0, 12)} is not the head of '${run.branch}' (${tip.commit.slice(0, 12)}); record the merge before advancing the branch`);
        }
        const proof = observeMergeProof(tip.worktree, {
          baseRef: slice.base_ref,
          reviewedCommit: review.reviewed_commit,
          mergeCommit: flags.mergeCommit,
        });
        if (!proof.proven) {
          throw new Error(`slice '${slice.id}' merge proof failed: ${proof.reason}`);
        }

        return {
          diff_observed: observation.diff_observed,
          unowned: unownedPaths(observation.files_changed, slice.paths),
          privileged: privilegedPaths(observation.files_changed),
        };
      });
    }

    const next = await transition(runDir, {
      participants: [{ familyId: "slices", mode: status === "merged" ? "merge" : "record" }],
      reobservers,
      apply: (state) => {
        const existing = state.slices.find((slice) => slice.id === sliceId);
        if (!existing) throw new Error(`unknown slice '${sliceId}'`);
        const row = {
          ...existing,
          status,
          attempts: flags.attempts === undefined ? existing.attempts : integer(flags.attempts, 1, "--attempts"),
          worktree: flags.worktree ?? existing.worktree,
          branch: flags.branch ?? existing.branch,
          base_ref: observedBase ?? existing.base_ref,
          evidence_ref: flags.evidenceRef ?? existing.evidence_ref,
          review_ref: flags.reviewRef ?? existing.review_ref,
          merge_commit: flags.mergeCommit ?? existing.merge_commit,
        };
        return { ...state, updated_at: at, slices: state.slices.map((slice) => (slice.id === sliceId ? row : slice)) };
      },
    });
    const row = next.slices.find((slice) => slice.id === sliceId);
    // base_ref is reported because this command is what establishes it, and the very next
    // step needs it: `observe --base` is compared for exact equality against this value at
    // merge time. The skill previously said to read it from `factory status`, which does not
    // expose it — so the documented path could not be followed at all.
    if (status === "merged") await verifyRecordedMerge({ repo, runDir, runId, mergeCommit: row.merge_commit });
    return emit(flags, mergedPayload(runId, sliceId, row));
  },

  async observe([runId, subject], flags) {
    if (!subject) throw new CliError("factory observe requires <subject>");
    if (!flags.worktree || !flags.base) throw new CliError("factory observe requires --worktree and --base");
    if (flags.repositoryVerify && flags.testCmd !== undefined) {
      throw new CliError("--repository-verify is mutually exclusive with --test-cmd");
    }
    if (flags.repositoryVerify && subject !== "test-verifier") {
      throw new CliError("--repository-verify is valid only for test-verifier");
    }
    const runDir = runDirFor(flags, runId);
    const repo = resolve(flags.repo ?? process.cwd());
    const run = readRun(runDir);
    const integration = flags.repositoryVerify ? requireIntegrationWorktree(repo, run, flags.worktree) : null;
    const worktree = integration?.worktree ?? resolveWorktree(repo, flags.worktree);
    if (!worktree) throw new CliError(`worktree '${flags.worktree}' is not inside the repository`);

    let repositoryVerifyCommand = null;
    if (flags.repositoryVerify) {
      const expectedBase = branchPoint(run);
      if (flags.base !== expectedBase) throw new CliError(`--base must equal the first seeded root slice base_ref ${expectedBase}`);
      try {
        repositoryVerifyCommand = readRepositoryVerify(worktree);
      } catch (error) {
        if (error instanceof RepositoryConfigError) throw new CliError("invalid .factory.json");
        throw error;
      }
    }

    let claim = null;
    if (flags.claim) {
      try {
        claim = JSON.parse(readFileSync(resolve(repo, flags.claim), "utf8"));
      } catch (error) {
        throw new CliError(`could not read --claim: ${error.message}`);
      }
    }

    // Whether this subject may be review-ready without an observed test run is read from
    // the ratified plan, not supplied. `--skip-tests-reason` was the flag this replaces:
    // it let the orchestrator write its own exemption at the moment of observation, and
    // any nonempty string was accepted, so "no tests needed" was a valid reason to ship
    // untested code. An empty test_plan is the same exemption, decided at Gate 2 by the
    // human who owns that call.
    //
    // A subject with no slice row - test-verifier, an agent step - has no ratified
    // waiver and so has none: its tests must be observed.
    const slice = run.slices.find((entry) => entry.id === subject);
    if (slice && flags.testCmd !== undefined
      && !slice.test_plan.some((entry) => entry === flags.testCmd)) {
      throw new CliError(
        `test command for slice '${subject}' must exactly match one ratified test_plan entry; `
        + `expected ${JSON.stringify(slice.test_plan)}; received ${JSON.stringify(flags.testCmd)}`,
      );
    }
    const skipReason = slice && slice.test_plan.length === 0
      ? `test_plan for '${subject}' was approved empty at slices-seed`
      : null;

    const { evidence, ancestry } = await writeObservedEvidence({
      runDir, runId, subject,
      attempt: flags.attempt === undefined ? 1 : integer(flags.attempt, 1, "--attempt"),
      branch: flags.repositoryVerify ? run.branch : flags.branch ?? null,
      baseRef: flags.base, worktree, status: flags.status ?? "completed",
      blockedReason: flags.blockedReason ?? null, claim,
      testCommand: flags.repositoryVerify ? repositoryVerifyCommand : flags.testCmd ? flags.testCmd.split(" ").filter(Boolean) : null,
      skipReason, shellCommand: flags.repositoryVerify === true,
    });
    return emit(flags, {
      run_id: runId, subject, evidence_ref: evidenceRef(subject),
      review_ready: evidence.review_ready, files_changed: evidence.files_changed.length,
      tests: evidence.tests.observed ? `exit ${evidence.tests.exit}` : `skipped: ${evidence.tests.skipped_reason}`,
      ancestry, mismatches: evidence.claim_reconciliation.mismatches.map((entry) => entry.field),
    });
  },
  async init(positional, flags) {
    return dispatchInit(positional, flags);
  },

  status([runId], flags) {
    const runDir = runDirFor(flags, runId);
    const observed = readRunUnchecked(runDir);
    if (!observed.ok) return emit(flags, { run_id: runId, valid: false, sandbox_path: resolve(flags.repo ?? process.cwd()), error: observed.error });
    let run;
    try {
      run = readRun(runDir);
    } catch (error) {
      // A record that exists but does not validate is reported, not hidden: the
      // operator needs to see the invalid state, not an absence.
      return emit(flags, { run_id: runId, valid: false, sandbox_path: resolve(flags.repo ?? process.cwd()), error: error.message });
    }
    const lock = inspectSessionLock(runDir);
    return emit(flags, {
      run_id: run.run_id,
      issue_key: run.issue_key ?? null,
      valid: true, sandbox_path: resolve(flags.repo ?? process.cwd()),
      status: run.status,
      mode: run.mode,
      branch: run.branch,
      pr_base: run.pr_base ?? null,
      lock: lock.state, dead_lock: !run.terminal_result && lock.state === "stale",
      lock_session: lock.owner?.session ?? null,
      gates: Object.fromEntries(GATE_NAMES.filter((name) => run.gates[name]).map((name) => [name, run.gates[name].status])),
      steps: run.steps.map((step) => `${step.agent}:${step.status}(${step.attempts})`),
      slices: run.slices.map((slice) => `${slice.id}:${slice.status}(${slice.attempts})`),
      validator: run.validator?.verdict ?? null,
      pr_url: run.pr_url,
      terminal_result: run.terminal_result,
      next: nextAction(run),
    });
  },

  async lock([runId, action], flags) {
    const runDir = runDirFor(flags, runId);
    const ttlMs = flags.ttlMs === undefined ? undefined : integer(flags.ttlMs, undefined, "--ttl-ms");
    const now = flags.now ? Date.parse(flags.now) : undefined;
    try {
      if (action === "claim" || action === "steal") {
        const owner = await claimSessionLock(runDir, {
          session: flags.session, runId, branch: flags.branch, now, ttlMs, force: action === "steal",
        });
        return emit(flags, { run_id: runId, action, session: owner.session, stolen_from: owner.stolen_from?.session ?? null });
      }
      if (action === "release") {
        const released = await releaseSessionLock(runDir, { session: flags.session });
        return emit(flags, { run_id: runId, action, ...released });
      }
      // `inspect` was here and is gone: `factory status` already reports the lock state
      // and its owning session, so this was a second way to ask one question.
    } catch (error) {
      if (error instanceof SessionLockHeldError) {
        throw new CliError(`${error.message}\n  resume with --session ${error.owner.session}, or take it with 'lock ${runId} steal'`);
      }
      throw error;
    }
    throw new CliError("factory lock requires <claim|steal|release>");
  },

  async heartbeat([runId], flags) {
    const runDir = runDirFor(flags, runId);
    const owner = await refreshSessionLock(runDir, {
      session: flags.session,
      now: flags.now ? Date.parse(flags.now) : undefined,
    });
    return emit(flags, { run_id: runId, heartbeat_at: owner.heartbeat_at });
  },

  async gate([runId, name, decision], flags) {
    if (!GATE_NAMES.includes(name)) throw new CliError(`gate must be one of ${GATE_NAMES.join(" | ")}`);
    if (!GATE_STATUSES.includes(decision)) throw new CliError(`decision must be one of ${GATE_STATUSES.join(" | ")}`);
    const runDir = runDirFor(flags, runId);
    const repo = resolve(flags.repo ?? process.cwd());
    const at = stamp(flags);

    // Gate 3's approval is what authorizes publication, and in the skill's flow it is the
    // last transition before the branch is pushed and the PR is created. Readiness was
    // checked only in `factory pr`, which runs after both of those effects - it could
    // report a bad publication but not prevent one. The gates contract refuses a pre_pr
    // approval that arrives with no observer registered, so this cannot go quiet.
    const reobservers = new Map();
    if (name === "pre_pr" && decision === "approved") {
      reobservers.set("gates", async ({ nextState }) => {
        assertPublicationReady({
          runDir, state: nextState, runId,
          observeHead: () => integrationHead(repo, nextState).commit,
        });
      });
    }

    const next = await transition(runDir, {
      participants: [{ familyId: "gates", mode: decision === "pending" ? "open" : "decide" }],
      reobservers,
      apply: (state) => ({
        ...state,
        updated_at: at,
        gates: {
          ...state.gates,
          [name]: {
            status: decision,
            at: decision === "pending" ? null : at,
            artifact: flags.artifact ?? state.gates[name]?.artifact ?? null,
          },
        },
        ...(name === "brief" ? { plan_digest: briefDigestFor(decision, state, runDir) } : {}),
      }),
    });
    return emit(flags, { run_id: runId, gate: name, status: next.gates[name].status, at: next.gates[name].at });
  },

  async step([runId, agent, status], flags) {
    if (!agent) throw new CliError("factory step requires <agent>");
    if (!STEP_STATUSES.includes(status)) throw new CliError(`status must be one of ${STEP_STATUSES.join(" | ")}`);
    const runDir = runDirFor(flags, runId);
    const at = stamp(flags);
    const next = await transition(runDir, {
      participants: [{ familyId: "steps", mode: "record" }],
      apply: (state) => {
        const existing = state.steps.find((step) => step.agent === agent);
        const attempts = flags.attempts === undefined
          ? existing?.attempts ?? 1
          : integer(flags.attempts, 1, "--attempts");
        const row = {
          agent,
          status,
          attempts,
          review_ref: flags.reviewRef ?? existing?.review_ref ?? null,
          evidence_ref: flags.evidenceRef ?? existing?.evidence_ref ?? null,
        };
        return {
          ...state,
          updated_at: at,
          steps: existing
            ? state.steps.map((step) => (step.agent === agent ? row : step))
            : [...state.steps, row],
        };
      },
    });
    const row = next.steps.find((step) => step.agent === agent);
    return emit(flags, { run_id: runId, agent, status: row.status, attempts: row.attempts });
  },

  async terminal([runId, status], flags) {
    if (!TERMINAL_STATUSES.includes(status)) throw new CliError(`status must be one of ${TERMINAL_STATUSES.join(" | ")}`);
    if (!flags.reason) throw new CliError("factory terminal requires --reason");
    const runDir = runDirFor(flags, runId);
    const at = stamp(flags);
    const next = await transition(runDir, {
      participants: [{ familyId: "envelope", mode: "terminalize" }],
      apply: (state) => ({
        ...state,
        updated_at: at,
        status,
        terminal_result: { status, reason: flags.reason },
      }),
    });
    return emit(flags, { run_id: runId, status: next.status, reason: next.terminal_result.reason });
  },
};

export async function dispatchInit(positional, flags, operations = INIT_OPERATIONS) {
  const candidate = preflightInit(positional, flags);
  const {
    cwd, resolvePath, joinPath, realpath, lstat, mkdir, readdir,
    runGit, prove, publish,
  } = operations;
  const dispatchInitPublication = publish;
  const runId = candidate.run_id;
  const operatorInput = resolvePath(flags.repo ?? cwd());
  let operatorRoot;
  try {
    operatorRoot = realpath(operatorInput);
  } catch {
    const S = joinPath(operatorInput, ".factory-sandboxes", runId);
    throw new CliError(`operator repository is not observable; sandbox path '${S}' was not created`);
  }
  const C = joinPath(operatorRoot, ".factory-sandboxes");
  const S = joinPath(C, runId);
  const runDir = joinPath(S, CONTROL_PLANE, runId);
  const legacyManifest = joinPath(operatorRoot, CONTROL_PLANE, runId, "run.json");
  const sandboxManifest = joinPath(runDir, "run.json");

  let top;
  try {
    const observed = runGit(operatorRoot, ["rev-parse", "--show-toplevel"]);
    top = observed.ok && observed.stdout.trim() ? realpath(resolvePath(operatorRoot, observed.stdout.trim())) : null;
  } catch {
    top = null;
  }
  if (top !== operatorRoot) throw new CliError(`--repo must name the canonical operator repository root; sandbox path '${S}' was not created`);

  let legacyState;
  let containerState;
  let sandboxState = { kind: "absent" };
  let sandboxManifestState = "absent";
  try {
    legacyState = manifestPresence(legacyManifest, { lstat });
    containerState = directoryState(C, { lstat, realpath });
    if (containerState.kind === "directory") {
      sandboxState = directoryState(S, { lstat, realpath });
      if (sandboxState.kind === "directory") sandboxManifestState = manifestPresence(sandboxManifest, { lstat });
    }
  } catch (error) {
    throw new CliError(`could not inspect destination policy for sandbox '${S}'`, { cause: error });
  }
  if (legacyState === "present" && sandboxManifestState === "present") {
    throw new CliError(`ambiguous run '${runId}': manifests exist at '${legacyManifest}' and '${sandboxManifest}'; inspect status with --repo '${operatorRoot}' and --repo '${S}'`);
  }
  if (containerState.kind === "unsafe") {
    const legacy = legacyState === "present" ? `; run status/resume for '${legacyManifest}' with --repo '${operatorRoot}'` : "";
    throw new CliError(`sandbox container '${C}' is ${containerState.type}; sandbox path '${S}' was not changed${legacy}`);
  }
  if (sandboxState.kind === "unsafe") {
    const legacy = legacyState === "present" ? `; run status/resume for '${legacyManifest}' with --repo '${operatorRoot}'` : "";
    throw new CliError(`sandbox destination '${S}' is ${sandboxState.type}; it was not reused, changed, or deleted${legacy}`);
  }
  if (legacyState === "present") throw new CliError(`run '${runId}' already exists at '${legacyManifest}'; run status/resume with --repo '${operatorRoot}'; sandbox path '${S}' was not created`);
  if (sandboxManifestState === "present") throw new CliError(`run '${runId}' already exists at '${sandboxManifest}'; run status/resume with --repo '${S}'`);
  if (sandboxState.kind === "directory") {
    const detail = sandboxManifestState === "blocked" ? " with a manifest path blocked by a non-directory component" : " without a manifest";
    throw new CliError(`sandbox destination '${S}' already exists${detail}; it was not reused, changed, or deleted`);
  }

  try {
    const observedContainer = directoryState(C, { lstat, realpath });
    if (observedContainer.kind === "absent") mkdir(C);
    else if (observedContainer.kind !== "directory") throw new Error(`unsafe sandbox container '${C}'`);
    exactDirectory(C, { lstat, realpath });
    mkdir(S);
    exactDirectory(S, { lstat, realpath });
    if (readdir(S).length !== 0) throw new Error("reserved destination is not empty");
  } catch (error) {
    throw new CliError(`could not reserve empty sandbox '${S}'; existing state was preserved`, { cause: error });
  }

  const cloned = runGit(operatorRoot, ["clone", "--local", "--", operatorRoot, S]);
  if (!cloned.ok) {
    let manifest;
    try {
      const state = manifestPresence(sandboxManifest, { lstat });
      manifest = state === "present" ? "present" : state === "absent" ? "absent" : "unobservable";
    } catch {
      manifest = "unobservable";
    }
    throw new CliError(`git clone failed for sandbox '${S}'; run.json is ${manifest}; sandbox was retained`);
  }

  let proof;
  try {
    proof = prove({ operatorRoot, sandboxPath: S, runId, worktree: candidate.worktree });
  } catch (error) {
    throw new CliError(`physical containment could not be proved for sandbox '${S}'; sandbox was retained`, { cause: error });
  }

  let prBase = candidate.pr_base;
  if (prBase === null) {
    const observed = runGit(proof.configuredWorktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    prBase = observed.ok ? observed.stdout.trim() : "";
    if (!prBase) throw new CliError(`could not observe a symbolic branch in PR base worktree '${candidate.worktree}' for sandbox '${S}'; pass --pr-base <branch> explicitly; sandbox was retained`);
  }
  let run;
  try {
    run = validateRun({ ...candidate, pr_base: prBase });
  } catch (error) {
    throw new CliError(`final manifest validation failed for sandbox '${S}'; sandbox was retained`, { cause: error });
  }
  const { observedRun } = await dispatchInitPublication({ runDir, sandboxPath: S, candidate: run });
  return emit(flags, {
    run_id: observedRun.run_id, run_dir: runDir, sandbox_path: proof.sandboxPath,
    branch: observedRun.branch, worktree: observedRun.worktree, pr_base: observedRun.pr_base,
    status: observedRun.status, mode: observedRun.mode,
  });
}

function preflightInit(positional, flags) {
  const refusal = (message, cause) => new CliError(`${message}; no sandbox path was derived or created`, cause ? { cause } : undefined);
  if (positional.length !== 1) throw refusal("factory init requires exactly one <run-id>");
  if (flags.repo !== undefined && (typeof flags.repo !== "string" || !flags.repo.trim())) throw refusal("--repo must be a non-empty string");
  const runId = positional[0];
  try {
    const at = stamp(flags);
    return validateRun({
      version: SCHEMA_VERSION,
      run_id: runId,
      issue_key: flags.issue ?? null,
      branch: flags.branch ?? `feature/${runId}`,
      worktree: flags.worktree ?? ".",
      pr_base: flags.prBase ?? null,
      created_at: at,
      updated_at: at,
      status: "running",
      mode: flags.mode ?? "interactive",
      max_parallel_slices: integer(flags.maxParallelSlices, 3, "--max-parallel-slices"),
      max_retries: integer(flags.maxRetries, 3, "--max-retries"),
      gates: {},
      steps: [],
      slices: [],
      validator: null,
      terminal_result: null,
      pr_url: null,
      plan_digest: null,
    });
  } catch (error) {
    throw refusal(error.message, error);
  }
}

function manifestPresence(path, { lstat }) {
  try {
    lstat(path);
    return "present";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    if (error?.code === "ENOTDIR") return "blocked";
    throw error;
  }
}

function directoryState(path, { lstat, realpath }) {
  let stats;
  try {
    stats = lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (stats.isSymbolicLink()) return { kind: "unsafe", type: "a symbolic link" };
  if (!stats.isDirectory()) return { kind: "unsafe", type: stats.isFile() ? "a regular file" : "an unsafe filesystem entry" };
  if (realpath(path) !== path) return { kind: "unsafe", type: "a non-canonical directory" };
  return { kind: "directory" };
}

function exactDirectory(path, operations) {
  const state = directoryState(path, operations);
  if (state.kind !== "directory") throw new Error(`unsafe directory '${path}'`);
}

function integer(value, fallback, flag) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CliError(`${flag} must be a positive integer`);
  return parsed;
}

function stamp(flags) {
  const at = flags.now !== undefined ? Date.parse(flags.now) : Date.now();
  if (!Number.isFinite(at)) throw new CliError("--now must be an ISO timestamp");
  return new Date(at).toISOString();
}

function emit(flags, payload) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const [name, value] of Object.entries(payload)) {
      if (value === null || value === undefined) continue;
      process.stdout.write(`${name}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`);
    }
  }
  return payload;
}

function usage() {
  process.stdout.write(`factory — durable control plane for /feature runs

  factory init <run-id> [--branch B=feature/<run-id>] [--worktree W=.] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]
  factory status <run-id> [--json]
  factory lock <run-id> <claim|steal|release> --session ID [--ttl-ms N]
  factory heartbeat <run-id> --session ID
  factory gate <run-id> <${GATE_NAMES.join("|")}> <${GATE_STATUSES.join("|")}> [--artifact REF]
  factory step <run-id> <agent> <${STEP_STATUSES.join("|")}> [--attempts N] [--review-ref REF] [--evidence-ref REF]
  factory validator <run-id> --report REF   (verdict and head come from reviews/implementation-validator.json)
  factory terminal <run-id> <${TERMINAL_STATUSES.join("|")}> --reason TEXT

Every command takes [--repo PATH] and [--json]. Unknown options are errors.
`);
  return null;
}

// A refusal raised inside a transition reaches here wrapped by the atomic writer,
// whose own message is generic. Printing only `error.message` would report every
// refusal as "protected file commit failed" and hide the reason the operator needs,
// so the cause chain is printed. This was caught by an end-to-end test rather than
// by reading the code.
export function describeError(error, depth = 0) {
  const lines = [];
  let current = error;
  let indent = "";
  while (current && depth < 5) {
    const message = String(current.message ?? current);
    // The wrapper adds nothing once its cause is shown; skip it rather than lead
    // with it.
    if (!(indent === "" && current.cause && message === "protected file commit failed")) {
      lines.push(`${indent}${message}`);
      indent = `${indent}  `;
    }
    current = current.cause;
    depth += 1;
  }
  return lines.join("\n");
}

// Invoked as a program rather than imported. Compared through realpath and pathToFileURL, not by
// building a `file://` string by hand: `process.argv[1]` is the path as typed, while
// `import.meta.url` is resolved, so a symlink anywhere in it makes the two differ and the CLI exits
// 0 having done nothing. That is not exotic — on macOS every temp directory is /var -> /private/var,
// and npm bin shims are symlinks. It was invisible to the whole suite because every test invokes the
// CLI through an already-resolved absolute path; the packed-tarball test found it immediately.
const invokedAsProgram = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (invokedAsProgram()) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
