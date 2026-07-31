// The package's entire public surface for consumers (the opencode plugin, the TUI):
// a read-only reader plus the schema. Anything that mutates goes through the CLI.
//
// Finding 6: `transition` used to be exported from here, and package.json exposes
// this module as the package root — so the public API handed out mutation authority
// while claiming to be read-only. It now lives in ./transition.js, which is not
// exported from package.json and is imported only by bin/factory.js.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_NAMES, TERMINAL_STATUSES, validateRun } from "./schema.js";

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

// The single answer to "what happens next". Both `factory status` and the opencode
// sidebar need it, and two implementations of resume order would drift — which is the
// defect class this codebase keeps finding. Read-only, so it belongs here.
//
// Resume: the first thing a returning session needs to know. Mirrors viso's
// resume rules — a pending gate re-presents, a running slice re-observes, an
// unaccepted step re-runs.
export function nextAction(run) {
  if (TERMINAL_STATUSES.includes(run.status)) return `terminal:${run.status}`;
  const openStep = run.steps.find((step) => step.status !== "accepted");
  for (const name of GATE_NAMES) {
    const gate = run.gates[name];
    // `pending` waits on a human; absent means the phase has not been reached, which is
    // still not "done". But naming an absent gate while an agent is mid-round reads as
    // "waiting on you" — so the open step, the work actually happening, is named instead.
    if (gate === undefined) return openStep ? `step:${openStep.agent}` : `gate:${name}`;
    if (gate.status === "pending") return `gate:${name}`;
    if (gate.status === "stop") return `stopped-at-gate:${name}`;
    if (gate.status === "changes") return `changes-at-gate:${name}`;
  }
  const blockedSlice = run.slices.find((slice) => slice.status === "blocked");
  if (blockedSlice) return `blocked-slice:${blockedSlice.id}`;
  const activeSlice = run.slices.find((slice) => ["running", "review"].includes(slice.status));
  if (activeSlice) return `observe-slice:${activeSlice.id}`;
  const pendingSlice = run.slices.find((slice) => slice.status === "pending");
  if (pendingSlice) return `dispatch-slice:${pendingSlice.id}`;
  if (openStep) return `step:${openStep.agent}`;
  if (!run.pr_url) return "pr";
  return "complete";
}
