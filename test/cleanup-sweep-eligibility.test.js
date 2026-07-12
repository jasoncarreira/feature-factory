import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("R03-R06 cover symlinked entries and every deterministic invalid manifest form", () => {
  const fixture = createCleanupSweepFixture("entry-variants");
  try {
    symlinkSync(fixture.worktreeRoot, join(fixture.factoryRoot, "entry-link"));
    mkdirSync(join(fixture.factoryRoot, "manifest-link"));
    symlinkSync(join(fixture.repo, "README.md"), join(fixture.factoryRoot, "manifest-link", "run.json"));
    mkdirSync(join(fixture.factoryRoot, "manifest-array"));
    writeJson(join(fixture.factoryRoot, "manifest-array", "run.json"), []);
    mkdirSync(join(fixture.factoryRoot, "manifest-schema"));
    writeJson(join(fixture.factoryRoot, "manifest-schema", "run.json"), { run_id: "manifest-schema", status: "unknown" });
    const byName = candidatesByName(inspect(fixture));
    assert.deepEqual(byName["entry-link"].reason_codes, ["SKIPPED_UNSAFE_ENTRY"]);
    assert.deepEqual(byName["manifest-link"].reason_codes, ["SKIPPED_INVALID_RUN_STATE"]);
    assert.deepEqual(byName["manifest-array"].reason_codes, ["SKIPPED_INVALID_RUN_STATE"]);
    assert.deepEqual(byName["manifest-schema"].reason_codes, ["SKIPPED_INVALID_RUN_STATE"]);
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

test("R11 applies branch and worktree collisions from invalid raw manifests to every claimant", () => {
  const fixture = createCleanupSweepFixture("raw-claim-collisions");
  try {
    const sharedWorktree = join(fixture.worktreeRoot, "shared");
    fixture.addRun("valid", { branch: "shared", worktree: sharedWorktree });
    fixture.addRun("invalid", { branch: "shared", worktree: sharedWorktree, status: "unknown" });
    const byName = candidatesByName(inspect(fixture));
    assert.deepEqual(byName.valid.reason_codes, ["SHARED_TARGET_CLAIM"]);
    assert.deepEqual(byName.invalid.reason_codes, ["SKIPPED_INVALID_RUN_STATE", "SHARED_TARGET_CLAIM"]);
  } finally { fixture.cleanup(); }
});

test("R12-R22 classify lock, heartbeat, process, and run-lock evidence fail closed", async (t) => {
  const cases = [
    ["neutral factory lock", ({ fixture, runDir }) => writeJson(join(runDir, "factory.lock"), { schema_version: 1, run_id: "run" }), "eligible", "ELIGIBLE", {}],
    ["invalid factory lock", ({ runDir }) => writeJson(join(runDir, "factory.lock"), { nope: true }), "skipped", "SKIPPED_FACTORY_LOCK_INVALID", {}],
    ["mismatched factory lock", ({ runDir }) => writeJson(join(runDir, "factory.lock"), { schema_version: 1, run_id: "other" }), "skipped", "SKIPPED_FACTORY_LOCK_INVALID", {}],
    ["symlinked factory lock", ({ fixture, runDir }) => symlinkSync(join(fixture.repo, "README.md"), join(runDir, "factory.lock")), "skipped", "SKIPPED_FACTORY_LOCK_INVALID", {}],
    ["fresh heartbeat", ({ runDir }) => writeJson(join(runDir, "heartbeat.json"), heartbeat("run", NOW)), "protected", "PROTECTED_FRESH_HEARTBEAT", {}],
    ["stale heartbeat", ({ runDir }) => writeJson(join(runDir, "heartbeat.json"), heartbeat("run", NOW - 300_000)), "eligible", "ELIGIBLE", {}],
    ["mismatched heartbeat", ({ runDir }) => writeJson(join(runDir, "heartbeat.json"), heartbeat("other", NOW)), "skipped", "SKIPPED_HEARTBEAT_UNCERTAIN", {}],
    ["malformed heartbeat", ({ runDir }) => writeFileSync(join(runDir, "heartbeat.json"), "{"), "skipped", "SKIPPED_HEARTBEAT_UNCERTAIN", {}],
    ["future heartbeat", ({ runDir }) => writeJson(join(runDir, "heartbeat.json"), heartbeat("run", NOW + 60_000)), "skipped", "SKIPPED_HEARTBEAT_UNCERTAIN", {}],
    ["absent process", () => {}, "eligible", "ELIGIBLE", { inspectProcess: () => ({ state: "absent" }) }],
    ["live process", () => {}, "protected", "PROTECTED_LIVE_PROCESS", { inspectProcess: () => ({ state: "live-matching" }) }],
    ["mismatched process", () => {}, "skipped", "SKIPPED_PROCESS_UNCERTAIN", { inspectProcess: () => ({ state: "mismatched" }) }],
    ["invalid process", () => {}, "skipped", "SKIPPED_PROCESS_UNCERTAIN", { inspectProcess: () => ({ state: "invalid" }) }],
    ["indeterminate process", () => {}, "skipped", "SKIPPED_PROCESS_UNCERTAIN", { inspectProcess: () => ({ state: "indeterminate" }) }],
    ["preview lock", ({ runDir }) => mkdirSync(join(runDir, "run-json.lock")), "skipped", "SKIPPED_RUN_LOCK_PRESENT_PREVIEW", {}],
    ["contended execution lock", ({ runDir }) => mkdirSync(join(runDir, "run-json.lock")), "skipped", "SKIPPED_RUN_LOCK_CONTENDED", { runLockContended: true }],
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

test("R07-R23 retain all ordered protected and uncertain local evidence", () => {
  const fixture = createCleanupSweepFixture("coexisting-reasons");
  try {
    const { runDir } = fixture.addRun("run", {
      status: "blocked",
      terminal_result: { status: "blocked", run_id: "run", pr_url: null, reason: "recoverable", artifacts: {} },
    });
    writeJson(join(runDir, "factory.lock"), { nope: true });
    writeJson(join(runDir, "heartbeat.json"), heartbeat("run", NOW));
    mkdirSync(join(runDir, "run-json.lock"));
    const candidate = inspect(fixture, { inspectProcess: () => ({ state: "indeterminate" }) }).candidates[0];
    assert.equal(candidate.classification, "protected");
    assert.deepEqual(candidate.reason_codes, [
      "PROTECTED_STATUS_BLOCKED",
      "SKIPPED_FACTORY_LOCK_INVALID",
      "PROTECTED_FRESH_HEARTBEAT",
      "SKIPPED_PROCESS_UNCERTAIN",
      "SKIPPED_RUN_LOCK_PRESENT_PREVIEW",
    ]);
  } finally { fixture.cleanup(); }
});

test("R14-R19 retain active-owner, heartbeat, and live-process reasons together", () => {
  const fixture = createCleanupSweepFixture("active-owner-reasons");
  try {
    const { runDir } = fixture.addRun("run");
    writeJson(join(runDir, "factory.lock"), { schema_version: 1, run_id: "run" });
    writeJson(join(runDir, "heartbeat.json"), heartbeat("run", NOW));
    const candidate = inspect(fixture, { inspectProcess: () => ({ state: "live-matching" }) }).candidates[0];
    assert.equal(candidate.classification, "protected");
    assert.deepEqual(candidate.reason_codes, ["PROTECTED_ACTIVE_FACTORY_OWNER", "PROTECTED_FRESH_HEARTBEAT", "PROTECTED_LIVE_PROCESS"]);
  } finally { fixture.cleanup(); }
});

test("R24-R28 require exact closed PR metadata and a freshly fetched exact base", async (t) => {
  const cases = [
    ["metadata mismatch", ({ fixture }) => { const run = fixture.readRun("run"); run.pr_url = null; fixture.writeRun("run", run); }, "SKIPPED_PR_METADATA_MISMATCH", {}],
    ["terminal tuple mismatch", ({ fixture }) => { const run = fixture.readRun("run"); run.terminal_result.pr_number = 8; fixture.writeRun("run", run); }, "SKIPPED_PR_METADATA_MISMATCH", {}],
    ["lookup unavailable", () => {}, "SKIPPED_PR_LOOKUP_UNCERTAIN", { githubRunner: () => ({ ok: false, status: 1, stdout: "" }) }],
    ["malformed response", () => {}, "SKIPPED_PR_LOOKUP_UNCERTAIN", { githubRunner: () => ({ ok: true, status: 0, stdout: "{" }) }],
    ["response tuple mismatch", () => {}, "SKIPPED_PR_LOOKUP_UNCERTAIN", { github: { number: 8 } }],
    ["open", () => {}, "SKIPPED_PR_OPEN", { github: { state: "open", merged: false } }],
    ["invalid base ref", () => {}, "SKIPPED_BASE_UNPROVABLE", { github: { base: { ref: "bad ref" } } }],
    ["base fetch failure", () => {}, "SKIPPED_BASE_UNPROVABLE", { gitRunner: (_cwd, args) => args[0] === "fetch" ? { ok: false, status: 1, stdout: "" } : null }],
    ["base oid mismatch", () => {}, "SKIPPED_BASE_UNPROVABLE", { gitRunner: (_cwd, args) => args[0] === "rev-parse" && String(args[2]).startsWith("refs/feature-factory/") ? { ok: true, status: 0, stdout: `${"f".repeat(40)}\n` } : null }],
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

test("R32 rejects a branch checked out in an unrecorded worktree", () => {
  const fixture = createCleanupSweepFixture("branch-unrecorded-checkout");
  try {
    fixture.addRun("run");
    fixture.addRegisteredWorktree("outside", "run", fixture.root);
    const candidate = inspect(fixture).candidates[0];
    assert.deepEqual(candidate.reason_codes, ["SKIPPED_BRANCH_CHECKED_OUT"]);
    assert.equal(candidate.evidence.branches[0].state, "checked-out-unrecorded");
  } finally { fixture.cleanup(); }
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
  await t.test("symlinked and non-directory worktrees skip", () => {
    const fixture = createCleanupSweepFixture("worktree-unsafe-types");
    try {
      const worktree = join(fixture.worktreeRoot, "run");
      fixture.addRun("run", { worktree });
      symlinkSync(fixture.root, worktree);
      assert.deepEqual(inspect(fixture).candidates[0].reason_codes, ["SKIPPED_WORKTREE_UNSAFE"]);
      unlinkSync(worktree);
      writeFileSync(worktree, "not a directory");
      assert.deepEqual(inspect(fixture).candidates[0].reason_codes, ["SKIPPED_WORKTREE_MISSING"]);
    } finally { fixture.cleanup(); }
  });
  await t.test("registered branch and head mismatches skip", () => {
    const fixture = createCleanupSweepFixture("worktree-identity-mismatch");
    try {
      fixture.addRun("run");
      fixture.addRecordedWorktree("run");
      const branchRunner = fallbackRunner((_cwd, args) => {
        if (args[0] !== "worktree") return null;
        const listed = fixture.gitRunner(fixture.repo, args);
        return { ...listed, stdout: listed.stdout.replace("branch refs/heads/run", "branch refs/heads/main") };
      }, fixture.gitRunner);
      assert.deepEqual(inspect(fixture, { gitRunner: branchRunner }).candidates[0].reason_codes, ["SKIPPED_WORKTREE_IDENTITY"]);
      const headRunner = fallbackRunner((_cwd, args) => {
        if (args[0] !== "worktree") return null;
        const listed = fixture.gitRunner(fixture.repo, args);
        const blocks = listed.stdout.split("\n\n").map((block) => block.includes(`worktree ${join(fixture.worktreeRoot, "run")}`)
          ? block.replace(/^HEAD [0-9a-f]+$/mu, `HEAD ${"f".repeat(40)}`)
          : block);
        return { ...listed, stdout: blocks.join("\n\n") };
      }, fixture.gitRunner);
      assert.deepEqual(inspect(fixture, { gitRunner: headRunner }).candidates[0].reason_codes, ["SKIPPED_WORKTREE_IDENTITY"]);
    } finally { fixture.cleanup(); }
  });
  await t.test("validates slice-only worktree associations", () => {
    const fixture = createCleanupSweepFixture("worktree-slice-only");
    try {
      fixture.createBranch("slice");
      const worktree = fixture.addRegisteredWorktree("slice", "slice");
      fixture.addRun("run", { branch: null, slices: [{ id: "slice", branch: "slice", worktree }] });
      assert.equal(inspect(fixture).candidates[0].classification, "eligible");
    } finally { fixture.cleanup(); }
  });
  await t.test("fails closed when top-level and slice claims assign one path to different branches", () => {
    const fixture = createCleanupSweepFixture("worktree-conflicting-associations");
    try {
      fixture.addRun("run");
      const worktree = fixture.addRecordedWorktree("run");
      fixture.createBranch("slice");
      const run = fixture.readRun("run");
      run.slices = [{ id: "slice", branch: "slice", worktree }];
      fixture.writeRun("run", run);
      const candidate = inspect(fixture).candidates[0];
      assert.deepEqual(candidate.reason_codes, ["SKIPPED_WORKTREE_IDENTITY"]);
      assert.deepEqual(candidate.evidence.worktrees.map((item) => item.branch), ["run", "slice"]);
      assert.equal(candidate.evidence.worktrees.every((item) => item.state === "branch-mismatch"), true);
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

test("R52 returns a registered temporary ref when inspection throws after fetch", () => {
  const fixture = createCleanupSweepFixture("post-fetch-inspection-failure");
  try {
    fixture.addRun("run");
    const runner = fallbackRunner((_cwd, args) => {
      if (args[0] === "worktree") throw new Error("injected after fetch");
      return null;
    }, fixture.gitRunner);
    const result = inspect(fixture, { gitRunner: runner });
    assert.deepEqual(result.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
    assert.deepEqual(result.temporary_refs, [expectedTemporaryRef("run")]);
  } finally { fixture.cleanup(); }
});

test("R28 returns a generated temporary ref when fetch or post-fetch verification throws", async (t) => {
  for (const operation of ["fetch", "rev-parse"]) await t.test(operation, () => {
    const fixture = createCleanupSweepFixture(`temp-ref-${operation}`);
    try {
      fixture.addRun("run");
      const runner = fallbackRunner((_cwd, args) => {
        if (args[0] === operation && (operation !== "rev-parse" || String(args[2]).startsWith("refs/feature-factory/"))) throw new Error("injected");
        return null;
      }, fixture.gitRunner);
      const result = inspect(fixture, { gitRunner: runner });
      assert.deepEqual(result.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
      assert.deepEqual(result.temporary_refs, [expectedTemporaryRef("run")]);
    } finally { fixture.cleanup(); }
  });
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
function expectedTemporaryRef(runId) {
  return `refs/feature-factory/cleanup-sweep/v1/00000000-0000-4000-8000-000000000001/${createHash("sha256").update(runId).digest("hex")}`;
}
function fallbackRunner(primary, fallback) { return (cwd, args, options) => primary(cwd, args, options) ?? fallback(cwd, args, options); }
function githubVariant(fixture, changes) {
  return (...args) => {
    const result = fixture.githubRunner(...args);
    const body = JSON.parse(result.stdout);
    const merged = { ...body, ...changes };
    if (changes.base) merged.base = { ...body.base, ...changes.base };
    return { ...result, stdout: JSON.stringify(merged) };
  };
}
