import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareSelectedRunPushTarget, configureSandboxPushTarget, SENSITIVE_CHILD_ENV_DENYLIST,
} from "../core/effective-push.js";
import { describeError } from "../bin/factory.js";

test("AC4/AC8-AC12 skill init, push, branch, recovery, and publication policy", () => {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(pkg, "bin", "factory.js");
  const skill = readFileSync(resolve(pkg, "skills", "feature", "SKILL.md"), "utf8");
  const secret = "https://user224unique:token224unique@push.invalid/org/target224.git";
  const secretTwo = "https://user225unique:token225unique@push.invalid/org/target225.git";
  const specialSecret = 'https://user224unique:token224unique@push.invalid/org/a"b\\c-é.git';
  const representations = (value) => {
    const bytes = Buffer.from(value);
    const percent = [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
    return [value, encodeURIComponent(value), percent.toUpperCase(), percent.toLowerCase(), bytes.toString("base64"),
      bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
  };
  const forbidden = [...new Set([
    secret, secretTwo, specialSecret, "user224unique:token224unique", "user224unique:token224unique@",
    "user225unique:token225unique", "user225unique:token225unique@", "user224unique", "token224unique",
    "user225unique", "token225unique",
  ].flatMap(representations))];
  const redacted = (values, label) => assert.equal(values.some((value) => forbidden.some((entry) => String(value).includes(entry))), false, label);
  const failureSurface = (error) => {
    const causes = [];
    for (let current = error; current; current = current.cause) causes.push(current);
    return [error.name, error.message, error.stack, describeError(error), JSON.stringify(error),
      ...Reflect.ownKeys(error).map((key) => String(error[key])), ...causes.flatMap((entry) => [entry.message, entry.stack])];
  };
  const fixed = {
    operator: (sandbox) => `factory sandbox: operator effective push target unavailable; sandbox retained at ${sandbox}`,
    sandbox: (sandbox) => `factory sandbox: sandbox effective push target unavailable at ${sandbox}`,
    mismatch: (sandbox) => `factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${sandbox}`,
  };
  const result = (stdout = Buffer.alloc(0), overrides = {}) => ({
    status: 0, signal: null, stdout, stderr: Buffer.alloc(0), ...overrides,
  });
  const framed = (value) => Buffer.concat([Buffer.isBuffer(value) ? value : Buffer.from(value), Buffer.from("\n")]);
  const fakeOperations = (responses, overrides = {}) => {
    const calls = [];
    const writes = [];
    return {
      calls, writes,
      operations: {
        env: Object.fromEntries([...SENSITIVE_CHILD_ENV_DENYLIST, "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "GIT_CONFIG_COUNT"].map((name) => [name, `v-${name}`])),
        realpath: (path) => path,
        spawn(command, args, options) {
          calls.push({ command, args, options });
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        },
        open: () => 7,
        write(_fd, bytes, offset, length) { writes.push(Buffer.from(bytes.subarray(offset, offset + length))); return length; },
        fsync: () => {}, close: () => {},
        ...overrides,
      },
    };
  };
  const invokeConfigure = (responses, overrides) => {
    const fake = fakeOperations(responses, overrides);
    return { fake, invoke: () => configureSandboxPushTarget({ operatorRoot: "/operator", sandboxRoot: "/operator/.factory-sandboxes/r01" }, fake.operations) };
  };
  const targetResponses = (initial = secret, currentOperator = initial, currentSandbox = currentOperator) => [
    result(framed(initial)), result(), result(framed(currentOperator)), result(framed(currentSandbox)),
  ];

  for (const fragment of [
    "effective push target in code, recaptures both current values",
    "private mode-0600 configuration fragment",
    "repeated init refuses the occupied destination",
    "factory sandbox: operator effective push target unavailable; sandbox retained at <S>",
    "factory sandbox: sandbox effective push target unavailable at <S>",
    "factory sandbox: sandbox effective push target does not match operator target; sandbox retained at <S>",
    "publication_child()",
    "push --no-verify origin",
    "factory publication: git push failed; selected repository retained at $RUN_REPO",
    "factory publication: draft PR creation failed or returned unsafe output; selected repository retained at $RUN_REPO",
    "Only a single userinfo-free absolute HTTPS URL",
    "makes no push or forge call",
  ]) assert.equal(skill.includes(fragment), true, fragment);
  assert.equal(skill.includes("remote get-url --push origin"), false);
  assert.equal(skill.includes("remote.origin.pushurl"), false);
  assert.equal(skill.includes("CURRENT_OPERATOR_PUSH"), false);
  for (const name of SENSITIVE_CHILD_ENV_DENYLIST) assert.equal(skill.includes(`-u ${name}`), true, name);
  assert.match(skill, /factory gate "\$R" pre_pr approved --repo "\$RUN_REPO"/u);
  assert.match(skill, /git -C "\$RUN_REPO" push --no-verify origin/u);
  const validatorCode = /node -e '([^']+)' 2>\/dev\/null/u.exec(skill)?.[1];
  assert.ok(validatorCode);
  const unsafePr = spawnSync(process.execPath, ["-e", validatorCode], { input: secret, encoding: "utf8" });
  assert.equal(unsafePr.status, 1);
  assert.equal(unsafePr.stdout, "");
  assert.equal(unsafePr.stderr, "");
  redacted([unsafePr.stdout, unsafePr.stderr], "r-gh-unsafe");
  const safePr = spawnSync(process.execPath, ["-e", validatorCode], { input: "https://forge.invalid/org/repo/pull/1", encoding: "utf8" });
  assert.deepEqual({ status: safePr.status, stdout: safePr.stdout, stderr: safePr.stderr },
    { status: 0, stdout: "https://forge.invalid/org/repo/pull/1", stderr: "" });

  const cliSource = readFileSync(cli, "utf8");
  const orderedSource = (start, end, fragments, label) => {
    const section = cliSource.slice(cliSource.indexOf(start), cliSource.indexOf(end));
    const positions = fragments.map((fragment) => section.indexOf(fragment));
    assert.equal(positions.every((position) => position >= 0), true, `${label}-present`);
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), `${label}-order`);
  };
  orderedSource("async lock", "async heartbeat", ["readRun(runDir)", "compareSelectedRunPushTarget", "claimSessionLock"], "r-lock-wire");
  orderedSource("async gate", "async step", ["assertRunNotParked", "compareSelectedRunPushTarget", "const reobservers", "transition(runDir"], "r-gate-wire");
  orderedSource("async resume", "export async function dispatchInit", ["readRun(runDir)", "current.status", "compareSelectedRunPushTarget", "inspectSessionLock", "transition(runDir"], "r-resume-wire");
  orderedSource("export async function dispatchInit", "function preflightInit", ["proof = prove", "configurePushTarget({", "let prBase", "await dispatchInitPublication"], "r-init-wire");

  const accepted = [
    secret, "http://host.invalid/r.git", "ssh://host.invalid/r.git", "git://host.invalid/r.git",
    "git@host.invalid:org/r.git", "host.invalid:org/r.git",
  ];
  for (const [index, target] of accepted.entries()) {
    const { fake, invoke } = invokeConfigure(targetResponses(target));
    assert.equal(invoke(), "verified", `r-a${index}`);
    assert.deepEqual(fake.calls.map(({ args }) => args), [
      ["remote", "get-url", "--push", "origin"],
      ["config", "--local", "--add", "include.path", "./factory-push-target.config"],
      ["remote", "get-url", "--push", "origin"],
      ["remote", "get-url", "--push", "origin"],
    ]);
    for (const call of fake.calls) {
      assert.equal(call.options.shell, false);
      assert.equal(Object.hasOwn(call.options, "encoding"), false);
      assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
      assert.equal(call.options.env.LC_ALL, "C");
      assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
      for (const name of SENSITIVE_CHILD_ENV_DENYLIST) assert.equal(Object.hasOwn(call.options.env, name), false, `${index}-${name}`);
      for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "GIT_CONFIG_COUNT"]) {
        assert.equal(call.options.env[name], `v-${name}`);
      }
      redacted([call.command, ...call.args, ...Object.keys(call.options.env)], `r-env-${index}`);
    }
  }

  const escapedTarget = Buffer.from('https://host.invalid/a"b\\c-\u00e9.git');
  const escaped = invokeConfigure(targetResponses(escapedTarget));
  assert.equal(escaped.invoke(), "verified");
  const fragment = Buffer.concat(escaped.fake.writes);
  assert.equal(fragment.equals(Buffer.concat([
    Buffer.from("[remote \"origin\"]\n\tpushurl = \"https://host.invalid/a\\\"b\\\\c-"), Buffer.from("é"), Buffer.from(".git\"\n"),
  ])), true, "r-escape");

  const rejected = ["relative/path", "/absolute/path", "~/target", "C:\\target", "file:///target", "helper::address", "ftp://host/r", "https:///missing", "x:y"];
  for (const [index, target] of rejected.entries()) {
    const { invoke } = invokeConfigure([result(framed(target))]);
    assert.throws(invoke, (error) => error.message === fixed.operator("/operator/.factory-sandboxes/r01") && error.cause === undefined, `r-t${index}`);
  }

  const lowSecret = new Error(secret, { cause: new Error(secretTwo) });
  const captureFailures = [
    result(framed(secret), { status: 1, stderr: Buffer.from(secretTwo) }),
    result(framed(secret), { signal: "SIGTERM", status: null }),
    result(framed(secret), { error: lowSecret, status: null }),
    result("not-buffer"), result(Buffer.from("")), result(Buffer.from("\n")), result(Buffer.from(`${secret}\n\n`)),
    result(Buffer.concat([Buffer.from(secret), Buffer.from([0]), Buffer.from("\n")])), lowSecret,
  ];
  for (const [index, injected] of captureFailures.entries()) {
    const { invoke } = invokeConfigure([injected]);
    let error;
    try { invoke(); } catch (caught) { error = caught; }
    assert.equal(error?.message, fixed.operator("/operator/.factory-sandboxes/r01"), `r-c${index}`);
    assert.equal(error?.cause, undefined, `r-cause${index}`);
    redacted(failureSurface(error), `r-redact${index}`);
  }

  for (const [phase, expected] of [[1, "sandbox"], [2, "operator"], [3, "sandbox"]]) {
    const responses = targetResponses();
    responses[phase] = result(framed(secret), { status: 9, stderr: Buffer.from(secretTwo) });
    const { invoke } = invokeConfigure(responses);
    let error;
    try { invoke(); } catch (caught) { error = caught; }
    assert.equal(error?.message, fixed[expected]("/operator/.factory-sandboxes/r01"), `r-p${phase}`);
    redacted(failureSurface(error), `r-pr${phase}`);
  }
  const mismatch = invokeConfigure(targetResponses(secret, secret, secretTwo));
  let mismatchError;
  try { mismatch.invoke(); } catch (error) { mismatchError = error; }
  assert.equal(mismatchError?.message, fixed.mismatch("/operator/.factory-sandboxes/r01"));
  redacted(failureSurface(mismatchError), "r-mismatch");

  for (const name of ["open", "write", "fsync", "close"]) {
    const failure = new Error(secret, { cause: new Error(secretTwo) });
    const { fake, invoke } = invokeConfigure(targetResponses(), { [name]: () => { throw failure; } });
    let error;
    try { invoke(); } catch (caught) { error = caught; }
    assert.equal(error?.message, fixed.sandbox("/operator/.factory-sandboxes/r01"), `r-fs-${name}`);
    assert.equal(fake.calls.length, 2, `r-stop-${name}`);
    redacted(failureSurface(error), `r-fsr-${name}`);
  }

  const root = mkdtempSync(join(tmpdir(), "factory-effective-push-"));
  try {
    const operator = join(root, "operator");
    const container = join(operator, ".factory-sandboxes");
    const sandbox = join(container, "r-real");
    mkdirSync(operator);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: operator });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: operator });
    execFileSync("git", ["config", "user.email", "factory@example.test"], { cwd: operator });
    writeFileSync(join(operator, ".gitignore"), ".factory-sandboxes/\n");
    writeFileSync(join(operator, "tracked"), "tracked\n");
    execFileSync("git", ["add", "."], { cwd: operator });
    execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: operator });
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", specialSecret], { cwd: operator });
    mkdirSync(container);
    execFileSync("git", ["clone", "--quiet", "--local", "--", operator, sandbox]);
    assert.equal(configureSandboxPushTarget({ operatorRoot: realpathSync(operator), sandboxRoot: realpathSync(sandbox) }), "verified");
    const privateFragment = join(sandbox, ".git", "factory-push-target.config");
    assert.equal(lstatSync(privateFragment).mode & 0o777, 0o600);
    const observed = execFileSync("git", ["remote", "get-url", "--push", "origin"], { cwd: sandbox });
    assert.equal(observed.subarray(0, -1).equals(Buffer.from(specialSecret)), true, "r-roundtrip");
    assert.equal(compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "r-real" }), "verified");
    const before = readFileSync(privateFragment);
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", secretTwo], { cwd: operator });
    let activeError;
    try { compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "r-real" }); } catch (error) { activeError = error; }
    assert.equal(activeError?.message, fixed.mismatch(realpathSync(sandbox)));
    assert.equal(readFileSync(privateFragment).equals(before), true, "r-no-mutation");
    redacted(failureSurface(activeError), "r-active");
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", specialSecret], { cwd: operator });
    assert.equal(compareSelectedRunPushTarget({ selectedRoot: operator, runId: "legacy" }), "legacy-direct");
    assert.throws(() => compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "wrong" }), (error) => error.message === fixed.operator(realpathSync(sandbox)));

    const missing = join(root, "missing");
    assert.throws(() => compareSelectedRunPushTarget({ selectedRoot: missing, runId: "r" }),
      (error) => error.message === `factory sandbox: selected repository unavailable at ${missing}; selected run unchanged`);
    const linked = join(root, "linked");
    symlinkSync(sandbox, linked);
    assert.throws(() => compareSelectedRunPushTarget({ selectedRoot: linked, runId: "r-real" }),
      (error) => error.message === `factory sandbox: selected repository unavailable at ${linked}; selected run unchanged`);
    assert.throws(() => compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "r-real" }, { realpath: () => { throw lowSecret; } }),
      (error) => error.message === `factory sandbox: selected repository unavailable at ${sandbox}; selected run unchanged`);

    const freshOperator = join(root, "fresh-operator");
    mkdirSync(freshOperator);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: freshOperator });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: freshOperator });
    execFileSync("git", ["config", "user.email", "factory@example.test"], { cwd: freshOperator });
    writeFileSync(join(freshOperator, ".gitignore"), ".factory-sandboxes/\n.factory/\n");
    writeFileSync(join(freshOperator, "tracked"), "tracked\n");
    execFileSync("git", ["add", "."], { cwd: freshOperator });
    execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: freshOperator });
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", secret], { cwd: freshOperator });
    const init = spawnSync(process.execPath, [cli, "init", "r-cli", "--repo", freshOperator, "--json"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const initialized = JSON.parse(init.stdout);
    redacted([init.stdout, init.stderr, readFileSync(join(initialized.run_dir, "run.json"), "utf8")], "r-cli-init");
    assert.equal(lstatSync(join(initialized.sandbox_path, ".git", "factory-push-target.config")).mode & 0o777, 0o600);
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", secretTwo], { cwd: freshOperator });
    const manifestPath = join(initialized.run_dir, "run.json");
    const manifestBefore = readFileSync(manifestPath);
    const malformed = JSON.parse(manifestBefore);
    malformed.unexpected = true;
    writeFileSync(manifestPath, `${JSON.stringify(malformed)}\n`);
    const manifestFirst = spawnSync(process.execPath, [cli, "lock", "r-cli", "claim", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    assert.match(manifestFirst.stderr, /unknown key/u);
    assert.equal(manifestFirst.stderr.includes("effective push target"), false);
    writeFileSync(manifestPath, manifestBefore);
    const lockRefusal = spawnSync(process.execPath, [cli, "lock", "r-cli", "claim", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    assert.equal(lockRefusal.status, 1);
    assert.equal(lockRefusal.stderr, `${fixed.mismatch(initialized.sandbox_path)}\n`);
    assert.equal(existsSync(join(initialized.run_dir, "factory.lock")), false);
    assert.equal(readFileSync(manifestPath).equals(manifestBefore), true, "r-lock-state");
    redacted([lockRefusal.stdout, lockRefusal.stderr], "r-lock-output");
    const gateRefusal = spawnSync(process.execPath, [cli, "gate", "r-cli", "pre_pr", "approved", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    assert.equal(gateRefusal.stderr, `${fixed.mismatch(initialized.sandbox_path)}\n`);
    assert.equal(readFileSync(manifestPath).equals(manifestBefore), true, "r-gate-state");
    assert.equal(existsSync(`${manifestPath}.tmp`), false);
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", secret], { cwd: freshOperator });
    execFileSync(process.execPath, [cli, "lock", "r-cli", "claim", "--session", "s1", "--repo", initialized.sandbox_path]);
    execFileSync(process.execPath, [cli, "terminal", "r-cli", "needs-human", "--reason", "pause", "--repo", initialized.sandbox_path]);
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", secretTwo], { cwd: freshOperator });
    const parkedBefore = readFileSync(manifestPath);
    const resumeRefusal = spawnSync(process.execPath, [cli, "resume", "r-cli", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    assert.equal(resumeRefusal.stderr, `${fixed.mismatch(initialized.sandbox_path)}\n`);
    assert.equal(readFileSync(manifestPath).equals(parkedBefore), true, "r-resume-state");
    const heartbeat = spawnSync(process.execPath, [cli, "heartbeat", "r-cli", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    assert.equal(heartbeat.status, 0);
    const release = spawnSync(process.execPath, [cli, "lock", "r-cli", "release", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    assert.equal(release.status, 0);

    const refusedOperator = join(root, "refused-operator");
    mkdirSync(refusedOperator);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: refusedOperator });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: refusedOperator });
    execFileSync("git", ["config", "user.email", "factory@example.test"], { cwd: refusedOperator });
    writeFileSync(join(refusedOperator, "tracked"), "tracked\n");
    execFileSync("git", ["add", "."], { cwd: refusedOperator });
    execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: refusedOperator });
    execFileSync("git", ["config", "--replace-all", "remote.origin.pushurl", join(root, "local-target")], { cwd: refusedOperator });
    const refusedSandbox = join(realpathSync(refusedOperator), ".factory-sandboxes", "r-refused");
    const refused = spawnSync(process.execPath, [cli, "init", "r-refused", "--repo", refusedOperator], { encoding: "utf8" });
    assert.equal(refused.stderr, `${fixed.operator(refusedSandbox)}\n`);
    assert.equal(existsSync(refusedSandbox), true);
    assert.equal(existsSync(join(refusedSandbox, ".factory", "r-refused", "run.json")), false);
    const repeated = spawnSync(process.execPath, [cli, "init", "r-refused", "--repo", refusedOperator], { encoding: "utf8" });
    assert.match(repeated.stderr, /already exists without a manifest/u);

    const publish = join(root, "publish");
    const remote = join(root, "remote.git");
    mkdirSync(publish);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: publish });
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: publish });
    execFileSync("git", ["config", "user.email", "factory@example.test"], { cwd: publish });
    writeFileSync(join(publish, "tracked"), "tracked\n");
    execFileSync("git", ["add", "."], { cwd: publish });
    execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: publish });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: publish });
    execFileSync("git", ["config", "remote.origin.pushurl", remote], { cwd: publish });
    const hookSentinel = join(root, "hook-ran");
    const hook = join(publish, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nprintf hook >${JSON.stringify(hookSentinel)}\n`);
    chmodSync(hook, 0o755);
    const bin = join(root, "bin");
    const argvLog = join(root, "argv.json");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2)));const r=require("node:child_process").spawnSync(process.env.REAL_GIT,process.argv.slice(2),{stdio:"inherit",env:process.env});process.exit(r.status??1);\n`);
    chmodSync(join(bin, "git"), 0o755);
    const trace = join(root, "git-trace");
    const refspec = "refs/heads/main:refs/heads/main";
    const envArgs = SENSITIVE_CHILD_ENV_DENYLIST.flatMap((name) => ["-u", name]);
    const published = spawnSync("env", [...envArgs, "LC_ALL=C", "GIT_TERMINAL_PROMPT=0", "git", "-C", publish, "push", "--no-verify", "origin", refspec], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARGV_LOG: argvLog, REAL_GIT: realGit, GIT_TRACE: trace, DEBUG: secret },
      stdio: ["ignore", "ignore", "ignore"],
    });
    assert.equal(published.status, 0);
    assert.equal(existsSync(hookSentinel), false);
    assert.equal(existsSync(trace), false);
    const pushArgv = JSON.parse(readFileSync(argvLog, "utf8"));
    assert.deepEqual(pushArgv, ["-C", publish, "push", "--no-verify", "origin", refspec]);
    redacted(pushArgv, "r-push-argv");

    const negative = spawnSync(process.execPath, ["-e", 'require("node:assert/strict").equal(true,false,"r-neg")'], {
      encoding: "utf8", env: { ...process.env, FACTORY_NEGATIVE_SECRET: secret },
    });
    assert.notEqual(negative.status, 0);
    redacted([negative.stdout, negative.stderr], "r-negative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
