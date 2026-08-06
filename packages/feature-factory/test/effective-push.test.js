import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateRun } from "../state/schema.js";
import { initFresh } from "./init-fixture.js";

test("AC4/AC8-AC12 skill init, push, branch, recovery, and publication policy", () => {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(pkg, "bin", "factory.js");
  const skill = readFileSync(resolve(pkg, "skills", "feature", "SKILL.md"), "utf8");
  const resumeStart = skill.indexOf("### Resume or collision");
  const freshStart = skill.indexOf("### Fresh sandbox request");
  const gateOneStart = skill.indexOf("### Gate 1 — Story");
  const gateThreeStart = skill.indexOf("### Gate 3 — Pre-PR");
  const publicationStart = skill.indexOf("## Step 6 — Draft PR");
  const summaryStart = skill.indexOf("## Step 7 — Summary");
  const resume = skill.slice(resumeStart, freshStart);
  const fresh = skill.slice(freshStart, gateOneStart);
  const gateThree = skill.slice(gateThreeStart, publicationStart);
  const publication = skill.slice(publicationStart, summaryStart);
  const summary = skill.slice(summaryStart);
  const required = (section, fragment, trace) => {
    const index = section.indexOf(fragment);
    assert.notEqual(index, -1, `${trace} contract is missing: ${fragment}`);
    return index;
  };
  const ordered = (section, fragments, trace) => {
    const positions = fragments.map((fragment) => required(section, fragment, trace));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), `${trace} operations are out of order`);
  };
  const occurrences = (section, fragment) => section.split(fragment).length - 1;
  const command = (name, args, options = {}) => spawnSync(name, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", ...options.env },
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gitResult = (repository, ...args) => command("git", ["-C", repository, ...args]);
  const git = (repository, ...args) => {
    const result = gitResult(repository, ...args);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const factory = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const snapshot = (root) => {
    const visit = (path, name, entries) => {
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push([name, "directory"]);
        for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child, entries);
      } else if (stat.isSymbolicLink()) {
        entries.push([name, "symlink"]);
      } else {
        entries.push([name, "file", readFileSync(path).toString("base64")]);
      }
    };
    const entries = [];
    visit(root, ".", entries);
    return entries;
  };
  const effectiveTarget = (repository) => {
    const result = gitResult(repository, "remote", "get-url", "--push", "origin");
    return result.status === 0 && result.stdout.trim() ? { ok: true, value: result.stdout.trim() } : { ok: false };
  };
  const compareOnly = (operator, sandbox) => {
    const operatorTarget = effectiveTarget(operator);
    if (!operatorTarget.ok) return { ok: false, message: `factory sandbox: operator effective push target unavailable; sandbox retained at ${sandbox}` };
    const sandboxTarget = effectiveTarget(sandbox);
    if (!sandboxTarget.ok) return { ok: false, message: `factory sandbox: sandbox effective push target unavailable at ${sandbox}` };
    if (sandboxTarget.value !== operatorTarget.value) {
      return { ok: false, message: `factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${sandbox}` };
    }
    return { ok: true };
  };
  const configureAndCompare = (operator, sandbox, afterConfigure = () => {}) => {
    const events = [];
    const operatorTarget = effectiveTarget(operator);
    events.push("operator-capture");
    if (!operatorTarget.ok) return { ...compareOnly(operator, sandbox), events };
    const configured = gitResult(sandbox, "config", "--replace-all", "remote.origin.pushurl", operatorTarget.value);
    events.push("sandbox-configure");
    if (configured.status !== 0) {
      return { ok: false, message: `factory sandbox: sandbox effective push target unavailable at ${sandbox}`, events };
    }
    afterConfigure();
    const compared = compareOnly(operator, sandbox);
    events.push("operator-recapture", "sandbox-recapture", "compare");
    return { ...compared, events };
  };
  const featureLog = (repository, branch) => {
    const raw = git(repository, "rev-parse", "--git-path", `logs/refs/heads/${branch}`);
    const path = isAbsolute(raw) ? raw : resolve(repository, raw);
    const root = realpathSync(join(repository, ".git", "logs", "refs", "heads"));
    const fromRoot = relative(root, path);
    assert.ok(fromRoot && !fromRoot.startsWith("..") && !isAbsolute(fromRoot));
    return path;
  };
  const provenance = (repository, branch, bootstrapPending) => {
    const path = featureLog(repository, branch);
    if (!existsSync(path)) return { ok: false, reason: "reflog absent" };
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    if (bootstrapPending && lines.length !== 1) return { ok: false, reason: "bootstrap reflog count" };
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) .+\tbranch: Created from ([0-9a-f]{40})$/u.exec(lines[0]);
    if (!match || match[1] !== "0".repeat(40) || match[2] !== match[3]) return { ok: false, reason: "raw creation provenance" };
    const ancestry = gitResult(repository, "merge-base", "--is-ancestor", match[2], `refs/heads/${branch}`);
    return ancestry.status === 0 ? { ok: true, seed: match[2], lines } : { ok: false, reason: "seed ancestry" };
  };
  const operatorRefAbsent = (operator, branch) => gitResult(operator, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).status === 1;
  const createBranch = (sandbox, branch) => {
    assert.equal(gitResult(sandbox, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).status, 1);
    const log = git(sandbox, "rev-parse", "--git-path", `logs/refs/heads/${branch}`);
    assert.equal(existsSync(isAbsolute(log) ? log : resolve(sandbox, log)), false);
    assert.equal(gitResult(sandbox, "diff", "--quiet").status, 0);
    assert.equal(gitResult(sandbox, "diff", "--cached", "--quiet").status, 0);
    const seed = git(sandbox, "rev-parse", "--verify", "HEAD^{commit}");
    git(sandbox, "switch", "--no-track", "-c", branch, seed);
    const proof = provenance(sandbox, branch, true);
    assert.equal(proof.ok, true, proof.reason);
    assert.equal(proof.seed, seed);
    assert.equal(git(sandbox, "symbolic-ref", "--quiet", "--short", "HEAD"), branch);
    assert.equal(git(sandbox, "rev-parse", "HEAD"), seed);
    return { seed, log: featureLog(sandbox, branch) };
  };
  const bootstrapPending = (run, status) => run.status === "running"
    && run.created_at === run.updated_at
    && Object.keys(run.gates).length === 0
    && run.steps.length === 0
    && run.slices.length === 0
    && run.validator === null
    && run.terminal_result === null
    && run.pr_url === null
    && run.plan_digest === null
    && status.lock === "absent";
  const selectResume = (runDir, repository, intakeBranch) => {
    const events = ["intake-branch"];
    const parsedRun = validateRun(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
    events.push("manifest-validated");
    const featureBranch = parsedRun.branch;
    events.push("feature-branch-bound");
    const featureRef = `refs/heads/${featureBranch}`;
    events.push("feature-ref-bound");
    const recordedWorktree = parsedRun.worktree;
    const lexicalWorktree = isAbsolute(recordedWorktree) ? recordedWorktree : resolve(repository, recordedWorktree);
    const integrationWorktree = realpathSync(lexicalWorktree);
    const fromRepository = relative(realpathSync(repository), integrationWorktree);
    assert.equal(fromRepository.startsWith("..") || isAbsolute(fromRepository), false);
    events.push("integration-worktree-bound");
    const operatorGuard = operatorRefAbsent;
    events.push("operator-guard-ready");
    return {
      events,
      intakeBranch,
      featureBranch,
      featureRef,
      integrationWorktree,
      operatorGuard,
      preLockFeatureRef: featureRef,
    };
  };

  assert.ok(resumeStart >= 0 && freshStart > resumeStart && gateOneStart > freshStart);
  assert.ok(gateThreeStart >= 0 && publicationStart > gateThreeStart && summaryStart > publicationStart);
  ordered(fresh, [
    'git -C "$O" show-ref --verify --quiet "$FEATURE_REF"',
    'factory init "$R" --branch "$FEATURE_BRANCH"',
    "successful JSON response selects paths",
    "Immediately after fresh selection",
    "### Effective push proof",
    'git -C "$RUN_REPO" config --replace-all remote.origin.pushurl "$OPERATOR_PUSH"',
    "the two current shell strings must be exactly equal",
    "### Feature branch provenance and crash recovery",
    'git -C "$INTEGRATION_WORKTREE" switch --no-track -c "$FEATURE_BRANCH" "$SEED_HEAD"',
    "Immediately before claiming or stealing a lock",
    'factory lock "$R" claim --session "$SESSION_ID" --repo "$RUN_REPO"',
    "dispatch the planned ticket",
  ], "fresh request/push/branch/lock");
  for (const fragment of [
    "exact canonical `sandbox_path`",
    "exact absolute `run_dir`",
    "exact `branch`",
    "exact `worktree`",
    "exact `pr_base`",
    "pre-reserves the deterministic sandbox",
    "performs exactly one\n`git clone --local -- O S`",
    "completes the physical containment proof, and only then publishes\n`run.json`",
    "The skill does not construct or prove the sandbox.",
    "created_at` exactly\nequals `updated_at`",
    "qualified status reports lock state exactly `absent`",
    "An active resume skips the configuration command",
    "Never persist, log, echo, normalize, interpolate into a cause",
    "Suppress target-operation stdout, stderr, and argv",
    "oldest raw line",
    "forty-zero old OID",
    "branch: Created from <seed-oid>",
    "merge-base --is-ancestor",
    "Non-bootstrap, sandbox branch absent",
    "Never recreate a progressed run's branch.",
  ]) required(fresh, fragment, "ratified skill policy");
  assert.equal(occurrences(fresh, 'git -C "$O" show-ref --verify --quiet "$FEATURE_REF"'), 4);
  assert.equal(occurrences(fresh, "config --replace-all remote.origin.pushurl"), 1);
  assert.doesNotMatch(fresh, /git clone --local "\$O"|--no-hardlinks|hardlink clone|\bfallback\b|copy-mode|\bstaging\b|\bretry(?:ing)?\b|alternate destination|attempt-numbered|quarantine|ownership (?:evidence|record)|rm -|rmSync|recursive removal|mkdir|pwd -P|rev-parse --absolute-git-dir/iu);
  for (const fragment of [
    "derive later paths only from the successful command response",
    'RUN_REPO="<exact response sandbox_path>"',
    "An active sandbox resume only\nrecaptures and compares targets; it never changes remote configuration.",
  ]) required(resume, fragment, "resume selection");
  ordered(resume, [
    "bind it as `parsedRun`,\nand validate it",
    "discard every intake or stale feature-branch",
    "FEATURE_BRANCH = parsedRun.branch",
    "FEATURE_REF = refs/heads/<exact FEATURE_BRANCH>",
    "RECORDED_RUN_WORKTREE = parsedRun.worktree",
    "INTEGRATION_WORKTREE = physical normalized resolution",
    "Immediately after these bindings",
    'git -C "$O" show-ref --verify --quiet "$FEATURE_REF"',
    "Only after that guard passes may resume enter the effective-push proof",
  ], "resume recorded-branch binding");
  required(resume, "No intake or previously bound\nbranch or worktree value may participate in operator-ref, provenance, lock, dispatch, transition, or\npublication checks", "resume stale-value exclusion");
  for (const message of [
    "factory sandbox: operator effective push target unavailable; sandbox retained at <S>",
    "factory sandbox: sandbox effective push target unavailable at <S>",
    "factory sandbox: sandbox effective push target does not match operator target; sandbox retained at <S>",
  ]) required(fresh, message, "redacted refusal");
  ordered(fresh, [
    "On any capture, configuration, recapture, or equality failure",
    "permit only `factory status",
    "stop before branch handling",
  ], "push refusal effects");
  required(fresh, "stop before branch handling,\nlock claim or steal, dispatch, transition, push, forge command, or further publication.", "push refusal effects");
  required(gateThree, "Production source: <landed count> / 3600", "Gate 3 source accounting");
  ordered(publication, [
    'factory status "$R" --json --repo "$RUN_REPO"',
    'git -C "$O" show-ref --verify --quiet "refs/heads/$FEATURE_BRANCH"',
    "set +x",
    'CURRENT_OPERATOR_PUSH="$(LC_ALL=C git -C "$O" remote get-url --push origin)"',
    'CURRENT_RUN_PUSH="$(LC_ALL=C git -C "$RUN_REPO" remote get-url --push origin)"',
    "Step 6 only compares and never runs `git config`",
    'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"',
    'gh pr create --draft --base "$PR_BASE" --head "$FEATURE_BRANCH"',
    'factory pr "$R" --url "$PR_URL" --repo "$RUN_REPO"',
    "Production source ceiling: <landed count> / 3600",
  ], "Step 6 compare/publication");
  for (const fragment of [
    "## Post-merge test-only repairs",
    "include every attempt",
    "latest-failed, exhausted, or `needs-human` records",
  ]) required(publication, fragment, "post-merge repair disclosure");
  assert.equal(occurrences(publication, "config --replace-all remote.origin.pushurl"), 0);
  assert.doesNotMatch(publication, /git -C "\$RUN_REPO" config/u);
  required(summary, "guarded sandbox-removal", "Step 7 exclusion");
  required(summary, "Only after all ref and archive verification succeeds", "Step 7 guard");

  const root = mkdtempSync(join(tmpdir(), "factory-effective-push-"));
  try {
    const operator = join(root, "operator");
    const bare = join(root, "published.git");
    const secretOne = "https://operator-user:credential-token@example.invalid/org/fetch-target.git";
    const secretTwo = "https://other-user:other-token@example.invalid/org/push-target.git";
    mkdirSync(operator);
    command("git", ["init", "--bare", "--initial-branch=main", bare]);
    git(operator, "init", "--initial-branch=main");
    git(operator, "config", "user.name", "Factory Test");
    git(operator, "config", "user.email", "factory@example.test");
    writeFileSync(join(operator, "fixture.txt"), "effective push\n");
    git(operator, "add", "fixture.txt");
    git(operator, "commit", "-m", "fixture");
    git(operator, "remote", "add", "origin", bare);
    git(operator, "config", "--replace-all", "remote.origin.pushurl", secretOne);

    const mismatchBranch = "feature/push-mismatch";
    assert.equal(operatorRefAbsent(operator, mismatchBranch), true);
    const mismatch = initFresh(operator, ["push-mismatch", "--branch", mismatchBranch, "--pr-base", "main", "--now", "2026-08-04T12:00:00.000Z"]);
    assert.equal(mismatch.response.sandbox_path, mismatch.repository);
    assert.equal(mismatch.response.run_dir, mismatch.runDir);
    assert.ok(isAbsolute(mismatch.repository));
    assert.equal(realpathSync(mismatch.repository), mismatch.repository);
    assert.equal(relative(mismatch.repository, mismatch.runDir).startsWith(".."), false);
    assert.equal(operatorRefAbsent(operator, mismatchBranch), true);
    const beforeMismatch = snapshot(mismatch.runDir);
    const mismatchResult = configureAndCompare(operator, mismatch.repository, () => {
      git(operator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
    });
    assert.equal(mismatchResult.ok, false);
    assert.deepEqual(mismatchResult.events, ["operator-capture", "sandbox-configure", "operator-recapture", "sandbox-recapture", "compare"]);
    assert.equal(mismatchResult.message, `factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${mismatch.repository}`);
    for (const hidden of [secretOne, secretTwo, "operator-user", "credential-token", "other-user", "other-token", "fetch-target.git", "push-target.git"]) {
      assert.equal(mismatchResult.message.includes(hidden), false, `refusal disclosed ${hidden}`);
    }
    assert.deepEqual(snapshot(mismatch.runDir), beforeMismatch);
    assert.equal(gitResult(mismatch.repository, "show-ref", "--verify", "--quiet", `refs/heads/${mismatchBranch}`).status, 1);
    assert.equal(existsSync(join(mismatch.runDir, "factory.lock")), false);
    assert.equal(existsSync(mismatch.repository), true);
    assert.equal(gitResult(bare, "show-ref", "--verify", "--quiet", `refs/heads/${mismatchBranch}`).status, 1);
    const mismatchStatus = factory("status", "push-mismatch", "--repo", mismatch.repository);
    assert.equal(mismatchStatus.valid, true);
    assert.equal(mismatchStatus.lock, "absent");

    git(operator, "config", "--replace-all", "remote.origin.pushurl", secretOne);
    const crashBranch = "feature/crash-recovery";
    const crash = initFresh(operator, ["crash-recovery", "--branch", crashBranch, "--pr-base", "main", "--now", "2026-08-04T12:01:00.000Z"]);
    assert.equal(gitResult(crash.repository, "config", "--get-all", "remote.origin.pushurl").status, 1);
    const crashRun = JSON.parse(readFileSync(join(crash.runDir, "run.json"), "utf8"));
    const crashStatus = factory("status", "crash-recovery", "--repo", crash.repository);
    assert.equal(bootstrapPending(crashRun, crashStatus), true);
    assert.equal(configureAndCompare(operator, crash.repository).ok, true);
    const configuredTarget = git(crash.repository, "config", "--get-all", "remote.origin.pushurl");
    assert.equal(configureAndCompare(operator, crash.repository).ok, true);
    assert.equal(git(crash.repository, "config", "--get-all", "remote.origin.pushurl"), configuredTarget);
    assert.equal(operatorRefAbsent(operator, crashBranch), true);
    const crashCreated = createBranch(crash.repository, crashBranch);
    assert.equal(operatorRefAbsent(operator, crashBranch), true);
    assert.equal(provenance(crash.repository, crashBranch, true).ok, true);
    assert.equal(existsSync(join(crash.runDir, "factory.lock")), false);

    writeFileSync(join(crash.runDir, "artifacts", "story.md"), "story\n");
    factory("gate", "crash-recovery", "story", "pending", "--artifact", "artifacts/story.md", "--repo", crash.repository, "--now", "2026-08-04T12:02:00.000Z");
    // The sandbox is a clone, and `git clone` does not copy the operator's committer identity —
    // it lives in the source repository's own config, not in anything cloned. On a developer
    // machine a global identity fills the gap invisibly; on a fresh CI runner there is none, and
    // this commit failed with `fatal: empty ident name`. Configure it here rather than relying on
    // the environment, the same way every other fixture in this suite does.
    git(crash.repository, "config", "user.name", "Factory Test");
    git(crash.repository, "config", "user.email", "factory@example.test");
    writeFileSync(join(crash.repository, "progressed.txt"), "progressed\n");
    git(crash.repository, "add", "progressed.txt");
    git(crash.repository, "commit", "-m", "progress branch");
    assert.equal(provenance(crash.repository, crashBranch, true).ok, false);
    const progressed = provenance(crash.repository, crashBranch, false);
    assert.equal(progressed.ok, true, progressed.reason);
    assert.equal(progressed.seed, crashCreated.seed);
    const staleIntakeBranch = "feature/stale-intake";
    git(operator, "branch", staleIntakeBranch, "HEAD");
    assert.equal(operatorRefAbsent(operator, staleIntakeBranch), false);
    const resumed = selectResume(crash.runDir, crash.repository, staleIntakeBranch);
    assert.deepEqual(resumed.events, [
      "intake-branch",
      "manifest-validated",
      "feature-branch-bound",
      "feature-ref-bound",
      "integration-worktree-bound",
      "operator-guard-ready",
    ]);
    assert.notEqual(resumed.intakeBranch, resumed.featureBranch);
    assert.equal(resumed.featureBranch, crashBranch);
    assert.equal(resumed.featureRef, `refs/heads/${crashBranch}`);
    assert.equal(resumed.integrationWorktree, crash.repository);
    assert.equal(resumed.operatorGuard(operator, resumed.featureBranch), true);
    assert.equal(resumed.operatorGuard(operator, resumed.intakeBranch), false);
    assert.equal(provenance(crash.repository, resumed.featureBranch, false).ok, true);
    assert.equal(provenance(crash.repository, resumed.intakeBranch, false).ok, false);
    assert.equal(resumed.preLockFeatureRef, `refs/heads/${crashBranch}`);
    assert.equal(gitResult(operator, "show-ref", "--verify", "--quiet", resumed.preLockFeatureRef).status, 1);
    assert.equal(gitResult(operator, "show-ref", "--verify", "--quiet", `refs/heads/${staleIntakeBranch}`).status, 0);
    assert.equal(existsSync(join(crash.runDir, "factory.lock")), false);
    const resumedStatus = factory("status", "crash-recovery", "--repo", crash.repository);
    assert.equal(resumedStatus.branch, crashBranch);
    assert.notEqual(resumedStatus.branch, staleIntakeBranch);
    const publicationRef = `refs/heads/${resumedStatus.branch}`;
    assert.equal(publicationRef, `refs/heads/${crashBranch}`);
    assert.notEqual(publicationRef, `refs/heads/${staleIntakeBranch}`);
    assert.equal(gitResult(bare, "show-ref", "--verify", "--quiet", publicationRef).status, 1);
    const activePushBefore = git(crash.repository, "config", "--get-all", "remote.origin.pushurl");
    git(operator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
    assert.equal(compareOnly(operator, crash.repository).ok, false);
    assert.equal(git(crash.repository, "config", "--get-all", "remote.origin.pushurl"), activePushBefore);
    git(operator, "config", "--replace-all", "remote.origin.pushurl", activePushBefore);
    assert.equal(compareOnly(operator, crash.repository).ok, true);
    assert.equal(git(crash.repository, "config", "--get-all", "remote.origin.pushurl"), activePushBefore);

    const recreatedBranch = "feature/recreated";
    const recreated = initFresh(operator, ["recreated", "--branch", recreatedBranch, "--pr-base", "main", "--now", "2026-08-04T12:03:00.000Z"]);
    configureAndCompare(operator, recreated.repository);
    const firstCreation = createBranch(recreated.repository, recreatedBranch);
    const firstRaw = readFileSync(firstCreation.log, "utf8");
    git(recreated.repository, "switch", "main");
    git(recreated.repository, "branch", "-D", recreatedBranch);
    git(recreated.repository, "switch", "--no-track", "-c", recreatedBranch, firstCreation.seed);
    writeFileSync(firstCreation.log, `${firstRaw}${readFileSync(firstCreation.log, "utf8")}`);
    assert.equal(provenance(recreated.repository, recreatedBranch, true).ok, false);

    const raceLooseBranch = "feature/race-loose";
    assert.equal(operatorRefAbsent(operator, raceLooseBranch), true);
    git(operator, "branch", raceLooseBranch, "HEAD");
    const raceLoose = initFresh(operator, ["race-loose", "--branch", raceLooseBranch, "--pr-base", "main", "--now", "2026-08-04T12:04:00.000Z"]);
    const raceLooseState = snapshot(raceLoose.runDir);
    assert.equal(operatorRefAbsent(operator, raceLooseBranch), false);
    assert.equal(gitResult(raceLoose.repository, "config", "--get-all", "remote.origin.pushurl").status, 1);
    assert.deepEqual(snapshot(raceLoose.runDir), raceLooseState);
    assert.equal(existsSync(join(raceLoose.runDir, "factory.lock")), false);

    const raceHeadBranch = "feature/race-head";
    assert.equal(operatorRefAbsent(operator, raceHeadBranch), true);
    git(operator, "switch", "-c", raceHeadBranch);
    const raceHead = initFresh(operator, ["race-head", "--branch", raceHeadBranch, "--pr-base", "main", "--now", "2026-08-04T12:05:00.000Z"]);
    const inheritedRefs = git(raceHead.repository, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort();
    const raceHeadState = snapshot(raceHead.runDir);
    assert.equal(operatorRefAbsent(operator, raceHeadBranch), false);
    assert.equal(provenance(raceHead.repository, raceHeadBranch, true).ok, false);
    assert.deepEqual(git(raceHead.repository, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort(), inheritedRefs);
    assert.equal(gitResult(raceHead.repository, "config", "--get-all", "remote.origin.pushurl").status, 1);
    assert.deepEqual(snapshot(raceHead.runDir), raceHeadState);
    assert.equal(existsSync(join(raceHead.runDir, "factory.lock")), false);
    assert.equal(existsSync(raceHead.repository), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
