// run.json — viso's 15 fields plus exactly three justified additions.
//
//   mode            required by autonomy; changes gate handling
//   terminal_result "check later" needs a machine-readable why
//   base_commit     the merge proof needs the base the reviewed tree derives from
//
// Closed key sets everywhere. An unknown key is a rejection, not a warning: the
// whole reason this package exists is that agents cannot be trusted to produce a
// schema-perfect record, so the schema is the thing that refuses.

export const SCHEMA_VERSION = 1;

export const RUN_KEYS = Object.freeze([
  "version", "run_id", "jira_key", "branch", "worktree", "created_at", "updated_at",
  "status", "mode", "max_parallel_slices", "max_retries", "base_commit",
  "gates", "steps", "slices", "validator", "terminal_result", "pr_url",
]);

export const RUN_STATUSES = Object.freeze(["running", "completed", "blocked", "partial", "needs-human"]);
export const TERMINAL_STATUSES = Object.freeze(["completed", "blocked", "partial", "needs-human"]);
export const MODES = Object.freeze(["interactive", "headless", "autonomous"]);

export const GATE_NAMES = Object.freeze(["story", "brief", "pre_pr"]);
export const GATE_STATUSES = Object.freeze(["pending", "approved", "changes", "stop"]);
export const GATE_KEYS = Object.freeze(["status", "at", "artifact"]);

export const STEP_STATUSES = Object.freeze(["running", "accepted", "rejected", "blocked"]);
export const STEP_KEYS = Object.freeze(["agent", "status", "attempts", "review_ref", "evidence_ref"]);

export const SLICE_STATUSES = Object.freeze(["pending", "running", "review", "merged", "blocked"]);
export const SLICE_KEYS = Object.freeze([
  "id", "stack", "depends_on", "status", "worktree", "branch", "attempts",
  // `paths` is the ratified ownership declaration, seeded from plan/slices.json at
  // the decompose gate. It lives here rather than being re-read from the plan at
  // merge time so the set a transition validates against is the set the gate
  // approved, and so ownership is decidable from run.json alone.
  // base_ref is the integration head the slice branched from, recorded when it is
  // dispatched. Without it a slice's own diff is undecidable after the merge - the
  // integration branch by then contains the slice, so diffing against it is empty
  // and every ownership check would silently pass.
  "paths", "base_ref", "evidence_ref", "review_ref", "merge_commit",
]);

