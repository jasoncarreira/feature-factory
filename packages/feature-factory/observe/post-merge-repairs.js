import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveReviewReady, EVIDENCE_KEYS } from "./index.js";

const SHA = "[0-9a-f]{40}";
const RECORD = new RegExp(`^repair-(${SHA})-([1-9][0-9]*)$`, "u");
const FILE = new RegExp(`^post-merge-repair-reverify-(repair-${SHA}-[1-9][0-9]*)-attempt-([1-9][0-9]*)\\.json$`, "u");
const PREFIX = "post-merge-repair-reverify-";
const MARKER = "Reverify-v1: ";

export function readPostMergeReverifications(runDir, run) {
  let journal = "";
  try { journal = readFileSync(join(runDir, "artifacts", "post-merge-repairs.md"), "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
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
    if (JSON.stringify(Object.keys(evidence ?? {})) !== JSON.stringify(EVIDENCE_KEYS)
      || evidence.subject !== `repair-reverify:${record.recordId}` || evidence.run_id !== run.run_id
      || evidence.attempt !== attempt || evidence.branch !== run.branch || evidence.commit !== record.mergeCommit
      || evidence.status !== "completed" || evidence.observed_by !== "orchestrator"
      || evidence.tests?.cmd !== record.trigger.command || evidence.tests?.skipped_reason !== null
      || typeof evidence.tests?.observed !== "boolean"
      || !((evidence.tests.observed && Number.isInteger(evidence.tests.exit))
        || (!evidence.tests.observed && evidence.tests.exit === null))
      || typeof evidence.review_ready !== "boolean" || evidence.review_ready !== deriveReviewReady(evidence)) {
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
