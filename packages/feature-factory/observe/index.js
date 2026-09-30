// Observe, don't trust. A subagent's report is a claim, so independently re-derive
// the diff and re-run its named tests before work-reviewer judges observed evidence.
// `factory observe` mechanizes that rule because an autonomous run has no human to
// check whether the orchestrator actually observed anything.
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONTROL_PLANE } from "../state/schema.js";

export const DEFAULT_REPOSITORY_VERIFY_TIMEOUT_MS = 900000;
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 900000;

export const EVIDENCE_KEYS = Object.freeze([
  "subject", "run_id", "attempt", "branch", "base_ref", "worktree", "status", "blocked_reason",
  "worktree_clean",
  "files_changed", "diff_stat", "diff_observed", "commands", "tests", "commit",
  "observed_by", "review_ready", "claim_reconciliation", "repository_verify", "reused_from",
]);

export function git(cwd, args, { runner = spawnSync } = {}) {
  const result = runner("git", args, { cwd, encoding: "utf8", shell: false, env: { ...process.env, LC_ALL: "C" } });
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
  const names = record(git(worktree, ["--literal-pathspecs", "diff", "--name-only", "-z", `${baseRef}...${ref}`], options));
  const stat = record(git(worktree, ["diff", "--stat", `${baseRef}...${ref}`], options));

  const observed = head.ok && names.ok && stat.ok;
  return {
    commit: head.ok ? head.stdout.trim() : null,
    // NUL-separated and untrimmed: ownership is decided on these paths, so a name with a
    // trailing space must stay a distinct path rather than collapsing onto another.
    files_changed: names.ok ? names.stdout.split("\0").filter((path) => path !== "") : [],
    diff_stat: stat.ok ? stat.stdout.trim() : null,
    diff_observed: observed,
    commands,
  };
}

// Attack 7: a caller may present any head it likes. Ancestry is asked of git, and
// git's exit codes are read precisely: 0 is "is an ancestor", 1 is "proven not",
// anything else is a failed probe that must not be read as either.
// Finding 3: observeWorktree derives the commit and diff from a git ref, but runTests
// executes in the mutable working directory. So tests could pass on uncommitted bytes
// while the evidence claimed the HEAD commit - and the same tests then failed on the
// clean merged tree. This is not an adversarial case: a builder leaving uncommitted
// changes is the ordinary state of an agent-driven worktree.
//
// Observation of a dirty tree is meaningless, so it is refused rather than recorded.
export function observeCleanliness(worktree, options = {}) {
  const probe = git(worktree, ["status", "--porcelain", "--untracked-files=normal"], options);
  if (!probe.ok) return { clean: false, reason: "worktree state could not be observed", entries: [] };
  const entries = probe.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return { clean: entries.length === 0, reason: entries.length === 0 ? null : "worktree has uncommitted changes", entries };
}

export function runBootstrap(worktree, command, timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS, { runner = spawnSync } = {}) {
  try {
    const result = runner(command, [], {
      cwd: worktree, shell: true, env: process.env, timeout: timeoutMs, stdio: ["inherit", process.stderr, process.stderr],
    });
    return Number.isSafeInteger(result?.status) && result.status >= 0 ? result.status : null;
  } catch { return null; }
}

export function observeTrackedCleanliness(worktree, options = {}) {
  try {
    const top = git(worktree, ["rev-parse", "--show-toplevel"], options);
    const probes = [
      git(worktree, ["--literal-pathspecs", "diff", "--name-only", "-z"], options),
      git(worktree, ["--literal-pathspecs", "diff", "--cached", "--name-only", "-z"], options),
    ];
    if (!top.ok || realpathSync(resolve(worktree, top.stdout.trim())) !== realpathSync(worktree)
      || probes.some((probe) => !probe.ok)) return { observed: false, entries: [] };
    return { observed: true, entries: [...new Set(probes.flatMap((probe) => probe.stdout.split("\0").filter(Boolean)))].sort() };
  } catch { return { observed: false, entries: [] }; }
}

export function observeAncestry(worktree, ancestor, descendant, options = {}) {
  const probe = git(worktree, ["merge-base", "--is-ancestor", ancestor, descendant], options);
  if (probe.ok) return "ancestor";
  if (probe.status === 1) return "not-ancestor";
  return "indeterminate";
}

