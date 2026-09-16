// The package's entire public surface for consumers (the opencode plugin, the TUI):
// a read-only reader plus the schema. Anything that mutates goes through the CLI.
//
// Finding 6: `transition` used to be exported from here, and package.json exposes
// this module as the package root — so the public API handed out mutation authority
// while claiming to be read-only. It now lives in ./transition.js, which is not
// exported from package.json and is imported only by bin/factory.js.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_NAMES, validateRun } from "./schema.js";

export { CONTROL_PLANE, validateRun, SchemaError, RUN_KEYS, SCHEMA_VERSION, RUN_STATUSES, TERMINAL_STATUSES, MODES,
  GATE_NAMES, GATE_STATUSES, STEP_STATUSES, SLICE_STATUSES, VALIDATOR_VERDICTS } from "./schema.js";

export function readRun(runDir) {
  return validateRun(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
}

// Read a run without validating, for diagnostics that must describe a broken
// record rather than refuse to load it. Never use this to make a decision.
export function readRunUnchecked(runDir) {
  try {
    return { ok: true, run: JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function nextSliceAction(slices) {
  const blockedSlice = slices.find((slice) => slice.status === "blocked");
  if (blockedSlice) return { kind: "blocked-slice", subject: blockedSlice.id };
  const activeSlice = slices.find((slice) => ["running", "review"].includes(slice.status));
  if (activeSlice) return { kind: "observe-slice", subject: activeSlice.id };
  const pendingSlice = slices.find((slice) => slice.status === "pending");
  return pendingSlice ? { kind: "dispatch-slice", subject: pendingSlice.id } : undefined;
}

// The single answer to "what happens next". Both `factory status` and the opencode
// sidebar need it, and two implementations of resume order would drift — which is the
// defect class this codebase keeps finding. Read-only, so it belongs here.
//
// Resume: the first thing a returning session needs to know. Preserves the inherited
// rules: a pending gate re-presents, a running slice re-observes, an
// unaccepted step re-runs.
// `{kind, subject}`, because the answer is two facts and a consumer that must split a string on `:` to
// recover them is parsing a rendering. `subject` is null for the kinds that name no target.
export function nextActionRecord(run) {
  if (["completed", "partial", "blocked"].includes(run.status)) return { kind: "terminal", subject: run.status };
  const openStep = run.steps.find((step) => step.status !== "accepted");
  const stepAction = openStep ? { kind: "step", subject: openStep.agent } : null;
  const sliceAction = nextSliceAction(run.slices);
  for (const name of GATE_NAMES) {
    const gate = run.gates[name];
    // `pending` waits on a human; absent means the phase has not been reached, which is
    // still not "done". But naming an absent gate while an agent is mid-round reads as
    // "waiting on you" — so existing slice or step work is named instead.
    if (gate === undefined) return sliceAction ?? stepAction ?? { kind: "gate", subject: name };
    if (gate.status === "pending") return { kind: "gate", subject: name };
    if (gate.status === "stop") return { kind: "stopped-at-gate", subject: name };
    if (gate.status === "changes") return { kind: "changes-at-gate", subject: name };
    if (name === "brief" && gate.status === "approved" && run.slices.length === 0) return { kind: "seed-slices", subject: null };
  }
  if (sliceAction) return sliceAction;
  if (stepAction) return stepAction;
  if (!run.pr_url) return { kind: "pr", subject: null };
  return { kind: "complete", subject: null };
}

// The string form is DERIVED from the record rather than computed beside it, so the two cannot disagree.
// Retained because the driver contract, the sidebar and a great deal of prose all name `next: gate:story`,
// and because a human-facing label is a fair thing for a CLI to keep -- as long as it is a projection of
// the structured answer and not a second implementation of it.
export function nextAction(run) {
  const { kind, subject } = nextActionRecord(run);
  return subject === null ? kind : `${kind}:${subject}`;
}
