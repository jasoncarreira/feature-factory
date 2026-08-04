// The sole run.json write path is private to bin/factory.js.
// The package root exports reads, preserving the plugin's read-only boundary.
//
//   lock -> read -> validate -> apply -> validate -> CAS -> reobserve -> CAS -> rename
//
// Contracts validate every family before atomic rename replacement.
// `apply` receives a structured clone, never the lock, file, or rename.
// Initialization is the only write outside this path and uses create-only publication.
import { validateRun } from "./schema.js";
import { coordinateRunJsonTransition } from "../core/write-core.js";
import { FAMILY_CONTRACTS } from "../core/contracts.js";

export async function transition(runDir, { participants, apply, reobservers, hooks } = {}) {
  const descriptor = Object.freeze({
    participants: Object.freeze((participants ?? []).map((entry) => Object.freeze({ ...entry }))),
    apply,
  });
  return coordinateRunJsonTransition(runDir, {
    contracts: FAMILY_CONTRACTS,
    descriptor,
    validateRun,
    reobservers: reobservers ?? new Map(),
    atomicWriteHooks: hooks,
  });
}