// Attack 1: the test command is run here, by us, and its exit code is recorded
// from the process rather than from anybody's report. `observed: false` means we
// could not run it, which is not the same as a pass.
// #381: a failing run's output was only streamed to stderr, so the evidence recorded an exit code and nothing about
// why. Instruction-level evidence, not a gate: pass and fail are decided exactly as before.
export const LOG_CAP_BYTES = 50 * 1024 * 1024;
export const LOG_FIELDS = Object.freeze(["log_path", "log_bytes", "log_sha256", "log_truncated", "tail", "signal", "timed_out"]);
const TAIL_LINES = 200, TAIL_BYTES = 64 * 1024;
const SECRET_ENV = /^(?:GH_TOKEN|GITHUB_TOKEN)$|(?:_TOKEN|_API_KEY|_SECRET|_PASSWORD|_ACCESS_KEY)$/u;

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function readRange(fd, position, length) {
  const buffer = Buffer.alloc(length);
  return buffer.subarray(0, readSync(fd, buffer, 0, length, position));
}

// The child writes both streams, interleaved, to a private scratch file; only the capped, redacted bytes reach the
// run-local log, and a bounded tail goes to stderr on failure so `--json` stdout stays one object.
function captureOutput(log, env, spawn) {
  // The ref is built from the observed subject, so it must stay inside the run's own log directory.
  const target = resolve(log.runDir, log.ref), logRoot = resolve(log.runDir, "evidence", "logs");
  if (!target.startsWith(`${logRoot}${sep}`)) throw new Error(`log path '${log.ref}' escapes evidence/logs`);
  const secrets = Object.entries(env).filter(([key, value]) => SECRET_ENV.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => Buffer.from(value));
  const margin = Math.max(0, ...secrets.map((secret) => secret.length));
  // Masking is byte-for-byte, so nothing shifts: limits bound exactly the bytes kept, and reading a secret's length past
  // each cut before masking catches a value straddling it.
  // Every occurrence is found in the original bytes, overlaps included, and their union masked, so masking one value
  // can never hide another -- independent of environment order.
  const mask = (bytes) => {
    const original = Buffer.from(bytes);
    for (const secret of secrets) for (let at = original.indexOf(secret); at !== -1; at = original.indexOf(secret, at + 1)) bytes.fill(0x2a, at, at + secret.length);
    return bytes;
  };
  const scratch = join(tmpdir(), `factory-output-${randomUUID()}`);
  let result, size, head, tailBytes;
  try {
    const out = openSync(scratch, "w", 0o600);
    try { result = spawn(out); } finally { closeSync(out); }
    size = statSync(scratch).size;
    const input = openSync(scratch, "r");
    try {
      head = mask(readRange(input, 0, Math.min(size, LOG_CAP_BYTES + margin))).subarray(0, LOG_CAP_BYTES);
      const start = Math.max(0, size - TAIL_BYTES - margin);
      tailBytes = mask(readRange(input, start, size - start)).subarray(-TAIL_BYTES);
    } finally { closeSync(input); }
  } finally { rmSync(scratch, { force: true }); }
  // Decoding arbitrary output can expand it (a malformed byte becomes a 3-byte U+FFFD), so the decoded text is bounded
  // again in UTF-8 bytes, starting on a character boundary.
  const bounded = Buffer.from(tailBytes.toString("utf8")).subarray(-TAIL_BYTES);
  let from = 0;
  while (from < bounded.length && (bounded[from] & 0xc0) === 0x80) from += 1;
  const tail = bounded.subarray(from).toString("utf8").split("\n").slice(-TAIL_LINES).join("\n");
  // Review of #382: a log is never replaced and never written through a link. A repeat observation of the same attempt
  // and commit gets a fresh suffixed ref, so any record naming the earlier log keeps its bytes and digest.
  mkdirSync(dirname(target), { recursive: true });
  for (const dir of [join(log.runDir, "evidence"), logRoot]) if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a link; logs are written only into the run's own directory`);
  let ref = log.ref;
  for (let n = 2; existsSync(join(log.runDir, ref)) || isLink(join(log.runDir, ref)); n += 1) ref = log.ref.replace(/\.log$/u, `.${n}.log`);
  const fd = openSync(join(log.runDir, ref), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, head); } finally { closeSync(fd); }
  const timedOut = result?.error?.code === "ETIMEDOUT";
  if (result?.status !== 0 && tail) process.stderr.write(`${tail}${tail.endsWith("\n") ? "" : "\n"}`);
  return { result, fields: { log_path: ref, log_bytes: head.length, log_sha256: `sha256:${createHash("sha256").update(head).digest("hex")}`,
    log_truncated: size > LOG_CAP_BYTES, tail, ...(Number.isInteger(result?.status) ? {} : { signal: result?.signal ?? null, timed_out: timedOut }) } };
}

