// Acceptance tests are the attack catalogue from
// program/phase-0/FALSIFICATION-PROTOCOL.md, scoped to the small factory. Each
// attack injects one fault and asserts the rejection. Each must fail when its
// guard is removed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun } from "../state/index.js";
import { transition } from "../state/transition.js";
import { SchemaError, validateRun } from "../state/schema.js";

const NOW = "2026-07-30T12:00:00.000Z";
const LATER = "2026-07-30T12:05:00.000Z";
const SHA_A = "a".repeat(40);

function baseRun(overrides = {}) {
  return {
    version: 1,
    run_id: "app-1",
    jira_key: "APP-1",
    branch: "APP-1-thing",
    worktree: "/repo/.worktrees/APP-1-thing",
    created_at: NOW,
    updated_at: NOW,
    status: "running",
    mode: "interactive",
    max_parallel_slices: 3,
    max_retries: 3,
    gates: { story: { status: "pending", at: null, artifact: "artifacts/story.md" } },
    steps: [],
    slices: [],
    validator: null,
    terminal_result: null,
    pr_url: null,
    ...overrides,
  };
}

function fixture(name, overrides) {
  const root = mkdtempSync(join(tmpdir(), `ff-${name}-`));
  const runDir = join(root, ".factory", "app-1");
  mkdirSync(runDir, { recursive: true });
  const run = baseRun(overrides);
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return { root, runDir, run };
}

const bytes = (runDir) => readFileSync(join(runDir, "run.json"), "utf8");

