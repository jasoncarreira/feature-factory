import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
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
  // Test-owned, ordered boundary: do not derive this from the production export. A missing
  // production entry must fail before any child fixture can accidentally inherit it.
  const sensitiveChildEnvDenylist = [
    "DEBUG", "GH_DEBUG", "CURL_VERBOSE", "GIT_TRACE", "GIT_TRACE_PACKET",
    "GIT_TRACE_PACK_ACCESS", "GIT_TRACE_PERFORMANCE", "GIT_TRACE_SETUP", "GIT_TRACE_SHALLOW",
    "GIT_TRACE_FSMONITOR", "GIT_TRACE_CURL", "GIT_TRACE_CURL_NO_DATA", "GIT_CURL_VERBOSE",
    "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF", "GIT_TRACE2_BRIEF",
    "GIT_TRACE2_CONFIG_PARAMS", "GIT_TRACE2_ENV_VARS", "GIT_TRACE2_PARENT_SID", "GIT_TRACE_REDACT",
    "GIT_REDIRECT_STDOUT", "GIT_REDIRECT_STDERR", "GCM_TRACE", "GCM_TRACE2", "GCM_DEBUG",
    "GIT_CONFIG_PARAMETERS",
  ];
  const secret = "https://user224unique:token224unique@push.invalid/org/target224.git";
  const secretTwo = "https://user225unique:token225unique@push.invalid/org/target225.git";
  const specialSecret = 'https://user224unique:token224unique@push.invalid/org/a"b\\c-é.git';
  const components = [
    secret, secretTwo, specialSecret, "user224unique:token224unique", "user224unique:token224unique@",
    "user225unique:token225unique", "user225unique:token225unique@", "user224unique", "token224unique",
    "user225unique", "token225unique",
  ];
  const representations = (value) => {
    const bytes = Buffer.from(value);
    const percent = [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
    return [value, encodeURIComponent(value), percent.toUpperCase(), percent.toLowerCase(), bytes.toString("base64"),
      bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
  };
  const forbidden = [...new Set(components.flatMap(representations))];
  const providerNames = ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_COUNT"];
  const hash = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value))).digest("hex");
  const opaque = (actual, expected, label) => assert.equal(hash(actual), hash(expected), label);
  const yes = (condition, label) => assert.equal(Boolean(condition), true, label);
  const noLeaks = (values, label) => yes(!values.some((value) => forbidden.some((entry) => String(value).includes(entry))), label);
  const fixed = {
    operator: (sandbox) => `factory sandbox: operator effective push target unavailable; sandbox retained at ${sandbox}`,
    sandbox: (sandbox) => `factory sandbox: sandbox effective push target unavailable at ${sandbox}`,
    mismatch: (sandbox) => `factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${sandbox}`,
    context: (path) => `factory sandbox: selected repository unavailable at ${path}; selected run unchanged`,
    push: (path) => `factory publication: git push failed; selected repository retained at ${path}\n`,
    gh: (path) => `factory publication: draft PR creation failed or returned unsafe output; selected repository retained at ${path}\n`,
  };
  const failureSurface = (error) => {
    const causes = [];
    for (let current = error; current; current = current.cause) causes.push(current);
    return [error?.name, error?.message, error?.stack, describeError(error), JSON.stringify(error),
      ...Reflect.ownKeys(error ?? {}).map((key) => String(error[key])),
      ...causes.flatMap((entry) => [entry.message, entry.stack, JSON.stringify(entry)]),
    ];
  };
  const caught = (action) => {
    try { return { value: action(), error: null }; } catch (error) { return { value: null, error }; }
  };
  const refusal = (action, expected, label) => {
    const observed = caught(action);
    yes(observed.error instanceof Error, `${label}-e`);
    opaque(observed.error?.message ?? "", expected, `${label}-m`);
    yes(observed.error?.cause === undefined, `${label}-c`);
    noLeaks(failureSurface(observed.error), `${label}-r`);
    return observed.error;
  };
  const result = (stdout = Buffer.alloc(0), overrides = {}) => ({
    status: 0, signal: null, stdout, stderr: Buffer.alloc(0), ...overrides,
  });
  const framed = (value) => Buffer.concat([Buffer.isBuffer(value) ? value : Buffer.from(value), Buffer.from("\n")]);
  const foreign = (id) => {
    const error = new Error(`factory sandbox:${secret}:${id}`, { cause: new Error(secretTwo) });
    error.argv = [secret];
    error.stderr = Buffer.from(secretTwo);
    error.private = { target: specialSecret };
    return error;
  };
  const fakeOperations = (responses, overrides = {}) => {
    const calls = [];
    const writes = [];
    const opened = [];
    return {
      calls, writes, opened,
      operations: {
        env: {
          ...Object.fromEntries(sensitiveChildEnvDenylist.map((name) => [name, secret])),
          ...Object.fromEntries(providerNames.map((name) => [name, `v-${name}`])),
        },
        realpath: (path) => path,
        spawn(command, args, options) {
          calls.push({ command, args, options });
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        },
        open(path, flags, mode) { opened.push({ path, flags, mode }); return 7; },
        write(_fd, bytes, offset, length) { writes.push(Buffer.from(bytes.subarray(offset, offset + length))); return length; },
        fsync: () => {}, close: () => {},
        ...overrides,
      },
    };
  };
  const invokeConfigure = (responses, overrides) => {
    const fake = fakeOperations(responses, overrides);
    return {
      fake,
      invoke: () => configureSandboxPushTarget({ operatorRoot: "/operator", sandboxRoot: "/operator/.factory-sandboxes/r01" }, fake.operations),
    };
  };
  const targetResponses = (initial = secret, currentOperator = initial, currentSandbox = currentOperator) => [
    result(framed(initial)), result(), result(framed(currentOperator)), result(framed(currentSandbox)),
  ];
  const failureVariants = () => [
    ["m0", result(Buffer.alloc(0))],
    ["m1", result(Buffer.from("\n"))],
    ["m2", result(Buffer.from(secret))],
    ["m3", result(Buffer.from(`${secret}\n\n`))],
    ["m4", result(Buffer.concat([Buffer.from(secret), Buffer.from([0]), Buffer.from("\n")]))],
    ["m5", result(Buffer.concat([Buffer.from(secret), Buffer.from([0x7f]), Buffer.from("\n")]))],
    ["m6", result("not-buffer")],
    ["m7", result(framed(secret), { stderr: "not-buffer" })],
    ["re", result(framed(secret), { error: foreign("re"), status: null })],
    ["sg", result(framed(secret), { signal: "SIGTERM", status: null })],
    ["th", foreign("th")],
    ["se", result(framed(secret), { stderr: Buffer.from(secretTwo) })],
    ["nz", result(framed(secret), { status: 9 })],
    ["tr", result(framed(`/tmp/user224unique-token224unique-${secret.length}`))],
  ];
  const activeRoot = "/operator/.factory-sandboxes/r-active";
  const activeFake = (operatorResult = result(framed(secret)), sandboxResult = result(framed(secret)), overrides = {}) => fakeOperations([
    result(framed(activeRoot)), result(framed("/operator")), operatorResult, sandboxResult,
  ], {
    lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    ...overrides,
  });
  const inventory = (root) => {
    const rows = [];
    const visit = (path, name) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) rows.push([name, "link", stat.mode & 0o7777]);
      else if (stat.isDirectory()) {
        rows.push([name, "dir", stat.mode & 0o7777]);
        for (const entry of readdirSync(path).sort()) visit(join(path, entry), name === "." ? entry : `${name}/${entry}`);
      } else rows.push([name, "file", stat.mode & 0o7777, stat.size, hash(readFileSync(path))]);
    };
    visit(root, ".");
    return rows;
  };
  const scanTree = (root, excluded, label) => {
    let row = 0;
    const visit = (path) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path)) visit(join(path, entry));
      } else if (!excluded.has(path)) {
        noLeaks([readFileSync(path)], `${label}-${row}`);
        row += 1;
      }
    };
    visit(root);
  };

  opaque(SENSITIVE_CHILD_ENV_DENYLIST, sensitiveChildEnvDenylist, "r-denylist");
  for (const [index, fragment] of [
    "effective push target in code, recaptures both current values",
    "private mode-0600 configuration fragment",
    "repeated init refuses the occupied destination",
    "factory sandbox: operator effective push target unavailable; sandbox retained at <S>",
    "factory sandbox: sandbox effective push target unavailable at <S>",
    "factory sandbox: sandbox effective push target does not match operator target; sandbox retained at <S>",
    "publication_child()", "push --no-verify origin",
    "factory publication: git push failed; selected repository retained at $RUN_REPO",
    "factory publication: draft PR creation failed or returned unsafe output; selected repository retained at $RUN_REPO",
    "Only a single userinfo-free absolute HTTPS URL", "makes no push or forge call",
  ].entries()) yes(skill.includes(fragment), `r-s${index}`);
  yes(!skill.includes("remote get-url --push origin"), "r-s20");
  yes(!skill.includes("remote.origin.pushurl"), "r-s21");
  yes(!skill.includes("CURRENT_OPERATOR_PUSH"), "r-s22");
  for (const [index, name] of sensitiveChildEnvDenylist.entries()) yes(skill.includes(`-u ${name}`), `r-d${index}`);
  yes(/factory gate "\$R" pre_pr approved --repo "\$RUN_REPO"/u.test(skill), "r-s23");
  yes(/git -C "\$RUN_REPO" push --no-verify origin/u.test(skill), "r-s24");
  const validatorCode = /node -e '([^']+)' 2>\/dev\/null/u.exec(skill)?.[1];
  yes(typeof validatorCode === "string", "r-s25");
  const unsafePr = spawnSync(process.execPath, ["-e", validatorCode], { input: secret, encoding: "utf8" });
  yes(unsafePr.status === 1, "r-v0");
  opaque([unsafePr.stdout, unsafePr.stderr], ["", ""], "r-v1");
  noLeaks([unsafePr.stdout, unsafePr.stderr], "r-v2");
  const allowedUrl = "https://forge.invalid/org/repo/pull/1";
  const safePr = spawnSync(process.execPath, ["-e", validatorCode], { input: allowedUrl, encoding: "utf8" });
  opaque({ status: safePr.status, stdout: safePr.stdout, stderr: safePr.stderr }, { status: 0, stdout: allowedUrl, stderr: "" }, "r-v3");

  const cliSource = readFileSync(cli, "utf8");
  const orderedSource = (start, end, fragments, label) => {
    const section = cliSource.slice(cliSource.indexOf(start), cliSource.indexOf(end));
    const positions = fragments.map((fragment) => section.indexOf(fragment));
    yes(positions.every((position) => position >= 0), `${label}-p`);
    opaque(positions, [...positions].sort((left, right) => left - right), `${label}-o`);
  };
  orderedSource("async lock", "async heartbeat", ["readRun(runDir)", "compareSelectedRunPushTarget", "claimSessionLock"], "r-w0");
  orderedSource("async gate", "async step", ["assertRunNotParked", "compareSelectedRunPushTarget", "const reobservers", "transition(runDir"], "r-w1");
  orderedSource("async resume", "export async function dispatchInit", ["readRun(runDir)", "current.status", "compareSelectedRunPushTarget", "inspectSessionLock", "transition(runDir"], "r-w2");
  orderedSource("export async function dispatchInit", "function preflightInit", ["proof = prove", "configurePushTarget({", "let prBase", "await dispatchInitPublication"], "r-w3");

  const accepted = [
    secret, "http://host.invalid/r.git", "ssh://host.invalid/r.git", "git://host.invalid/r.git",
    "git@host.invalid:org/r.git", "host.invalid:org/r.git",
  ];
  const expectedTargetArgv = [
    ["remote", "get-url", "--push", "origin"],
    ["config", "--local", "--add", "include.path", "./factory-push-target.config"],
    ["remote", "get-url", "--push", "origin"],
    ["remote", "get-url", "--push", "origin"],
  ];
  for (const [index, target] of accepted.entries()) {
    const { fake, invoke } = invokeConfigure(targetResponses(target));
    opaque(invoke(), "verified", `r-a${index}`);
    opaque(fake.calls.map(({ args }) => args), expectedTargetArgv, `r-aa${index}`);
    noLeaks(fake.calls.flatMap((call) => [
      call.command, ...call.args, ...Object.keys(call.options.env), ...Object.values(call.options.env),
    ]), `r-al${index}`);
    for (const [callIndex, call] of fake.calls.entries()) {
      yes(call.options.shell === false && !Object.hasOwn(call.options, "encoding"), `r-ao${index}-${callIndex}`);
      opaque(call.options.stdio, ["ignore", "pipe", "pipe"], `r-as${index}-${callIndex}`);
      yes(call.options.env.LC_ALL === "C" && call.options.env.GIT_TERMINAL_PROMPT === "0", `r-ae${index}-${callIndex}`);
      for (const [denyIndex, name] of sensitiveChildEnvDenylist.entries()) {
        yes(!Object.hasOwn(call.options.env, name), `r-ad${index}-${callIndex}-${denyIndex}`);
      }
      for (const [providerIndex, name] of providerNames.entries()) {
        opaque(call.options.env[name], `v-${name}`, `r-ap${index}-${callIndex}-${providerIndex}`);
      }
    }
  }

  const escapedTarget = Buffer.from('https://host.invalid/a"b\\c-é.git');
  const escaped = invokeConfigure(targetResponses(escapedTarget));
  opaque(escaped.invoke(), "verified", "r-x0");
  yes(Buffer.concat(escaped.fake.writes).equals(Buffer.concat([
    Buffer.from("[remote \"origin\"]\n\tpushurl = \"https://host.invalid/a\\\"b\\\\c-"), Buffer.from("é"), Buffer.from(".git\"\n"),
  ])), "r-x1");
  const crlf = (value) => Buffer.concat([Buffer.from(value), Buffer.from("\r\n")]);
  opaque(invokeConfigure([result(crlf(secret)), result(), result(crlf(secret)), result(crlf(secret))]).invoke(), "verified", "r-crlf");
  for (const [index, byte] of [...Array.from({ length: 0x20 }, (_entry, value) => value), 0x7f].entries()) {
    const controlled = Buffer.concat([Buffer.from("https://host.invalid/a"), Buffer.from([byte]), Buffer.from("z.git\n")]);
    refusal(invokeConfigure([result(controlled)]).invoke, fixed.operator("/operator/.factory-sandboxes/r01"), `r-control-${index}`);
  }
  refusal(invokeConfigure([result(Buffer.from("https://host.invalid/a\r\r\n"))]).invoke,
    fixed.operator("/operator/.factory-sandboxes/r01"), "r-remaining-cr");

  for (const [index, target] of ["relative/path", "/absolute/path", "~/target", "C:\\target", "file:///target", "helper::address", "ftp://host/r", "https:///missing", "x:y"].entries()) {
    refusal(invokeConfigure([result(framed(target))]).invoke, fixed.operator("/operator/.factory-sandboxes/r01"), `r-t${index}`);
  }

  for (const [phaseIndex, [phase, expected]] of [[0, "operator"], [2, "operator"], [3, "sandbox"]].entries()) {
    for (const [variantIndex, [, injected]] of failureVariants().entries()) {
      const responses = targetResponses();
      responses[phase] = injected;
      refusal(invokeConfigure(responses).invoke, fixed[expected]("/operator/.factory-sandboxes/r01"), `r-f${phaseIndex}-${variantIndex}`);
    }
  }

  for (const [index, injected] of [
    result(Buffer.alloc(0), { status: 8, stderr: Buffer.from(secret) }),
    result(Buffer.alloc(0), { error: foreign("cr"), status: null }),
    result(Buffer.alloc(0), { signal: "SIGTERM", status: null }), foreign("ct"),
  ].entries()) {
    const invocation = invokeConfigure([result(framed(secret)), injected]);
    refusal(invocation.invoke, fixed.sandbox("/operator/.factory-sandboxes/r01"), `r-c${index}`);
    yes(invocation.fake.opened.length === 0 && invocation.fake.calls.length === 2, `r-cs${index}`);
  }

  for (const [index, [currentOperator, currentSandbox]] of [
    [secret, secretTwo], [secret, `${secret}/`], [secret, secret.replace("target224", "Target224")],
    [secret, secret.replace("target224", "target%3224")], [specialSecret, secret],
  ].entries()) {
    refusal(invokeConfigure(targetResponses(secret, currentOperator, currentSandbox)).invoke,
      fixed.mismatch("/operator/.factory-sandboxes/r01"), `r-mm${index}`);
  }
  opaque(invokeConfigure(targetResponses(secret, specialSecret, specialSecret)).invoke(), "verified", "r-current-equality");

  for (const [index, name] of ["open", "write", "fsync", "close"].entries()) {
    const invocation = invokeConfigure(targetResponses(), { [name]: () => { throw foreign(`fs-${name}`); } });
    refusal(invocation.invoke, fixed.sandbox("/operator/.factory-sandboxes/r01"), `r-z${index}`);
    yes(invocation.fake.calls.length === 2, `r-zs${index}`);
  }

  for (const [sideIndex, [responseIndex, expected]] of [[2, "operator"], [3, "sandbox"]].entries()) {
    for (const [variantIndex, [, injected]] of failureVariants().entries()) {
      const responses = [result(framed(activeRoot)), result(framed("/operator")), result(framed(secret)), result(framed(secret))];
      responses[responseIndex] = injected;
      const fake = fakeOperations(responses, { lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }) });
      refusal(() => compareSelectedRunPushTarget({ selectedRoot: activeRoot, runId: "r-active" }, fake.operations),
        fixed[expected](activeRoot), `r-q${sideIndex}-${variantIndex}`);
    }
  }
  for (const [index, [operatorTarget, sandboxTarget]] of [
    [secret, secretTwo], [secret, `${secret}/`], [secret, secret.replace("224", "225")],
    [specialSecret, secret], [secret, secret.replace(".git", "%2egit")],
  ].entries()) {
    const fake = activeFake(result(framed(operatorTarget)), result(framed(sandboxTarget)));
    refusal(() => compareSelectedRunPushTarget({ selectedRoot: activeRoot, runId: "r-active" }, fake.operations),
      fixed.mismatch(activeRoot), `r-am${index}`);
  }
  const contextVariants = (probe) => [
    result(Buffer.alloc(0)),
    result(framed(probe === 0 ? activeRoot : "/operator"), { status: 7 }),
    result(framed(probe === 0 ? activeRoot : "/operator"), { signal: "SIGTERM", status: null }),
    result(framed(probe === 0 ? activeRoot : "/operator"), { error: foreign(`context-result-${probe}`), status: null }),
    result(framed(probe === 0 ? activeRoot : "/operator"), { stderr: Buffer.from(secret) }),
    foreign(`context-throw-${probe}`),
    result(framed("/relationship-mismatch")),
  ];
  for (const probe of [0, 1]) {
    for (const [index, injected] of contextVariants(probe).entries()) {
      const responses = [result(framed(activeRoot)), result(framed("/operator")), result(framed(secret)), result(framed(secret))];
      responses[probe] = injected;
      const fake = fakeOperations(responses, { lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }) });
      refusal(() => compareSelectedRunPushTarget({ selectedRoot: activeRoot, runId: "r-active" }, fake.operations),
        fixed.operator(activeRoot), `r-context-${probe}-${index}`);
    }
  }
  const forged = activeFake(undefined, undefined, { basename: () => { throw foreign("forged"); } });
  refusal(() => compareSelectedRunPushTarget({ selectedRoot: activeRoot, runId: "r-active" }, forged.operations),
    fixed.operator(activeRoot), "r-forged");

  const root = mkdtempSync(join(tmpdir(), "factory-effective-push-"));
  try {
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const operator = join(root, "operator");
    const container = join(operator, ".factory-sandboxes");
    const sandbox = join(container, "r-real");
    mkdirSync(operator);
    git(operator, "init", "--quiet", "--initial-branch=main");
    git(operator, "config", "user.name", "Factory Test");
    git(operator, "config", "user.email", "factory@example.test");
    writeFileSync(join(operator, ".gitignore"), ".factory-sandboxes/\n");
    writeFileSync(join(operator, "tracked"), "tracked\n");
    git(operator, "add", ".");
    git(operator, "commit", "--quiet", "-m", "seed");
    git(operator, "config", "--replace-all", "remote.origin.pushurl", specialSecret);
    mkdirSync(container);

    const partialSandbox = join(container, "r-partial");
    git(root, "clone", "--quiet", "--local", "--", operator, partialSandbox);
    let partialWrite = true;
    refusal(() => configureSandboxPushTarget({ operatorRoot: realpathSync(operator), sandboxRoot: realpathSync(partialSandbox) }, {
      write(fd, bytes, offset, length) {
        if (!partialWrite) throw foreign("partial");
        partialWrite = false;
        return writeSync(fd, bytes, offset, Math.min(12, length));
      },
    }), fixed.sandbox(realpathSync(partialSandbox)), "r-partial");
    const partialFragment = join(partialSandbox, ".git", "factory-push-target.config");
    yes(existsSync(partialFragment), "r-partial-exists");
    yes(lstatSync(partialFragment).size === 12 && (lstatSync(partialFragment).mode & 0o777) === 0o600, "r-partial-bytes");
    const partialBefore = inventory(partialSandbox);
    opaque(inventory(partialSandbox), partialBefore, "r-partial-retained");
    yes(!existsSync(join(partialSandbox, ".factory", "r-partial", "run.json")), "r-partial-manifest");

    git(root, "clone", "--quiet", "--local", "--", operator, sandbox);
    opaque(configureSandboxPushTarget({ operatorRoot: realpathSync(operator), sandboxRoot: realpathSync(sandbox) }), "verified", "r-real-config");
    const privateFragment = join(sandbox, ".git", "factory-push-target.config");
    yes((lstatSync(privateFragment).mode & 0o777) === 0o600, "r-real-mode");
    const observed = git(sandbox, "remote", "get-url", "--push", "origin");
    yes(observed.subarray(0, -1).equals(Buffer.from(specialSecret)), "r-real-roundtrip");
    opaque(compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "r-real" }), "verified", "r-real-compare");
    const fragmentBefore = hash(readFileSync(privateFragment));
    git(operator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
    refusal(() => compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "r-real" }), fixed.mismatch(realpathSync(sandbox)), "r-real-mismatch");
    opaque(hash(readFileSync(privateFragment)), fragmentBefore, "r-real-stable");
    git(operator, "config", "--replace-all", "remote.origin.pushurl", specialSecret);
    opaque(compareSelectedRunPushTarget({ selectedRoot: operator, runId: "legacy" }), "legacy-direct", "r-legacy");
    refusal(() => compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "wrong" }), fixed.operator(realpathSync(sandbox)), "r-run-context");

    const missing = join(root, "missing");
    refusal(() => compareSelectedRunPushTarget({ selectedRoot: missing, runId: "r" }), fixed.context(missing), "r-missing");
    const linked = join(root, "linked");
    symlinkSync(sandbox, linked);
    refusal(() => compareSelectedRunPushTarget({ selectedRoot: linked, runId: "r-real" }), fixed.context(linked), "r-linked");
    refusal(() => compareSelectedRunPushTarget({ selectedRoot: sandbox, runId: "r-real" }, {
      lstat: () => { const error = foreign("unreadable"); error.code = "EACCES"; throw error; },
    }), fixed.context(sandbox), "r-unreadable");
    const contextResponses = [foreign("context")];
    const contextFake = fakeOperations(contextResponses, { lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }) });
    refusal(() => compareSelectedRunPushTarget({ selectedRoot: activeRoot, runId: "r-active" }, contextFake.operations), fixed.operator(activeRoot), "r-context-foreign");

    const freshOperator = join(root, "fresh-operator");
    mkdirSync(freshOperator);
    git(freshOperator, "init", "--quiet", "--initial-branch=main");
    git(freshOperator, "config", "user.name", "Factory Test");
    git(freshOperator, "config", "user.email", "factory@example.test");
    writeFileSync(join(freshOperator, ".gitignore"), ".factory-sandboxes/\n.factory/\n");
    writeFileSync(join(freshOperator, "tracked"), "tracked\n");
    git(freshOperator, "add", ".");
    git(freshOperator, "commit", "--quiet", "-m", "seed");
    git(freshOperator, "config", "--replace-all", "remote.origin.pushurl", secret);
    const init = spawnSync(process.execPath, [cli, "init", "r-cli", "--repo", freshOperator, "--json"], { encoding: "utf8" });
    yes(init.status === 0, "r-cli-init-status");
    noLeaks([init.stdout, init.stderr], "r-cli-init-output");
    const initialized = JSON.parse(init.stdout);
    const cliFragment = join(initialized.sandbox_path, ".git", "factory-push-target.config");
    yes((lstatSync(cliFragment).mode & 0o777) === 0o600, "r-cli-mode");
    const plainStatus = spawnSync(process.execPath, [cli, "status", "r-cli", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    const jsonStatus = spawnSync(process.execPath, [cli, "status", "r-cli", "--repo", initialized.sandbox_path, "--json"], { encoding: "utf8" });
    noLeaks([plainStatus.stdout, plainStatus.stderr, jsonStatus.stdout, jsonStatus.stderr], "r-cli-status-output");
    const manifestPath = join(initialized.run_dir, "run.json");
    noLeaks([readFileSync(manifestPath)], "r-cli-manifest");

    git(freshOperator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
    const manifestBefore = readFileSync(manifestPath);
    const malformed = JSON.parse(manifestBefore);
    malformed.unexpected = true;
    writeFileSync(manifestPath, `${JSON.stringify(malformed)}\n`);
    const manifestFirst = spawnSync(process.execPath, [cli, "lock", "r-cli", "claim", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    yes(/unknown key/u.test(manifestFirst.stderr) && !manifestFirst.stderr.includes("effective push target"), "r-manifest-first");
    noLeaks([manifestFirst.stdout, manifestFirst.stderr], "r-manifest-first-output");
    writeFileSync(manifestPath, manifestBefore);
    git(freshOperator, "config", "--replace-all", "remote.origin.pushurl", secret);
    execFileSync(process.execPath, [cli, "lock", "r-cli", "claim", "--session", "s1", "--repo", initialized.sandbox_path], { stdio: "ignore" });
    git(freshOperator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
    const lockInventory = inventory(initialized.sandbox_path);
    const lockRefusal = spawnSync(process.execPath, [cli, "lock", "r-cli", "claim", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    opaque(lockRefusal.stderr, `${fixed.mismatch(initialized.sandbox_path)}\n`, "r-lock-message");
    opaque(inventory(initialized.sandbox_path), lockInventory, "r-lock-retained");
    yes(existsSync(join(initialized.run_dir, "factory.lock")), "r-lock-present");
    noLeaks([lockRefusal.stdout, lockRefusal.stderr], "r-lock-output");
    const stealRefusal = spawnSync(process.execPath, [cli, "lock", "r-cli", "steal", "--session", "s2", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    opaque(stealRefusal.stderr, `${fixed.mismatch(initialized.sandbox_path)}\n`, "r-steal-message");
    opaque(inventory(initialized.sandbox_path), lockInventory, "r-steal-retained");
    noLeaks([stealRefusal.stdout, stealRefusal.stderr], "r-steal-output");
    execFileSync(process.execPath, [cli, "lock", "r-cli", "release", "--session", "s1", "--repo", initialized.sandbox_path], { stdio: "ignore" });

    const cliFragmentBytes = readFileSync(cliFragment);
    const tracePaths = [join(root, "trace.log"), join(root, "trace2.log"), join(root, "gcm.log")];
    const targetEnv = { ...process.env, ...Object.fromEntries(sensitiveChildEnvDenylist.map((name) => [name, secret])) };
    [targetEnv.GIT_TRACE, targetEnv.GIT_TRACE2_EVENT, targetEnv.GCM_TRACE] = tracePaths;
    const gate = (label, expected) => {
      const beforeGate = inventory(initialized.sandbox_path);
      const observedGate = spawnSync(process.execPath, [cli, "gate", "r-cli", "pre_pr", "approved", "--repo", initialized.sandbox_path, "--json"], { encoding: "utf8", env: targetEnv });
      opaque(observedGate.stderr, `${expected}\n`, `${label}-message`);
      opaque(inventory(initialized.sandbox_path), beforeGate, `${label}-inventory`);
      noLeaks([observedGate.stdout, observedGate.stderr], `${label}-output`);
      for (const [index, path] of tracePaths.entries()) yes(!existsSync(path), `${label}-trace-${index}`);
      return observedGate;
    };
    const mismatchGate = gate("r-gate-mismatch", fixed.mismatch(initialized.sandbox_path));
    git(freshOperator, "config", "--unset-all", "remote.origin.pushurl");
    const operatorGate = gate("r-gate-operator", fixed.operator(initialized.sandbox_path));
    git(freshOperator, "config", "--replace-all", "remote.origin.pushurl", secret);
    rmSync(cliFragment);
    const sandboxGate = gate("r-gate-sandbox", fixed.sandbox(initialized.sandbox_path));
    writeFileSync(cliFragment, cliFragmentBytes, { mode: 0o600 });
    chmodSync(cliFragment, 0o600);

    git(freshOperator, "config", "--replace-all", "remote.origin.pushurl", secret);
    execFileSync(process.execPath, [cli, "lock", "r-cli", "claim", "--session", "s1", "--repo", initialized.sandbox_path], { stdio: "ignore" });
    execFileSync(process.execPath, [cli, "terminal", "r-cli", "needs-human", "--reason", "pause", "--repo", initialized.sandbox_path], { stdio: "ignore" });
    git(freshOperator, "config", "--replace-all", "remote.origin.pushurl", secretTwo);
    const resumeBefore = inventory(initialized.sandbox_path);
    const resumeRefusal = spawnSync(process.execPath, [cli, "resume", "r-cli", "--session", "s1", "--repo", initialized.sandbox_path], { encoding: "utf8" });
    opaque(resumeRefusal.stderr, `${fixed.mismatch(initialized.sandbox_path)}\n`, "r-resume-message");
    opaque(inventory(initialized.sandbox_path), resumeBefore, "r-resume-inventory");
    noLeaks([resumeRefusal.stdout, resumeRefusal.stderr], "r-resume-output");
    yes(spawnSync(process.execPath, [cli, "heartbeat", "r-cli", "--session", "s1", "--repo", initialized.sandbox_path], { stdio: "ignore" }).status === 0, "r-heartbeat");
    yes(spawnSync(process.execPath, [cli, "lock", "r-cli", "release", "--session", "s1", "--repo", initialized.sandbox_path], { stdio: "ignore" }).status === 0, "r-release");

    const refusedOperator = join(root, "refused-operator");
    mkdirSync(refusedOperator);
    git(refusedOperator, "init", "--quiet", "--initial-branch=main");
    git(refusedOperator, "config", "user.name", "Factory Test");
    git(refusedOperator, "config", "user.email", "factory@example.test");
    writeFileSync(join(refusedOperator, "tracked"), "tracked\n");
    git(refusedOperator, "add", ".");
    git(refusedOperator, "commit", "--quiet", "-m", "seed");
    git(refusedOperator, "config", "--replace-all", "remote.origin.pushurl", join(root, "local-target"));
    const refusedSandbox = join(realpathSync(refusedOperator), ".factory-sandboxes", "r-refused");
    const refused = spawnSync(process.execPath, [cli, "init", "r-refused", "--repo", refusedOperator], { encoding: "utf8" });
    opaque(refused.stderr, `${fixed.operator(refusedSandbox)}\n`, "r-fresh-refusal");
    yes(existsSync(refusedSandbox) && !existsSync(join(refusedSandbox, ".factory", "r-refused", "run.json")), "r-fresh-retained");
    const refusedBefore = inventory(refusedSandbox);
    const repeated = spawnSync(process.execPath, [cli, "init", "r-refused", "--repo", refusedOperator], { encoding: "utf8" });
    yes(/already exists without a manifest/u.test(repeated.stderr), "r-fresh-repeat");
    opaque(inventory(refusedSandbox), refusedBefore, "r-fresh-repeat-retained");
    noLeaks([refused.stdout, refused.stderr, repeated.stdout, repeated.stderr], "r-fresh-output");

    const publish = join(root, "publish");
    const remote = join(root, "remote.git");
    mkdirSync(publish);
    git(publish, "init", "--quiet", "--initial-branch=main");
    git(root, "init", "--quiet", "--bare", remote);
    git(publish, "config", "user.name", "Factory Test");
    git(publish, "config", "user.email", "factory@example.test");
    writeFileSync(join(publish, "tracked"), "tracked\n");
    writeFileSync(join(publish, "body"), "body\n");
    git(publish, "add", ".");
    git(publish, "commit", "--quiet", "-m", "seed");
    git(publish, "remote", "add", "origin", remote);
    git(publish, "config", "remote.origin.pushurl", remote);
    const hookSentinel = join(root, "hook-ran");
    const hook = join(publish, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nprintf hook >${JSON.stringify(hookSentinel)}\n`);
    chmodSync(hook, 0o755);
    const bin = join(root, "bin");
    const gitJournal = join(root, "git-argv.jsonl");
    const ghJournal = join(root, "gh-argv.jsonl");
    const factoryJournal = join(root, "factory-argv.jsonl");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const journalPrelude = 'const fs=require("node:fs");const deny=JSON.parse(process.env.DENYLIST);const present=deny.filter((key)=>Object.hasOwn(process.env,key));const providers=JSON.parse(process.env.PROVIDERS).filter((key)=>Object.hasOwn(process.env,key));const values=Object.fromEntries([...deny,...providers].map((key)=>[key,process.env[key]??null]));';
    const factoryJournalPrelude = 'const fs=require("node:fs");const deny=JSON.parse(process.env.DENYLIST);const present=deny.filter((key)=>Object.hasOwn(process.env,key));const providers=JSON.parse(process.env.PROVIDERS).filter((key)=>Object.hasOwn(process.env,key));';
    writeFileSync(join(bin, "git"), `#!/usr/bin/env node\n${journalPrelude}fs.appendFileSync(process.env.GIT_JOURNAL,JSON.stringify({args:process.argv.slice(2),present,providers,values})+"\\n");if(process.env.GIT_SHIM_FAIL==="1"){const corpus=JSON.parse(process.env.SHIM_CORPUS).join("\\n")+"\\n";process.stdout.write(corpus);process.stderr.write(corpus);for(const key of ["GIT_TRACE","GIT_TRACE2_EVENT","GCM_TRACE"]){if(process.env[key])fs.appendFileSync(process.env[key],corpus)}process.exit(42)}const r=require("node:child_process").spawnSync(process.env.REAL_GIT,process.argv.slice(2),{stdio:"inherit",env:process.env});process.exit(r.status??1);\n`);
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\n${journalPrelude}fs.appendFileSync(process.env.GH_JOURNAL,JSON.stringify({args:process.argv.slice(2),present,providers,values})+"\\n");process.stdout.write(process.env.GH_STDOUT||"");process.stderr.write(process.env.GH_STDERR||"");process.exit(Number(process.env.GH_EXIT||0));\n`);
    writeFileSync(join(bin, "factory"), `#!/usr/bin/env node\n${factoryJournalPrelude}fs.appendFileSync(process.env.FACTORY_JOURNAL,JSON.stringify({args:process.argv.slice(2),present,providers})+"\\n");\n`);
    for (const name of ["git", "gh", "factory"]) chmodSync(join(bin, name), 0o755);
    const publicationStart = skill.indexOf("set +x\npublication_child()");
    const publicationScript = skill.slice(publicationStart, skill.indexOf("\n```", publicationStart));
    yes(publicationStart >= 0 && publicationScript.endsWith('factory pr "$R" --url "$PR_URL" --repo "$RUN_REPO"'), "r-pub-script");
    const publicationTrace = [join(root, "publication-trace"), join(root, "publication-trace2"), join(root, "publication-gcm")];
    const traceSentinel = "trace sentinel unchanged\n";
    const publication = (overrides = {}, { seedTrace = false } = {}) => {
      for (const path of [gitJournal, ghJournal, factoryJournal, hookSentinel, ...publicationTrace]) rmSync(path, { force: true });
      if (seedTrace) writeFileSync(publicationTrace[0], traceSentinel);
      const env = {
        ...process.env,
        ...Object.fromEntries(sensitiveChildEnvDenylist.map((name) => [name, secret])),
        PATH: `${bin}:${process.env.PATH}`, DENYLIST: JSON.stringify(sensitiveChildEnvDenylist), PROVIDERS: JSON.stringify(providerNames),
        REAL_GIT: realGit, GIT_JOURNAL: gitJournal, GH_JOURNAL: ghJournal, FACTORY_JOURNAL: factoryJournal,
        R: "r-publish", RUN_REPO: publish, FEATURE_BRANCH: "main", O: publish, PR_BASE: "main",
        TITLE: "title", BODY_FILE: join(publish, "body"),
        ...Object.fromEntries(providerNames.map((name) => [name, `provider-${name}`])),
        GIT_CONFIG_COUNT: "0",
        ...overrides,
      };
      [env.GIT_TRACE, env.GIT_TRACE2_EVENT, env.GCM_TRACE] = publicationTrace;
      return spawnSync("sh", ["-c", publicationScript], { encoding: "utf8", env });
    };
    const journal = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const assertJournal = (path, expectedArgs, label, { sanitized = true } = {}) => {
      const rows = journal(path);
      opaque(rows.map(({ args }) => args), expectedArgs, `${label}-args`);
      if (sanitized) yes(rows.every(({ present }) => present.length === 0), `${label}-env`);
      yes(rows.every(({ providers }) => hash(providers) === hash(providerNames)), `${label}-providers`);
      if (sanitized) yes(rows.every(({ values }) => sensitiveChildEnvDenylist.every((name) => values[name] === null)), `${label}-values`);
      noLeaks(rows.flatMap(({ args, present, providers, values }) => [
        ...args, ...present, ...providers, ...Object.keys(values ?? {}), ...Object.values(values ?? {}),
      ]), `${label}-value-leak`);
      noLeaks([readFileSync(path)], `${label}-leak`);
    };
    const refspec = "refs/heads/main:refs/heads/main";
    const pushArgs = [["-C", publish, "push", "--no-verify", "origin", refspec]];
    const ghArgs = [["pr", "create", "--draft", "--base", "main", "--head", "main", "--title", "title", "--body-file", join(publish, "body")]];
    const pushFailure = publication({ GIT_SHIM_FAIL: "1", SHIM_CORPUS: JSON.stringify(forbidden), GH_STDOUT: secret, GH_STDERR: secretTwo }, { seedTrace: true });
    opaque({ status: pushFailure.status, stdout: pushFailure.stdout, stderr: pushFailure.stderr }, { status: 1, stdout: fixed.push(publish), stderr: "" }, "r-push-fail");
    assertJournal(gitJournal, pushArgs, "r-push-journal");
    yes(!existsSync(ghJournal) && !existsSync(factoryJournal), "r-push-stop");
    yes(!existsSync(hookSentinel), "r-push-hook");
    opaque(readFileSync(publicationTrace[0]), traceSentinel, "r-push-trace-unchanged");
    yes(!existsSync(publicationTrace[1]) && !existsSync(publicationTrace[2]), "r-push-trace-absent");
    noLeaks([pushFailure.stdout, pushFailure.stderr], "r-push-outer");

    const ghFailure = publication({ GH_EXIT: "42", GH_STDOUT: secret, GH_STDERR: secretTwo });
    opaque({ status: ghFailure.status, stdout: ghFailure.stdout, stderr: ghFailure.stderr }, { status: 1, stdout: fixed.gh(publish), stderr: "" }, "r-gh-fail");
    assertJournal(gitJournal, pushArgs, "r-gh-git-journal");
    assertJournal(ghJournal, ghArgs, "r-gh-journal");
    yes(!existsSync(factoryJournal), "r-gh-stop");
    noLeaks([ghFailure.stdout, ghFailure.stderr], "r-gh-outer");

    const unsafeGh = publication({ GH_STDOUT: `${secret}\n`, GH_STDERR: secretTwo });
    opaque({ status: unsafeGh.status, stdout: unsafeGh.stdout, stderr: unsafeGh.stderr }, { status: 1, stdout: fixed.gh(publish), stderr: "" }, "r-gh-unsafe-run");
    assertJournal(gitJournal, pushArgs, "r-gh-unsafe-git");
    assertJournal(ghJournal, ghArgs, "r-gh-unsafe-gh");
    yes(!existsSync(factoryJournal), "r-gh-unsafe-stop");
    noLeaks([unsafeGh.stdout, unsafeGh.stderr], "r-gh-unsafe-outer");

    const safePublication = publication({ GH_STDOUT: `${allowedUrl}\n` });
    opaque({ status: safePublication.status, stdout: safePublication.stdout, stderr: safePublication.stderr }, { status: 0, stdout: "", stderr: "" }, "r-pub-safe");
    assertJournal(gitJournal, pushArgs, "r-pub-safe-git");
    assertJournal(ghJournal, ghArgs, "r-pub-safe-gh");
    assertJournal(factoryJournal, [["pr", "r-publish", "--url", allowedUrl, "--repo", publish]], "r-pub-safe-factory", { sanitized: false });
    yes(!existsSync(hookSentinel), "r-pub-hook");
    for (const [index, path] of publicationTrace.entries()) yes(!existsSync(path), `r-pub-trace-${index}`);
    for (const [index, path] of [join(root, "PR_RESULT"), join(root, "PR_URL"), join(root, "publication.out")].entries()) yes(!existsSync(path), `r-pub-remnant-${index}`);

    const capturedOutput = (observed) => ({ status: observed.status, stdout: observed.stdout, stderr: observed.stderr });
    const evidenceOutput = join(initialized.run_dir, "evidence", "captured-refusals.json");
    const reviewOutput = join(initialized.run_dir, "reviews", "captured-publication.json");
    const factoryOutput = join(initialized.run_dir, "factory.log");
    const cliRefusals = {
      manifest: capturedOutput(manifestFirst), lock: capturedOutput(lockRefusal), mismatch: capturedOutput(mismatchGate),
      operator: capturedOutput(operatorGate), sandbox: capturedOutput(sandboxGate), resume: capturedOutput(resumeRefusal),
      fresh: capturedOutput(refused), repeated: capturedOutput(repeated),
    };
    const publicationRefusals = {
      push: capturedOutput(pushFailure), gh: capturedOutput(ghFailure), unsafe: capturedOutput(unsafeGh),
    };
    writeFileSync(evidenceOutput, `${JSON.stringify(cliRefusals)}\n`);
    writeFileSync(reviewOutput, `${JSON.stringify(publicationRefusals)}\n`);
    writeFileSync(factoryOutput, `${JSON.stringify({ cli: cliRefusals, publication: publicationRefusals })}\n`);
    for (const [index, path] of [evidenceOutput, reviewOutput, factoryOutput].entries()) {
      noLeaks([readFileSync(path)], `r-sink-${index}`);
    }

    const scannerProbe = join(root, "scanner-negative");
    mkdirSync(scannerProbe);
    writeFileSync(join(scannerProbe, "planted"), forbidden[Math.floor(forbidden.length / 2)]);
    const scannerResult = caught(() => scanTree(scannerProbe, new Set(), "r-scanner-inner"));
    yes(scannerResult.error instanceof Error, "r-scanner-detected");
    noLeaks(failureSurface(scannerResult.error), "r-scanner-safe-output");
    rmSync(scannerProbe, { recursive: true, force: true });

    const excluded = new Set([
      join(operator, ".git", "config"), privateFragment, partialFragment,
      join(freshOperator, ".git", "config"), cliFragment,
      join(freshOperator, ".factory-sandboxes", "r-cli", ".git", "factory-push-target.config"),
    ]);
    scanTree(root, excluded, "r-tree");
    scanTree(initialized.run_dir, new Set(), "r-control-plane");

    const negative = spawnSync(process.execPath, ["-e", 'require("node:assert/strict").equal(true,false,"r-neg")'], {
      encoding: "utf8", env: { ...process.env, FACTORY_NEGATIVE_SECRET: secret },
    });
    yes(negative.status !== 0, "r-negative-status");
    noLeaks([negative.stdout, negative.stderr], "r-negative-output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