export function runTests(worktree, command, { runner = spawnSync, skipReason = null, shellCommand = false, timeoutMs = DEFAULT_REPOSITORY_VERIFY_TIMEOUT_MS, stdio = "inherit", env = process.env, log = null } = {}) {
  if (!command) {
    // Finding 1: defaulting a skip reason let omission manufacture review readiness.
    // Tests must be observed green or explicitly skipped with a caller-declared reason;
    // omission alone is neither.
    return { cmd: null, exit: null, observed: false, skipped_reason: skipReason };
  }
  const spawn = (fd) => (shellCommand
    ? runner(command, [], { cwd: worktree, shell: true, stdio: fd === undefined ? stdio : [Array.isArray(stdio) ? stdio[0] : stdio, fd, fd], env, timeout: timeoutMs })
    : runner(command[0], command.slice(1), fd === undefined ? { cwd: worktree, encoding: "utf8", shell: false } : { cwd: worktree, shell: false, stdio: ["ignore", fd, fd], env }));
  const { result, fields } = log ? captureOutput(log, env, spawn) : { result: spawn(), fields: {} };
  const exit = Number.isInteger(result?.status) ? result.status : null;
  return { cmd: shellCommand ? command : command.join(" "), exit, observed: exit !== null, skipped_reason: null, ...fields };
}

