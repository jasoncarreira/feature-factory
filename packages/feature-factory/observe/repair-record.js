import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { git, privilegedPaths } from "./index.js";
import { parseRepositoryConfig } from "./repository-config.js";
import { repositoryRelativePath, validateRun } from "../state/schema.js";

export const REPAIR_JOURNAL_REF = "artifacts/post-merge-repairs.md";
export const REPAIR_EVIDENCE_PREFIX = "repair-reverification.";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RECORD_ID = /^repair-([0-9a-f]{40})-([1-9][0-9]*)$/u;
const JOURNAL_KEYS = ["version", "records"];
const RECORD_KEYS = ["record_id", "introducing_merge", "attempt", "starting_head", "trigger", "trigger_result", "test_paths", "cause", "property_outcome", "repair_commit", "post_repair_result", "status"];
const MARKER_KEYS = ["version", "run_id", "record_id", "attempt", "run_sha256", "journal_sha256", "record_sha256", "introducing_merge", "repair_commit", "trigger", "started_at"];
const RESULT_KEYS = ["version", "run_id", "record_id", "attempt", "marker_sha256", "run_sha256", "journal_sha256", "record_sha256", "introducing_merge", "repair_commit", "trigger", "result", "observed_at", "observed_by"];
const STATUSES = ["planned", "committed", "verified", "failed", "exhausted", "needs-human"];

