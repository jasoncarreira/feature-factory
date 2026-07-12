import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "./helpers/git-fixture.js";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createTrackedProcessCleanup } from "./process-cleanup-helper.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
// Spawn deadline for the CLI subprocess. This is a hang-guard, not a performance
// assertion: `npm run check` runs many test files concurrently and several of them
// (this one included) spawn their own `node` CLI, so a correct invocation can be
// slow to start under CPU oversubscription. The bound must be generous enough that
// only a genuinely stuck process trips it — a slow-but-progressing start must not.
// (A tight 5s bound previously flaked with ETIMEDOUT under full-suite concurrency.)
const CLI_TIMEOUT_MS = 30000;
const RUN_ID = "cli-cost-report";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("factory cost-report CLI", () => {
  it("lists the command in help", () => {
    const proc = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });

    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /factory cost-report <run-id> \[--json\] \[--telemetry\]/u);
  });

  it("reports invalid workflow state without locks, heartbeats, attestations, or writes", () => {
    const repo = tempRepo();
    const runDir = seedRun(repo, populatedRun());
    mkdirSync(join(runDir, "run-json.lock"), { recursive: true });
    writeFileSync(join(runDir, "run-json.lock", "owner.json"), '{"pid":1,"token":"held"}\n');
    writeJson(join(runDir, "heartbeat.json"), {
      schema_version: 1,
      run_id: RUN_ID,
      phase: "builder-wave",
      pid: process.pid,
      last_tick_at: new Date().toISOString(),
      interval_ms: 1000,
    });
    mkdirSync(join(runDir, "gates"), { recursive: true });
    writeFileSync(join(runDir, "gates", "rejected.question.md"), "not accepted\n");

    try {
      const beforeRunJson = readFileSync(join(runDir, "run.json"));
      const beforeTree = snapshotTree(runDir);
      const proc = runCostReport(repo, [RUN_ID, "--json"]);

      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(proc.stderr, "");
      const report = JSON.parse(proc.stdout);
      assert.equal(report.schema_version, 1);
      assert.equal(report.run_id, RUN_ID);
      assert.equal(report.status, "partial");
      assert.equal(report.entry_count, 2);
      assert.equal(report.agent_count, 2);
      assert.equal(report.step_count, 1);
      assert.equal(report.slice_count, 1);
      assert.equal(report.unattributed_step_entry_count, 1);
      assert.equal(report.totals.total_tokens, 12);
      assert.equal(report.by_agent["backend-builder"].cost_total, 0.1);
      assert.equal(report.by_step.build.entry_count, 1);
      assert.equal(report.by_slice.core.entry_count, 1);
      assert.deepEqual(readFileSync(join(runDir, "run.json")), beforeRunJson);
      assert.deepEqual(snapshotTree(runDir), beforeTree);
    } finally {
      cleanup(repo);
    }
  });

  it("prints the human contract and uses the run directory basename as canonical run_id", () => {
    const repo = tempRepo();
    seedRun(repo, populatedRun());

    try {
      const proc = runCostReport(repo, [RUN_ID]);

      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, new RegExp(`^Cost report for ${RUN_ID}\\nTotals:`, "u"));
      assert.match(proc.stdout, /By agent \(2\):/u);
      assert.match(proc.stdout, /By step \(1; unattributed entries=1\):/u);
      assert.match(proc.stdout, /By slice \(1\):/u);
      assert.match(proc.stdout, /"backend-builder": status=available/u);
      assert.doesNotMatch(proc.stdout, /wrong-run-id/u);
    } finally {
      cleanup(repo);
    }
  });

  it("redacts credentials and encodes controls in human and JSON cost output", () => {
    const repo = tempRepo();
    const secret = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
    seedRun(repo, { cost_attribution: { entries: [availableEntry({
      agent: `Authorization: Basic ${secret}`,
      step: "build\u001B]0;pwned\u0007",
      slice_id: "slice\u202Ehidden",
    })] } });
    try {
      for (const args of [[RUN_ID], [RUN_ID, "--json"]]) {
        const proc = runCostReportSuccess(repo, args);
        assert.doesNotMatch(proc.stdout, new RegExp(secret, "u"));
        assert.doesNotMatch(proc.stdout, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E]/u);
        assert.match(proc.stdout, /\[redacted\]|\\u001B/u);
      }
    } finally {
      cleanup(repo);
    }
  });

  it("returns well-formed unavailable reports for absent and empty attribution", () => {
    for (const [name, attribution] of [
      ["absent", undefined],
      ["null", null],
      ["empty-object", {}],
      ["null-entries", { entries: null }],
      ["empty-entries", { entries: [] }],
    ]) {
      const repo = tempRepo();
      const run = { deliberately: "not a full run" };
      if (name !== "absent") run.cost_attribution = attribution;
      seedRun(repo, run);
      try {
        const json = JSON.parse(runCostReportSuccess(repo, [RUN_ID, "--json"]).stdout);
        assert.equal(json.status, "unavailable", name);
        assert.equal(json.entry_count, 0, name);
        assert.deepEqual(json.by_agent, {}, name);
        assert.deepEqual(json.by_step, {}, name);
        assert.deepEqual(json.by_slice, {}, name);

        const human = runCostReportSuccess(repo, [RUN_ID]).stdout;
        assert.match(human, /status=unavailable \| entries=0 \| requests=0/u, name);
        assert.equal((human.match(/  \(none\)/gu) || []).length, 3, name);
      } finally {
        cleanup(repo);
      }
    }
  });

  it("rejects malformed run IDs before shared resolution", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".opencode", "factory"), { recursive: true });
    try {
      for (const runId of [".", "..", "/tmp/run", "dir/run", "dir\\run"]) {
        const proc = runCostReport(repo, [runId, "--json"]);
        assert.notEqual(proc.status, 0, runId);
        assert.equal(proc.stdout, "", runId);
        assert.match(proc.stderr, /error: factory cost-report requires a bare <run-id>, not a filesystem path/u, runId);
      }
      for (const runId of ["bad id", "bad..id", "bad.lock", "-bad", "bad-", ` ${RUN_ID} `]) {
        const proc = runCostReport(repo, [runId, "--json"]);
        assert.notEqual(proc.status, 0, runId);
        assert.equal(proc.stdout, "", runId);
        assert.match(proc.stderr, /error: factory cost-report requires a safe <run-id> using letters, digits, "\.", "_", or "-"/u, runId);
      }

      for (const args of [[], [RUN_ID, "extra"]]) {
        const proc = runCostReport(repo, args);
        assert.notEqual(proc.status, 0);
        assert.equal(proc.stdout, "");
        assert.match(proc.stderr, /error: factory cost-report requires exactly one <run-id>/u);
      }
    } finally {
      cleanup(repo);
    }
  });

  it("rejects flags outside the cost-report command contract", () => {
    const repo = tempRepo();
    seedRun(repo, populatedRun());
    try {
      for (const args of [[RUN_ID, "--force"], [RUN_ID, "--model", "openai/gpt-5.6-sol"]]) {
        const proc = runCostReport(repo, args);
        assertFailure(proc, /factory cost-report does not support --(?:force|model)/u);
      }
    } finally {
      cleanup(repo);
    }
  });

  it("rejects escaped run directories, malformed files, and invalid attribution with no partial stdout", () => {
    const repo = tempRepo();
    const external = tempRepo();
    mkdirSync(join(repo, ".opencode", "factory"), { recursive: true });
    try {
      const missing = runCostReport(repo, ["missing", "--json"]);
      assertFailure(missing, /run not found: missing/u);

      let runDir = seedRun(repo, populatedRun());
      writeFileSync(join(runDir, "run.json"), "not json\n");
      assertFailure(runCostReport(repo, [RUN_ID, "--json"]), /run\.json must be valid JSON:/u);

      writeFileSync(join(runDir, "run.json"), "[]\n");
      assertFailure(runCostReport(repo, [RUN_ID, "--json"]), /run\.json must contain an object/u);

      writeJson(join(runDir, "run.json"), { cost_attribution: [] });
      assertFailure(runCostReport(repo, [RUN_ID, "--json"]), /run\.json\.cost_attribution must be an object, null, or absent/u);

      writeJson(join(runDir, "run.json"), { cost_attribution: { entries: {} } });
      assertFailure(runCostReport(repo, [RUN_ID, "--json"]), /run\.json\.cost_attribution\.entries must be an array, null, or absent/u);

      writeJson(join(runDir, "run.json"), { cost_attribution: { entries: [availableEntry({ run_id: "other" })] } });
      assertFailure(runCostReport(repo, [RUN_ID, "--json"]), /run\.cost_attribution\.entries\[0\]\.run_id: must match run\.run_id/u);

      const outsideFile = join(external, "outside.json");
      writeJson(outsideFile, populatedRun());
      rmSync(join(runDir, "run.json"));
      symlinkSync(outsideFile, join(runDir, "run.json"));
      assertFailure(runCostReport(repo, [RUN_ID, "--json"]), /run\.json must be a regular file inside the run directory/u);
      rmSync(join(runDir, "run.json"));
      writeJson(join(runDir, "run.json"), populatedRun());

      const outsideRun = join(external, RUN_ID);
      mkdirSync(outsideRun, { recursive: true });
      writeJson(join(outsideRun, "run.json"), populatedRun());
      rmSync(runDir, { recursive: true, force: true });
      symlinkSync(outsideRun, runDir, "dir");
      assertFailure(runCostReport(repo, [RUN_ID, "--json"]), /heartbeat run directory must be inside \.opencode\/factory/u);
    } finally {
      cleanup(repo);
      cleanup(external);
    }
  });

  it("rejects aggregate overflow with no partial stdout or filesystem mutation", () => {
    const repo = tempRepo();
    const runDir = seedRun(repo, { cost_attribution: { entries: [
      availableEntry({ id: "one", step: "build", input_tokens: Number.MAX_VALUE }),
      availableEntry({ id: "two", step: "build", input_tokens: Number.MAX_VALUE }),
    ] } });
    try {
      const beforeRunJson = readFileSync(join(runDir, "run.json"));
      const beforeTree = snapshotTree(runDir);
      const proc = runCostReport(repo, [RUN_ID, "--json"]);

      assertFailure(proc, /cost attribution aggregate overflow for input_tokens/u);
      assert.deepEqual(readFileSync(join(runDir, "run.json")), beforeRunJson);
      assert.deepEqual(snapshotTree(runDir), beforeTree);
    } finally {
      cleanup(repo);
    }
  });

  it("keeps telemetry off by default and validates explicit inherited correlation", () => {
    const repo = tempRepo();
    seedRun(repo, { cost_attribution: { entries: [] } });
    try {
      const plain = runCostReportSuccess(repo, [RUN_ID, "--json"]).stdout;
      const ambient = runCostReportSuccess(repo, [RUN_ID, "--json"], {
        FEATURE_FACTORY_TRACEPARENT: TRACEPARENT,
        FEATURE_FACTORY_PARENT_SPAN_ID: "00f067aa0ba902b7",
      }).stdout;
      assert.equal(ambient, plain);

      const correlated = JSON.parse(runCostReportSuccess(repo, [RUN_ID, "--json", "--telemetry"], {
        FEATURE_FACTORY_TRACEPARENT: TRACEPARENT.toUpperCase(),
        TRACEPARENT,
        FEATURE_FACTORY_PARENT_SPAN_ID: "00F067AA0BA902B7",
        TRACESTATE: "secret=value",
      }).stdout);
      assert.deepEqual(correlated.telemetry, {
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        parent_span_id: "00f067aa0ba902b7",
      });
      assert.doesNotMatch(JSON.stringify(correlated), /traceparent|tracestate/u);

      const noContext = JSON.parse(runCostReportSuccess(repo, [RUN_ID, "--json", "--telemetry"]).stdout);
      assert.equal(Object.hasOwn(noContext, "telemetry"), false);

      assertFailure(
        runCostReport(repo, [RUN_ID, "--telemetry"], { TRACEPARENT: "invalid" }),
        /cost-report telemetry: traceparent must match W3C format/u,
      );
      assertFailure(
        runCostReport(repo, [RUN_ID, "--telemetry"], {
          TRACEPARENT,
          FEATURE_FACTORY_TRACEPARENT: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        }),
        /cost-report telemetry: FEATURE_FACTORY_TRACEPARENT and TRACEPARENT must match/u,
      );
    } finally {
      cleanup(repo);
    }
  });

  it("makes zero connections to advertised OTLP endpoints", async () => {
    const repo = tempRepo();
    const owner = createTrackedProcessCleanup();
    seedRun(repo, { cost_attribution: { entries: [] } });
    const server = createServer();
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${server.address().port}`;

    try {
      const proc = await runCostReportAsync(owner, repo, [RUN_ID, "--json", "--telemetry"], {
        FEATURE_FACTORY_TRACEPARENT: TRACEPARENT,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
      });
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(JSON.parse(proc.stdout).telemetry.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
      assert.equal(connections, 0);
    } finally {
      await owner.cleanup().catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
      cleanup(repo);
    }
  });

  it("retains shared option parser errors", () => {
    const repo = tempRepo();
    try {
      assertFailure(runCostReport(repo, [RUN_ID, "--unknown"]), /unknown option: --unknown/u);
      const missingRepo = spawnSync(process.execPath, [CLI, "factory", "cost-report", RUN_ID, "--repo"], {
        cwd: repo,
        encoding: "utf8",
        env: cleanEnv(),
      });
      assertFailure(missingRepo, /--repo requires a value/u);

      for (const option of [
        `--unknown\u001B]0;pwned\u0007`,
        `--unknown\u001B[2J`,
        `--unknown\u009B2J`,
        `--unknown\u202Ehidden`,
      ]) {
        const proc = runCostReport(repo, [RUN_ID, option]);
        assertFailure(proc, /unknown option: --unknown/u);
        assert.match(proc.stderr, /\\u(?:001B|009B|202E)/u);
        assert.doesNotMatch(proc.stderr, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u);
      }
    } finally {
      cleanup(repo);
    }
  });
});

function populatedRun() {
  return {
    run_id: "wrong-run-id",
    status: "running",
    gates: { story: { status: "pending" }, brief: { status: "changes_requested" } },
    steps: [{ agent: "story-reader", status: "rejected" }],
    slices: [{ id: "core", status: "review" }],
    cost_attribution: {
      status: "available",
      totals: { entry_count: 999 },
      by_agent: { stale: { entry_count: 999 } },
      entries: [
        availableEntry(),
        {
          id: "partial-entry",
          recorded_at: "2026-07-08T12:01:00.000Z",
          run_id: RUN_ID,
          agent: "test-verifier",
          status: "partial",
          missing: ["usage", "cost_total"],
        },
      ],
    },
  };
}

function availableEntry(overrides = {}) {
  return {
    id: "available-entry",
    recorded_at: "2026-07-08T12:00:00.000Z",
    run_id: RUN_ID,
    agent: "backend-builder",
    step: "build",
    slice_id: "core",
    provider: "unknown-provider",
    model: "unknown-model",
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    cost_total: 0.1,
    cost_currency: "USD",
    status: "available",
    missing: [],
    ...overrides,
  };
}

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-cli-cost-report-"));
}

function seedRun(repo, run) {
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), run);
  return runDir;
}

function runCostReportSuccess(repo, args, extraEnv = {}) {
  const proc = runCostReport(repo, args, extraEnv);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc;
}

function runCostReport(repo, args, extraEnv = {}) {
  const proc = spawnSync(process.execPath, [CLI, "factory", "cost-report", ...args, "--repo", repo], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv(extraEnv),
    timeout: CLI_TIMEOUT_MS,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function runCostReportAsync(owner, repo, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = owner.spawn(process.execPath, [CLI, "factory", "cost-report", ...args, "--repo", repo], {
      cwd: repo,
      env: cleanEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    }, { label: "factory cost-report" });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      const error = new Error(`factory cost-report result collection timed out after ${CLI_TIMEOUT_MS}ms`);
      error.code = "CLI_RESULT_TIMEOUT";
      reject(error);
    }, CLI_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.FEATURE_FACTORY_TRACEPARENT;
  delete env.TRACEPARENT;
  delete env.FEATURE_FACTORY_PARENT_SPAN_ID;
  return { ...env, ...extra };
}

function assertFailure(proc, pattern) {
  assert.notEqual(proc.status, 0, proc.stdout || proc.stderr);
  assert.equal(proc.stdout, "");
  assert.match(proc.stderr, pattern);
}

function snapshotTree(root) {
  const snapshot = {};
  visit(root);
  return snapshot;

  function visit(path) {
    const name = relative(root, path) || ".";
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      snapshot[name] = { type: "symlink", target: readlinkSync(path) };
      return;
    }
    if (stat.isDirectory()) {
      snapshot[name] = { type: "directory" };
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    snapshot[name] = { type: "file", bytes: readFileSync(path).toString("base64") };
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