// Readiness requires completed, clean, changed, observed-diff evidence, no disagreement between
// the builder's claim and the observation, and tests observed passing or ratified as explicitly
// skipped with a reason.
export function deriveReviewReady(evidence) {
  if (evidence.status !== "completed") return false;
  // Enforcement (false green): a claim that disagrees with observation is itself the finding. It
  // lives here, not beside the writer, because `readEvidence` recomputes readiness from this
  // function alone; with the term only at write time, every mismatched record read back as
  // tampered and wedged its slice where `slice blocked` could never record it.
  if (evidence.claim_reconciliation?.mismatches?.length > 0) return false;
  // Absent on evidence written before #372, and null when no `verify` is configured.
  const verify = evidence.repository_verify;
  if (verify && !(verify.observed === true && verify.exit === 0)) return false;
  // A tree with uncommitted changes cannot produce evidence about the commit it
  // claims, whatever the tests said.
  if (evidence.worktree_clean !== true) return false;
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

// .gitignore can conceal files from cleanliness and observed-diff checks, so it is
// refused with control-plane prefixes regardless of ownership. Ecosystem manifests
// are authorized through ratified seeded ownership instead.
const PRIVILEGED_PREFIXES = Object.freeze([CONTROL_PLANE, ".git"]);
// `.factory.json` is the repository's declaration of how to resolve, verify, publish and publish-as.
// It is committed rather than ignored, so ownership cannot come from gitignore the way the run
// directory's does; it comes from here. A run that could edit it could redefine what it is allowed to
// run, which is the one thing configuration must not be able to do.
const PRIVILEGED_EXACT = Object.freeze([".gitignore", ".factory.json"]);

export function privilegedPaths(filesChanged) {
  return filesChanged.filter((file) => PRIVILEGED_PREFIXES.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
    || PRIVILEGED_EXACT.includes(file));
}

export function buildEvidence({ subject, runId, attempt, branch, baseRef, worktree, status, blockedReason = null, claim = null, testCommand = null, skipReason = null, shellCommand = false, testTimeoutMs = DEFAULT_REPOSITORY_VERIFY_TIMEOUT_MS, repositoryVerify = null, reused = null, logs = null, options = {} }) {
  // Cleanliness is established before anything else is observed, because every later
  // fact - the diff, the commit, and above all the test result - is only about the
  // recorded commit if the tree has nothing uncommitted in it.
  const cleanliness = observeCleanliness(worktree, options);
  const observation = observeWorktree(worktree, baseRef, options);
  // Tests are not run at all against a dirty tree: running them would produce a
  // result about bytes that are not going to merge.
  // `reused` carries a slice's green repository verify for a merge whose tree is byte-identical (#374).
  // Run-local logs, named by commit as well as attempt: the post-merge test-verifier restarts attempts per merge.
  const logFor = (kind) => (logs && observation.commit ? { runDir: logs.runDir, ref: `${logs.prefix}.${observation.commit.slice(0, 12)}.${kind}.log` } : null);
  const tests = cleanliness.clean && reused ? reused.tests : cleanliness.clean
    ? runTests(worktree, testCommand, { ...options, skipReason, shellCommand, timeoutMs: testTimeoutMs, log: logFor("test"),
      // Output to stderr, stdin inherited: `slice merged --json` and `observe --json` stay one JSON object.
      ...(shellCommand ? { stdio: ["inherit", 2, 2] } : {}) })
    : { cmd: testCommand ? (shellCommand ? testCommand : testCommand.join(" ")) : null, exit: null, observed: false, skipped_reason: null };
  // Enforcement (false green, #372): a slice ran only its ratified test command, so the repository's
  // configured `verify` (lint, format, full suite) first ran after merge, where production repair is
  // forbidden and one Clippy warning parked a 13-slice run. The same suite now runs on the slice's commit.
  // Skipped after a failing test run, which is already not review-ready; its output goes to stderr so
  // `observe --json` stays one JSON object. A bootstrap refusal (#376) means the tree is not prepared, so the
  // verify does not run and the refusal is the evidence's blocked reason.
  // Bootstrap is the verify's own first step (#376 review): it runs only when the verify will, and after the
  // ratified test, so nothing the test does can remove its output before the verify reads it.
  const eligible = repositoryVerify && cleanliness.clean && !(tests.observed && tests.exit !== 0);
  const bootstrapRefusal = eligible ? repositoryVerify.prepare?.() ?? null : null;
  const verifyRuns = eligible && !bootstrapRefusal;
  const verified = !repositoryVerify ? null : verifyRuns
    ? (({ skipped_reason, ...verify }) => verify)(runTests(worktree, repositoryVerify.command,
      { ...options, shellCommand: true, timeoutMs: repositoryVerify.timeoutMs, stdio: ["ignore", 2, 2], log: logFor("verify") }))
    : { cmd: repositoryVerify.command, exit: null, observed: false };

  // Third round, finding 1: cleanliness was a pre-test snapshot, so a test that wrote
  // tracked files left the tree dirty while the evidence still claimed a clean HEAD -
  // and the same test then failed on the merged tree. The tree and the commit are
  // re-observed after the run, and both must be unchanged for the result to describe
  // the recorded commit.
  //
  // This does NOT close the case where another process mutates the worktree during the
  // run and restores it before the end: both observations are clean and the commit
  // matches, so no before/after comparison can see it. Closing that needs tests run from
  // an isolated checkout. Left open deliberately - its precondition is a second writer
  // in this slice's worktree, meaning a builder that has not actually finished or two
  // slices sharing a worktree, which is an orchestration error rather than one of the
  // twelve attacks.
  const afterTests = observeCleanliness(worktree, options);
  const headAfter = git(worktree, ["rev-parse", options.ref ?? "HEAD"], options);
  const stableUnderTest = cleanliness.clean
    && afterTests.clean
    && headAfter.ok
    && headAfter.stdout.trim() === observation.commit;
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
    blocked_reason: blockedReason ?? cleanliness.reason ?? bootstrapRefusal
      ?? (stableUnderTest ? null : "worktree changed while the tests ran"),
    // Named for what it asserts: clean before the run, still clean after, and HEAD did
    // not move. A pre-test snapshot alone was not enough.
    worktree_clean: stableUnderTest,
    files_changed: observation.files_changed,
    diff_stat: observation.diff_stat,
    diff_observed: observation.diff_observed,
    commands: observation.commands,
    tests,
    commit: observation.commit,
    observed_by: "orchestrator",
    review_ready: false,
    claim_reconciliation: { claimed: false, mismatches: [] },
    repository_verify: verified,
    ...(reused ? { reused_from: reused.commit } : {}),
  };
  evidence.claim_reconciliation = reconcileClaim(claim, evidence);
  evidence.review_ready = deriveReviewReady(evidence);
  return evidence;
}

export function resolveWorktree(repo, worktree) {
  const absolute = resolve(repo, worktree);
  const rel = relative(resolve(repo), absolute);
  if (rel.startsWith("..") || rel.startsWith(sep) || !existsSync(absolute)) return null;
  return absolute;
}