const fail = (message) => { throw new Error(`repair state is invalid: ${message}`); };
const sameKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const nonblank = (value) => typeof value === "string" && Boolean(value.trim());
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function canonicalFile(path, label, { optional = false } = {}) {
  let stats;
  let bytes;
  try {
    stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} is not a regular non-symlink file`);
    bytes = readFileSync(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (String(error.message).startsWith("repair state is invalid:")) throw error;
    fail(`${label} could not be read: ${error.message}`);
  }
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail(`${label} is not canonical UTF-8 JSON`);
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"))) fail(`${label} bytes are not canonical`);
  return { bytes, value };
}

function validResult(value) {
  return sameKeys(value, ["observed", "exit"])
    && typeof value.observed === "boolean"
    && ((value.observed && Number.isSafeInteger(value.exit) && value.exit >= 0)
      || (!value.observed && value.exit === null));
}

function validateRecord(row, index, run) {
  const label = `journal record ${index + 1}`;
  if (!sameKeys(row, RECORD_KEYS)) fail(`${label} has the wrong key order or shape`);
  const match = RECORD_ID.exec(row.record_id);
  if (!match || !positive(row.attempt) || Number(match[2]) !== row.attempt || !Number.isSafeInteger(Number(match[2]))
    || match[1] !== row.introducing_merge) fail(`${label} has an invalid record binding`);
  if (!SHA.test(row.starting_head) || !STATUSES.includes(row.status)) fail(`${label} has an invalid head or status`);
  if (!sameKeys(row.trigger, ["command", "timeout_ms"]) || !nonblank(row.trigger.command) || !positive(row.trigger.timeout_ms)) {
    fail(`${label} has an invalid trigger`);
  }
  if (!validResult(row.trigger_result) || !row.trigger_result.observed || row.trigger_result.exit === 0) {
    fail(`${label} does not record an observed failing trigger`);
  }
  if (!Array.isArray(row.test_paths) || row.test_paths.length === 0
    || row.test_paths.some((path) => !repositoryRelativePath(path))
    || new Set(row.test_paths).size !== row.test_paths.length
    || !equal(row.test_paths, [...row.test_paths].sort()) || privilegedPaths(row.test_paths).length > 0) {
    fail(`${label} has invalid canonical test paths`);
  }
  if (!nonblank(row.cause) || row.attempt > run.max_retries) fail(`${label} has an invalid cause or exceeds max_retries`);
  const property = nonblank(row.property_outcome);
  const commit = SHA.test(String(row.repair_commit));
  const result = validResult(row.post_repair_result);
  const pass = result && row.post_repair_result.observed && row.post_repair_result.exit === 0;
  const observedFailure = result && row.post_repair_result.observed && row.post_repair_result.exit > 0;
  const unobserved = result && !row.post_repair_result.observed;
  const validShape = (row.status === "planned" && row.property_outcome === null && row.repair_commit === null && row.post_repair_result === null)
    || (row.status === "committed" && property && commit && row.post_repair_result === null)
    || (row.status === "verified" && property && commit && pass)
    || (row.status === "failed" && property && commit && observedFailure)
    || (row.status === "exhausted" && property && commit && observedFailure && row.attempt === run.max_retries)
    || (row.status === "needs-human" && ((row.property_outcome === null && row.repair_commit === null && row.post_repair_result === null)
      || (property && commit && (observedFailure || unobserved))));
  if (!validShape) fail(`${label} has a status-conditioned shape mismatch`);
  return row;
}

function gitValue(repo, args, label) {
  const observed = git(repo, args);
  if (!observed.ok) fail(`${label} could not be observed`);
  return observed.stdout;
}

function validateBindings(repo, row, run) {
  const slices = run.slices.filter((slice) => slice.status === "merged" && slice.merge_commit === row.introducing_merge);
  if (slices.length !== 1) fail(`record '${row.record_id}' introducing merge does not identify exactly one merged slice`);
  if (!git(repo, ["merge-base", "--is-ancestor", row.introducing_merge, row.starting_head]).ok) {
    fail(`record '${row.record_id}' starting head does not descend from its introducing merge`);
  }
  if (row.repair_commit === null) return;
  if (row.repair_commit === row.introducing_merge) fail(`record '${row.record_id}' repair commit equals its introducing merge`);
  const parents = gitValue(repo, ["rev-list", "--parents", "-n", "1", row.repair_commit], `record '${row.record_id}' repair commit`)
    .trim().split(/\s+/u).slice(1);
  if (parents.length !== 1 || parents[0] !== row.starting_head) fail(`record '${row.record_id}' repair commit has the wrong parent`);
  const paths = gitValue(repo, ["--literal-pathspecs", "diff", "--name-only", "--no-renames", "-z", row.starting_head, row.repair_commit], `record '${row.record_id}' repair diff`)
    .split("\0").filter(Boolean).sort();
  if (paths.length === 0 || !equal(paths, row.test_paths)) fail(`record '${row.record_id}' repair diff does not equal test_paths`);
  let config;
  try {
    config = parseRepositoryConfig(gitValue(repo, ["show", `${row.repair_commit}:.factory.json`], `record '${row.record_id}' committed config`));
  } catch (error) {
    fail(`record '${row.record_id}' committed config is invalid: ${error.message}`);
  }
  if (config.command !== row.trigger.command || config.timeoutMs !== row.trigger.timeout_ms) {
    fail(`record '${row.record_id}' trigger does not match its committed config`);
  }
}

function validateJournal(value, run, repo) {
  if (!sameKeys(value, JOURNAL_KEYS) || value.version !== 1 || !Array.isArray(value.records) || value.records.length === 0) {
    fail("journal has the wrong version, key order, or shape");
  }
  const records = value.records.map((row, index) => validateRecord(row, index, run));
  const ids = new Set();
  const chains = new Map();
  let active = 0;
  for (const row of records) {
    if (ids.has(row.record_id)) fail(`duplicate record '${row.record_id}'`);
    ids.add(row.record_id);
    if (["planned", "committed"].includes(row.status)) active += 1;
    const chain = chains.get(row.introducing_merge) ?? [];
    const prior = chain.at(-1);
    if (row.attempt !== chain.length + 1) fail(`record '${row.record_id}' is not the next contiguous attempt`);
    if (prior && (prior.status !== "failed" || row.starting_head !== prior.repair_commit)) {
      fail(`record '${row.record_id}' does not validly follow the prior repair attempt`);
    }
    chain.push(row);
    chains.set(row.introducing_merge, chain);
    validateBindings(repo, row, run);
  }
  if (active > 1) fail("more than one repair record is active");
  return { records, chains };
}

function canonicalTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateMarker(value, row, runId, attempt, label) {
  if (!sameKeys(value, MARKER_KEYS) || value.version !== 1 || value.run_id !== runId
    || value.record_id !== row.record_id || value.attempt !== attempt
    || !DIGEST.test(value.run_sha256) || !DIGEST.test(value.journal_sha256)
    || value.record_sha256 !== digest(row) || value.introducing_merge !== row.introducing_merge
    || value.repair_commit !== row.repair_commit || !equal(value.trigger, row.trigger)
    || !sameKeys(value.trigger, ["command", "timeout_ms"]) || !canonicalTimestamp(value.started_at)) {
    fail(`${label} has an invalid marker binding or schema`);
  }
}

function validateExecutionResult(value) {
  return sameKeys(value, ["observed", "exit", "commit", "worktree_clean"])
    && typeof value.observed === "boolean"
    && ((value.observed && Number.isSafeInteger(value.exit) && value.exit >= 0) || (!value.observed && value.exit === null))
    && (value.commit === null || SHA.test(value.commit)) && typeof value.worktree_clean === "boolean";
}

function validateResult(value, marker, row, runId, attempt, label) {
  if (!sameKeys(value, RESULT_KEYS) || value.version !== 1 || value.run_id !== runId
    || value.record_id !== row.record_id || value.attempt !== attempt || value.marker_sha256 !== digest(marker)
    || value.run_sha256 !== marker.run_sha256 || value.journal_sha256 !== marker.journal_sha256
    || value.record_sha256 !== marker.record_sha256 || value.introducing_merge !== marker.introducing_merge
    || value.repair_commit !== marker.repair_commit || !equal(value.trigger, marker.trigger)
    || !sameKeys(value.trigger, ["command", "timeout_ms"]) || !validateExecutionResult(value.result)
    || !canonicalTimestamp(value.observed_at) || value.observed_at !== marker.started_at || value.observed_by !== "factory") {
    fail(`${label} has an invalid result binding or schema`);
  }
}

function evidenceEntries(runDir) {
  const dir = join(runDir, "evidence");
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    fail(`evidence directory could not be inspected: ${error.message}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("evidence path is not a regular directory");
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().startsWith(REPAIR_EVIDENCE_PREFIX)).sort();
  } catch (error) {
    fail(`evidence directory could not be read: ${error.message}`);
  }
}

