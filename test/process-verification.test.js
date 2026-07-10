import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  PROCESS_INSPECTOR,
  PROCESS_SIGNAL_RACE_LIMITATION,
  PROCESS_VERIFICATION_CODES,
  inspectProcessIdentity,
  probeProcessLiveness,
  signalVerifiedProcess,
  verifyProcessIdentity,
} from "../src/hardening/process-verification.js";

const PID = 4242;
const CWD = resolve("/tmp/process-verification-repo");

function codedError(code, message = "sensitive operating system detail") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function procStat(pid, startMarker, command = "node worker (safe)") {
  const fields = ["S", ...Array(18).fill("0"), String(startMarker), "0", "0"];
  return `${pid} (${command}) ${fields.join(" ")}\n`;
}

function linuxOptions(overrides = {}) {
  let statReads = 0;
  const starts = overrides.starts || ["987654", "987654"];
  return {
    platform: "linux",
    hostnameFn: () => "test-host",
    livenessProbe: () => ({ status: "live" }),
    procReadFile(path) {
      if (path === `/proc/${PID}/stat`) {
        const value = starts[Math.min(statReads, starts.length - 1)];
        statReads += 1;
        return procStat(PID, value);
      }
      if (path === `/proc/${PID}/comm`) return overrides.command ?? "/opt/bin/node\n";
      throw new Error("unexpected proc path");
    },
    procReadlink(path) {
      assert.equal(path, `/proc/${PID}/cwd`);
      return overrides.cwd ?? CWD;
    },
    ...overrides.options,
  };
}

function expectedIdentity(overrides = {}) {
  const { identity: identityOverrides = {}, ...topLevelOverrides } = overrides;
  return {
    pid: PID,
    cwd: CWD,
    identity: {
      inspector: PROCESS_INSPECTOR,
      start_marker: "linux-procfs:987654",
      command_name: "/usr/local/bin/node",
      ...identityOverrides,
    },
    ...topLevelOverrides,
  };
}

function darwinExpectedIdentity(overrides = {}) {
  const { identity: identityOverrides = {}, ...topLevelOverrides } = overrides;
  return {
    pid: PID,
    cwd: CWD,
    identity: {
      inspector: PROCESS_INSPECTOR,
      start_marker: "darwin-ps:Thu Jul 9 15:00:00 2026",
      command_name: "opencode",
      ...identityOverrides,
    },
    ...topLevelOverrides,
  };
}

