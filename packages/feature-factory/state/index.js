// The package's entire public surface for consumers (the opencode plugin, the TUI):
// a read-only reader plus the schema. Anything that mutates goes through the CLI.
//
// Finding 6: `transition` used to be exported from here, and package.json exposes
// this module as the package root — so the public API handed out mutation authority
// while claiming to be read-only. It now lives in ./transition.js, which is not
// exported from package.json and is imported only by bin/factory.js.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRun } from "./schema.js";

export { validateRun, SchemaError, RUN_KEYS, SCHEMA_VERSION, RUN_STATUSES, TERMINAL_STATUSES, MODES,
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
