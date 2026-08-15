// The executable recovery path, exercised rather than described.
//
// The commands, the prose and the ceiling were all asserted before this file existed, and every one of
// them passed while nothing invoked `reverifyRepair`. That is the shape of a false green this repository
// exists to refuse: 241 tests green, and the state machine that turns an untrusted run artifact into
// publication authority never once executed. Reviewer on #308 caught it; this is the coverage it asked for.
//
// Each case builds a real repository — an introducing merge, a starting head, and an immutable repair
// commit whose diff is exactly the recorded test paths — because every binding under test is a fact about
// git, and a fixture that stubs them would prove only that the stubs agree with each other.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reverifyRepair } from "../observe/repair-reverification.js";
import { assertRepairPublicationReady, readRepairState, REPAIR_JOURNAL_REF } from "../observe/repair-record.js";
import { seedLegacyRun } from "./init-fixture.js";

const RUN_ID = "303";
const AT = "2026-08-15T12:00:00.000Z";
const TEST_PATH = "test/repair-fixture.test.js";

const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sh = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// `verify` is what the detached worktree will actually run, and it must equal the committed
// `.factory.json` at the repair commit or the binding check refuses before anything executes.
function seedRepair({ verify = "exit 0", timeoutMs = 60_000, run = {} } = {}) {
  const repository = mkdtempSync(join(tmpdir(), "factory-repair-"));
  const runDir = join(repository, ".factory", RUN_ID);
  sh(repository, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["user.name", "Factory Test"], ["user.email", "factory@example.test"]]) {
    sh(repository, ["config", key, value]);
  }
  writeFileSync(join(repository, ".factory.json"), canonical({
    resolve: "true", verify: verify.replace(/\{runDir\}/gu, runDir), publish: "true",
    publishing_identity: "tester", verify_timeout_ms: timeoutMs,
  }));
  mkdirSync(join(repository, "test"), { recursive: true });
  writeFileSync(join(repository, TEST_PATH), "// seeded\n");
  sh(repository, ["add", "-A"]);
  sh(repository, ["commit", "-q", "-m", "seed"]);
  const introducingMerge = sh(repository, ["rev-parse", "HEAD"]);

  writeFileSync(join(repository, "source.js"), "// integration head\n");
  sh(repository, ["add", "-A"]);
  sh(repository, ["commit", "-q", "-m", "head"]);
  const startingHead = sh(repository, ["rev-parse", "HEAD"]);

  // The repair commit touches the recorded test path and nothing else: `.factory.json` is privileged and
  // may never appear in test_paths, so it has to be already committed and untouched here.
  writeFileSync(join(repository, TEST_PATH), "// repaired\n");
  sh(repository, ["add", "-A"]);
  sh(repository, ["commit", "-q", "-m", "repair"]);
  const repairCommit = sh(repository, ["rev-parse", "HEAD"]);

  seedLegacyRun(repository, RUN_ID, {
    ...run,
    slices: [{
      id: "repair-slice", stack: "backend", depends_on: [], status: "merged", worktree: ".",
      branch: `feature/${RUN_ID}`, attempts: 1, paths: [TEST_PATH], path_amendments: [],
      test_plan: ["exit 0"], base_ref: introducingMerge, evidence_ref: null, review_ref: null,
      merge_commit: introducingMerge,
    }],
  });

  const recordId = `repair-${introducingMerge}-1`;
  const record = {
    record_id: recordId, introducing_merge: introducingMerge, attempt: 1, starting_head: startingHead,
    trigger: { command: verify.replace(/\{runDir\}/gu, runDir), timeout_ms: timeoutMs },
    trigger_result: { observed: true, exit: 1 }, test_paths: [TEST_PATH],
    cause: "docker was unavailable on the host", property_outcome: "assertions strengthened, no property weakened",
    repair_commit: repairCommit, post_repair_result: { observed: false, exit: null }, status: "needs-human",
  };
  writeFileSync(join(runDir, REPAIR_JOURNAL_REF), canonical({ version: 1, records: [record] }));
  return { repository, runDir, recordId, repairCommit, startingHead, introducingMerge, record };
}