describe("structured process liveness", () => {
  it("accepts only positive pids and structured injected classifications", () => {
    assert.deepEqual(probeProcessLiveness(0), {
      status: "indeterminate",
      code: PROCESS_VERIFICATION_CODES.INVALID_PID,
      reason: "process pid must be a positive integer",
      pid: 0,
    });
    assert.equal(probeProcessLiveness(PID, { livenessProbe: () => ({ status: "live" }) }).status, "live");
    assert.equal(probeProcessLiveness(PID, { livenessProbe: () => ({ status: "absent" }) }).status, "absent");
    assert.equal(probeProcessLiveness(PID, { livenessProbe: () => ({ status: "indeterminate" }) }).status, "indeterminate");
    const malformed = probeProcessLiveness(PID, { livenessProbe: () => false });
    assert.equal(malformed.status, "indeterminate");
    assert.equal(malformed.code, PROCESS_VERIFICATION_CODES.LIVENESS_RESULT_MALFORMED);
  });

  it("classifies only structured ESRCH as absent", () => {
    for (const code of ["EPERM", "EACCES"]) {
      const denied = probeProcessLiveness(PID, { livenessProbe: () => { throw codedError(code); } });
      assert.equal(denied.status, "indeterminate", code);
      assert.equal(denied.code, PROCESS_VERIFICATION_CODES.LIVENESS_PERMISSION_DENIED, code);
    }

    const absent = probeProcessLiveness(PID, { livenessProbe: () => { throw codedError("ESRCH"); } });
    assert.equal(absent.status, "absent");
    assert.equal(absent.code, PROCESS_VERIFICATION_CODES.LIVENESS_ABSENT);

    const textualLookalike = probeProcessLiveness(PID, {
      livenessProbe: () => { throw new Error("ESRCH: no such process"); },
    });
    assert.equal(textualLookalike.status, "indeterminate");
  });

  it("never exposes probe error text", () => {
    const secret = "TOP-SECRET-LIVENESS-DIAGNOSTIC";
    const result = probeProcessLiveness(PID, { livenessProbe: () => { throw codedError("EPERM", secret); } });
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
});

describe("platform process identity inspection", () => {
  it("inspects Linux proc identity, rechecks the start marker, and injects hostname", () => {
    const reads = [];
    const options = linuxOptions();
    const originalRead = options.procReadFile;
    options.procReadFile = (path, encoding) => {
      reads.push([path, encoding]);
      return originalRead(path, encoding);
    };

    const inspected = inspectProcessIdentity(PID, options);
    assert.equal(inspected.status, "live");
    assert.deepEqual(inspected.identity, {
      pid: PID,
      inspector: PROCESS_INSPECTOR,
      start_marker: "linux-procfs:987654",
      command_name: "node",
      cwd: CWD,
      hostname: "test-host",
    });
    assert.deepEqual(reads, [
      [`/proc/${PID}/stat`, "utf8"],
      [`/proc/${PID}/comm`, "utf8"],
      [`/proc/${PID}/stat`, "utf8"],
    ]);
  });

  it("fails closed when Linux metadata changes during one inspection", () => {
    const inspected = inspectProcessIdentity(PID, linuxOptions({ starts: ["111", "222"] }));
    assert.equal(inspected.status, "indeterminate");
    assert.equal(inspected.code, PROCESS_VERIFICATION_CODES.METADATA_MALFORMED);
  });

  it("turns failed or malformed metadata into absence only after a fresh ESRCH probe", () => {
    for (const metadataFailure of [
      () => { throw codedError("EACCES"); },
      () => "malformed stat",
    ]) {
      const statuses = ["live", "absent"];
      const inspected = inspectProcessIdentity(PID, {
        ...linuxOptions(),
        livenessProbe: () => ({ status: statuses.shift() }),
        procReadFile: metadataFailure,
      });
      assert.equal(inspected.status, "absent");
      assert.equal(inspected.code, PROCESS_VERIFICATION_CODES.LIVENESS_ABSENT);
    }
  });

  it("keeps proc read and permission failures indeterminate while liveness is not absent", () => {
    const liveness = [
      { status: "live" },
      () => { throw codedError("EPERM"); },
    ];
    const inspected = inspectProcessIdentity(PID, {
      ...linuxOptions(),
      livenessProbe: () => {
        const next = liveness.shift();
        return typeof next === "function" ? next() : next;
      },
      procReadFile: () => { throw codedError("EACCES", "do not leak this path"); },
    });
    assert.equal(inspected.status, "indeterminate");
    assert.equal(inspected.code, PROCESS_VERIFICATION_CODES.METADATA_UNAVAILABLE);
    assert.equal(inspected.liveness_status, "indeterminate");
    assert.equal(JSON.stringify(inspected).includes("do not leak"), false);
  });

  it("uses targeted Darwin tools with bounded options and a final start recheck", () => {
    const calls = [];
    const output = (command, args) => {
      if (command === "ps" && args.at(-1) === "lstart=") return "Thu Jul  9 15:00:00 2026\n";
      if (command === "ps" && args.at(-1) === "comm=") return "/opt/homebrew/bin/opencode\n";
      if (command === "lsof") return `p${PID}\nfcwd\nn${CWD}\n`;
      throw new Error("unexpected command");
    };
    const inspected = inspectProcessIdentity(PID, {
      platform: "darwin",
      hostname: "darwin-host",
      livenessProbe: () => ({ status: "live" }),
      commandRunner(command, args, options) {
        calls.push({ command, args, options });
        return output(command, args);
      },
    });

    assert.equal(inspected.status, "live");
    assert.deepEqual(inspected.identity, {
      pid: PID,
      inspector: PROCESS_INSPECTOR,
      start_marker: "darwin-ps:Thu Jul 9 15:00:00 2026",
      command_name: "opencode",
      cwd: CWD,
      hostname: "darwin-host",
    });
    assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
      ["ps", "-p", String(PID), "-o", "lstart="],
      ["ps", "-p", String(PID), "-o", "comm="],
      ["lsof", "-a", "-p", String(PID), "-d", "cwd", "-Fn"],
      ["ps", "-p", String(PID), "-o", "lstart="],
    ]);
    for (const call of calls) {
      assert.equal(call.options.timeout, 5_000);
      assert.equal(call.options.maxBuffer, 1024 * 1024);
      assert.equal(Object.hasOwn(call.options, "shell"), false);
    }
  });

  it("keeps Darwin timeout, missing-tool, permission, and malformed output indeterminate", () => {
    const failures = [
      codedError("ETIMEDOUT"),
      codedError("ENOENT"),
      codedError("EACCES"),
      null,
    ];
    for (const failure of failures) {
      const inspected = inspectProcessIdentity(PID, {
        platform: "darwin",
        hostname: "host",
        livenessProbe: () => ({ status: "live" }),
        commandRunner: () => {
          if (failure) throw failure;
          return "";
        },
      });
      assert.equal(inspected.status, "indeterminate");
      assert.notEqual(inspected.status, "absent");
    }
  });

  it("rejects nonempty malformed or multiline Darwin ps output without signaling", async () => {
    const cases = [
      {
        name: "nonempty malformed lstart",
        lstart: "not a process start timestamp\n",
        command: "/opt/homebrew/bin/opencode\n",
      },
      {
        name: "impossible lstart date",
        lstart: "Mon Feb 31 15:00:00 2026\n",
        command: "/opt/homebrew/bin/opencode\n",
      },
      {
        name: "multiline lstart",
        lstart: "Thu Jul  9 15:00:00 2026\nFri Jul 10 15:00:00 2026\n",
        command: "/opt/homebrew/bin/opencode\n",
      },
      {
        name: "multiline comm",
        lstart: "Thu Jul  9 15:00:00 2026\n",
        command: "/opt/homebrew/bin/opencode\n/usr/bin/replacement\n",
      },
    ];

    for (const item of cases) {
      const signals = [];
      const result = await signalVerifiedProcess(darwinExpectedIdentity(), {
        platform: "darwin",
        hostname: "host",
        livenessProbe: () => ({ status: "live" }),
        commandRunner(command, args) {
          if (command === "ps" && args.at(-1) === "lstart=") return item.lstart;
          if (command === "ps" && args.at(-1) === "comm=") return item.command;
          if (command === "lsof") return `p${PID}\nfcwd\nn${CWD}\n`;
          throw new Error("unexpected command");
        },
        signalFn: (...args) => signals.push(args),
      });
      assert.equal(result.status, "not-signaled", item.name);
      assert.equal(result.verification.status, "indeterminate", item.name);
      assert.equal(result.verification.code, PROCESS_VERIFICATION_CODES.METADATA_MALFORMED, item.name);
      assert.deepEqual(signals, [], item.name);
    }
  });

  it("rejects malformed, misordered, ambiguous, or unassociated lsof records without signaling", async () => {
    const records = [
      ["misordered", `p${PID}\nn${CWD}\nfcwd\n`],
      ["ambiguous duplicate name", `p${PID}\nfcwd\nn${CWD}\nn/tmp/other\n`],
      ["unassociated pid", `p${PID + 1}\nfcwd\nn${CWD}\n`],
      ["multiple process records", `p${PID + 1}\nfcwd\nn/tmp/other\np${PID}\nfcwd\nn${CWD}\n`],
      ["extra blank record", `p${PID}\nfcwd\nn${CWD}\n\n`],
      ["missing file descriptor record", `p${PID}\nn${CWD}\n`],
    ];

    for (const [name, lsof] of records) {
      const signals = [];
      const result = await signalVerifiedProcess(darwinExpectedIdentity(), {
        platform: "darwin",
        hostname: "host",
        livenessProbe: () => ({ status: "live" }),
        commandRunner(command, args) {
          if (command === "ps" && args.at(-1) === "lstart=") return "Thu Jul  9 15:00:00 2026\n";
          if (command === "ps" && args.at(-1) === "comm=") return "/opt/homebrew/bin/opencode\n";
          if (command === "lsof") return lsof;
          throw new Error("unexpected command");
        },
        signalFn: (...args) => signals.push(args),
      });
      assert.equal(result.status, "not-signaled", name);
      assert.equal(result.verification.status, "indeterminate", name);
      assert.equal(result.verification.code, PROCESS_VERIFICATION_CODES.METADATA_MALFORMED, name);
      assert.deepEqual(signals, [], name);
    }
  });

  it("classifies unsupported platforms as indeterminate", () => {
    const inspected = inspectProcessIdentity(PID, {
      platformFn: () => "unsupported-test-platform",
      livenessProbe: () => ({ status: "live" }),
    });
    assert.equal(inspected.status, "indeterminate");
    assert.equal(inspected.code, PROCESS_VERIFICATION_CODES.PLATFORM_UNSUPPORTED);
  });
});

