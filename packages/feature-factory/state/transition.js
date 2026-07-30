// The single write path. Deliberately NOT part of the package's public exports:
// package.json exposes state/index.js as the root, and handing consumers a mutation
// entry point would contradict the read-only boundary the plugin package relies on.
// Only bin/factory.js imports this.
//
//   lock -> read -> validate -> apply -> validate -> CAS -> reobserve -> CAS -> rename
//
// `apply` receives a structured clone and returns the next state. It never sees the
// lock, the file, or the rename.
import { validateRun } from "./schema.js";
import { coordinateRunJsonTransition } from "../core/write-core.js";
import { FAMILY_CONTRACTS } from "../core/contracts.js";

// The single write path. Every CLI command is one call to this.
//
//   lock -> read -> validate -> apply -> validate -> re-read+compare (CAS) -> rename
//
// `apply` receives a structured clone and returns the next state. It never sees
// the lock, the file, or the rename.
export async function transition(runDir, { participants, apply, reobservers, hooks } = {}) {
  const descriptor = Object.freeze({
    participants: Object.freeze((participants ?? []).map((entry) => Object.freeze({ ...entry }))),
    apply,
  });
  return coordinateRunJsonTransition(runDir, {
    contracts: FAMILY_CONTRACTS,
    descriptor,
    validateEnvelope: validateRun,
    reobservers: reobservers ?? new Map(),
    atomicWriteHooks: hooks,
  });
}
