import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { enforceEffectivePushTarget } from "../core/effective-push.js";
import { describeError } from "../bin/factory.js";
import { validateRun } from "../state/schema.js";
import { initFresh } from "./init-fixture.js";

test("AC4/AC8-AC12 skill init, push, branch, recovery, and publication policy", () => {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(pkg, "bin", "factory.js");
  const skill = readFileSync(resolve(pkg, "WORKFLOW.md"), "utf8");
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
  const effectiveProof = fresh.slice(fresh.indexOf("### Effective push proof"), fresh.indexOf("### Feature branch provenance and crash recovery"));
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
  const fencedShBlocks = (source) => [...source.matchAll(/```sh\n([\s\S]*?)```/gu)].map((match) => ({
    index: match.index,
    body: match[1],
    operations: match[1].split("\n").map((line) => line.trim()).filter(Boolean),
  }));
  const command = (name, args, options = {}) => spawnSync(name, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", ...options.env },
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const identityCommand = "gh api --method GET /user --jq .login";
  const absoluteShell = "/bin/sh";
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const asciiJson = (value) => {
    let rendered = '"';
    const short = new Map([[8, "\\b"], [9, "\\t"], [10, "\\n"], [12, "\\f"], [13, "\\r"]]);
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (short.has(unit)) rendered += short.get(unit);
      else if (unit === 34) rendered += '\\"';
      else if (unit === 92) rendered += "\\\\";
      else if (unit >= 0x20 && unit <= 0x7e) rendered += value[index];
      else rendered += `\\u${unit.toString(16).padStart(4, "0")}`;
    }
    return `${rendered}"`;
  };
  const classifyIdentity = ({ status, stdout, stderr }) => {
    if (typeof status !== "number" || status !== 0 || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stderr.length !== 0) {
      return { observable: false };
    }
    if (stdout.length < 2 || stdout[stdout.length - 1] !== 10) return { observable: false };
    const bytes = stdout.subarray(0, -1);
    if ([...bytes].some((byte) => byte > 0x7f)) return { observable: false };
    const value = bytes.toString("ascii");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)) return { observable: false };
    return { observable: true, value };
  };
  const identityFailure = (declared, result) => {
    const observed = classifyIdentity(result);
    if (!observed.observable) {
      return `publishing identity unobservable: declared ${asciiJson(declared)}; launch with inherited GH_TOKEN for ${asciiJson(declared)} as documented in OPERATING.md and retry.`;
    }
    if (declared === observed.value) return null;
    return `publishing identity mismatch: declared ${asciiJson(declared)}, observed ${asciiJson(observed.value)}; authenticate as ${asciiJson(declared)} and retry.`;
  };
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
  const childResult = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
  const invokeEffectivePush = (positionals, outcomes) => {
    const events = [];
    let error = null;
    try {
      enforceEffectivePushTarget(positionals, {
        spawnSync(name, args, options) {
          events.push({ name, args, options });
          const outcome = outcomes[events.length - 1];
          if (typeof outcome === "function") return outcome();
          return outcome;
        },
      });
    } catch (caught) {
      error = caught;
    }
    return { events, error };
  };
  const assertChildOptions = (events) => {
    for (const event of events) {
      assert.equal(event.name, "git");
      assert.equal(event.options.shell, false);
      // No encoding: stdout must stay bytes. Decoding to utf8 maps every distinct invalid
      // byte sequence to the same U+FFFD, so two unequal targets could compare equal here
      // while `git push` used the original raw bytes. This assertion previously pinned
      // `"utf8"` — it pinned the defect.
      assert.equal(event.options.encoding, undefined,
        "the target comparison must read bytes, not a lossily decoded string");
      assert.deepEqual(event.options.stdio, ["ignore", "pipe", "pipe"]);
      assert.equal(event.options.env.LC_ALL, "C");
      assert.equal(event.options.env.PATH, process.env.PATH);
    }
  };
  const effectivePushProgram = (...args) => spawnSync(process.execPath, [cli, "effective-push", ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const arityMessage = "factory effective-push: expected exactly three positional arguments: <bootstrap|check> <operator-repository> <sandbox-repository>";
  const emptyMessage = "factory effective-push: positional arguments must be non-empty";
  const operationMessage = "factory effective-push: operation must be bootstrap or check";
  for (const [positionals, message] of [
    [[], arityMessage],
    [["check", "operator"], arityMessage],
    [["check", "operator", "sandbox", "extra"], arityMessage],
    [["", "operator", "sandbox"], emptyMessage],
    [["check", "", "sandbox"], emptyMessage],
    [["check", "operator", ""], emptyMessage],
    [["check", "operator", 1], emptyMessage],
    [["CHECK", "operator", "sandbox"], operationMessage],
  ]) {
    const observed = invokeEffectivePush(positionals, []);
    assert.equal(observed.events.length, 0);
    assert.equal(observed.error?.message, message);
    assert.equal(observed.error?.cause, undefined);
  }

  const initialTarget = "https://initial-user:initial-token@example.invalid/org/repository.git";
  const currentTarget = "https://current-user:current-token@example.invalid/org/repository.git";
  const bootstrapCalls = invokeEffectivePush(["bootstrap", "operator", "sandbox"], [
    childResult(`${initialTarget}\n`),
    { ...childResult("ignored-output"), stderr: "ignored-diagnostic" },
    // Both carry exactly one git record terminator. These previously read `\n\n` and a bare
    // target, which only compared equal because the parser stripped every trailing LF.
    childResult(`${currentTarget}\n`),
    childResult(`${currentTarget}\n`),
  ]);
  assert.equal(bootstrapCalls.error, null);
  assert.equal(bootstrapCalls.events.length, 4);
  assert.deepEqual(bootstrapCalls.events.map(({ args }) => args), [
    ["-C", "operator", "remote", "get-url", "--push", "origin"],
    ["-C", "sandbox", "config", "--replace-all", "remote.origin.pushurl", initialTarget],
    ["-C", "operator", "remote", "get-url", "--push", "origin"],
    ["-C", "sandbox", "remote", "get-url", "--push", "origin"],
  ]);
  assertChildOptions(bootstrapCalls.events);

  const checkCalls = invokeEffectivePush(["check", "operator", "sandbox"], [
    // One terminator each. The second previously omitted it, and only matched because the
    // parser stripped every trailing LF rather than git's single record terminator.
    childResult(`${currentTarget}\n`), childResult(`${currentTarget}\n`),
  ]);
  assert.equal(checkCalls.error, null);
  assert.equal(checkCalls.events.length, 2);
  assert.equal(checkCalls.events.some(({ args }) => args.includes("config")), false);
  assertChildOptions(checkCalls.events);

  // Parsing removes exactly one git-added record terminator and preserves every byte before it.
  // The previous table paired DIFFERENT raw outputs that should "normalize" to one target, and
  // that tolerance is the defect: `repo\n\n` and `repo\n` reduced to the same target while the
  // push used unequal bytes. Only identical bytes can match now, so each pair here is identical.
  for (const [stdout, expected] of [
    ["ssh://example/repo\n", "ssh://example/repo"],
    ["ssh://example/repo\n\n", "ssh://example/repo\n"],
    ["ssh://example/repo\r\n", "ssh://example/repo\r"],
    ["ssh://example/repo\npath\n", "ssh://example/repo\npath"],
    ["ssh://example/repo \t\n", "ssh://example/repo \t"],
  ]) {
    const normalized = invokeEffectivePush(["check", "operator", "sandbox"], [
      childResult(stdout), childResult(`${expected}\n`),
    ]);
    assert.equal(normalized.error, null, JSON.stringify({ stdout, expected }));
    assert.equal(normalized.events.length, 2);
  }
  // The reason the strip is exactly one: a target that itself ends in LF must not equal the same
  // target without it. A greedy strip reduced both to the same bytes and accepted the pair.
  const trailingLfTarget = invokeEffectivePush(["check", "operator", "sandbox"], [
    childResult("ssh://example/repo\n\n"), childResult("ssh://example/repo\n"),
  ]);
  assert.equal(trailingLfTarget.error?.message,
    "factory sandbox: sandbox effective push target does not match operator target; sandbox retained at sandbox",
    "a target ending in LF must not compare equal to the same target without it");
  // Fail closed when git's terminator is absent: that is not the output shape being parsed, so
  // guessing at it would be inventing a target rather than reading one.
  for (const stdout of ["ssh://example/repo", "ssh://example/repo\r", "", "\r", "\n"]) {
    const normalizedEmpty = invokeEffectivePush(["check", "operator", "sandbox"], [childResult(stdout)]);
    assert.equal(normalizedEmpty.events.length, 1);
    assert.equal(normalizedEmpty.error?.message, "factory sandbox: operator effective push target unavailable; sandbox retained at sandbox");
  }

  const diagnosticTarget = "https://diagnostic-user:diagnostic-token@example.invalid/private.git";
  const diagnosticCause = new Error(`nested ${diagnosticTarget}`);
  const unavailableResults = [
    () => { throw new Error(`thrown ${diagnosticTarget}`, { cause: diagnosticCause }); },
    { ...childResult(diagnosticTarget), error: new Error(`result ${diagnosticTarget}`, { cause: diagnosticCause }) },
    { ...childResult(diagnosticTarget), status: null, signal: "SIGTERM", stderr: diagnosticTarget },
    { ...childResult(diagnosticTarget), status: null, stderr: diagnosticTarget },
    { ...childResult(diagnosticTarget), status: 7, stderr: diagnosticTarget },
    // A Buffer stdout used to count as "unavailable", because capture required a string.
    // Bytes are now the normal case, so that row asserted the lossy-decode defect itself.
    // Exactly the terminator and nothing else, so the target is empty. This read `"\n\n"` while
    // the parser stripped every trailing LF; under single-terminator parsing that is a one-byte
    // target, not an absent one.
    childResult("\n"),
  ];
  for (const unavailable of unavailableResults) {
    const operatorFailure = invokeEffectivePush(["check", "operator", "sandbox"], [unavailable]);
    assert.equal(operatorFailure.events.length, 1);
    assert.equal(operatorFailure.error?.message, "factory sandbox: operator effective push target unavailable; sandbox retained at sandbox");
    assert.equal(operatorFailure.error?.cause, undefined);
    assert.equal(describeError(operatorFailure.error).includes(diagnosticTarget), false);
    const sandboxFailure = invokeEffectivePush(["check", "operator", "sandbox"], [
      childResult(`${currentTarget}\n`), unavailable,
    ]);
    assert.equal(sandboxFailure.events.length, 2);
    assert.equal(sandboxFailure.error?.message, "factory sandbox: sandbox effective push target unavailable at sandbox");
    assert.equal(sandboxFailure.error?.cause, undefined);
    assert.equal(describeError(sandboxFailure.error).includes(diagnosticTarget), false);
  }

  const configFailures = [
    () => { throw new Error(`config ${diagnosticTarget}`, { cause: diagnosticCause }); },
    { status: undefined, signal: null, error: new Error(diagnosticTarget), stdout: diagnosticTarget, stderr: diagnosticTarget },
    { status: null, signal: "SIGTERM", stdout: diagnosticTarget, stderr: diagnosticTarget },
    { status: 9, signal: null, stdout: diagnosticTarget, stderr: diagnosticTarget },
  ];
  for (const unavailable of configFailures) {
    const configFailure = invokeEffectivePush(["bootstrap", "operator", "sandbox"], [
      childResult(`${initialTarget}\n`), unavailable,
    ]);
    assert.equal(configFailure.events.length, 2);
    assert.equal(configFailure.error?.message, "factory sandbox: sandbox effective push target unavailable at sandbox");
    assert.equal(configFailure.error?.cause, undefined);
    assert.equal(describeError(configFailure.error).includes(diagnosticTarget), false);
  }

  for (const [outcomes, calls, message] of [
    [[childResult(`${initialTarget}\n`), childResult(), childResult("\n")], 3,
      "factory sandbox: operator effective push target unavailable; sandbox retained at sandbox"],
    [[childResult(`${initialTarget}\n`), childResult(), childResult(`${currentTarget}\n`), childResult("\n")], 4,
      "factory sandbox: sandbox effective push target unavailable at sandbox"],
    [[childResult(`${initialTarget}\n`), childResult(), childResult(`${currentTarget}\n`), childResult(`${initialTarget}\n`)], 4,
      "factory sandbox: sandbox effective push target does not match operator target; sandbox retained at sandbox"],
  ]) {
    const stopped = invokeEffectivePush(["bootstrap", "operator", "sandbox"], outcomes);
    assert.equal(stopped.events.length, calls);
    assert.equal(stopped.error?.message, message);
  }
  const checkMismatch = invokeEffectivePush(["check", "operator", "sandbox"], [
    childResult(`${initialTarget}\n`), childResult(`${currentTarget}\n`),
  ]);
  assert.equal(checkMismatch.events.length, 2);
  assert.equal(checkMismatch.error?.message, "factory sandbox: sandbox effective push target does not match operator target; sandbox retained at sandbox");
  assert.equal(checkMismatch.error?.cause, undefined);
  // Two DIFFERENT invalid UTF-8 targets. Decoded as utf8 both become the same U+FFFD string
  // and this comparison passes, while `git push` would use the original unequal bytes — a
  // sandbox publishing to a target the operator never approved. Byte comparison refuses.
  // A local-path remote on Unix can legitimately hold non-UTF-8 bytes, so this is reachable.
  const invalidA = Buffer.concat([Buffer.from("ssh://host/"), Buffer.from([0xff]), Buffer.from("\n")]);
  const invalidB = Buffer.concat([Buffer.from("ssh://host/"), Buffer.from([0xfe]), Buffer.from("\n")]);
  assert.equal(invalidA.toString("utf8"), invalidB.toString("utf8"),
    "the premise: utf8 decoding collapses these two distinct targets to one string");
  const undecodableMismatch = invokeEffectivePush(["check", "operator", "sandbox"], [
    childResult(invalidA), childResult(invalidB),
  ]);
  assert.equal(undecodableMismatch.error?.message,
    "factory sandbox: sandbox effective push target does not match operator target; sandbox retained at sandbox",
    "distinct invalid UTF-8 targets must not compare equal");
  // Equal raw bytes still match, so the byte comparison did not simply refuse everything.
  const undecodableMatch = invokeEffectivePush(["check", "operator", "sandbox"], [
    childResult(Buffer.from(invalidA)), childResult(Buffer.from(invalidA)),
  ]);
  assert.equal(undecodableMatch.error, null, "identical raw targets must still pass");
  // Bootstrap cannot place a non-round-tripping target in argv without altering it, so it
  // refuses rather than configuring something other than what it captured.
  const unrepresentable = invokeEffectivePush(["bootstrap", "operator", "sandbox"], [
    childResult(invalidA),
  ]);
  assert.equal(unrepresentable.error?.message,
    "factory sandbox: operator effective push target is not representable for configuration; sandbox retained at sandbox");
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
    'factory effective-push "$EFFECTIVE_PUSH_OPERATION" "$O" "$RUN_REPO"',
    "the freshly captured strings must be exactly equal",
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
    "uses `check`, performs two fresh captures, and never changes remote configuration",
    // The bounded properties, not a generic non-disclosure claim. `bootstrap` necessarily puts the
    // target in a child's argv, so "never otherwise expose" was false; these four are what holds.
    "Never persist a captured target, write it to the manifest or an artifact, log or echo it, or",
    "interpolate it into a refusal message or an error's cause chain.",
    // And the boundary must stay stated, so the next reader does not re-derive the wider claim.
    "There is no non-argv route:",
    "discards target-operation stdout, stderr, and subprocess errors",
    "oldest raw line",
    "forty-zero old OID",
    "branch: Created from <seed-oid>",
    "merge-base --is-ancestor",
    "Non-bootstrap, sandbox branch absent",
    "Never recreate a progressed run's branch.",
  ]) required(fresh, fragment, "ratified skill policy");
  assert.equal(occurrences(fresh, 'git -C "$O" show-ref --verify --quiet "$FEATURE_REF"'), 4);
  const effectivePushSites = skill.split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("factory effective-push "));
  assert.deepEqual(effectivePushSites, [
    'factory effective-push "$EFFECTIVE_PUSH_OPERATION" "$O" "$RUN_REPO"',
    'factory effective-push check "$O" "$RUN_REPO"',
  ]);
  assert.doesNotMatch(skill, /remote get-url --push|remote\.origin\.pushurl|OPERATOR_PUSH|CURRENT_OPERATOR_PUSH|CURRENT_RUN_PUSH/u);
  assert.doesNotMatch(skill, /(?:test\s+|\[\s*)["']?\$[A-Z_]*PUSH/u);
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
  ordered(gateThree, [
    "Before every Gate 3 presentation",
    "first validate `artifacts/post-merge-repairs.md`",
    "Then write or refresh `gates/pre_pr.md`",
    "`## Post-merge test-only repairs` section",
    'factory gate "$R" pre_pr pending --artifact gates/pre_pr.md',
  ], "Gate 3 repair validation and summary");
  for (const fragment of [
    "summarizes every journal record in order",
    "introducing\nmerge, attempt, Starting head, trigger result, sorted test paths, cause, property outcome and every\nproperty loss, repair commit, post-repair result, and final or active status",
    "No attempt, outcome, or\nproperty loss may be omitted or collapsed into only the latest result",
  ]) required(gateThree, fragment, "Gate 3 repair attempt/property-loss summary");
  ordered(publication, [
    'factory status "$R" --json --repo "$RUN_REPO"',
    'git -C "$O" show-ref --verify --quiet "refs/heads/$FEATURE_BRANCH"',
    'factory effective-push check "$O" "$RUN_REPO"',
    "Step 6 only compares and never reconfigures a remote",
    'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"',
    'gh pr create --draft --base "$PR_BASE" --head "$FEATURE_BRANCH"',
    'factory pr "$R" --url "$PR_URL" --repo "$RUN_REPO"',
    "Production source ceiling: <landed count> / 3600",
  ], "Step 6 compare/publication");
  const stepSixEquality = required(publication, 'factory effective-push check "$O" "$RUN_REPO"', "Step 6 success sequence");
  const stepSixFirstIdentity = required(publication, identityCommand, "Step 6 success sequence");
  const stepSixPush = required(publication, 'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"', "Step 6 success sequence");
  assert.deepEqual([stepSixEquality, stepSixFirstIdentity, stepSixPush],
    [...[stepSixEquality, stepSixFirstIdentity, stepSixPush]].sort((left, right) => left - right),
    "Step 6 success must keep equality, the first identity guard, and push adjacent in that order");
  const equalityToPush = publication.slice(stepSixEquality + 'factory effective-push check "$O" "$RUN_REPO"'.length, stepSixPush);
  assert.deepEqual(fencedShBlocks(equalityToPush).flatMap(({ operations }) => operations), [identityCommand],
    "Step 6 equality-to-push interval must contain only the first identity guard");
  const distinctRefusal = "Step 6 effective-push refusal parks differently from Step 0: Step 0 remains status-only with an unchanged manifest; Step 6 follows the procedure below.";
  required(publication, distinctRefusal, "Step 6 refusal lifecycle");
  assert.match(publication, /nonzero result from the command below[\s\S]*stdout is empty and stderr\s+is exactly one fixed Step 0 refusal followed by exactly one LF[\s\S]*bind\s+`PRE_QUOTING_REASON` to the resulting already-redacted ASCII refusal/u);
  assert.match(publication, /quiesce every builder, tool,\s+background task, and heartbeat call[\s\S]*surrounding\s+the complete reason with single quotes and replacing every literal `'` with the exact shell sequence\s+`'\\''`/u);
  assert.match(publication, /exact parked top-level status produced by that command[\s\S]*reason byte-for-byte equal to `PRE_QUOTING_REASON`[\s\S]*same verified `SESSION_ID` owner[\s\S]*Release only that owner[\s\S]*lock absent with null owner/u);
  assert.match(publication, /Perform no publishing-identity observation, push, `gh` command, `factory pr`, Step 7 handoff, cleanup, or\s+other effect/u);
  assert.match(effectiveProof, /permit only `factory status "\$R" --json --repo "\$RUN_REPO"`[\s\S]*stop before branch handling/u);
  assert.doesNotMatch(effectiveProof, /factory terminal|factory lock|needs-human/u);
  assert.throws(() => required(publication.replace(distinctRefusal, ""), distinctRefusal, "Step 6 refusal lifecycle"),
    /Step 6 refusal lifecycle contract is missing/u);
  for (const fragment of [
    "## Post-merge test-only repairs",
    "include every attempt",
    "This publication repair-record needs-human remains blocking, and envelope resume does not clear it.",
  ]) required(publication, fragment, "post-merge repair disclosure");
  assert.doesNotMatch(publication, /git -C "\$RUN_REPO" (?:config|remote get-url)/u);
  required(summary, "guarded sandbox-removal", "Step 7 exclusion");
  required(summary, "Only after all ref and archive verification succeeds", "Step 7 guard");

  const identityPolicySection = (source) => {
    const start = required(source, "#### Publishing identity enforcement", "identity enforcement");
    const end = required(source, "#### Story presentation", "identity enforcement boundary");
    return source.slice(start, end);
  };
  const checkIdentitySeams = (source) => {
    const seam = (id, fragment) => {
      assert.equal(occurrences(source, fragment), 1, `identity seam ${id} must appear exactly once`);
      return required(source, fragment, `identity seam ${id}`);
    };
    const freshLock = seam("fresh-verified-lock", "immediately obtain qualified status and require a fresh lock owned by this driver's exact\n`SESSION_ID`.");
    const freshNext = seam("fresh-next-operation", "With a declared identity, the very next operation is the guard below.");
    const freshNoWork = seam("fresh-no-work-before-success", "Only after\nownership and any required guard succeed may the driver reconcile or consult `status.next`. Only then\ndispatch the planned ticket, story, or design agent or transition state.");
    const freshPolicy = seam("fresh-probe-policy", "For a fresh run with `DECLARED_PUBLISHING_IDENTITY`, immediately after qualified status verifies fresh\nlock ownership by this driver's `SESSION_ID`, run the identity observation below before\nreconciliation, reading `status.next`, dispatch, or any transition.");
    const firstProbe = seam("fresh-first-probe", "After that preflight succeeds, submit exactly this command as one ordinary host shell step with cwd\nexactly `RUN_REPO`, the inherited environment including that nonempty `GH_TOKEN`, and no stdin:\n\n```sh\ngh api --method GET /user --jq .login\n```");
    assert.deepEqual([freshLock, freshNext, freshNoWork, freshPolicy, firstProbe],
      [freshLock, freshNext, freshNoWork, freshPolicy, firstProbe].sort((left, right) => left - right),
      "identity seam fresh ordering must keep the verified owner, immediate guard, no-work rule, and probe together");

    const resumeOrderSeven = seam("resume-order-seven", "Resume order 7 — invoke explicit factory resume with the verified owning session, then verify running status, unchanged historical terminal result, real next action, and the same fresh owner.");
    const resumeOrderEight = seam("resume-order-eight-reconciliation", "Resume order 8 — run only existing post-lock reconciliation for an already-recorded merge, its evidence, and repository verification.");
    const resumeBoundary = seam("resume-identity-boundary", "When a validated present config declares `publishing_identity`, the mandatory guard below is the exact\nboundary between completion of resume order 7 and the first operation in resume order 8. Nothing may\nintervene between the verified running/same-owner result and that guard, or between a successful guard\nand reconciliation.");
    const resumePolicy = seam("resume-verified-running-guard", "For a parked resume, run it instead\nimmediately after explicit resume has been verified `running` with unchanged historical result, real\nnext action, and the same fresh owner. No operation may intervene on either side of this guard.");
    assert.ok(resumeOrderSeven < resumeOrderEight && resumeOrderEight < resumeBoundary && resumeBoundary < resumePolicy,
      "identity seam resume ordering must bind verified order 7 to the guard before order-8 reconciliation");
  };
  const identityGuardSites = (source) => fencedShBlocks(source)
    .filter(({ operations }) => operations.includes(identityCommand));
  const inspectIdentityOperation = (operation, allowed = []) => {
    if (/\bgh\s+auth\b/u.test(operation)) throw new Error("identity operation: forbidden gh auth");
    if (/\bgit\s+credential\b/u.test(operation)) throw new Error("identity operation: forbidden Git credential query");
    if (/\bgit\s+config\b[\s\S]*\bcredential[._-]?helper\b/iu.test(operation)) throw new Error("identity operation: forbidden credential helper mutation");
    if (/\bgit\s+config\b/u.test(operation)) throw new Error("identity operation: forbidden Git configuration");
    if (/(?:^|\s)--(?:token|auth-token)\b|\bGH_TOKEN=/u.test(operation)) throw new Error("identity operation: forbidden token argv");
    if (/\$\(|`[^`]+`/u.test(operation)) throw new Error("identity operation: forbidden command substitution");
    if (/\b(?:retry|fallback)\b|\|\|/iu.test(operation)) throw new Error("identity operation: forbidden retry or fallback");
    if (/\b(?:mktemp|tee)\b|(?:^|\s)(?:\/tmp\/|[^\s]+\.(?:tmp|out|log))\b/u.test(operation)) throw new Error("identity operation: forbidden temporary or persistent output");
    if (/(^|[^|])\|(?!\|)/u.test(operation)) throw new Error("identity operation: forbidden pipe");
    if (/(^|\s)(?:>>?|<)\s*/u.test(operation.replace(/<[A-Z_][A-Z0-9_]*>/gu, ""))) throw new Error("identity operation: forbidden redirection");
    if (operation === identityCommand || allowed.includes(operation) || /^factory (?:terminal|lock|status|resume)\b/u.test(operation)) return;
    throw new Error("identity operation: alternate identity command");
  };
  const checkIdentityGuardSites = (source) => {
    const push = 'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"';
    const pr = 'gh pr create --draft --base "$PR_BASE" --head "$FEATURE_BRANCH" --title "$TITLE" --body-file "$BODY_FILE"';
    const record = 'factory pr "$R" --url "$PR_URL" --repo "$RUN_REPO"';
    const expectedSites = [
      [identityCommand],
      [identityCommand],
      [push, identityCommand, "(", 'cd "$O"', pr, ")", record],
    ];
    const sites = identityGuardSites(source);
    assert.equal(sites.length, 3, "identity guard sites must be exactly early, pre-push, and pre-PR");
    for (const [index, site] of sites.entries()) {
      assert.equal(site.operations.filter((operation) => operation === identityCommand).length, 1,
        `identity guard site ${index + 1} must contain one exact probe`);
      for (const operation of site.operations) inspectIdentityOperation(operation, expectedSites[index]);
      assert.deepEqual(site.operations, expectedSites[index],
        `identity guard site ${index + 1} must preserve its complete allowed operation sequence`);
    }
    const targetChecks = [...source.matchAll(/^    factory effective-push .+$/gmu)].map((match) => match.index);
    assert.equal(targetChecks.length, 2, "package target checks remain outside all identity guard sites");
    assert.equal(targetChecks.every((index) => !sites.some((site) => index >= site.index && index < site.index + site.body.length)), true,
      "target check sites must not become identity guard sites");
  };
  const checkIdentityPolicy = (source) => {
    checkIdentitySeams(source);
    const policy = identityPolicySection(source);
    const policyEnd = source.indexOf("#### Story presentation");
    checkIdentityGuardSites(source);
    assert.match(policy, /verification is enforcement under AGENTS\.md and CLAUDE\.md because it prevents a false-green\s+publication/u);
    assert.match(policy, /Provisioning `GH_TOKEN` and\s+configuring credential helpers are instruction only/u);
    assert.match(policy, /At every one of the three guards, before submitting a host shell step, inspect only the inherited\s+environment value and require `GH_TOKEN` to exist and contain at least one character/u);
    assert.match(policy, /Missing or empty\s+`GH_TOKEN` is immediately the same unobservable reason[\s\S]*Do not invoke `gh`, hit the network,\s+inspect stored authentication, query or attempt credentials, or run any fallback/u);
    assert.match(policy, /preflight succeeds, submit exactly this command as one ordinary host shell step with cwd\s+exactly `RUN_REPO`, the inherited environment including that nonempty `GH_TOKEN`, and no stdin/u);
    assert.match(policy, /host result directly as three separate values: exact stdout bytes, exact stderr bytes, and the\s+numeric status/u);
    assert.match(policy, /Do not use command substitution, pipes, redirection, shell capture variables, temporary\s+files, nested capture, retry, fallback, `gh auth`, credential queries, Git configuration, a token in\s+argv, or persistence of output or diagnostics/u);
    assert.match(policy, /status is numeric zero, stderr has exactly zero bytes, and stdout\s+is exactly one ASCII login followed by exactly one LF byte/u);
    assert.ok(policy.includes("`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`"));
    assert.match(policy, /compare the raw declared and observed strings exactly and\s+case-sensitively before rendering/u);
    assert.match(policy, /deterministic ASCII-only JSON-string renderer[\s\S]*lowercase `\\uXXXX`[\s\S]*unpaired surrogate[\s\S]*Leave slash unescaped/u);
    assert.ok(policy.includes("publishing identity mismatch: declared <declared-ascii-json>, observed <observed-ascii-json>; authenticate as <declared-ascii-json> and retry."));
    assert.ok(policy.includes("publishing identity unobservable: declared <declared-ascii-json>; launch with inherited GH_TOKEN for <declared-ascii-json> as documented in OPERATING.md and retry."));
    assert.match(policy, /Never expose the token, raw stdout or stderr, diagnostics, status, command text, target, helper output,\s+or environment/u);
    assert.match(policy, /quiesce every builder, tool, background task, and heartbeat call[\s\S]*Bind `PRE_QUOTING_REASON` to the complete already-rendered ASCII reason/u);
    assert.match(policy, /surrounding the complete reason with single quotes and replacing every literal\s+`'` inside it with the exact shell sequence `'\\''`[\s\S]*encoded token as the sole `--reason`\s+argument in the host shell command string/u);
    assert.match(policy, /Do not put the raw or rendered reason inside double quotes, interpolate it as unquoted shell syntax,\s+`eval` it, use command substitution, a temporary file, or environment indirection/u);
    assert.match(policy, /quoting form is\s+transport only and is never persisted[\s\S]*reason\s+byte-for-byte equal to `PRE_QUOTING_REASON`, not the encoded token[\s\S]*Release only that owner[\s\S]*prove the lock absent with null owner/u);
    assert.match(policy, /new driver's own `SESSION_ID`[\s\S]*factory resume "\$R" --session "\$SESSION_ID" --repo "\$RUN_REPO"[\s\S]*continue from the newly qualified `status\.next`[\s\S]*Never reuse the\s+released session/u);
    assert.match(policy, /report only `Outcome: retained-lock-error`[\s\S]*no parked-success or resumability claim/u);
    assert.match(source, /exact\s+boundary between completion of resume order 7 and the first operation in resume order 8/u);
    assert.match(source, /There is no\s+separate identity guard before `factory pr`/u);
    const positions = [...source.matchAll(new RegExp(identityCommand, "gu"))].map((match) => match.index);
    assert.equal(positions.length, 3);
    const push = required(source, 'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"', "identity push order");
    const pr = required(source, 'gh pr create --draft --base "$PR_BASE" --head "$FEATURE_BRANCH"', "identity PR order");
    assert.ok(positions[0] > gateOneStart && positions[0] < policyEnd);
    assert.ok(positions[1] > source.indexOf("Both lookups must succeed and return nonempty output") && positions[1] < push);
    assert.ok(positions[2] > push && positions[2] < pr);
  };
  checkIdentityPolicy(skill);
  for (const [id, fragment] of [
    ["fresh-verified-lock", "immediately obtain qualified status and require a fresh lock owned by this driver's exact\n`SESSION_ID`."],
    ["fresh-next-operation", "With a declared identity, the very next operation is the guard below."],
    ["fresh-no-work-before-success", "Only after\nownership and any required guard succeed may the driver reconcile or consult `status.next`. Only then\ndispatch the planned ticket, story, or design agent or transition state."],
    ["fresh-probe-policy", "For a fresh run with `DECLARED_PUBLISHING_IDENTITY`, immediately after qualified status verifies fresh\nlock ownership by this driver's `SESSION_ID`, run the identity observation below before\nreconciliation, reading `status.next`, dispatch, or any transition."],
    ["fresh-first-probe", "After that preflight succeeds, submit exactly this command as one ordinary host shell step with cwd\nexactly `RUN_REPO`, the inherited environment including that nonempty `GH_TOKEN`, and no stdin:\n\n```sh\ngh api --method GET /user --jq .login\n```"],
    ["resume-order-seven", "Resume order 7 — invoke explicit factory resume with the verified owning session, then verify running status, unchanged historical terminal result, real next action, and the same fresh owner."],
    ["resume-order-eight-reconciliation", "Resume order 8 — run only existing post-lock reconciliation for an already-recorded merge, its evidence, and repository verification."],
    ["resume-identity-boundary", "When a validated present config declares `publishing_identity`, the mandatory guard below is the exact\nboundary between completion of resume order 7 and the first operation in resume order 8. Nothing may\nintervene between the verified running/same-owner result and that guard, or between a successful guard\nand reconciliation."],
    ["resume-verified-running-guard", "For a parked resume, run it instead\nimmediately after explicit resume has been verified `running` with unchanged historical result, real\nnext action, and the same fresh owner. No operation may intervene on either side of this guard."],
  ]) assert.throws(() => checkIdentityPolicy(skill.replace(fragment, "")), new RegExp(`identity seam ${id}`, "u"),
    `removing ${id} must break the load-bearing identity seam`);
  const moveUnique = (source, fragment, anchor, placement) => {
    assert.equal(occurrences(source, fragment), 1, "movement control fragment must be unique before removal");
    assert.equal(occurrences(source, anchor), 1, "movement control anchor must be unique before insertion");
    const without = source.replace(fragment, "");
    const anchorIndex = required(without, anchor, "movement control anchor");
    const insertion = placement === "before" ? anchorIndex : anchorIndex + anchor.length;
    const moved = `${without.slice(0, insertion)}${fragment}\n${without.slice(insertion)}`;
    assert.equal(occurrences(moved, fragment), 1, "movement control must reinsert exactly one fragment");
    return moved;
  };
  const freshNoWorkFragment = "Only after\nownership and any required guard succeed may the driver reconcile or consult `status.next`. Only then\ndispatch the planned ticket, story, or design agent or transition state.";
  const freshLockFragment = "immediately obtain qualified status and require a fresh lock owned by this driver's exact\n`SESSION_ID`.";
  assert.throws(() => checkIdentityPolicy(moveUnique(skill, freshNoWorkFragment, freshLockFragment, "before")),
    /identity seam fresh ordering/u, "moving the fresh no-work boundary before verified ownership must fail");
  const resumeBoundaryFragment = "When a validated present config declares `publishing_identity`, the mandatory guard below is the exact\nboundary between completion of resume order 7 and the first operation in resume order 8. Nothing may\nintervene between the verified running/same-owner result and that guard, or between a successful guard\nand reconciliation.";
  const resumeOrderSevenFragment = "Resume order 7 — invoke explicit factory resume with the verified owning session, then verify running status, unchanged historical terminal result, real next action, and the same fresh owner.";
  assert.throws(() => checkIdentityPolicy(moveUnique(skill, resumeBoundaryFragment, resumeOrderSevenFragment, "before")),
    /identity seam resume ordering/u, "moving the resume guard boundary outside order 7 to order 8 must fail");
  for (const transition of [
    identityCommand,
    'factory terminal "$R" needs-human --reason <REASON_TOKEN> --repo "$RUN_REPO"',
    'factory lock "$R" release --session "$SESSION_ID" --repo "$RUN_REPO"',
    'factory status "$R" --json --repo "$RUN_REPO"',
    'factory resume "$R" --session "$SESSION_ID" --repo "$RUN_REPO"',
  ]) assert.doesNotThrow(() => inspectIdentityOperation(transition), `identity instrumentation must allow ${transition}`);
  for (const [id, operation, expected] of [
    ["gh-auth", "gh auth status", /forbidden gh auth/u],
    ["credential-query", "git credential fill", /forbidden Git credential query/u],
    ["git-config", "git config --global user.name wrong-account", /forbidden Git configuration/u],
    ["helper-mutation", "git config --global credential.helper store", /forbidden credential helper mutation/u],
    ["token-argv", `${identityCommand} --token secret`, /forbidden token argv/u],
    ["command-substitution", `IDENTITY=$( ${identityCommand} )`, /forbidden command substitution/u],
    ["pipe", `${identityCommand} | cat`, /forbidden pipe/u],
    ["redirection", `${identityCommand} > /dev/null`, /forbidden redirection/u],
    ["temp-file", "mktemp identity", /forbidden temporary or persistent output/u],
    ["persistent-output", "tee identity.log", /forbidden temporary or persistent output/u],
    ["retry-fallback", `${identityCommand} || retry ${identityCommand}`, /forbidden retry or fallback/u],
    ["alternate-command", "whoami", /alternate identity command/u],
  ]) {
    for (const [siteIndex, site] of identityGuardSites(skill).entries()) {
      assert.equal(site.operations.filter((entry) => entry === identityCommand).length, 1,
        `identity guard site ${siteIndex + 1} has one probe before ${id} injection`);
      const probeIndex = skill.indexOf(identityCommand, site.index);
      assert.ok(probeIndex >= site.index && probeIndex < site.index + site.body.length,
        `identity guard site ${siteIndex + 1} locates its probe before ${id} injection`);
      const injected = `${skill.slice(0, probeIndex + identityCommand.length)}\n${operation}${skill.slice(probeIndex + identityCommand.length)}`;
      assert.throws(() => checkIdentityGuardSites(injected), expected,
        `identity instrumentation must reject ${id} beside probe in guard site ${siteIndex + 1}`);
    }
  }
  for (const marker of [
    "#### Publishing identity enforcement",
    "At every one of the three guards, before submitting a host shell step",
    "Missing or empty\n`GH_TOKEN` is immediately the same unobservable reason",
    "Use the host result directly as three separate values",
    "deterministic ASCII-only JSON-string renderer",
    "publishing identity mismatch: declared <declared-ascii-json>",
    "publishing identity unobservable: declared <declared-ascii-json>",
    "Bind `PRE_QUOTING_REASON` to the complete already-rendered ASCII reason",
    "exact shell sequence `'\\''`",
    "Do not put the raw or rendered reason inside double quotes",
    "byte-for-byte equal to `PRE_QUOTING_REASON`, not the encoded token",
    "report only `Outcome: retained-lock-error`",
    "There is no\nseparate identity guard before `factory pr`",
  ]) assert.throws(() => checkIdentityPolicy(skill.replace(marker, "")), undefined, marker);

  const root = mkdtempSync(join(tmpdir(), "factory-effective-push-"));
  try {
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    const invocationMarker = join(root, "gh-invocations");
    writeFileSync(fakeGh, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const expected = ["api", "--method", "GET", "/user", "--jq", ".login"];
const received = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_MARKER, JSON.stringify(received) + "\\n");
if (JSON.stringify(received) !== JSON.stringify(expected)) process.exit(97);
process.stdout.write(Buffer.from(process.env.FAKE_GH_STDOUT_B64 ?? "", "base64"));
process.stderr.write(Buffer.from(process.env.FAKE_GH_STDERR_B64 ?? "", "base64"));
process.exit(Number(process.env.FAKE_GH_STATUS ?? "0"));
`);
    chmodSync(fakeGh, 0o755);
    const observeIdentity = (cwd, {
      stdout = Buffer.from("A\n"), stderr = Buffer.alloc(0), status = 0, ghToken = "prepared-token",
    } = {}) => {
      const env = {
        ...process.env,
        PATH: fakeBin,
        GH_TOKEN: ghToken,
        FAKE_GH_MARKER: invocationMarker,
        FAKE_GH_STDOUT_B64: stdout.toString("base64"),
        FAKE_GH_STDERR_B64: stderr.toString("base64"),
        FAKE_GH_STATUS: String(status),
      };
      if (ghToken === null) delete env.GH_TOKEN;
      return spawnSync(absoluteShell, ["-c", identityCommand], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    };
    const terminalThroughShell = (repository, run, reason) => {
      const reasonToken = shellQuote(reason);
      const commandString = [
        shellQuote(process.execPath), shellQuote(cli), "terminal", shellQuote(run), "needs-human",
        "--reason", reasonToken, "--repo", shellQuote(repository), "--json",
      ].join(" ");
      const result = spawnSync(absoluteShell, ["-c", commandString], {
        cwd: repository,
        env: { ...process.env, PATH: fakeBin },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { commandString, reasonToken, result };
    };
    const guardedDriver = (repository, declared, observations = []) => {
      const events = [];
      let observation = 0;
      const guard = (name) => {
        if (declared === null) return null;
        events.push(`identity:${name}`);
        const options = observations[observation] ?? {};
        observation += 1;
        const ghToken = Object.hasOwn(options, "ghToken") ? options.ghToken : "prepared-token";
        if (typeof ghToken !== "string" || ghToken.length === 0) {
          return identityFailure(declared, { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
        }
        return identityFailure(declared, observeIdentity(repository, { ...options, ghToken }));
      };
      let reason = guard("post-lock-or-resume");
      if (reason) return { events, reason };
      events.push("reconciliation/status.next/dispatch/transition");
      events.push("effective-push-targets-exactly-equal");
      reason = guard("pre-push");
      if (reason) return { events, reason };
      events.push('git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"');
      reason = guard("pre-pr-create");
      if (reason) return { events, reason };
      events.push('gh pr create --draft --base "$PR_BASE" --head "$FEATURE_BRANCH" --title "$TITLE" --body-file "$BODY_FILE"');
      events.push('factory pr "$R" --url "$PR_URL" --repo "$RUN_REPO"');
      return { events, reason: null };
    };
    const markerLines = () => existsSync(invocationMarker)
      ? readFileSync(invocationMarker, "utf8").trimEnd().split("\n").filter(Boolean)
      : [];
    assert.equal(isAbsolute(absoluteShell), true);
    assert.equal(isAbsolute(process.execPath), true);
    assert.equal(readFileSync(fakeGh, "utf8").startsWith(`#!${process.execPath}\n`), true);
    assert.equal(readFileSync(fakeGh, "utf8").includes("GH_TOKEN"), false);
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
    for (const [value, expected] of [
      ['"', '"\\""'],
      ["\\", '"\\\\"'],
      ["/", '"/"'],
      ["\u0000\b\t\n\f\r\u001f", '"\\u0000\\b\\t\\n\\f\\r\\u001f"'],
      ["\u007f", '"\\u007f"'],
      ["\u0080\u0085", '"\\u0080\\u0085"'],
      ["\u2028\u2029", '"\\u2028\\u2029"'],
      ["🚀", '"\\ud83d\\ude80"'],
      ["\ud800", '"\\ud800"'],
    ]) assert.equal(asciiJson(value), expected);
    rmSync(invocationMarker, { force: true });
    assert.deepEqual(classifyIdentity(observeIdentity(root)), { observable: true, value: "A" });
    assert.deepEqual(markerLines(), [JSON.stringify(["api", "--method", "GET", "/user", "--jq", ".login"])]);
    const noFallbackBin = join(root, "no-fallback-bin");
    mkdirSync(noFallbackBin);
    const unresolvedGh = spawnSync(absoluteShell, ["-c", identityCommand], {
      cwd: root,
      env: { ...process.env, PATH: noFallbackBin, GH_TOKEN: "prepared-token" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(unresolvedGh.status, 127);
    for (const result of [
      { status: null, stdout: Buffer.from("A\n"), stderr: Buffer.alloc(0) },
      { status: "0", stdout: Buffer.from("A\n"), stderr: Buffer.alloc(0) },
      observeIdentity(root, { status: 1 }),
      observeIdentity(root, { stdout: Buffer.from("A") }),
      observeIdentity(root, { stdout: Buffer.from("A\n\n") }),
      observeIdentity(root, { stdout: Buffer.from("-A\n") }),
      observeIdentity(root, { stdout: Buffer.from(`${"A".repeat(40)}\n`) }),
      observeIdentity(root, { stdout: Buffer.from([0x41, 0x85, 0x0a]) }),
      observeIdentity(root, { stderr: Buffer.from("diagnostic-secret") }),
    ]) assert.deepEqual(classifyIdentity(result), { observable: false });
    assert.equal(identityFailure("A", observeIdentity(root)), null);
    assert.equal(identityFailure("a", observeIdentity(root)), 'publishing identity mismatch: declared "a", observed "A"; authenticate as "a" and retry.');
    const unobservableReason = identityFailure("A\u2028🚀", observeIdentity(root, {
      stdout: Buffer.from("raw-output-secret"),
      stderr: Buffer.from("diagnostic-secret token-that-must-never-appear"),
    }));
    assert.equal(unobservableReason, 'publishing identity unobservable: declared "A\\u2028\\ud83d\\ude80"; launch with inherited GH_TOKEN for "A\\u2028\\ud83d\\ude80" as documented in OPERATING.md and retry.');
    for (const hidden of ["raw-output-secret", "diagnostic-secret", "token-that-must-never-appear", identityCommand, root]) {
      assert.equal(unobservableReason.includes(hidden), false);
    }
    for (const ghToken of [null, ""]) {
      rmSync(invocationMarker, { force: true });
      const stopped = guardedDriver(root, "A", [{ ghToken, stdout: Buffer.from("A\n") }]);
      assert.deepEqual(stopped.events, ["identity:post-lock-or-resume"]);
      assert.equal(stopped.reason, 'publishing identity unobservable: declared "A"; launch with inherited GH_TOKEN for "A" as documented in OPERATING.md and retry.');
      assert.equal(existsSync(invocationMarker), false);
    }
    rmSync(invocationMarker, { force: true });
    const allMatching = guardedDriver(root, "A", [
      { ghToken: "prepared-token" }, { ghToken: "prepared-token" }, { ghToken: "prepared-token" },
    ]);
    assert.deepEqual(allMatching, {
      events: [
        "identity:post-lock-or-resume",
        "reconciliation/status.next/dispatch/transition",
        "effective-push-targets-exactly-equal",
        "identity:pre-push",
        'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"',
        "identity:pre-pr-create",
        'gh pr create --draft --base "$PR_BASE" --head "$FEATURE_BRANCH" --title "$TITLE" --body-file "$BODY_FILE"',
        'factory pr "$R" --url "$PR_URL" --repo "$RUN_REPO"',
      ],
      reason: null,
    });
    assert.deepEqual(allMatching.events.slice(2, 5), [
      "effective-push-targets-exactly-equal",
      "identity:pre-push",
      'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"',
    ]);
    assert.equal(markerLines().length, 3);
    assert.equal(markerLines().every((line) => line === JSON.stringify(["api", "--method", "GET", "/user", "--jq", ".login"])), true);
    const beforeAbsentConfig = markerLines();
    const absentConfig = guardedDriver(root, null);
    assert.deepEqual(absentConfig.events, allMatching.events.filter((event) => !event.startsWith("identity:")));
    assert.deepEqual(markerLines(), beforeAbsentConfig);
    for (const [observations, finalEvent, invocationCount] of [
      [[{ ghToken: "prepared-token", stdout: Buffer.from("B\n") }], undefined, 1],
      [[{ ghToken: "prepared-token" }, { ghToken: "prepared-token", stdout: Buffer.from("B\n") }], "effective-push-targets-exactly-equal", 2],
      [[{ ghToken: "prepared-token" }, { ghToken: "prepared-token" }, { ghToken: "prepared-token", stdout: Buffer.from("B\n") }], 'git -C "$RUN_REPO" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"', 3],
    ]) {
      rmSync(invocationMarker, { force: true });
      const stopped = guardedDriver(root, "A", observations);
      assert.equal(stopped.reason, 'publishing identity mismatch: declared "A", observed "B"; authenticate as "A" and retry.');
      assert.equal(stopped.events.at(-2) === finalEvent || stopped.events.at(-1) === finalEvent, true);
      assert.equal(stopped.events.includes('gh pr create --draft --base "$PR_BASE" --head "$FEATURE_BRANCH" --title "$TITLE" --body-file "$BODY_FILE"'), false);
      assert.equal(stopped.events.includes('factory pr "$R" --url "$PR_URL" --repo "$RUN_REPO"'), false);
      assert.equal(markerLines().length, invocationCount);
    }
    assert.deepEqual(readdirSync(fakeBin), ["gh"]);
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

    const sideEffectSentinel = join(root, "identity-reason-side-effect");
    const hostileIdentities = [
      `$(: > ${sideEffectSentinel})`,
      `\`: > ${sideEffectSentinel}\``,
      "single'quote",
      'double"quote',
      "back\\slash",
      "semi;colon",
      "space value",
      "glob*?[x]",
    ];
    for (const [index, declared] of hostileIdentities.entries()) {
      const run = `identity-transport-${index}`;
      const parkedIdentity = initFresh(operator, [run, "--branch", `feature/${run}`, "--pr-base", "main", "--now", `2026-08-04T11:59:${String(index).padStart(2, "0")}.000Z`]);
      const parkedReason = identityFailure(declared, { status: 0, stdout: Buffer.from("B\n"), stderr: Buffer.alloc(0) });
      const releasedSession = `released-session-${index}`;
      const freshSession = `fresh-session-${index}`;
      rmSync(sideEffectSentinel, { force: true });
      factory("lock", run, "claim", "--session", releasedSession, "--repo", parkedIdentity.repository);
      const ownedBeforePark = factory("status", run, "--repo", parkedIdentity.repository);
      assert.equal(ownedBeforePark.lock_session, releasedSession);
      const transported = terminalThroughShell(parkedIdentity.repository, run, parkedReason);
      assert.equal(transported.result.status, 0, transported.result.stderr);
      assert.ok(transported.commandString.includes(`--reason ${transported.reasonToken} --repo`));
      assert.equal((transported.commandString.match(/--reason/gu) ?? []).length, 1);
      assert.equal(transported.commandString.includes('--reason "'), false);
      assert.equal(transported.reasonToken, shellQuote(parkedReason));
      const durablePark = factory("status", run, "--repo", parkedIdentity.repository);
      assert.equal(durablePark.status, "needs-human");
      assert.equal(durablePark.terminal_result.reason, parkedReason);
      assert.equal(durablePark.lock_session, releasedSession);
      assert.equal(existsSync(sideEffectSentinel), false);
      factory("lock", run, "release", "--session", releasedSession, "--repo", parkedIdentity.repository);
      const unlockedPark = factory("status", run, "--repo", parkedIdentity.repository);
      assert.equal(unlockedPark.lock, "absent");
      assert.equal(unlockedPark.lock_session, null);
      factory("lock", run, "claim", "--session", freshSession, "--repo", parkedIdentity.repository);
      const freshlyClaimed = factory("status", run, "--repo", parkedIdentity.repository);
      assert.equal(freshlyClaimed.status, "needs-human");
      assert.deepEqual(freshlyClaimed.terminal_result, durablePark.terminal_result);
      assert.equal(freshlyClaimed.next, durablePark.next);
      assert.equal(freshlyClaimed.lock_session, freshSession);
      factory("resume", run, "--session", freshSession, "--repo", parkedIdentity.repository);
      const resumedIdentity = factory("status", run, "--repo", parkedIdentity.repository);
      assert.equal(resumedIdentity.status, "running");
      assert.deepEqual(resumedIdentity.terminal_result, durablePark.terminal_result);
      assert.equal(resumedIdentity.next, durablePark.next);
      assert.equal(resumedIdentity.lock_session, freshSession);
      assert.equal(existsSync(sideEffectSentinel), false);
    }

    const mismatchBranch = "feature/push-mismatch";
    assert.equal(operatorRefAbsent(operator, mismatchBranch), true);
    const mismatch = initFresh(operator, ["push-mismatch", "--branch", mismatchBranch, "--pr-base", "main", "--now", "2026-08-04T12:00:00.000Z"]);
    assert.equal(mismatch.response.sandbox_path, mismatch.repository);
    assert.equal(mismatch.response.run_dir, mismatch.runDir);
    assert.ok(isAbsolute(mismatch.repository));
    assert.equal(realpathSync(mismatch.repository), mismatch.repository);
    assert.equal(relative(mismatch.repository, mismatch.runDir).startsWith(".."), false);
    assert.equal(operatorRefAbsent(operator, mismatchBranch), true);
    for (const [args, message] of [
      [[], arityMessage],
      [["check", operator], arityMessage],
      [["check", operator, mismatch.repository, "extra"], arityMessage],
      [["", operator, mismatch.repository], emptyMessage],
      [["check", "", mismatch.repository], emptyMessage],
      [["check", operator, ""], emptyMessage],
      [["CHECK", operator, mismatch.repository], operationMessage],
    ]) {
      const invalid = effectivePushProgram(...args);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, "");
      assert.equal(invalid.stderr, `${message}\n`);
    }
    const bootstrapProgram = effectivePushProgram("bootstrap", operator, mismatch.repository);
    assert.equal(bootstrapProgram.status, 0, bootstrapProgram.stderr);
    assert.equal(bootstrapProgram.stdout, "");
    assert.equal(bootstrapProgram.stderr, "");
    const checkProgram = effectivePushProgram("check", operator, mismatch.repository);
    assert.equal(checkProgram.status, 0, checkProgram.stderr);
    assert.equal(checkProgram.stdout, "");
    assert.equal(checkProgram.stderr, "");
    const beforeMismatch = snapshot(mismatch.runDir);
    const mismatchEvents = [];
    let mismatchError;
    try {
      enforceEffectivePushTarget(["bootstrap", operator, mismatch.repository], {
        spawnSync(name, args, options) {
          mismatchEvents.push({ name, args, options });
          const result = spawnSync(name, args, options);
          if (mismatchEvents.length === 2) git(operator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
          return result;
        },
      });
    } catch (error) {
      mismatchError = error;
    }
    assert.equal(mismatchEvents.length, 4);
    assertChildOptions(mismatchEvents);
    assert.equal(mismatchEvents[1].args.at(-1), secretOne);
    assert.equal(mismatchError?.message, `factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${mismatch.repository}`);
    assert.equal(mismatchError?.cause, undefined);
    assert.equal(describeError(mismatchError), mismatchError.message);
    const mismatchProgram = effectivePushProgram("check", operator, mismatch.repository);
    assert.equal(mismatchProgram.status, 1);
    assert.equal(mismatchProgram.stdout, "");
    assert.equal(mismatchProgram.stderr, `${mismatchError.message}\n`);
    const unavailableProgram = effectivePushProgram("check", join(root, "missing-operator"), mismatch.repository);
    assert.equal(unavailableProgram.status, 1);
    assert.equal(unavailableProgram.stdout, "");
    assert.equal(unavailableProgram.stderr, `factory sandbox: operator effective push target unavailable; sandbox retained at ${mismatch.repository}\n`);
    for (const hidden of [secretOne, secretTwo, "operator-user", "credential-token", "other-user", "other-token", "fetch-target.git", "push-target.git"]) {
      assert.equal(mismatchError.message.includes(hidden), false, `refusal disclosed ${hidden}`);
      assert.equal(describeError(mismatchError).includes(hidden), false, `cause chain disclosed ${hidden}`);
      assert.equal(mismatchProgram.stderr.includes(hidden), false, `program refusal disclosed ${hidden}`);
      assert.equal(JSON.stringify(snapshot(mismatch.runDir)).includes(hidden), false, `factory state disclosed ${hidden}`);
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
    const crash = initFresh(operator, ["crash-recovery", "--branch", crashBranch, "--pr-base", "main", "--mode", "autonomous", "--now", "2026-08-04T12:01:00.000Z"]);
    assert.equal(gitResult(crash.repository, "config", "--get-all", "remote.origin.pushurl").status, 1);
    const crashRun = JSON.parse(readFileSync(join(crash.runDir, "run.json"), "utf8"));
    const crashStatus = factory("status", "crash-recovery", "--repo", crash.repository);
    assert.equal(bootstrapPending(crashRun, crashStatus), true);
    assert.doesNotThrow(() => enforceEffectivePushTarget(["bootstrap", operator, crash.repository]));
    const configuredTarget = git(crash.repository, "config", "--get-all", "remote.origin.pushurl");
    assert.doesNotThrow(() => enforceEffectivePushTarget(["bootstrap", operator, crash.repository]));
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
    const stepSixSession = "step-six-owner";
    factory("lock", "crash-recovery", "claim", "--session", stepSixSession, "--repo", crash.repository);
    const beforeStepSixStatus = factory("status", "crash-recovery", "--repo", crash.repository);
    assert.equal(beforeStepSixStatus.status, "running");
    assert.equal(beforeStepSixStatus.mode, "autonomous");
    assert.equal(beforeStepSixStatus.lock_session, stepSixSession);
    const beforeStepSixRun = JSON.parse(readFileSync(join(crash.runDir, "run.json"), "utf8"));
    const progressState = ({ status: _status, updated_at: _updatedAt, terminal_result: _terminalResult, ...progress }) => progress;
    rmSync(invocationMarker, { force: true });
    git(operator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
    const stepSixEvents = ["effective-push:check"];
    const stepSixRefusal = effectivePushProgram("check", operator, crash.repository);
    const stepSixReason = `factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${crash.repository}`;
    assert.equal(stepSixRefusal.status, 1);
    assert.equal(stepSixRefusal.stdout, "");
    assert.equal(stepSixRefusal.stderr, `${stepSixReason}\n`);
    assert.match(stepSixReason, /^[\x20-\x7e]+$/u);
    stepSixEvents.push("quiesce:builders-tools-background-heartbeats");
    const parkedStepSix = terminalThroughShell(crash.repository, "crash-recovery", stepSixReason);
    stepSixEvents.push("terminal:needs-human");
    assert.equal(parkedStepSix.result.status, 0, parkedStepSix.result.stderr);
    assert.equal(parkedStepSix.reasonToken, shellQuote(stepSixReason));
    assert.equal((parkedStepSix.commandString.match(/--reason/gu) ?? []).length, 1);
    assert.ok(parkedStepSix.commandString.includes(`--reason ${parkedStepSix.reasonToken} --repo`));
    assert.equal(parkedStepSix.commandString.includes('--reason "'), false);
    const parkedStepSixStatus = factory("status", "crash-recovery", "--repo", crash.repository);
    stepSixEvents.push("status:parked-owner-and-reason");
    assert.equal(parkedStepSixStatus.status, "needs-human");
    assert.deepEqual(parkedStepSixStatus.terminal_result, { status: "needs-human", reason: stepSixReason });
    assert.equal(parkedStepSixStatus.lock_session, stepSixSession);
    const parkedStepSixRun = JSON.parse(readFileSync(join(crash.runDir, "run.json"), "utf8"));
    assert.deepEqual(progressState(parkedStepSixRun), progressState(beforeStepSixRun));
    assert.equal(parkedStepSixRun.terminal_result.reason, stepSixReason);
    factory("lock", "crash-recovery", "release", "--session", stepSixSession, "--repo", crash.repository);
    stepSixEvents.push("lock:release");
    const unlockedStepSix = factory("status", "crash-recovery", "--repo", crash.repository);
    stepSixEvents.push("status:unlocked");
    assert.equal(unlockedStepSix.status, "needs-human");
    assert.deepEqual(unlockedStepSix.terminal_result, parkedStepSixStatus.terminal_result);
    assert.equal(unlockedStepSix.lock, "absent");
    assert.equal(unlockedStepSix.lock_session, null);
    assert.deepEqual(stepSixEvents, [
      "effective-push:check",
      "quiesce:builders-tools-background-heartbeats",
      "terminal:needs-human",
      "status:parked-owner-and-reason",
      "lock:release",
      "status:unlocked",
    ]);
    assert.equal(stepSixEvents.some((event) => /identity|push origin|gh pr|factory pr|cleanup/u.test(event)), false);
    assert.equal(existsSync(invocationMarker), false);
    assert.equal(gitResult(bare, "show-ref", "--verify", "--quiet", publicationRef).status, 1);
    assert.equal(parkedStepSixRun.pr_url, null);
    assert.equal(existsSync(join(crash.repository, "progressed.txt")), true);
    assert.equal(existsSync(crash.repository), true);
    for (const hidden of [secretOne, secretTwo, "operator-user", "credential-token", "other-user", "other-token"]) {
      assert.equal(stepSixReason.includes(hidden), false);
      assert.equal(JSON.stringify(parkedStepSixRun).includes(hidden), false);
    }
    assert.equal(git(crash.repository, "config", "--get-all", "remote.origin.pushurl"), activePushBefore);
    git(operator, "config", "--replace-all", "remote.origin.pushurl", activePushBefore);
    assert.equal(git(crash.repository, "config", "--get-all", "remote.origin.pushurl"), activePushBefore);

    const recreatedBranch = "feature/recreated";
    const recreated = initFresh(operator, ["recreated", "--branch", recreatedBranch, "--pr-base", "main", "--now", "2026-08-04T12:03:00.000Z"]);
    enforceEffectivePushTarget(["bootstrap", operator, recreated.repository]);
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
