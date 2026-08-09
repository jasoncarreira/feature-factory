// run.json adds mode, terminal_result, and pr_base to the inherited fifteen-field baseline.
// pr_base comes from init, is immutable through the envelope, and feeds status and Step 6.
// mode preserves autonomous intent; terminal_result records why a run stopped.
// base_commit was removed because no consumer used it and existing refs answer its questions.
// Every durable field needs a source, immutable route, and consumer.
// Closed key sets reject unknown agent-produced state instead of warning.

export const SCHEMA_VERSION = 1;

// Where run state lives, relative to the repository. Was `.claude/factory`, and the privileged-path
// list hedged with `.opencode/factory` too: two host dotfiles in a host-agnostic package.
export const CONTROL_PLANE = ".factory";

export const RUN_KEYS = Object.freeze([
  "version", "run_id", "issue_key", "branch", "worktree", "pr_base", "pr_draft", "created_at", "updated_at",
  "status", "mode", "max_parallel_slices", "max_retries",
  "gates", "steps", "slices", "validator", "terminal_result", "pr_url",
  // Digest of the plan bytes the brief gate approved, so the seed ratifies that plan and not a
  // later edit of the same filename. See the check in `slices-seed`.
  "plan_digest",
  "bootstrap_command", "bootstrap_exit",
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
  //
  // test_plan is ratified the same way and for the same reason. It replaced
  // `observe --skip-tests-reason`, under which the orchestrator authored its own excuse
  // for shipping an untested slice at the moment of observation - and any nonempty
  // string was accepted, so "no tests needed" was a valid one. Whether a slice needs
  // tests is a decision the decompose gate makes: a nonempty test_plan means an observed
  // green run is required, and an empty one is an approved exemption. Empty by omission
  // is not possible, because the field is required.
  "paths", "path_amendments", "test_plan", "base_ref", "evidence_ref", "review_ref", "merge_commit",
]);
const PATH_AMENDMENT_KEYS = Object.freeze(["added_paths", "reason", "session", "at"]);

export const VALIDATOR_VERDICTS = Object.freeze(["GO", "GO-WITH-NITS", "NO-GO"]);
// reviewed_head is the fourth field, justified by attack 4: a verdict that does not
// name the head it judged cannot be refused once that head moves.
export const VALIDATOR_KEYS = Object.freeze(["verdict", "report", "reviewed_head", "loops"]);
export const TERMINAL_RESULT_KEYS = Object.freeze(["status", "reason"]);

// Finding 2: an invalid evidence ref was only rejected when consumed at merge, so a
// foreign path could be recorded into run.json and sit there looking legitimate. Refs
// are admitted at store time: run-local, no traversal, no absolute paths, and under
// the directory that owns them.
const REF_DIRS = Object.freeze({ evidence_ref: "evidence", review_ref: "reviews" });

