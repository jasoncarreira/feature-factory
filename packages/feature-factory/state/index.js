// The package's entire public surface for consumers (the opencode plugin, the
// TUI): a read-only reader plus the schema. Anything that mutates goes through
// the CLI. If a consumer needs more than this, the package boundary is wrong.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRun } from "./schema.js";
import { coordinateRunJsonTransition } from "../core/write-core.js";
import { FAMILY_CONTRACTS } from "../core/contracts.js";

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

// The single write path. Every CLI command is one call to this.
//
//   lock -> read -> validate -> apply -> validate -> re-read+compare (CAS) -> rename
//
// `apply` receives a structured clone and returns the next state. It never sees
// the lock, the file, or the rename.
export async function transition(runDir, { participants, apply, reobservers, lockOptions, hooks } = {}) {
  const descriptor = Object.freeze({
    participants: Object.freeze((participants ?? []).map((entry) => Object.freeze({ ...entry }))),
    apply,
  });
  return coordinateRunJsonTransition(runDir, {
    contracts: FAMILY_CONTRACTS,
    descriptor,
    validateEnvelope: validateRun,
    reobservers: reobservers ?? new Map(),
    lockOptions: lockOptions ?? {},
    atomicWriteHooks: hooks,
  });
}