describe("exact normalized process identity matching", () => {
  it("matches exact PID, inspector, marker, command basename, and resolved cwd", () => {
    const verified = verifyProcessIdentity(expectedIdentity(), linuxOptions());
    assert.equal(verified.status, "live-and-matching");
    assert.equal(verified.code, PROCESS_VERIFICATION_CODES.IDENTITY_MATCH);
    assert.equal(verified.identity.command_name, "node");
  });

  it("returns only mismatched field names for PID reuse and identity changes", () => {
    const cases = [
      ["inspector", expectedIdentity({ identity: { inspector: "other-inspector" } })],
      ["start_marker", expectedIdentity({ identity: { start_marker: "linux-procfs:old" } })],
      ["command_name", expectedIdentity({ identity: { command_name: "other" } })],
      ["cwd", expectedIdentity({ cwd: resolve("/tmp/other-process-cwd") })],
    ];
    for (const [field, expected] of cases) {
      const verified = verifyProcessIdentity(expected, linuxOptions());
      assert.equal(verified.status, "mismatched", field);
      assert.deepEqual(verified.mismatched_fields, [field], field);
      assert.equal(JSON.stringify(verified).includes("987654"), false, field);
    }
  });

  it("treats malformed or missing expected evidence as indeterminate", () => {
    for (const expected of [null, {}, { pid: -PID }, expectedIdentity({ cwd: "relative" }), expectedIdentity({ identity: { start_marker: "" } })]) {
      const verified = verifyProcessIdentity(expected, linuxOptions());
      assert.equal(verified.status, "indeterminate");
      assert.equal(verified.code, PROCESS_VERIFICATION_CODES.IDENTITY_INVALID);
    }
  });
});