function runLocalRef(errors, holder, key, path) {
  const value = holder[key];
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return;
  }
  const parts = value.split(/[\\/]/u);
  if (value.startsWith("/") || parts.includes("..") || parts.includes(".")) {
    errors.push({ path: `${path}.${key}`, message: "must be run-local without traversal" });
    return;
  }
  const dir = REF_DIRS[key];
  if (dir && !value.startsWith(`${dir}/`)) {
    errors.push({ path: `${path}.${key}`, message: `must be under ${dir}/` });
  }
}

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
  for (const key of ["issue_key", "pr_base", "pr_url", "plan_digest"]) optionalString(errors, run, key, "run");
  if (Object.hasOwn(run, "pr_draft") && typeof run.pr_draft !== "boolean") {
    errors.push({ path: "run.pr_draft", message: "must be a boolean" });
  }
  if (Object.hasOwn(run, "bootstrap_command") !== Object.hasOwn(run, "bootstrap_exit")) {
    errors.push({ path: "run.bootstrap_command", message: "must be present exactly when bootstrap_exit is present" });
  } else if (Object.hasOwn(run, "bootstrap_command")) {
    required(errors, run, "bootstrap_command", "run");
    if (run.bootstrap_exit !== null) nonNegativeInt(errors, run, "bootstrap_exit", "run");
  }

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
    for (const key of ["review_ref", "evidence_ref"]) runLocalRef(errors, step, key, path);
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
    for (const key of ["evidence_ref", "review_ref"]) runLocalRef(errors, slice, key, path);
    if (slice.base_ref !== null && slice.base_ref !== undefined) optionalPattern(errors, slice, "base_ref", SHA, path);
    // Finding 3: requiring base_ref only at "merged" let a slice run and review with
    // none, then receive its first value on the merge transition - chosen after the
    // fact to exclude earlier commits from the ownership diff. The branch point is a
    // fact established when the slice is activated, so it is required from the moment
    // the slice leaves "pending".
    if (slice.status !== "pending" && !SHA.test(String(slice.base_ref))) {
      errors.push({ path: `${path}.base_ref`, message: `is required once a slice is ${slice.status}` });
    }
    if (slice.merge_commit !== null && slice.merge_commit !== undefined) {
      optionalPattern(errors, slice, "merge_commit", SHA, path);
    }
    // An array, possibly empty - empty is the approved exemption - but never absent, so a
    // slice cannot acquire an exemption by omitting the field.
    if (!Array.isArray(slice.test_plan) || !slice.test_plan.every((entry) => stringValue(entry))) {
      errors.push({ path: `${path}.test_plan`, message: "must be an array of strings; empty means tests were waived at the gate" });
    }
    if (!Array.isArray(slice.paths) || slice.paths.length === 0 || !slice.paths.every((entry) => stringValue(entry))) {
      errors.push({ path: `${path}.paths`, message: "must be a non-empty array of paths" });
    } else if (slice.paths.some((entry) => !repositoryRelativePath(entry))) {
      // A declared path that escapes the repository would make ownership
      // unenforceable, so it is refused at admission rather than at merge.
      errors.push({ path: `${path}.paths`, message: "must be repository-relative without '..'" });
    }
    pathAmendments(errors, slice, path);
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

function pathAmendments(errors, slice, path) {
  if (slice.path_amendments === undefined) return;
  if (!Array.isArray(slice.path_amendments)) {
    errors.push({ path: `${path}.path_amendments`, message: "must be an array" });
    return;
  }
  const recorded = new Set();
  const currentPaths = Array.isArray(slice.paths) ? slice.paths : [];
  slice.path_amendments.forEach((amendment, index) => {
    const amendmentPath = `${path}.path_amendments[${index}]`;
    if (!object(errors, amendment, amendmentPath, PATH_AMENDMENT_KEYS)) return;
    for (const key of ["reason", "session"]) required(errors, amendment, key, amendmentPath);
    pattern(errors, amendment, "at", ISO, amendmentPath);
    if (!Array.isArray(amendment.added_paths) || amendment.added_paths.length === 0
      || !amendment.added_paths.every((entry) => repositoryRelativePath(entry))) {
      errors.push({ path: `${amendmentPath}.added_paths`, message: "must be a non-empty array of repository-relative paths without '..'" });
      return;
    }
    for (const added of amendment.added_paths) {
      if (recorded.has(added)) errors.push({ path: `${amendmentPath}.added_paths`, message: `duplicate recorded path '${added}'` });
      recorded.add(added);
      if (!currentPaths.includes(added)) errors.push({ path: `${amendmentPath}.added_paths`, message: `recorded path '${added}' must exist in slice paths` });
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
  if (value.status !== status && !(status === "running" && value.status === "needs-human")) {
    errors.push({ path: "run.terminal_result.status", message: "must match run.status or preserve a resumed needs-human result" });
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

export function repositoryRelativePath(value) {
  return stringValue(value) && !value.startsWith("/") && !value.split("/").includes("..");
}
