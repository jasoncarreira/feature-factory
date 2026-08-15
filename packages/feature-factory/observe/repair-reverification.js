import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProtectedJsonAtomic } from "../core/atomic-write.js";
import { withRunJsonLock } from "../core/run-lock.js";
import { git, observeCleanliness } from "./index.js";
import { REPAIR_EVIDENCE_PREFIX, readRepairState } from "./repair-record.js";

const SHA = /^[0-9a-f]{40}$/u;
const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
const sameNames = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

function assertEnvelope(run) {
  if (!["running", "needs-human"].includes(run.status)) {
    throw new Error(`factory reverify-repair requires run status running or needs-human; found '${run.status}'`);
  }
}

function assertDetached(worktree, commit) {
  const head = git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.ok || head.stdout.trim() !== commit) throw new Error(`detached repair worktree is not at immutable repair commit ${commit}`);
  const symbolic = git(worktree, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symbolic.status !== 1) throw new Error("repair worktree is not detached");
  const cleanliness = observeCleanliness(worktree);
  if (!cleanliness.clean) throw new Error(`detached repair worktree is not initially clean: ${cleanliness.reason}`);
}

function ensureEvidenceDirectory(runDir) {
  const path = join(runDir, "evidence");
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("repair evidence path is not a regular directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}

function evidenceNames(recordId, attempt) {
  const stem = `${REPAIR_EVIDENCE_PREFIX}${recordId}.${attempt}`;
  return { marker: `evidence/${stem}.started.json`, result: `evidence/${stem}.json` };
}

function createDetached(repo, commit) {
  const parent = mkdtempSync(join(tmpdir(), "factory-reverify-repair-"));
  const worktree = join(parent, "worktree");
  const added = git(repo, ["worktree", "add", "--detach", worktree, commit]);
  if (!added.ok) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`could not create detached repair worktree at ${commit}`);
  }
  return { parent, worktree };
}

function removeDetached(repo, temporary) {
  const removed = git(repo, ["worktree", "remove", "--force", temporary.worktree]);
  if (!removed.ok || existsSync(temporary.worktree)) {
    throw new Error(`repair worktree cleanup failed; retained at ${temporary.worktree}`);
  }
  try {
    rmSync(temporary.parent, { recursive: true, force: false });
  } catch (error) {
    throw new Error(`repair worktree cleanup failed for ${temporary.parent}: ${error.message}`);
  }
}

