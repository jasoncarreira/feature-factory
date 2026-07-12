import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { discoverCleanupSweepCandidates } from "../src/cleanup-sweep-eligibility.js";
import { createCleanupSweepFixture, snapshotTree, writeJson } from "./helpers/cleanup-sweep-fixture.js";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");

test("returns a successful empty candidate set when the selected repository factory root is absent", () => {
  const fixture = createCleanupSweepFixture("absent");
  try {
    rmSync(fixture.factoryRoot, { recursive: true });
    assert.deepEqual(discoverCleanupSweepCandidates(fixture.repo), {
      factory_root: fixture.factoryRoot,
      candidates: [],
      temporary_refs: [],
    });
  } finally { fixture.cleanup(); }
});

test("discovers only direct-root entries and does not mutate cleanup targets", () => {
  const fixture = createCleanupSweepFixture("direct-root");
  try {
    fixture.addRun("direct");
    const nested = join(fixture.factoryRoot, "container", "nested");
    mkdirSync(nested, { recursive: true });
    writeJson(join(nested, "run.json"), { run_id: "nested", status: "running" });
    const before = snapshotTree(fixture.factoryRoot);
    const result = inspect(fixture);
    assert.deepEqual(result.candidates.map((item) => item.entry_name), ["container", "direct"]);
    assert.equal(result.candidates[0].reason_codes.includes("SKIPPED_PRE_MANIFEST"), true);
    assert.deepEqual(snapshotTree(fixture.factoryRoot), before);
  } finally { fixture.cleanup(); }
});

test("R03-R06 classify unsafe, pre-manifest, invalid, and mismatched entries", () => {
  const fixture = createCleanupSweepFixture("entry-state");
  try {
    writeFileSync(join(fixture.factoryRoot, "file"), "not a run");
    mkdirSync(join(fixture.factoryRoot, "pre"));
    mkdirSync(join(fixture.factoryRoot, "bad"));
    writeFileSync(join(fixture.factoryRoot, "bad", "run.json"), "{");
    fixture.addRun("wrong");
    const wrong = fixture.readRun("wrong"); wrong.run_id = "other"; wrong.terminal_result.run_id = "other"; fixture.writeRun("wrong", wrong);
    const byName = candidatesByName(inspect(fixture));
    assert.deepEqual(byName.file.reason_codes, ["SKIPPED_UNSAFE_ENTRY"]);
    assert.deepEqual(byName.pre.reason_codes, ["SKIPPED_PRE_MANIFEST"]);
    assert.deepEqual(byName.bad.reason_codes, ["SKIPPED_INVALID_RUN_STATE"]);
    assert.deepEqual(byName.wrong.reason_codes, ["SKIPPED_RUN_ID_MISMATCH"]);
  } finally { fixture.cleanup(); }
});

test("R07-R10 protect every recoverable status and skip running without external lookup", () => {
  const fixture = createCleanupSweepFixture("statuses");
  try {
    for (const status of ["blocked", "partial", "needs-human"]) {
      fixture.addRun(status, { status, terminal_result: { status, run_id: status, pr_url: null, reason: "recoverable", artifacts: {} } });
    }
    fixture.addRun("running", { status: "running", terminal_result: undefined });
    let calls = 0;
    const result = discoverCleanupSweepCandidates(fixture.repo, { gitRunner: fixture.gitRunner, githubRunner: () => { calls += 1; throw new Error("must not lookup"); } });
    const byName = candidatesByName(result);
    assert.deepEqual(byName.blocked.reason_codes, ["PROTECTED_STATUS_BLOCKED"]);
    assert.deepEqual(byName.partial.reason_codes, ["PROTECTED_STATUS_PARTIAL"]);
    assert.deepEqual(byName["needs-human"].reason_codes, ["PROTECTED_STATUS_NEEDS_HUMAN"]);
    assert.deepEqual(byName.running.reason_codes, ["SKIPPED_NON_TERMINAL_STATUS"]);
    assert.equal(calls, 0);
  } finally { fixture.cleanup(); }
});

test("R11 completes raw claim inventory before validation and skips every completed claimant", () => {
  const fixture = createCleanupSweepFixture("claims");
  try {
    fixture.addRun("one", { branch: "shared" });
    fixture.addRun("two", { branch: "shared" });
    const byName = candidatesByName(inspect(fixture));
    assert.equal(byName.one.reason_codes.includes("SHARED_TARGET_CLAIM"), true);
    assert.equal(byName.two.reason_codes.includes("SHARED_TARGET_CLAIM"), true);
    assert.equal(byName.one.classification, "skipped");
  } finally { fixture.cleanup(); }
});