describe("final verified targeted signaling", () => {
  it("sends exactly one positive-PID SIGTERM after a final matching inspection", async () => {
    const calls = [];
    const signaled = await signalVerifiedProcess(expectedIdentity(), {
      ...linuxOptions(),
      signalFn(pid, signal) {
        calls.push([pid, signal]);
      },
    });
    assert.equal(signaled.status, "signaled");
    assert.deepEqual(calls, [[PID, "SIGTERM"]]);
    assert.equal(signaled.post_signal.status, "not-checked");
    assert.equal(signaled.limitation, PROCESS_SIGNAL_RACE_LIMITATION);
    assert.match(signaled.limitation, /not atomic/u);
  });

  it("reinspects immediately before signaling and rejects a replacement PID identity", async () => {
    let generation = "old";
    const calls = [];
    const options = linuxOptions({
      options: {
        procReadFile(path) {
          if (path.endsWith("/stat")) return procStat(PID, generation === "old" ? "987654" : "222222");
          if (path.endsWith("/comm")) return "node\n";
          throw new Error("unexpected path");
        },
      },
    });
    assert.equal(verifyProcessIdentity(expectedIdentity(), options).status, "live-and-matching");
    generation = "replacement";

    const result = await signalVerifiedProcess(expectedIdentity(), {
      ...options,
      signalFn: (...args) => calls.push(args),
    });
    assert.equal(result.status, "not-signaled");
    assert.equal(result.verification.status, "mismatched");
    assert.deepEqual(calls, []);
  });

  it("sends zero signals for absent, mismatched, indeterminate, invalid, or non-SIGTERM requests", async () => {
    const cases = [
      { expected: expectedIdentity(), options: { livenessProbe: () => ({ status: "absent" }) } },
      { expected: expectedIdentity({ identity: { start_marker: "linux-procfs:replacement" } }), options: linuxOptions() },
      { expected: expectedIdentity(), options: { platform: "unsupported", livenessProbe: () => ({ status: "live" }) } },
      { expected: {}, options: linuxOptions() },
      { expected: expectedIdentity(), options: { ...linuxOptions(), signal: "SIGKILL" } },
    ];
    for (const item of cases) {
      const calls = [];
      const result = await signalVerifiedProcess(item.expected, {
        platform: "linux",
        hostname: "host",
        ...item.options,
        signalFn: (...args) => calls.push(args),
      });
      assert.equal(result.status, "not-signaled");
      assert.deepEqual(calls, []);
    }
  });

  it("reports a signal syscall failure without retry or fallback", async () => {
    let calls = 0;
    const result = await signalVerifiedProcess(expectedIdentity(), {
      ...linuxOptions(),
      signalFn() {
        calls += 1;
        throw codedError("ESRCH", "replacement race detail");
      },
    });
    assert.equal(result.status, "signal-failed");
    assert.equal(result.code, PROCESS_VERIFICATION_CODES.SIGNAL_FAILED);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("replacement race detail"), false);
  });

  it("uses injected clock and sleep and never confirms post-signal mismatch as exit", async () => {
    let signaled = false;
    let now = 0;
    const sleeps = [];
    const options = linuxOptions({
      options: {
        procReadFile(path) {
          if (path.endsWith("/stat")) return procStat(PID, signaled ? "222222" : "987654");
          if (path.endsWith("/comm")) return "node\n";
          throw new Error("unexpected path");
        },
      },
    });
    const result = await signalVerifiedProcess(expectedIdentity(), {
      ...options,
      waitForExitMs: 10,
      pollIntervalMs: 2,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      signalFn() {
        signaled = true;
      },
    });
    assert.equal(result.status, "signaled");
    assert.equal(result.post_signal.status, "mismatched");
    assert.notEqual(result.post_signal.status, "absent");
    assert.deepEqual(sleeps, [2]);
  });

  it("contains no broad, group, negative-PID, shell, or fallback signal mechanism", () => {
    const source = readFileSync(new URL("../src/hardening/process-verification.js", import.meta.url), "utf8");
    for (const token of ["p" + "kill", "kill" + "all"]) assert.equal(source.includes(token), false, token);
    assert.doesNotMatch(source, /process\.kill\(\s*-/u);
    assert.doesNotMatch(source, /\b(?:spawn|exec)\s*\(/u);
    assert.doesNotMatch(source, /shell\s*:/u);
  });
});

it("real supported-platform identity smoke", {
  skip: process.env.RUN_PROCESS_VERIFICATION_SMOKE !== "1",
}, (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") t.skip("unsupported host platform");
  if (process.platform === "linux" && !existsSync(`/proc/${process.pid}/stat`)) t.skip("procfs unavailable");
  const inspected = inspectProcessIdentity(process.pid);
  assert.equal(inspected.status, "live", `${inspected.code}: ${inspected.reason}`);
  assert.equal(inspected.identity.pid, process.pid);
  assert.ok(inspected.identity.command_name.length > 0);
  assert.ok(inspected.identity.cwd.startsWith("/"));
});