export function proveInitContainment({ operatorRoot, sandboxPath, runId, worktree }) {
  const container = join(operatorRoot, ".factory-sandboxes");
  if (sandboxPath !== join(container, runId)) throw new Error("sandbox is not the exact derived run path");
  exactDirectory(operatorRoot);
  exactDirectory(container);
  exactDirectory(sandboxPath);
  if (dirname(sandboxPath) !== container || realpathSync(dirname(sandboxPath)) !== container) throw new Error("sandbox parent is not the canonical container");

  const gitDirectory = join(sandboxPath, ".git");
  if (gitPath(sandboxPath, ["rev-parse", "--show-toplevel"]) !== sandboxPath) throw new Error("sandbox Git top level escapes the sandbox");
  exactDirectory(gitDirectory);
  if (gitPath(sandboxPath, ["rev-parse", "--absolute-git-dir"]) !== gitDirectory) throw new Error("sandbox Git directory is not S/.git");
  if (gitPath(sandboxPath, ["rev-parse", "--git-common-dir"]) !== gitDirectory) throw new Error("sandbox Git common directory is not S/.git");

  const configuredWorktree = resolve(sandboxPath, worktree);
  if (!within(configuredWorktree, sandboxPath)) throw new Error("configured worktree escapes the sandbox");
  inspectComponents(sandboxPath, configuredWorktree);
  exactDirectory(configuredWorktree);
  const worktreeTop = gitPath(configuredWorktree, ["rev-parse", "--show-toplevel"]);
  if (worktreeTop !== sandboxPath && worktreeTop !== configuredWorktree) throw new Error("configured worktree Git top level escapes the sandbox");
  const worktreeGitDirectory = gitPath(configuredWorktree, ["rev-parse", "--absolute-git-dir"]);
  if (!within(worktreeGitDirectory, gitDirectory)) throw new Error("configured worktree Git directory escapes S/.git");
  assertWorktreeRelationship(sandboxPath, configuredWorktree, gitDirectory, worktreeTop, worktreeGitDirectory);
  if (gitPath(configuredWorktree, ["rev-parse", "--git-common-dir"]) !== gitDirectory) throw new Error("configured worktree Git common directory is not S/.git");

  const factory = ensureDirectory(join(sandboxPath, CONTROL_PLANE), sandboxPath);
  const runDir = ensureDirectory(join(factory, runId), factory);
  const directories = [
    ...["plan", "artifacts", "evidence", "reviews"].map((name) => ensureDirectory(join(runDir, name), runDir)),
    ensureDirectory(join(factory, "worktrees"), factory),
  ];
  directories.push(ensureDirectory(join(directories.at(-1), runId), directories.at(-1)));

  for (const path of [operatorRoot, container, sandboxPath, gitDirectory, configuredWorktree, factory, runDir, ...directories]) exactDirectory(path);
  const finalTop = gitPath(configuredWorktree, ["rev-parse", "--show-toplevel"]);
  const finalGitDirectory = gitPath(configuredWorktree, ["rev-parse", "--absolute-git-dir"]);
  if (gitPath(sandboxPath, ["rev-parse", "--show-toplevel"]) !== sandboxPath
    || gitPath(sandboxPath, ["rev-parse", "--absolute-git-dir"]) !== gitDirectory
    || gitPath(sandboxPath, ["rev-parse", "--git-common-dir"]) !== gitDirectory
    || gitPath(configuredWorktree, ["rev-parse", "--git-common-dir"]) !== gitDirectory) {
    throw new Error("final Git containment proof failed");
  }
  assertWorktreeRelationship(sandboxPath, configuredWorktree, gitDirectory, finalTop, finalGitDirectory);
  return { sandboxPath, configuredWorktree };
}

function exactDirectory(path) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(path) !== path) throw new Error(`unsafe directory '${path}'`);
  return path;
}

function ensureDirectory(path, parent) {
  exactDirectory(parent);
  try {
    exactDirectory(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path);
    exactDirectory(path);
  }
  if (dirname(path) !== parent || realpathSync(dirname(path)) !== parent || !within(realpathSync(path), parent, true)) throw new Error(`directory escapes its parent '${path}'`);
  return path;
}

function inspectComponents(root, target) {
  const path = relative(root, target);
  let cursor = root;
  for (const part of path.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`unsafe configured worktree component '${cursor}'`);
  }
}

function gitPath(cwd, args) {
  const result = git(cwd, args);
  if (!result.ok || !result.stdout.trim()) throw new Error(`Git observation failed: git ${args.join(" ")}`);
  return realpathSync(resolve(cwd, result.stdout.trim()));
}

function assertWorktreeRelationship(sandbox, worktree, gitDirectory, top, observedGitDirectory) {
  if (top === sandbox && observedGitDirectory === gitDirectory) return;
  if (worktree !== sandbox && top === worktree && within(observedGitDirectory, gitDirectory, true)) return;
  throw new Error("configured worktree Git relationship is not contained");
}

function within(child, parent, strict = false) {
  const path = relative(parent, child);
  return (!strict && path === "") || (path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

function summarize(result) {
  const text = (result.ok ? result.stdout : result.stderr).trim().split("\n")[0] ?? "";
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export const EVIDENCE_DIR = "evidence";
export const evidenceRef = (subject) => join(EVIDENCE_DIR, `${subject}.json`);
