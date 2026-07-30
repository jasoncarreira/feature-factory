// Acceptance tests are the attack catalogue from
// program/phase-0/FALSIFICATION-PROTOCOL.md, scoped to the small factory. Each
// attack injects one fault and asserts the rejection. Each must fail when its
// guard is removed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun, transition } from "../state/index.js";
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
    worktree: "/repo/.claude/worktrees/APP-1-thing",
    created_at: NOW,
    updated_at: NOW,
    status: "running",
    mode: "interactive",
    max_parallel_slices: 3,
    max_retries: 3,
    base_commit: SHA_A,
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
  const runDir = join(root, ".claude", "factory", "app-1");
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
    ]) {
      const run = baseRun();
      mutate(run);
      assert.throws(() => validateRun(run), pattern);
    }
  });

  it("accepts the baseline record it is meant to accept", () => {
    assert.equal(validateRun(baseRun()).run_id, "app-1");
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
    ["updated_at cannot move backwards", (state) => ({ ...state, updated_at: "2026-07-29T00:00:00.000Z" }), /cannot move backwards/u],
    ["a gate cannot open already approved", (state) => ({ ...state, updated_at: LATER, gates: { ...state.gates, brief: { status: "approved", at: LATER, artifact: null } } }), /must open as pending/u],
    ["a decided gate cannot be re-decided", (state) => ({ ...state, updated_at: LATER, gates: { story: { status: "approved", at: LATER, artifact: "artifacts/story.md" } } }), null],
    ["a step cannot skip attempts", (state) => ({ ...state, updated_at: LATER, steps: [{ agent: "spec-writer", status: "running", attempts: 3, review_ref: null, evidence_ref: null }] }), /must start at attempt 1/u],
    ["only a terminalize transition may enter blocked", (state) => ({ ...state, updated_at: LATER, status: "blocked", terminal_result: { status: "blocked", reason: "sneaked in" } }), /only a terminalize transition may enter blocked/u],
  ];

  for (const [label, apply, pattern] of cases) {
    if (!pattern) continue;
    it(label, async () => {
      const f = fixture(`contract-${label.replace(/\W+/gu, "-").slice(0, 20)}`);
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
    const f = fixture("gate-ok");
    try {
      const next = await transition(f.runDir, {
        participants: [{ familyId: "gates", mode: "decide" }],
        apply: (state) => ({ ...state, updated_at: LATER, gates: { story: { status: "approved", at: LATER, artifact: "artifacts/story.md" } } }),
      });
      assert.equal(next.gates.story.status, "approved");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
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