test("R12-R22 classify lock, heartbeat, process, and run-lock evidence fail closed", async (t) => {
  const cases = [
    ["neutral factory lock", ({ fixture, runDir }) => writeJson(join(runDir, "factory.lock"), { schema_version: 1, run_id: "run" }), "eligible", "ELIGIBLE", {}],
    ["invalid factory lock", ({ runDir }) => writeJson(join(runDir, "factory.lock"), { nope: true }), "skipped", "SKIPPED_FACTORY_LOCK_INVALID", {}],
    ["fresh heartbeat", ({ runDir }) => writeJson(join(runDir, "heartbeat.json"), heartbeat("run", NOW)), "protected", "PROTECTED_FRESH_HEARTBEAT", {}],
    ["stale heartbeat", ({ runDir }) => writeJson(join(runDir, "heartbeat.json"), heartbeat("run", NOW - 300_000)), "eligible", "ELIGIBLE", {}],
    ["mismatched heartbeat", ({ runDir }) => writeJson(join(runDir, "heartbeat.json"), heartbeat("other", NOW)), "skipped", "SKIPPED_HEARTBEAT_UNCERTAIN", {}],
    ["live process", () => {}, "protected", "PROTECTED_LIVE_PROCESS", { inspectProcess: () => ({ state: "live-matching" }) }],
    ["indeterminate process", () => {}, "skipped", "SKIPPED_PROCESS_UNCERTAIN", { inspectProcess: () => ({ state: "indeterminate" }) }],
    ["preview lock", ({ runDir }) => mkdirSync(join(runDir, "run-json.lock")), "skipped", "SKIPPED_RUN_LOCK_PRESENT_PREVIEW", {}],
    ["unsafe lock", ({ runDir }) => writeFileSync(join(runDir, "run-json.lock"), "bad"), "skipped", "SKIPPED_RUN_LOCK_INVALID", {}],
  ];
  for (const [name, arrange, classification, reason, options] of cases) await t.test(name, () => {
    const fixture = createCleanupSweepFixture(`liveness-${name.replaceAll(" ", "-")}`);
    try {
      const { runDir } = fixture.addRun("run"); arrange({ fixture, runDir });
      const candidate = inspect(fixture, options).candidates[0];
      assert.equal(candidate.classification, classification);
      assert.equal(candidate.reason_codes.includes(reason), true);
    } finally { fixture.cleanup(); }
  });
});

test("R24-R28 require exact closed PR metadata and a freshly fetched exact base", async (t) => {
  const cases = [
    ["metadata mismatch", ({ fixture }) => { const run = fixture.readRun("run"); run.pr_url = null; fixture.writeRun("run", run); }, "SKIPPED_PR_METADATA_MISMATCH", {}],
    ["lookup unavailable", () => {}, "SKIPPED_PR_LOOKUP_UNCERTAIN", { githubRunner: () => ({ ok: false, status: 1, stdout: "" }) }],
    ["open", () => {}, "SKIPPED_PR_OPEN", { github: { state: "open", merged: false } }],
    ["base fetch failure", () => {}, "SKIPPED_BASE_UNPROVABLE", { gitRunner: (_cwd, args) => args[0] === "fetch" ? { ok: false, status: 1, stdout: "" } : null }],
  ];
  for (const [name, arrange, reason, variant] of cases) await t.test(name, () => {
    const fixture = createCleanupSweepFixture(`pr-${name.replaceAll(" ", "-")}`);
    try {
      fixture.addRun("run"); arrange({ fixture });
      const githubRunner = variant.github ? githubVariant(fixture, variant.github) : variant.githubRunner ?? fixture.githubRunner;
      const gitRunner = variant.gitRunner ? fallbackRunner(variant.gitRunner, fixture.gitRunner) : fixture.gitRunner;
      const candidate = inspect(fixture, { githubRunner, gitRunner }).candidates[0];
      assert.equal(candidate.reason_codes.includes(reason), true);
    } finally { fixture.cleanup(); }
  });
});

