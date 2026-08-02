import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("AC9/AC16-AC19 effective push targets are proven at bootstrap, resume, and publication", () => {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const skill = readFileSync(resolve(pkg, "skills", "feature", "SKILL.md"), "utf8");
  const resumeStart = skill.indexOf("### Resume or collision");
  const freshStart = skill.indexOf("### Fresh sandbox bootstrap");
  const stepOneStart = skill.indexOf("### Gate 1 — Story");
  const publicationStart = skill.indexOf("## Step 6 — Draft PR");
  const summaryStart = skill.indexOf("## Step 7 — Summary");
  const resume = skill.slice(resumeStart, freshStart);
  const fresh = skill.slice(freshStart, stepOneStart);
  const publication = skill.slice(publicationStart, summaryStart);
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
  const runGit = (...args) => execFileSync("git", args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
  const git = (repository, ...args) => runGit("-C", repository, ...args);

  assert.ok(resumeStart >= 0 && freshStart > resumeStart && stepOneStart > freshStart);
  assert.ok(publicationStart >= 0 && summaryStart > publicationStart);

  ordered(fresh, [
    'PUSH_TARGET="$(LC_ALL=C git -C "$O" remote get-url --push origin)"',
    'LC_ALL=C git clone --local "$O" "$S"',
    'git -C "$S" config --replace-all remote.origin.pushurl "$PUSH_TARGET"',
    'RESOLVED_PUSH="$(LC_ALL=C git -C "$S" remote get-url --push origin)"',
    "shell-string equality with\n`PUSH_TARGET` must be exact",
    "remove only this invocation's new `S`, and refuse dispatch",
  ], "AC16-AC18 fresh effective-push");
  for (const fragment of [
    "Each command must succeed and produce nonempty output.",
    "its result includes Git's configured `pushurl` and `pushInsteadOf` semantics and may differ from the\nfetch URL.",
    "Never read raw `remote.origin.url`, normalize the result, or expose it.",
    "Keep `PUSH_TARGET`\nout of the control plane and logs.",
    "Do not initialize state, claim a lock, or\nperform any external effect from the failed bootstrap.",
  ]) required(fresh, fragment, "AC16-AC18 fresh effective-push");
  assert.doesNotMatch(fresh, /git -C "\$O" config .*remote\.origin\.url/u);

  ordered(resume, [
    "Every sandbox resume recaptures both effective push targets",
    'CURRENT_OPERATOR_PUSH="$(LC_ALL=C git -C "$O" remote get-url --push origin)"',
    'CURRENT_SANDBOX_PUSH="$(LC_ALL=C git -C "$S" remote get-url --push origin)"',
    "Both lookups must succeed and return nonempty output",
    "their shell strings must be exactly equal",
    "permits only status reads against `S`",
    "do\nnot claim or steal the lock or publish, and refuse dispatch",
  ], "AC17 resume effective-push");
  for (const fragment of [
    "Never persist or log either target, normalize them, or automatically reconfigure the sandbox.",
    "A lookup\nfailure or mismatch retains `S`, exposes neither value",
  ]) required(resume, fragment, "AC17 resume effective-push");
  assert.equal(occurrences(resume, "config --replace-all remote.origin.pushurl"), 0);

  ordered(publication, [
    'factory status "$R" --json --repo "$S"',
    'CURRENT_OPERATOR_PUSH="$(LC_ALL=C git -C "$O" remote get-url --push origin)"',
    'CURRENT_SANDBOX_PUSH="$(LC_ALL=C git -C "$S" remote get-url --push origin)"',
    "their shell strings must be exactly equal",
    'git -C "$S" push origin "refs/heads/$FEATURE_BRANCH:refs/heads/$FEATURE_BRANCH"',
    'cd "$O"',
    'gh pr create --draft --base "<pr_base>" --head "<branch>"',
    'factory pr "$R" --url "$PR_URL" --repo "$S"',
  ], "AC9/AC17 publication effective-push");
  for (const fragment of [
    "Never persist or log either target, normalize them, or automatically reconfigure the sandbox.",
    "A lookup\nfailure or mismatch retains `S`, exposes neither value, permits status only, and blocks every\npublication effect.",
    "Use the status response's exact recorded `branch` as `FEATURE_BRANCH` and exact recorded `pr_base` as\n`PR_BASE`; never infer, shorten, normalize, or substitute either value.",
    "Publish the fully qualified\nrecorded feature ref from `S`, run `gh` from `O` with that exact head and base, require a draft",
    "`pr_url` is immutable once recorded",
    "If PR creation returns an unknown outcome, re-observe whether the PR exists before retrying",
    "For a legacy manifest where `pr_base` is absent or null, stop and\nrequire a human/operator to choose or confirm the exact target",
    "Never infer it from HEAD, the feature branch, repository or forge defaults, and\nnever backfill the legacy manifest.",
  ]) required(publication, fragment, "AC9/AC17 publication effective-push");
  assert.equal(occurrences(publication, "config --replace-all remote.origin.pushurl"), 0);
  assert.equal(occurrences(skill, "config --replace-all remote.origin.pushurl"), 1);

  const root = mkdtempSync(join(tmpdir(), "factory-effective-push-"));
  try {
    const operator = join(root, "operator");
    const fetchRoot = join(root, "fetch-target");
    const pushRoot = join(root, "push-target");
    const changedPushRoot = join(root, "changed-push-target");
    const mismatchRoot = join(root, "mismatch-target");
    const sandbox = join(root, "sandbox");
    const failedSandbox = join(root, "failed-sandbox");
    const fetchRepository = join(fetchRoot, "repository.git");
    const pushRepository = join(pushRoot, "repository.git");
    mkdirSync(operator);
    mkdirSync(fetchRoot);
    mkdirSync(pushRoot);
    runGit("init", "--bare", "--initial-branch=main", fetchRepository);
    runGit("init", "--bare", "--initial-branch=main", pushRepository);
    runGit("init", "--initial-branch=main", operator);
    git(operator, "config", "user.name", "Factory Test");
    git(operator, "config", "user.email", "factory@example.test");
    writeFileSync(join(operator, "fixture.txt"), "effective push\n");
    git(operator, "add", "fixture.txt");
    git(operator, "commit", "-m", "fixture");
    git(operator, "switch", "--quiet", "-c", "feature/173-3");
    git(operator, "remote", "add", "origin", "factory-fetch:repository.git");
    git(operator, "config", `url.${fetchRoot}/.insteadOf`, "factory-fetch:");
    git(operator, "config", `url.${pushRoot}/.pushInsteadOf`, "factory-fetch:");

    const fetchTarget = git(operator, "remote", "get-url", "origin");
    const capturedPushTarget = git(operator, "remote", "get-url", "--push", "origin");
    assert.equal(fetchTarget, fetchRepository, "AC19 fetch URL must resolve through insteadOf");
    assert.equal(capturedPushTarget, pushRepository, "AC16/AC19 push target must resolve through pushInsteadOf");
    assert.notEqual(capturedPushTarget, fetchTarget, "AC19 fixture must have different fetch and push targets");

    runGit("clone", "--quiet", "--local", operator, sandbox);
    git(sandbox, "config", "--replace-all", "remote.origin.pushurl", capturedPushTarget);
    const sandboxPushTarget = git(sandbox, "remote", "get-url", "--push", "origin");
    assert.equal(sandboxPushTarget, capturedPushTarget, "AC17 sandbox target must re-resolve exactly");

    const featureRef = "refs/heads/feature/173-3";
    git(sandbox, "push", "--quiet", "origin", `${featureRef}:${featureRef}`);
    assert.equal(git(pushRepository, "rev-parse", featureRef), git(sandbox, "rev-parse", featureRef), "AC9 fully qualified feature ref must reach the effective push target");

    runGit("clone", "--quiet", "--local", operator, failedSandbox);
    git(failedSandbox, "config", "--replace-all", "remote.origin.pushurl", capturedPushTarget);
    git(failedSandbox, "config", `url.${mismatchRoot}/.insteadOf`, `${pushRoot}/`);
    const mismatchedTarget = git(failedSandbox, "remote", "get-url", "--push", "origin");
    let dispatched = false;
    if (mismatchedTarget === capturedPushTarget) dispatched = true;
    else rmSync(failedSandbox, { recursive: true, force: true });
    assert.notEqual(mismatchedTarget, capturedPushTarget, "AC18 fixture must exercise exact mismatch refusal");
    assert.equal(existsSync(failedSandbox), false, "AC18 fresh mismatch must remove only the new sandbox");
    assert.equal(dispatched, false, "AC18 fresh mismatch must dispatch nothing");
    assert.equal(existsSync(operator), true, "AC18 fresh mismatch must retain the operator checkout");

    git(operator, "config", "--unset-all", `url.${pushRoot}/.pushInsteadOf`, "factory-fetch:");
    git(operator, "config", `url.${changedPushRoot}/.pushInsteadOf`, "factory-fetch:");
    const resumedOperatorTarget = git(operator, "remote", "get-url", "--push", "origin");
    const resumedSandboxTarget = git(sandbox, "remote", "get-url", "--push", "origin");
    assert.notEqual(resumedOperatorTarget, resumedSandboxTarget, "AC17 resume fixture must detect an effective-target change");
    assert.equal(existsSync(sandbox), true, "AC17 resume mismatch must retain the sandbox for status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