export async function reverifyRepair({ repo, runDir, runId, recordId, at }) {
  const parsedAt = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(parsedAt) || new Date(parsedAt).toISOString() !== at) throw new Error("repair re-verification timestamp is not canonical");
  const preread = readRepairState({ repo, runDir, runId, recordId });
  assertEnvelope(preread.run);
  if (preread.selectedHistory.pass !== null) throw new Error(`repair record '${recordId}' is already effectively verified`);
  if (preread.selectedHistory.tail) throw new Error(`repair record '${recordId}' has a marker-only attempt requiring manual resolution`);
  const temporary = createDetached(repo, preread.selected.repair_commit);
  try {
    assertDetached(temporary.worktree, preread.selected.repair_commit);
  } catch (error) {
    try { removeDetached(repo, temporary); } catch (cleanup) { throw new Error(`${error.message}; ${cleanup.message}`); }
    throw error;
  }

  let reservation;
  try {
    reservation = await withRunJsonLock(runDir, async () => {
      const current = readRepairState({ repo, runDir, runId, recordId });
      assertEnvelope(current.run);
      assertDetached(temporary.worktree, current.selected.repair_commit);
      const history = current.selectedHistory;
      if (history.pass !== null) throw new Error(`repair record '${recordId}' is already effectively verified`);
      if (history.tail) throw new Error(`repair record '${recordId}' has a marker-only attempt requiring manual resolution`);
      const attempt = history.attempts + 1;
      const refs = evidenceNames(recordId, attempt);
      const marker = {
        version: 1, run_id: runId, record_id: recordId, attempt,
        run_sha256: digest(current.run), journal_sha256: digest(current.journal), record_sha256: digest(current.selected),
        introducing_merge: current.selected.introducing_merge, repair_commit: current.selected.repair_commit,
        trigger: current.selected.trigger, started_at: at,
      };
      ensureEvidenceDirectory(runDir);
      await writeProtectedJsonAtomic(runDir, refs.marker, marker, { createOnly: true });
      const reread = readRepairState({ repo, runDir, runId, recordId });
      if (!reread.selectedHistory.tail || reread.selectedHistory.attempts !== attempt
        || !sameNames(reread.selectedHistory.names, [...history.names, refs.marker.slice("evidence/".length)])
        || JSON.stringify(reread.selectedHistory.markers.get(attempt)) !== JSON.stringify(marker)) {
        throw new Error("repair marker did not read back as the unique next attempt");
      }
      return { attempt, refs, marker, runBytes: Buffer.from(current.runBytes), journalBytes: Buffer.from(current.journalBytes),
        priorNames: [...history.names], repairCommit: current.selected.repair_commit, trigger: current.selected.trigger };
    });
  } catch (error) {
    try { removeDetached(repo, temporary); } catch (cleanup) { throw new Error(`${error.message}; ${cleanup.message}`); }
    throw error;
  }

  let execution;
  try {
    const outcome = spawnSync(reservation.trigger.command, [], {
      cwd: temporary.worktree, shell: true, env: process.env, stdio: "inherit", timeout: reservation.trigger.timeout_ms,
    });
    const exit = Number.isSafeInteger(outcome?.status) && outcome.status >= 0 ? outcome.status : null;
    const head = git(temporary.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const commit = head.ok && SHA.test(head.stdout.trim()) ? head.stdout.trim() : null;
    const cleanliness = observeCleanliness(temporary.worktree);
    execution = { observed: exit !== null, exit, commit, worktree_clean: cleanliness.clean };
  } catch (error) {
    try { removeDetached(repo, temporary); } catch (cleanup) { throw new Error(`${error.message}; ${cleanup.message}`); }
    throw error;
  }
  removeDetached(repo, temporary);

  const completed = await withRunJsonLock(runDir, async () => {
    const current = readRepairState({ repo, runDir, runId, recordId });
    assertEnvelope(current.run);
    if (!current.runBytes.equals(reservation.runBytes) || !current.journalBytes.equals(reservation.journalBytes)) {
      throw new Error("run or repair journal bytes changed during re-verification");
    }
    const history = current.selectedHistory;
    const markerName = reservation.refs.marker.slice("evidence/".length);
    if (!history.tail || history.attempts !== reservation.attempt
      || !sameNames(history.names, [...reservation.priorNames, markerName])
      || JSON.stringify(history.markers.get(reservation.attempt)) !== JSON.stringify(reservation.marker)
      || current.selected.repair_commit !== reservation.repairCommit
      || JSON.stringify(current.selected.trigger) !== JSON.stringify(reservation.trigger)) {
      throw new Error("repair reservation changed before result publication");
    }
    const result = {
      version: 1, run_id: runId, record_id: recordId, attempt: reservation.attempt,
      marker_sha256: digest(reservation.marker), run_sha256: reservation.marker.run_sha256,
      journal_sha256: reservation.marker.journal_sha256, record_sha256: reservation.marker.record_sha256,
      introducing_merge: reservation.marker.introducing_merge, repair_commit: reservation.repairCommit,
      trigger: reservation.trigger, result: execution, observed_at: at, observed_by: "factory",
    };
    await writeProtectedJsonAtomic(runDir, reservation.refs.result, result, { createOnly: true });
    const reread = readRepairState({ repo, runDir, runId, recordId });
    if (reread.selectedHistory.tail || reread.selectedHistory.attempts !== reservation.attempt
      || JSON.stringify(reread.selectedHistory.results.get(reservation.attempt)) !== JSON.stringify(result)) {
      throw new Error("repair result did not read back as the unique final attempt");
    }
    return { result, effective: reread.selectedHistory.pass === reservation.attempt };
  });
  if (!completed.effective) throw new Error(`repair re-verification attempt ${reservation.attempt} did not pass`);
  return {
    run_id: runId, record_id: recordId, attempt: reservation.attempt,
    physical_status: "needs-human", effective_status: "verified", repair_commit: reservation.repairCommit,
    evidence_ref: reservation.refs.result,
  };
}