test("R29-R35 classify branch safety, presence, checkout, ancestry, and exact ancestors", async (t) => {
  const cases = [
    ["no branches", { branch: null }, "ELIGIBLE"],
    ["unsafe", { branch: "bad branch" }, "SKIPPED_BRANCH_UNSAFE"],
    ["missing", { branch: "missing", noCreate: true }, "SKIPPED_BRANCH_MISSING"],
    ["current", { branch: "main" }, "SKIPPED_BRANCH_CHECKED_OUT"],
    ["unmerged", { branch: "run", ancestry: 1 }, "SKIPPED_BRANCH_UNMERGED"],
    ["unprovable", { branch: "run", ancestry: 2 }, "SKIPPED_BRANCH_UNPROVABLE"],
    ["ancestor", { branch: "run" }, "ELIGIBLE"],
  ];
  for (const [name, setup, reason] of cases) await t.test(name, () => {
    const fixture = createCleanupSweepFixture(`branch-${name}`);
    try {
      fixture.addRun("run", { branch: setup.branch });
      if (setup.noCreate) fixture.gitRunner(fixture.repo, ["branch", "-D", "missing"]);
      const runner = setup.ancestry ? fallbackRunner((_cwd, args) => args[0] === "merge-base" ? { ok: false, status: setup.ancestry, stdout: "" } : null, fixture.gitRunner) : fixture.gitRunner;
      const candidate = inspect(fixture, { gitRunner: runner }).candidates[0];
      assert.equal(candidate.reason_codes.includes(reason), true);
    } finally { fixture.cleanup(); }
  });
});

test("R36-R41 verify recorded worktree containment, registration, branch/head identity, and eligibility", async (t) => {
  await t.test("verified identity is eligible", () => {
    const fixture = createCleanupSweepFixture("worktree-ok");
    try { fixture.addRun("run"); fixture.addRecordedWorktree("run"); assert.equal(inspect(fixture).candidates[0].classification, "eligible"); }
    finally { fixture.cleanup(); }
  });
  await t.test("outside root is unsafe", () => {
    const fixture = createCleanupSweepFixture("worktree-outside");
    try { fixture.addRun("run", { worktree: join(fixture.root, "outside") }); assert.equal(inspect(fixture).candidates[0].reason_codes.includes("SKIPPED_WORKTREE_UNSAFE"), true); }
    finally { fixture.cleanup(); }
  });
  await t.test("missing and unregistered worktrees skip", () => {
    const fixture = createCleanupSweepFixture("worktree-missing");
    try {
      fixture.addRun("run", { worktree: join(fixture.worktreeRoot, "run") });
      assert.equal(inspect(fixture).candidates[0].reason_codes.includes("SKIPPED_WORKTREE_MISSING"), true);
      mkdirSync(join(fixture.worktreeRoot, "run"));
      assert.equal(inspect(fixture).candidates[0].reason_codes.includes("SKIPPED_WORKTREE_UNREGISTERED"), true);
    } finally { fixture.cleanup(); }
  });
});

test("R52 turns an unexpected per-entry inspection exception into FAILED_INSPECTION", () => {
  const fixture = createCleanupSweepFixture("inspection-failure");
  try {
    fixture.addRun("run");
    const result = inspect(fixture, { gitRunner: () => { throw new Error("injected"); } });
    assert.equal(result.candidates[0].classification, "failed");
    assert.deepEqual(result.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
    assert.equal(result.candidates[0].failure_stage, "inspection");
  } finally { fixture.cleanup(); }
});

function inspect(fixture, options = {}) {
  return discoverCleanupSweepCandidates(fixture.repo, {
    invocationId: "00000000-0000-4000-8000-000000000001",
    clock: () => NOW,
    githubRunner: options.githubRunner ?? fixture.githubRunner,
    gitRunner: options.gitRunner ?? fixture.gitRunner,
    ...options,
  });
}
function candidatesByName(result) { return Object.fromEntries(result.candidates.map((candidate) => [candidate.entry_name, candidate])); }
function heartbeat(runId, lastTick) { return { schema_version: 1, run_id: runId, phase: "builder-wave", pid: 123, interval_ms: 30_000, last_tick_at: new Date(lastTick).toISOString() }; }
function fallbackRunner(primary, fallback) { return (cwd, args, options) => primary(cwd, args, options) ?? fallback(cwd, args, options); }
function githubVariant(fixture, changes) {
  return (...args) => {
    const result = fixture.githubRunner(...args);
    const body = JSON.parse(result.stdout);
    return { ...result, stdout: JSON.stringify({ ...body, ...changes }) };
  };
}