function validateInventory(runDir, runId, records) {
  const rows = new Map(records.map((row) => [row.record_id, row]));
  const histories = new Map();
  const filename = /^repair-reverification\.(repair-[0-9a-f]{40}-[1-9][0-9]*)\.([1-9][0-9]*)(\.started)?\.json$/u;
  for (const name of evidenceEntries(runDir)) {
    const match = filename.exec(name);
    if (!match) fail(`evidence entry '${name}' has a malformed repair re-verification name`);
    const row = rows.get(match[1]);
    const attempt = Number(match[2]);
    if (!row || !positive(attempt) || !(row.status === "needs-human" && row.repair_commit !== null)) {
      fail(`evidence entry '${name}' does not identify an eligible repair record`);
    }
    const history = histories.get(row.record_id) ?? { markers: new Map(), results: new Map(), names: [] };
    const kind = match[3] ? "markers" : "results";
    const parsed = canonicalFile(join(runDir, "evidence", name), `evidence '${name}'`).value;
    if (history[kind].has(attempt)) fail(`evidence entry '${name}' duplicates an attempt`);
    history[kind].set(attempt, parsed);
    history.names.push(name);
    histories.set(row.record_id, history);
  }
  for (const [recordId, history] of histories) {
    const row = rows.get(recordId);
    const attempts = [...history.markers.keys()].sort((a, b) => a - b);
    if (attempts.some((attempt, index) => attempt !== index + 1)) fail(`evidence for '${recordId}' has a marker gap`);
    if ([...history.results.keys()].some((attempt) => !history.markers.has(attempt))) fail(`evidence for '${recordId}' has a result without its marker`);
    let pass = null;
    for (const attempt of attempts) {
      const marker = history.markers.get(attempt);
      validateMarker(marker, row, runId, attempt, `evidence marker for '${recordId}' attempt ${attempt}`);
      const result = history.results.get(attempt);
      if (result) {
        validateResult(result, marker, row, runId, attempt, `evidence result for '${recordId}' attempt ${attempt}`);
        const qualifies = result.result.observed && result.result.exit === 0
          && result.result.commit === row.repair_commit && result.result.worktree_clean;
        if (qualifies) {
          if (pass !== null) fail(`evidence for '${recordId}' contains a second pass`);
          pass = attempt;
        }
      } else if (attempt !== attempts.at(-1)) fail(`evidence for '${recordId}' has a non-final marker-only attempt`);
    }
    if (pass !== null && (pass !== attempts.at(-1) || !history.results.has(pass))) fail(`evidence for '${recordId}' continues after its first pass`);
    history.attempts = attempts.length;
    history.tail = attempts.length > 0 && !history.results.has(attempts.at(-1));
    history.pass = pass;
    history.names.sort();
  }
  return histories;
}