const evidence = (runDir) => readdirSync(join(runDir, "evidence")).filter((name) => name.startsWith("repair-reverification.")).sort();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.message;
  }
}

describe("repair re-verification — the recovery path is executable, not just declared", () => {
  it("passes at the immutable repair commit, and only that commit substitutes for publication", async () => {
    // Both envelopes the contract admits, because `needs-human` is a parked stop and not a terminal
    // state: it is resumable by explicit `factory resume`, and a parked run is the state this command
    // exists to recover. Admitting only `running` would refuse the case that motivated the feature.
    for (const [envelope, run] of [
      ["a running envelope", {}],
      ["a parked needs-human envelope", { status: "needs-human", terminal_result: { status: "needs-human", reason: "repair verification could not complete" } }],
    ]) {
    const fixture = seedRepair({ run });
    const outcome = await reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at: AT });

    assert.equal(outcome.attempt, 1, envelope);
    assert.equal(outcome.physical_status, "needs-human", "the physical journal row stays frozen");
    assert.equal(outcome.effective_status, "verified", envelope);
    assert.equal(outcome.repair_commit, fixture.repairCommit);
    assert.equal(outcome.evidence_ref, `evidence/repair-reverification.${fixture.recordId}.1.json`);

    // Both files, marker before result, each canonical and create-only.
    assert.deepEqual(evidence(fixture.runDir), [
      `repair-reverification.${fixture.recordId}.1.json`,
      `repair-reverification.${fixture.recordId}.1.started.json`,
    ]);
    const result = readJson(join(fixture.runDir, outcome.evidence_ref));
    assert.deepEqual(result.result, { observed: true, exit: 0, commit: fixture.repairCommit, worktree_clean: true });
    assert.equal(result.observed_at, AT);
    assert.equal(result.observed_by, "factory");

    // The journal row itself is untouched: recovery is effective status, never a rewritten record.
    const journal = readJson(join(fixture.runDir, REPAIR_JOURNAL_REF));
    assert.deepEqual(journal.records[0], fixture.record);

    const state = readRepairState({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId });
    assert.equal(state.selectedHistory.pass, 1);

    // Substitution is bound to current HEAD. The same passing evidence authorizes publication at the
    // repair commit and authorizes nothing at any other head.
    const options = { repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID };
    assert.equal(assertRepairPublicationReady({ ...options, head: fixture.repairCommit }).tested, fixture.repairCommit);
    assert.equal(assertRepairPublicationReady({ ...options, head: fixture.startingHead }).tested, null);

    // And a second invocation cannot append after a pass.
    assert.match(
      await refusal(reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at: AT })),
      /already effectively verified/u,
      envelope,
    );

    // Recovery never unparks the run itself. That remains an explicit operator resume.
    assert.equal(readJson(join(fixture.runDir, "run.json")).status, run.status ?? "running", envelope);
    rmSync(fixture.repository, { recursive: true, force: true });
    }
  });

  it("keeps every non-passing outcome non-passing, and admits exactly the next contiguous attempt", async () => {
    // A non-passing outcome must still be published as a completed attempt: a failure that left only a
    // marker would be indistinguishable from a crash, and would park the record for a human forever.
    for (const [label, verify, expected] of [
      ["nonzero exit", "exit 3", { observed: true, exit: 3, worktree_clean: true, atRepairCommit: true }],
      ["dirty worktree", "printf x > untracked.txt", { observed: true, exit: 0, worktree_clean: false, atRepairCommit: true }],
      // A command that commits moves detached HEAD off the immutable repair commit. The tree it leaves is
      // clean and the exit is zero, so `commit` is the only thing standing between this and a false pass:
      // evidence would otherwise say the repair commit was tested when something else was.
      ["moved detached HEAD", 'git -c user.name=T -c user.email=t@e.test commit --allow-empty -q -m moved',
        { observed: true, exit: 0, worktree_clean: true, atRepairCommit: false }],
    ]) {
      const fixture = seedRepair({ verify });
      const message = await refusal(reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at: AT }));
      assert.match(message, /attempt 1 did not pass/u, label);

      const first = readJson(join(fixture.runDir, "evidence", `repair-reverification.${fixture.recordId}.1.json`));
      assert.equal(first.result.observed, expected.observed, label);
      assert.equal(first.result.exit, expected.exit, label);
      assert.equal(first.result.worktree_clean, expected.worktree_clean, label);
      assert.equal(first.result.commit === fixture.repairCommit, expected.atRepairCommit, `${label}: observed commit`);

      const state = readRepairState({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId });
      assert.equal(state.selectedHistory.pass, null, label);
      assert.equal(state.selectedHistory.tail, false, `${label}: a completed failure is not a tail`);
      // A failed attempt does not merely fail to authorize publication; it blocks it, and says which
      // record is blocking. Returning a quiet `tested: null` here would let a caller publish anyway.
      assert.throws(
        () => assertRepairPublicationReady({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, head: fixture.repairCommit }),
        /remains needs-human and blocks publication/u,
        label,
      );
      rmSync(fixture.repository, { recursive: true, force: true });
    }

    // Cleanup failure is its own branch, and the invariant is that it can never become passing evidence.
    // `git worktree lock` makes the real removal path fail rather than a test double standing in for it,
    // so the marker is already published when the throw happens and no result ever follows it.
    const locked = seedRepair({ verify: 'git worktree lock "$(pwd)"' });
    const cleanupMessage = await refusal(reverifyRepair({ repo: locked.repository, runDir: locked.runDir, runId: RUN_ID, recordId: locked.recordId, at: AT }));
    assert.ok(cleanupMessage, "a failed cleanup must refuse rather than return an outcome");
    assert.match(cleanupMessage, /repair worktree cleanup failed; retained at /u);
    assert.deepEqual(evidence(locked.runDir), [`repair-reverification.${locked.recordId}.1.started.json`],
      "cleanup failure leaves the marker and publishes no result");
    const stranded = readRepairState({ repo: locked.repository, runDir: locked.runDir, runId: RUN_ID, recordId: locked.recordId });
    assert.equal(stranded.selectedHistory.tail, true, "the interrupted attempt is a tail");
    assert.equal(stranded.selectedHistory.pass, null);
    assert.throws(
      () => assertRepairPublicationReady({ repo: locked.repository, runDir: locked.runDir, runId: RUN_ID, head: locked.repairCommit }),
      /remains needs-human and blocks publication/u,
      "a stranded attempt cannot authorize publication",
    );
    // And the record now requires a human: no further attempt may be reserved over an unresolved tail.
    assert.match(
      await refusal(reverifyRepair({ repo: locked.repository, runDir: locked.runDir, runId: RUN_ID, recordId: locked.recordId, at: AT })),
      /marker-only attempt requiring manual resolution/u,
    );
    const retained = /retained at (\S+)/u.exec(cleanupMessage)?.[1];
    if (retained) {
      sh(locked.repository, ["worktree", "unlock", retained]);
      sh(locked.repository, ["worktree", "remove", "--force", retained]);
    }
    rmSync(locked.repository, { recursive: true, force: true });

    // The next attempt is N+1 and nothing else. Rewriting `.factory.json` is not possible mid-record —
    // the trigger is bound to the committed config — so the second attempt reruns the same failing
    // command and lands as attempt 2.
    const fixture = seedRepair({ verify: "exit 3" });
    for (const attempt of [1, 2, 3]) {
      const message = await refusal(reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at: AT }));
      assert.match(message, new RegExp(`attempt ${attempt} did not pass`, "u"));
      const state = readRepairState({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId });
      assert.equal(state.selectedHistory.attempts, attempt);
      assert.deepEqual([...state.selectedHistory.results.keys()].sort(), [1, 2, 3].slice(0, attempt));
    }
    rmSync(fixture.repository, { recursive: true, force: true });
  });

  it("fails closed on every inventory the validator cannot trust", async () => {
    // Each row corrupts evidence a run could plausibly leave behind, then asserts the next read refuses
    // rather than treating it as authority. The marker-only tail is first because it is the crash case:
    // a driver that died between reserving an attempt and publishing its result.
    const cases = [
      ["marker-only tail requires a human", (fixture, names) => {
        rmSync(join(fixture.runDir, "evidence", names.result));
      }, /marker-only attempt requiring manual resolution/u],
      ["a result without its marker is refused", (fixture, names) => {
        rmSync(join(fixture.runDir, "evidence", names.marker));
      }, /result without its marker/u],
      ["a marker gap is refused", (fixture, names) => {
        for (const name of [names.marker, names.result]) {
          const value = readJson(join(fixture.runDir, "evidence", name));
          rmSync(join(fixture.runDir, "evidence", name));
          writeFileSync(join(fixture.runDir, "evidence", name.replace(".1.", ".2.")), canonical({ ...value, attempt: 2 }));
        }
      }, /marker gap/u],
      ["a tampered result digest is refused", (fixture, names) => {
        const value = readJson(join(fixture.runDir, "evidence", names.result));
        writeFileSync(join(fixture.runDir, "evidence", names.result), canonical({ ...value, run_sha256: `sha256:${"0".repeat(64)}` }));
      }, /evidence result/u],
      ["non-canonical bytes are refused", (fixture, names) => {
        const value = readJson(join(fixture.runDir, "evidence", names.result));
        writeFileSync(join(fixture.runDir, "evidence", names.result), JSON.stringify(value));
      }, /bytes are not canonical/u],
      ["an aliased evidence name is refused", (fixture, names) => {
        const value = readJson(join(fixture.runDir, "evidence", names.result));
        writeFileSync(join(fixture.runDir, "evidence", `repair-reverification.${fixture.recordId}.01.json`), canonical(value));
      }, /malformed repair re-verification name/u],
      ["evidence for an unknown record is refused", (fixture) => {
        writeFileSync(join(fixture.runDir, "evidence", `repair-reverification.repair-${"a".repeat(40)}-1.1.json`), canonical({ version: 1 }));
      }, /does not identify an eligible repair record/u],
    ];
    for (const [label, corrupt, expected] of cases) {
      const fixture = seedRepair();
      await reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at: AT });
      const names = {
        marker: `repair-reverification.${fixture.recordId}.1.started.json`,
        result: `repair-reverification.${fixture.recordId}.1.json`,
      };
      corrupt(fixture, names);
      let message = null;
      try {
        readRepairState({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId });
      } catch (error) {
        message = error.message;
      }
      if (message === null) {
        // A corruption the reader accepts must at least be refused before it can authorize a new attempt.
        message = await refusal(reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at: AT }));
      }
      assert.match(String(message), expected, label);
      rmSync(fixture.repository, { recursive: true, force: true });
    }
  });

  it("refuses concurrent invocation, mutated state, and a non-canonical timestamp", async () => {
    // Two drivers racing the same record must not both reserve an attempt. The marker is written
    // create-only under the run lock, so the loser cannot claim the same number and cannot invent the next.
    const racing = seedRepair();
    const both = await Promise.allSettled([1, 2].map(() =>
      reverifyRepair({ repo: racing.repository, runDir: racing.runDir, runId: RUN_ID, recordId: racing.recordId, at: AT })));
    assert.equal(both.filter((outcome) => outcome.status === "fulfilled").length, 1, "exactly one invocation may succeed");
    const state = readRepairState({ repo: racing.repository, runDir: racing.runDir, runId: RUN_ID, recordId: racing.recordId });
    assert.equal(state.selectedHistory.attempts, 1, "the loser must not reserve a second attempt");
    assert.equal(state.selectedHistory.pass, 1);
    rmSync(racing.repository, { recursive: true, force: true });

    // Run state changing under a running attempt invalidates it: the evidence would otherwise claim to
    // describe a run that no longer exists in the form it was reserved against.
    const mutating = seedRepair({ verify: `printf '' && node -e "const p=process.argv[1];const fs=require('fs');const v=JSON.parse(fs.readFileSync(p));v.updated_at='2026-08-15T13:00:00.000Z';fs.writeFileSync(p, JSON.stringify(v,null,2)+String.fromCharCode(10));" {runDir}/run.json` });
    assert.match(
      await refusal(reverifyRepair({ repo: mutating.repository, runDir: mutating.runDir, runId: RUN_ID, recordId: mutating.recordId, at: AT })),
      /run or repair journal bytes changed during re-verification/u,
    );
    assert.equal(
      readRepairState({ repo: mutating.repository, runDir: mutating.runDir, runId: RUN_ID, recordId: mutating.recordId }).selectedHistory.pass,
      null,
      "a mutated run leaves the record unverified",
    );
    rmSync(mutating.repository, { recursive: true, force: true });

    for (const [label, at] of [["not canonical", "2026-08-15T12:00:00Z"], ["not a timestamp", "yesterday"], ["not a string", 17]]) {
      const fixture = seedRepair();
      assert.match(
        await refusal(reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at })),
        /timestamp is not canonical/u,
        label,
      );
      assert.equal(existsSync(join(fixture.runDir, "evidence")) ? evidence(fixture.runDir).length : 0, 0, `${label}: nothing is reserved`);
      rmSync(fixture.repository, { recursive: true, force: true });
    }
  });

  it("refuses a record or envelope that does not qualify, before executing anything", async () => {
    for (const [label, mutate, expected] of [
      ["a terminal run", (fixture) => {
        const path = join(fixture.runDir, "run.json");
        writeFileSync(path, canonical({ ...readJson(path), status: "blocked",
          terminal_result: { status: "blocked", reason: "ceiling exceeded" } }));
      }, /requires run status running or needs-human/u],
      ["a record that is already verified", (fixture) => {
        const path = join(fixture.runDir, REPAIR_JOURNAL_REF);
        const journal = readJson(path);
        journal.records[0].status = "verified";
        journal.records[0].post_repair_result = { observed: true, exit: 0 };
        writeFileSync(path, canonical(journal));
      }, /not the latest eligible post-commit needs-human row/u],
      ["a record with no repair commit", (fixture) => {
        const path = join(fixture.runDir, REPAIR_JOURNAL_REF);
        const journal = readJson(path);
        journal.records[0].repair_commit = null;
        journal.records[0].property_outcome = null;
        journal.records[0].post_repair_result = null;
        writeFileSync(path, canonical(journal));
      }, /not the latest eligible post-commit needs-human row/u],
      ["a trigger that disagrees with the committed config", (fixture) => {
        const path = join(fixture.runDir, REPAIR_JOURNAL_REF);
        const journal = readJson(path);
        journal.records[0].trigger = { command: "exit 0 # rewritten", timeout_ms: 60_000 };
        writeFileSync(path, canonical(journal));
      }, /trigger does not match its committed config/u],
      ["a repair commit whose diff is not the recorded test paths", (fixture) => {
        const path = join(fixture.runDir, REPAIR_JOURNAL_REF);
        const journal = readJson(path);
        journal.records[0].test_paths = ["source.js"];
        writeFileSync(path, canonical(journal));
      }, /repair diff does not equal test_paths/u],
      ["an unknown record id", (fixture) => { fixture.recordId = `repair-${"b".repeat(40)}-1`; },
        /does not identify exactly one journal row/u],
    ]) {
      const fixture = seedRepair();
      mutate(fixture);
      assert.match(
        await refusal(reverifyRepair({ repo: fixture.repository, runDir: fixture.runDir, runId: RUN_ID, recordId: fixture.recordId, at: AT })),
        expected,
        label,
      );
      // Nothing executed means nothing was reserved: refusal happens before the worktree is created.
      assert.equal(existsSync(join(fixture.runDir, "evidence")) ? evidence(fixture.runDir).length : 0, 0, `${label}: no evidence`);
      rmSync(fixture.repository, { recursive: true, force: true });
    }
  });
});
