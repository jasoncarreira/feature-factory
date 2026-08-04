import { isDeepStrictEqual } from "node:util";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ProtectedWriteError, writeProtectedJsonAtomic } from "../core/atomic-write.js";
import { validateRun } from "../state/schema.js";

const CLASSES = new Set(["absent", "unsafe", "unreadable", "invalid", "different", "exact"]);
const COMMITTED = new Set([
  "protected create published target but initial temporary cleanup failed",
  "protected create published target but temporary cleanup is indeterminate",
  "protected target is committed but directory sync failed",
]);

export async function dispatchInitPublication(
  { runDir, sandboxPath, candidate },
  { writer = writeProtectedJsonAtomic, observeTarget = observeInitTarget } = {},
) {
  const intendedBytes = `${JSON.stringify(candidate, null, 2)}\n`;
  let writerError = null;
  try {
    await writer(runDir, "run.json", candidate, { createOnly: true });
  } catch (error) {
    writerError = error;
  }

  let observed;
  try {
    observed = await observeTarget({ runDir, candidate, intendedBytes });
  } catch {
    throw new Error(`manifest state unobservable at sandbox '${sandboxPath}'`);
  }
  const classification = typeof observed === "string" ? observed : observed?.classification;
  if (!CLASSES.has(classification)) throw new Error(`manifest state unobservable at sandbox '${sandboxPath}'`);

  const normal = writerError === null;
  const committed = writerError instanceof ProtectedWriteError && COMMITTED.has(writerError.message);
  if ((normal || committed) && classification === "exact") return { observedRun: observed.observedRun };

  const collision = writerError instanceof ProtectedWriteError && writerError.message === "protected create target already exists";
  const action = collision ? `; run 'factory status ${candidate.run_id} --json --repo ${sandboxPath}' and resume` : "";
  throw new Error(`manifest publication refused for sandbox '${sandboxPath}': observed ${classification}${action}`);
}

function observeInitTarget({ runDir, candidate, intendedBytes }) {
  const target = join(runDir, "run.json");
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    return { classification: error?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return { classification: "unsafe" };
  try {
    if (realpathSync(target) !== target || realpathSync(runDir) !== runDir) return { classification: "unsafe" };
  } catch {
    return { classification: "unreadable" };
  }
  let bytes;
  try {
    bytes = readFileSync(target, "utf8");
  } catch {
    return { classification: "unreadable" };
  }
  let observedRun;
  try {
    observedRun = validateRun(JSON.parse(bytes));
  } catch {
    return { classification: "invalid" };
  }
  if (bytes !== intendedBytes || !isDeepStrictEqual(observedRun, candidate)) return { classification: "different", observedRun };
  return { classification: "exact", observedRun };
}