export function readRepairState({ runDir, state = null, runId, repo, recordId = null } = {}) {
  let runBytes;
  let rawRun;
  try {
    runBytes = readFileSync(join(runDir, "run.json"));
    rawRun = validateRun(JSON.parse(runBytes.toString("utf8")));
  } catch (error) {
    fail(`run.json could not be validated: ${error.message}`);
  }
  const run = validateRun(state ?? rawRun);
  if (run.run_id !== runId || rawRun.run_id !== runId) fail(`run ID does not equal loaded run_id '${rawRun.run_id}'`);
  const journalPath = join(runDir, REPAIR_JOURNAL_REF);
  const journalFile = canonicalFile(journalPath, REPAIR_JOURNAL_REF, { optional: true });
  if (!journalFile) {
    const inventory = validateInventory(runDir, runId, []);
    if (recordId !== null) fail(`repair journal is absent; record '${recordId}' does not exist`);
    return { run, runBytes, journal: null, journalBytes: null, records: [], chains: new Map(), inventory, selected: null };
  }
  if (!repo) fail("repository is required to validate the repair journal");
  const { records, chains } = validateJournal(journalFile.value, run, repo);
  const inventory = validateInventory(runDir, runId, records);
  let selected = null;
  if (recordId !== null) {
    const matches = records.filter((row) => row.record_id === recordId);
    if (matches.length !== 1) fail(`record '${recordId}' does not identify exactly one journal row`);
    selected = matches[0];
    if (chains.get(selected.introducing_merge)?.at(-1) !== selected
      || selected.status !== "needs-human" || selected.repair_commit === null) {
      fail(`record '${recordId}' is not the latest eligible post-commit needs-human row`);
    }
  }
  return { run, runBytes, journal: journalFile.value, journalBytes: journalFile.bytes,
    records, chains, inventory, selected, selectedHistory: selected ? inventory.get(recordId) ?? { markers: new Map(), results: new Map(), names: [], attempts: 0, tail: false, pass: null } : null };
}

export function assertRepairPublicationReady(options) {
  const observed = readRepairState(options);
  let tested = null;
  for (const chain of observed.chains.values()) {
    const row = chain.at(-1);
    const history = observed.inventory.get(row.record_id);
    const effective = row.status === "verified" || (row.status === "needs-human" && history?.pass !== null && history?.pass !== undefined);
    if (!effective) throw new Error(`repair record '${row.record_id}' remains ${row.status} and blocks publication`);
    if (row.status === "needs-human" && history?.pass && row.repair_commit === options.head) tested = row.repair_commit;
  }
  return { tested, observed };
}