describe("attack 12 — a malformed record submitted by an agent", () => {
  it("rejects an unknown top-level key before any write", async () => {
    const f = fixture("unknown-key");
    try {
      const before = bytes(f.runDir);
      await assert.rejects(
        () => transition(f.runDir, {
          participants: [{ familyId: "envelope", mode: "annotate" }],
          apply: (state) => ({ ...state, hash_chain: ["sha256:deadbeef"], updated_at: LATER }),
        }),
        (error) => {
          assert.equal(error.name, "SchemaError");
          assert.match(error.message, /unknown keys: hash_chain/u);
          return true;
        },
      );
      assert.equal(bytes(f.runDir), before, "run.json must be byte-identical after a rejected write");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("rejects an out-of-enum status, a bad timestamp, and a dangling dependency", () => {
    for (const [mutate, pattern] of [
      [(run) => { run.status = "almost-done"; }, /run\.status: must be one of/u],
      [(run) => { run.updated_at = "yesterday"; }, /run\.updated_at: must match/u],
      [(run) => { run.slices = [{ id: "fe", stack: "frontend", depends_on: ["nope"], status: "pending", worktree: null, branch: null, attempts: 1, evidence_ref: null, review_ref: null, merge_commit: null }]; }, /unknown slice 'nope'/u],
      [(run) => { run.slices = [{ id: "be", stack: "backend", depends_on: [], status: "merged", worktree: null, branch: null, attempts: 1, evidence_ref: null, review_ref: null, merge_commit: null }]; }, /merge_commit: is required when a slice is merged/u],
      [(run) => { run.status = "blocked"; }, /terminal_result: is required when status is blocked/u],
      [(run) => { run.pr_base = ""; }, /run\.pr_base: must be a non-empty string/u],
      [(run) => { run.pr_base = "   "; }, /run\.pr_base: must be a non-empty string/u],
      [(run) => { run.pr_base = 42; }, /run\.pr_base: must be a non-empty string/u],
    ]) {
      const run = baseRun();
      mutate(run);
      assert.throws(() => validateRun(run), pattern);
    }
  });

  it("requires a slice base_ref from the moment it leaves pending", () => {
    // Requiring it only at "merged" let a slice run and review with none, then receive
    // its first value on the merge transition - chosen after the fact to exclude
    // earlier commits from the ownership diff.
    const slice = (status, baseRef) => ({
      id: "be", stack: "backend", depends_on: [], status, worktree: null, branch: null,
      attempts: 1, paths: ["src/"], test_plan: ["t"], base_ref: baseRef, evidence_ref: null, review_ref: null,
      merge_commit: status === "merged" ? "c".repeat(40) : null,
    });
    // Pending may have none: the slice has not been activated yet.
    validateRun(baseRun({ slices: [slice("pending", null)] }));
    for (const status of ["running", "review", "merged", "blocked"]) {
      assert.throws(() => validateRun(baseRun({ slices: [slice(status, null)] })),
        new RegExp(`base_ref: is required once a slice is ${status}`, "u"), `must require it at ${status}`);
    }
    validateRun(baseRun({ slices: [slice("running", "a".repeat(40))] }));
  });

  it("accepts the baseline record it is meant to accept", () => {
    assert.equal(validateRun(baseRun()).run_id, "app-1");
    assert.equal(validateRun(baseRun({ pr_base: null })).pr_base, null);
    assert.equal(validateRun(baseRun({ pr_base: "integration" })).pr_base, "integration");
  });
});

describe("attack 11 — a concurrent writer changes run.json mid-transition", () => {
  it("rejects on compare-and-swap with the intruder's bytes intact", async () => {
    const f = fixture("cas");
    try {
      const intruder = baseRun({ updated_at: LATER, jira_key: "APP-999" });
      const intruderBytes = `${JSON.stringify(intruder, null, 2)}\n`;

      await assert.rejects(
        () => transition(f.runDir, {
          participants: [{ familyId: "envelope", mode: "annotate" }],
          apply: (state) => ({ ...state, updated_at: LATER, pr_url: "https://example.test/pr/1" }),
          // The write core re-reads immediately before rename. Writing here
          // simulates another process committing between our read and our commit.
          hooks: { beforeCommit: () => writeFileSync(join(f.runDir, "run.json"), intruderBytes) },
        }),
        // The protected writer wraps a rename-time failure; the CAS rejection is
        // the cause, so assert the chain rather than the outer message.
        (error) => {
          assert.match(String(error.cause?.message ?? error.message), /run state changed before protected replacement/u);
          return true;
        },
      );

      assert.equal(bytes(f.runDir), intruderBytes, "the concurrent writer's record must survive intact");
      assert.equal(readRun(f.runDir).pr_url, null, "our partial write must not have landed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("rejects a write that lands after the reobservers run", async () => {
    // The earlier test injects at beforeCommit, which is *before* the comparison, so
    // it only ever exercised a window that was already safe. This injects from a
    // reobserver — after the comparison and before the rename — which is where the
    // lost update actually was.
    const f = fixture("cas-late");
    try {
      const intruder = baseRun({ updated_at: LATER, jira_key: "APP-999" });
      const intruderBytes = `${JSON.stringify(intruder, null, 2)}\n`;
      let injected = false;

      await assert.rejects(
        () => transition(f.runDir, {
          participants: [{ familyId: "envelope", mode: "annotate" }],
          apply: (state) => ({ ...state, updated_at: LATER, pr_url: "https://example.test/pr/1" }),
          reobservers: new Map([["envelope", async () => {
            injected = true;
            writeFileSync(join(f.runDir, "run.json"), intruderBytes);
          }]]),
        }),
        (error) => {
          assert.match(String(error.cause?.message ?? error.message), /run state changed before protected replacement/u);
          return true;
        },
      );

      assert.equal(injected, true, "the reobserver must have run, or the window was never opened");
      assert.equal(bytes(f.runDir), intruderBytes, "the competing record must survive");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("commits when no concurrent write occurred", async () => {
    const f = fixture("cas-clean");
    try {
      const next = await transition(f.runDir, {
        participants: [{ familyId: "envelope", mode: "annotate" }],
        apply: (state) => ({ ...state, updated_at: LATER, pr_url: "https://example.test/pr/1" }),
      });
      assert.equal(next.pr_url, "https://example.test/pr/1");
      assert.equal(readRun(f.runDir).pr_url, "https://example.test/pr/1");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe("family contracts refuse transitions the schema alone would allow", () => {
  const cases = [
    ["run identity is immutable", (state) => ({ ...state, run_id: "app-2", updated_at: LATER }), /run_id is immutable/u],
    ["an absent PR base cannot become null", (state) => ({ ...state, pr_base: null, updated_at: LATER }), /envelope\.pr_base is immutable/u],
    ["an absent PR base cannot become a string", (state) => ({ ...state, pr_base: "main", updated_at: LATER }), /envelope\.pr_base is immutable/u],
    ["a null PR base cannot become absent", (state) => { const next = { ...state, updated_at: LATER }; delete next.pr_base; return next; }, /envelope\.pr_base is immutable/u, { pr_base: null }],
    ["a null PR base cannot become a string", (state) => ({ ...state, pr_base: "main", updated_at: LATER }), /envelope\.pr_base is immutable/u, { pr_base: null }],
    ["a string PR base cannot become absent", (state) => { const next = { ...state, updated_at: LATER }; delete next.pr_base; return next; }, /envelope\.pr_base is immutable/u, { pr_base: "main" }],
    ["a string PR base cannot become null", (state) => ({ ...state, pr_base: null, updated_at: LATER }), /envelope\.pr_base is immutable/u, { pr_base: "main" }],
    ["a string PR base cannot change", (state) => ({ ...state, pr_base: "release", updated_at: LATER }), /envelope\.pr_base is immutable/u, { pr_base: "main" }],
    // Mode decides who may decide the gates: interactive stops at each one, headless records
    // needs-human, autonomous decides without a human. It is set once by `init` and nothing reads it
    // afterwards, which is why it was missed — a field that looks inert. Left writable, a run could be
    // flipped to autonomous mid-flight and the manifest would read as though it always had been: the
    // record of who was entitled to decide, rewritable by the party deciding. This does not make a
    // decision verifiable — the factory cannot tell a human's approval from an agent's, both being the
    // same command — it makes the recorded intent durable.
    ["mode cannot change after init", (state) => ({ ...state, mode: "autonomous", updated_at: LATER }), /envelope\.mode is immutable/u],
    ["updated_at cannot move backwards", (state) => ({ ...state, updated_at: "2026-07-29T00:00:00.000Z" }), /cannot move backwards/u],
    ["a gate cannot open already approved", (state) => ({ ...state, updated_at: LATER, gates: { ...state.gates, brief: { status: "approved", at: LATER, artifact: null } } }), /must open as pending/u],
    ["a decided gate cannot be re-decided", (state) => ({ ...state, updated_at: LATER, gates: { story: { status: "approved", at: LATER, artifact: "artifacts/story.md" } } }), null],
    ["a step cannot skip attempts", (state) => ({ ...state, updated_at: LATER, steps: [{ agent: "spec-writer", status: "running", attempts: 3, review_ref: null, evidence_ref: null }] }), /must start at attempt 1/u],
    ["only a terminalize transition may enter blocked", (state) => ({ ...state, updated_at: LATER, status: "blocked", terminal_result: { status: "blocked", reason: "sneaked in" } }), /only a terminalize transition may enter blocked/u],
  ];

  for (const [label, apply, pattern, overrides] of cases) {
    if (!pattern) continue;
    it(label, async () => {
      const f = fixture(`contract-${label.replace(/\W+/gu, "-").slice(0, 20)}`, overrides);
      try {
        const before = bytes(f.runDir);
        await assert.rejects(() => transition(f.runDir, {
          participants: [{ familyId: "envelope", mode: "annotate" }, { familyId: "gates", mode: "annotate" }, { familyId: "steps", mode: "annotate" }],
          apply,
        }), pattern);
        assert.equal(bytes(f.runDir), before);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }

  it("permits a legitimate gate decision", async () => {
    for (const [name, overrides, expected] of [
      ["absent", undefined, undefined], ["null", { pr_base: null }, null], ["string", { pr_base: "main" }, "main"],
    ]) {
      const f = fixture(`gate-ok-${name}`, overrides);
      try {
        const next = await transition(f.runDir, {
          participants: [{ familyId: "gates", mode: "decide" }],
          apply: (state) => ({ ...state, updated_at: LATER, gates: { story: { status: "approved", at: LATER, artifact: "artifacts/story.md" } } }),
        });
        assert.equal(next.gates.story.status, "approved");
        assert.equal(next.pr_base, expected);
        assert.equal(Object.hasOwn(next, "pr_base"), name !== "absent");
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it("terminalizes through the declared mode", async () => {
    const f = fixture("terminal-ok");
    try {
      const next = await transition(f.runDir, {
        participants: [{ familyId: "envelope", mode: "terminalize" }],
        apply: (state) => ({ ...state, updated_at: LATER, status: "blocked", terminal_result: { status: "blocked", reason: "slice be-entity exhausted retries" } }),
      });
      assert.equal(next.status, "blocked");
      assert.equal(next.terminal_result.reason, "slice be-entity exhausted retries");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
