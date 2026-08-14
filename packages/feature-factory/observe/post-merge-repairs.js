import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { deriveReviewReady, EVIDENCE_KEYS } from "./index.js";

const SHA = "[0-9a-f]{40}";
const RECORD = new RegExp(`^repair-(${SHA})-([1-9][0-9]*)$`, "u");
const FILE = new RegExp(`^post-merge-repair-reverify-(repair-${SHA}-[1-9][0-9]*)-attempt-([1-9][0-9]*)\\.json$`, "u");
const PREFIX = "post-merge-repair-reverify-";
const MARKER = "Reverify-v1: ";

export function canonicalObservedEvidence(evidence, { runId, branch, baseRef, worktree, commit, command, subject, attempt }) {
  const commandNames = [
    "git rev-parse HEAD",
    `git --literal-pathspecs diff --name-only -z ${baseRef}...HEAD`,
    `git diff --stat ${baseRef}...HEAD`,
  ];
  const commandsAreCanonical = Array.isArray(evidence?.commands)
    && evidence.commands.length === commandNames.length
    && evidence.commands.every((item, index) => item && typeof item === "object" && !Array.isArray(item)
      && JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["cmd", "exit", "summary"])
      && item.cmd === commandNames[index] && item.exit === 0 && typeof item.summary === "string");
  const tests = evidence?.tests;
  const testsAreCanonical = tests && typeof tests === "object" && !Array.isArray(tests)
    && JSON.stringify(Object.keys(tests).sort()) === JSON.stringify(["cmd", "exit", "observed", "skipped_reason"])
    && tests.cmd === command && typeof tests.observed === "boolean" && tests.skipped_reason === null
    && ((tests.observed && Number.isInteger(tests.exit)) || (!tests.observed && tests.exit === null));
  const reconciliation = evidence?.claim_reconciliation;
  return JSON.stringify(Object.keys(evidence ?? {}).sort()) === JSON.stringify([...EVIDENCE_KEYS].sort())
    && evidence.subject === subject && evidence.run_id === runId && evidence.attempt === attempt
    && evidence.branch === branch && evidence.base_ref === baseRef && evidence.worktree === worktree
    && evidence.status === "completed" && typeof evidence.worktree_clean === "boolean"
    && ((evidence.worktree_clean && evidence.blocked_reason === null)
      || (!evidence.worktree_clean && typeof evidence.blocked_reason === "string" && Boolean(evidence.blocked_reason.trim())))
    && Array.isArray(evidence.files_changed) && evidence.files_changed.length > 0
    && evidence.files_changed.every((path) => typeof path === "string" && Boolean(path))
    && typeof evidence.diff_stat === "string" && evidence.diff_observed === true
    && commandsAreCanonical && testsAreCanonical && evidence.commit === commit
    && evidence.observed_by === "orchestrator" && evidence.review_ready === deriveReviewReady(evidence)
    && reconciliation && typeof reconciliation === "object" && !Array.isArray(reconciliation)
    && JSON.stringify(Object.keys(reconciliation).sort()) === JSON.stringify(["claimed", "mismatches"])
    && reconciliation.claimed === false && Array.isArray(reconciliation.mismatches)
    && reconciliation.mismatches.length === 0;
}

export function readPostMergeReverifications(runDir, run) {
  // False-green enforcement: malformed reserved history can never become command or publication authority.
  let journal = "";
  try {
    journal = readFileSync(join(runDir, "artifacts", "post-merge-repairs.md"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const records = new Map();
  const markerLines = journal.split("\n").filter((entry) => entry.startsWith("Reverify-v1"));
  if (markerLines.some((line) => !line.startsWith(MARKER))) throw new Error("post-merge repair re-verification marker is malformed");
  for (const line of markerLines) {
    let marker;
    try { marker = JSON.parse(line.slice(MARKER.length)); }
    catch { throw new Error("post-merge repair re-verification marker is malformed"); }
    const keys = ["record_id", "merge_commit", "trigger", "status"];
    const triggerKeys = ["command", "timeout_ms"];
    const match = RECORD.exec(marker?.record_id ?? "");
    if (JSON.stringify(Object.keys(marker ?? {})) !== JSON.stringify(keys)
      || JSON.stringify(Object.keys(marker?.trigger ?? {})) !== JSON.stringify(triggerKeys)
      || !match || marker.merge_commit !== match[1] || marker.status !== "needs-human"
      || typeof marker.trigger.command !== "string" || !marker.trigger.command.trim()
      || !Number.isSafeInteger(marker.trigger.timeout_ms) || marker.trigger.timeout_ms < 1) {
      throw new Error("post-merge repair re-verification marker is noncanonical");
    }
    if (!run.slices.some((slice) => slice.merge_commit !== null && slice.merge_commit === marker.merge_commit)) {
      throw new Error(`post-merge repair '${marker.record_id}' names an unrecorded merge`);
    }
    if (records.has(marker.record_id)) throw new Error(`duplicate post-merge repair '${marker.record_id}'`);
    records.set(marker.record_id, { recordId: marker.record_id, mergeCommit: marker.merge_commit, trigger: marker.trigger, evidence: [] });
  }

  let names;
  try { names = readdirSync(join(runDir, "evidence")); }
  catch (error) { throw new Error(`post-merge repair evidence could not be inventoried: ${error.message}`); }
  for (const name of names.filter((entry) => entry.startsWith(PREFIX))) {
    const match = FILE.exec(name);
    if (!match) throw new Error(`malformed reserved post-merge repair evidence filename '${name}'`);
    const record = records.get(match[1]);
    if (!record) throw new Error(`post-merge repair evidence '${name}' has no matching marker`);
    let evidence;
    try { evidence = JSON.parse(readFileSync(join(runDir, "evidence", name), "utf8")); }
    catch { throw new Error(`post-merge repair evidence '${name}' is malformed`); }
    const attempt = Number(match[2]);
    const baseRef = run.slices.find((slice) => Array.isArray(slice.depends_on) && slice.depends_on.length === 0)?.base_ref;
    const worktree = resolve(runDir, "..", "..", run.worktree);
    if (!canonicalObservedEvidence(evidence, {
      runId: run.run_id, branch: run.branch, baseRef, worktree, commit: record.mergeCommit,
      command: record.trigger.command, subject: `repair-reverify:${record.recordId}`, attempt,
    })) {
      throw new Error(`post-merge repair evidence '${name}' is noncanonical`);
    }
    record.evidence.push({ attempt, passed: evidence.tests.observed === true && evidence.tests.exit === 0 && evidence.review_ready === true });
  }

  const unresolved = [];
  for (const record of records.values()) {
    record.evidence.sort((left, right) => left.attempt - right.attempt);
    if (record.evidence.some((item, index) => item.attempt !== index + 1)) throw new Error(`post-merge repair '${record.recordId}' has gapped or duplicate attempts`);
    const passed = record.evidence.findIndex((item) => item.passed);
    if (passed >= 0 && passed !== record.evidence.length - 1) throw new Error(`post-merge repair '${record.recordId}' has evidence after its first pass`);
    if (passed < 0) unresolved.push({ recordId: record.recordId, mergeCommit: record.mergeCommit, trigger: record.trigger, nextAttempt: record.evidence.length + 1 });
  }
  if (unresolved.length > 1) throw new Error("more than one eligible post-merge repair is unresolved");
  return { unresolved: unresolved[0] ?? null };
}