export const VALIDATOR_VERDICTS = Object.freeze(["GO", "GO-WITH-NITS", "NO-GO"]);
// reviewed_head is the fourth field, justified by attack 4: a verdict that does not
// name the head it judged cannot be refused once that head moves.
export const VALIDATOR_KEYS = Object.freeze(["verdict", "report", "reviewed_head", "loops"]);
export const TERMINAL_RESULT_KEYS = Object.freeze(["status", "reason"]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SHA = /^[0-9a-f]{40}$/u;
const ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export class SchemaError extends Error {
  constructor(errors) {
    super(errors.map(({ path, message }) => `${path}: ${message}`).join("; "));
    this.name = "SchemaError";
    this.errors = errors;
  }
}

export function validateRun(run) {
  const errors = [];
  object(errors, run, "run", RUN_KEYS);
  if (errors.length) throw new SchemaError(errors);

  if (run.version !== SCHEMA_VERSION) errors.push({ path: "run.version", message: `must be ${SCHEMA_VERSION}` });
  pattern(errors, run, "run_id", ID, "run");
  enumValue(errors, run, "status", RUN_STATUSES, "run");
  enumValue(errors, run, "mode", MODES, "run");
  for (const key of ["branch", "worktree"]) required(errors, run, key, "run");
  for (const key of ["created_at", "updated_at"]) pattern(errors, run, key, ISO, "run");
  for (const key of ["max_parallel_slices", "max_retries"]) positiveInt(errors, run, key, "run");
  optionalPattern(errors, run, "base_commit", SHA, "run");
  for (const key of ["jira_key", "pr_url"]) optionalString(errors, run, key, "run");

  gates(errors, run.gates);
  steps(errors, run.steps);
  slices(errors, run.slices);
  validator(errors, run.validator);
  terminalResult(errors, run.terminal_result, run.status);

  if (errors.length) throw new SchemaError(errors);
  return run;
}

function gates(errors, value) {
  if (!isRecord(value)) return void errors.push({ path: "run.gates", message: "must be an object" });
  const unknown = Object.keys(value).filter((key) => !GATE_NAMES.includes(key));
  if (unknown.length) errors.push({ path: "run.gates", message: `unknown gates: ${unknown.join(", ")}` });
  for (const name of GATE_NAMES) {
    const gate = value[name];
    if (gate === undefined) continue;
    const path = `run.gates.${name}`;
    if (!object(errors, gate, path, GATE_KEYS)) continue;
    enumValue(errors, gate, "status", GATE_STATUSES, path);
    if (gate.at !== null) optionalPattern(errors, gate, "at", ISO, path);
    if (gate.artifact !== undefined && gate.artifact !== null) optionalString(errors, gate, "artifact", path);
  }
}

function steps(errors, value) {
  if (!Array.isArray(value)) return void errors.push({ path: "run.steps", message: "must be an array" });
  const seen = new Set();
  value.forEach((step, index) => {
    const path = `run.steps[${index}]`;
    if (!object(errors, step, path, STEP_KEYS)) return;
    required(errors, step, "agent", path);
    enumValue(errors, step, "status", STEP_STATUSES, path);
    positiveInt(errors, step, "attempts", path);
    for (const key of ["review_ref", "evidence_ref"]) nullableString(errors, step, key, path);
    if (seen.has(step.agent)) errors.push({ path: `${path}.agent`, message: "duplicate step agent" });
    seen.add(step.agent);
  });
}

function slices(errors, value) {
  if (!Array.isArray(value)) return void errors.push({ path: "run.slices", message: "must be an array" });
  const ids = new Set(value.filter(isRecord).map((slice) => slice.id));
  // Finding 5: the id set existed only for dependency validation, so two slices could
  // share an id. Every later update maps by id and would then hit both rows.
  const seenIds = new Set();
  for (const slice of value.filter(isRecord)) {
    if (seenIds.has(slice.id)) errors.push({ path: "run.slices", message: `duplicate slice id '${slice.id}'` });
    seenIds.add(slice.id);
  }
  value.forEach((slice, index) => {
    const path = `run.slices[${index}]`;
    if (!object(errors, slice, path, SLICE_KEYS)) return;
    pattern(errors, slice, "id", ID, path);
    required(errors, slice, "stack", path);
    enumValue(errors, slice, "status", SLICE_STATUSES, path);
    positiveInt(errors, slice, "attempts", path);
    for (const key of ["worktree", "branch"]) nullableString(errors, slice, key, path);
    for (const key of ["evidence_ref", "review_ref"]) nullableString(errors, slice, key, path);
    if (slice.base_ref !== null && slice.base_ref !== undefined) optionalPattern(errors, slice, "base_ref", SHA, path);
    if (slice.status === "merged" && !SHA.test(String(slice.base_ref))) {
      errors.push({ path: `${path}.base_ref`, message: "is required when a slice is merged" });
    }
    if (slice.merge_commit !== null && slice.merge_commit !== undefined) {
      optionalPattern(errors, slice, "merge_commit", SHA, path);
    }
    if (!Array.isArray(slice.paths) || slice.paths.length === 0 || !slice.paths.every((entry) => stringValue(entry))) {
      errors.push({ path: `${path}.paths`, message: "must be a non-empty array of paths" });
    } else if (slice.paths.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      // A declared path that escapes the repository would make ownership
      // unenforceable, so it is refused at admission rather than at merge.
      errors.push({ path: `${path}.paths`, message: "must be repository-relative without '..'" });
    }
    if (!Array.isArray(slice.depends_on)) {
      errors.push({ path: `${path}.depends_on`, message: "must be an array" });
    } else {
      for (const dep of slice.depends_on) {
        if (!ids.has(dep)) errors.push({ path: `${path}.depends_on`, message: `unknown slice '${dep}'` });
        if (dep === slice.id) errors.push({ path: `${path}.depends_on`, message: "slice cannot depend on itself" });
      }
    }
    // A merged slice must record what it merged; otherwise the merge proof has
    // nothing to bind to.
    if (slice.status === "merged" && !SHA.test(String(slice.merge_commit))) {
      errors.push({ path: `${path}.merge_commit`, message: "is required when a slice is merged" });
    }
  });
}

function validator(errors, value) {
  if (value === null || value === undefined) return;
  if (!object(errors, value, "run.validator", VALIDATOR_KEYS)) return;
  enumValue(errors, value, "verdict", VALIDATOR_VERDICTS, "run.validator");
  nullableString(errors, value, "report", "run.validator");
  pattern(errors, value, "reviewed_head", SHA, "run.validator");
  nonNegativeInt(errors, value, "loops", "run.validator");
}

function terminalResult(errors, value, status) {
  if (value === null || value === undefined) {
    if (TERMINAL_STATUSES.includes(status) && status !== "completed") {
      errors.push({ path: "run.terminal_result", message: `is required when status is ${status}` });
    }
    return;
  }
  if (!object(errors, value, "run.terminal_result", TERMINAL_RESULT_KEYS)) return;
  enumValue(errors, value, "status", TERMINAL_STATUSES, "run.terminal_result");
  required(errors, value, "reason", "run.terminal_result");
  if (value.status !== status) {
    errors.push({ path: "run.terminal_result.status", message: "must match run.status" });
  }
}

function object(errors, value, path, allowed) {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    errors.push({ path, message: `unknown keys: ${unknown.sort().join(", ")}` });
    return false;
  }
  return true;
}

function required(errors, holder, key, path) {
  if (!stringValue(holder[key])) errors.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
}

function optionalString(errors, holder, key, path) {
  if (holder[key] === undefined || holder[key] === null) return;
  required(errors, holder, key, path);
}

function nullableString(errors, holder, key, path) {
  if (holder[key] === null || holder[key] === undefined) return;
  required(errors, holder, key, path);
}

function pattern(errors, holder, key, regex, path) {
  if (typeof holder[key] !== "string" || !regex.test(holder[key])) {
    errors.push({ path: `${path}.${key}`, message: `must match ${regex.source}` });
  }
}

function optionalPattern(errors, holder, key, regex, path) {
  if (holder[key] === undefined || holder[key] === null) return;
  pattern(errors, holder, key, regex, path);
}

function enumValue(errors, holder, key, allowed, path) {
  if (!allowed.includes(holder[key])) {
    errors.push({ path: `${path}.${key}`, message: `must be one of ${allowed.join(" | ")}` });
  }
}

function positiveInt(errors, holder, key, path) {
  if (!Number.isSafeInteger(holder[key]) || holder[key] < 1) {
    errors.push({ path: `${path}.${key}`, message: "must be a positive integer" });
  }
}

function nonNegativeInt(errors, holder, key, path) {
  if (!Number.isSafeInteger(holder[key]) || holder[key] < 0) {
    errors.push({ path: `${path}.${key}`, message: "must be a non-negative integer" });
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
