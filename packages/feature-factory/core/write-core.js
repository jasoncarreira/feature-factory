import { readFile, rename } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { writeProtectedJsonAtomic } from "./atomic-write.js";
import { withRunJsonLock } from "./run-lock.js";

const RUN_FILE = "run.json";

export async function coordinateRunJsonTransition(runDir, options) {
  const {
    contracts,
    descriptor,
    validateEnvelope,
    reobservers = new Map(),
    atomicWriteHooks,
  } = options ?? {};
  const registry = contractRegistry(contracts);
  const participants = participantRegistry(descriptor, registry);
  if (typeof validateEnvelope !== "function") throw new Error("validateEnvelope must be a function");
  if (!(reobservers instanceof Map)) throw new Error("reobservers must be a Map");

  return withRunJsonLock(runDir, async () => {
    const initial = deepFreeze(await readRunState(runDir, validateEnvelope));
    const before = projectAll(registry, initial);
    const applied = descriptor.apply(structuredClone(initial));
    if (!applied || typeof applied !== "object" || Array.isArray(applied)) {
      throw new Error("transition apply must return a state object");
    }
    validateEnvelope(applied);
    const candidate = deepFreeze(applied);
    const after = projectAll(registry, candidate);

    for (const [familyId, contract] of registry) {
      contract.validateTransition({
        mode: participants.get(familyId),
        before: before.get(familyId),
        after: after.get(familyId),
        current: initial,
        candidate,
      });
    }

    await writeProtectedJsonAtomic(runDir, RUN_FILE, candidate, {
      hooks: atomicWriteHooks,
      fsOps: {
        rename: async (source, destination) => {

          // First comparison: gives the reobservers a state to reason about that is
          // known current as of this moment.
          const observed = deepFreeze(await readRunState(runDir, validateEnvelope));
          assertUnchanged(observed, initial);

          const observedProjections = projectAll(registry, observed);
          for (const [familyId, contract] of registry) {
            await contract.reobserve({
              mode: participants.get(familyId),
              current: observedProjections.get(familyId),
              candidate: after.get(familyId),
              observe: reobservers.get(familyId),
              state: observed,
              nextState: candidate,
            });
          }

          // Second comparison, immediately before the rename and after anything the
          // reobservers did. Comparing only once left a window: a reobserver - or a
          // concurrent writer running while one awaited - could commit a valid
          // record after the check, and this rename would silently overwrite it.
          // Nothing may run between this line and the rename.
          assertUnchanged(deepFreeze(await readRunState(runDir, validateEnvelope)), initial);
          await rename(source, destination);
        },
      },
    });
    return candidate;
  });
}

function assertUnchanged(observed, initial) {
  if (!isDeepStrictEqual(observed, initial)) {
    throw new Error("run state changed before protected replacement");
  }
}

async function readRunState(runDir, validateEnvelope) {
  const state = JSON.parse(await readFile(join(runDir, RUN_FILE), "utf8"));
  validateEnvelope(state);
  return state;
}

function contractRegistry(contracts) {
  if (!Array.isArray(contracts) || !Object.isFrozen(contracts)) {
    throw new Error("contracts must be a frozen array");
  }
  const registry = new Map();
  for (const contract of contracts) {
    if (!contract || !Object.isFrozen(contract) || typeof contract.id !== "string" || !contract.id) {
      throw new Error("each contract must be frozen and have an id");
    }
    for (const method of ["project", "validateProjection", "validateTransition", "reobserve"]) {
      if (typeof contract[method] !== "function") throw new Error(`contract '${contract.id}' is missing ${method}`);
    }
    if (registry.has(contract.id)) throw new Error(`duplicate contract '${contract.id}'`);
    registry.set(contract.id, contract);
  }
  return registry;
}

function participantRegistry(descriptor, contracts) {
  if (!descriptor || !Object.isFrozen(descriptor) || typeof descriptor.apply !== "function"
    || !Array.isArray(descriptor.participants) || !Object.isFrozen(descriptor.participants)) {
    throw new Error("descriptor and participants must be frozen");
  }
  const participants = new Map();
  for (const participant of descriptor.participants) {
    if (!participant || !Object.isFrozen(participant) || typeof participant.familyId !== "string"
      || !participant.familyId || typeof participant.mode !== "string" || !participant.mode) {
      throw new Error("each participant must be frozen and declare familyId and mode");
    }
    if (!contracts.has(participant.familyId)) throw new Error(`unknown contract '${participant.familyId}'`);
    if (participants.has(participant.familyId)) throw new Error(`duplicate participant '${participant.familyId}'`);
    participants.set(participant.familyId, participant.mode);
  }
  return participants;
}

function projectAll(contracts, state) {
  const projections = new Map();
  for (const [familyId, contract] of contracts) {
    const projection = contract.project(state);
    contract.validateProjection(projection);
    projections.set(familyId, projection);
  }
  return projections;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
