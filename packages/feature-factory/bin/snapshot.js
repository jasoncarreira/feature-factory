// Enforcement, not instruction: `factory terminal` needs no lock so a supervisor can park a run it is not
// driving, and `restore` consumes a parked snapshot -- but publishing one was specified only as driver
// prose, so an out-of-band park could complete step 1 of the three-step park and nothing else. mimir's
// budget park does exactly that: it cancels the driver, then terminalizes, and the process that would have
// published the snapshot is the one it just cancelled. A snapshot that exists but does not correspond to
// the plane is worse than none -- `status` reports a path, an operator believes the run is recoverable,
// and the copy is found partial only when it is needed -- so verify-before-commit cannot be delegated to
// prose for a caller that is not the driver.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTROL_PLANE, validateRun } from "../state/schema.js";
import { hasRetryGrantTransaction, isRetryGrantTransition, reconcileRetryGrantTransaction } from "../state/retry-grant-transaction.js";
import { RUN_JSON_LOCK_DIR, withRunJsonLock } from "../core/run-lock.js";
import { assertRetryExtensionBindings, copySnapshot, entryState, inventory, inventoryEntries } from "./restore.js";

// The two root entries excluded from publication are coordination, not run state: `factory.lock` is session
// liveness and `run-json.lock` serializes this copy with state transitions. Only those exact root paths are
// excluded; either name below the root remains durable state and must match.
const LIVENESS = new Set(["factory.lock", RUN_JSON_LOCK_DIR]);

export class SnapshotError extends Error {
  constructor(message, options) { super(message, options); this.name = "SnapshotError"; }
}

const ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

// Version 0.10.1 also used `.prior-$R` as its grant seam. Exact old bytes prove its grant did not
// commit; the grant contracts plus the bound snapshot digest prove that it did. Anything else is
// preserved and refused. New grants use a distinct durable fence and never overload this path.
function preflight(staging, prior, canonical, plane, runId) {
  if (entryState(staging)) throw new SnapshotError(`residual staging tree '${staging}' must be removed before publishing`);
  const cleanup = `${prior}.cleanup`;
  if (entryState(cleanup)) rmSync(cleanup, { recursive: true, force: true });
  const priorState = entryState(prior);
  if (!priorState) return;
  if (priorState.isSymbolicLink() || !priorState.isDirectory()) {
    throw new SnapshotError(`residual '${prior}' has an unsafe type`);
  }
  if (!entryState(canonical)) {
    const before = qualifyManifest(prior, runId, "prior park manifest");
    const current = qualifyManifest(plane, runId, "run manifest");
    if (readFileSync(join(prior, "run.json")).equals(readFileSync(join(plane, "run.json")))) {
      removeAbandonedGrantCandidate(plane, prior, before);
      if (inventory(plane, LIVENESS) !== inventory(prior, LIVENESS)) {
        throw new SnapshotError("interrupted retry grant live plane changed from its prior snapshot");
      }
      renameSync(prior, canonical);
      return;
    }
    if (!isCommittedRetryGrant(before, current, prior)) {
      throw new SnapshotError(`residual '${prior}' is not a recoverable retry-grant transaction`);
    }
  } else {
    qualifyManifest(canonical, runId, "canonical park manifest");
  }
  try { renameSync(prior, cleanup); rmSync(cleanup, { recursive: true, force: true }); }
  catch (error) { throw new SnapshotError(`residual '${prior}' could not be quarantined`, { cause: error }); }
}

function removeAbandonedGrantCandidate(plane, prior, before) {
  const candidates = readdirSync(plane).filter((name) => /^\.[0-9a-f-]{36}\.tmp$/u.test(name)
    && !entryState(join(prior, name)));
  if (candidates.length === 0) return;
  if (candidates.length !== 1) throw new SnapshotError("interrupted retry grant has ambiguous atomic candidates");
  const candidatePath = join(plane, candidates[0]), state = entryState(candidatePath);
  let candidate;
  try { candidate = state?.isFile() && !state.isSymbolicLink()
    ? validateRun(JSON.parse(readFileSync(candidatePath, "utf8"))) : null; } catch { candidate = null; }
  if (!candidate || !isCommittedRetryGrant(before, candidate, prior)) {
    throw new SnapshotError("interrupted retry grant has an unbound atomic candidate");
  }
  rmSync(candidatePath);
}

function isCommittedRetryGrant(before, after, prior) {
  const digest = `sha256:${createHash("sha256").update(Buffer.from(inventoryEntries(prior).join("\n"))).digest("hex")}`;
  return isRetryGrantTransition(before, after, digest);
}

// Applied to the live plane before staging and to the staged tree before the commit. The same schema and
// the same identity the consumer enforces: `restore` rejects a manifest that fails either, so a snapshot
// carrying one is recovery evidence its only reader refuses. Refused rather than permitted for a live
// plane too -- a snapshot of a running run records a moment no resume can return to.
function qualifyManifest(dir, runId, description) {
  const manifest = join(dir, "run.json"), state = entryState(manifest);
  if (!state?.isFile() || state.isSymbolicLink() || realpathSync(manifest) !== manifest) {
    throw new SnapshotError(`${description} for '${runId}' must be a regular file to publish a snapshot`);
  }
  let run;
  try { run = validateRun(JSON.parse(readFileSync(manifest, "utf8"))); }
  catch (error) { throw new SnapshotError(`${description} for '${runId}' is not a valid run`, { cause: error }); }
  if (run.run_id !== runId) throw new SnapshotError(`${description} names '${run.run_id}', not the requested '${runId}'`);
  if (run.status !== "needs-human") throw new SnapshotError(`factory snapshot requires a parked run; '${runId}' is '${run.status}'`);
  try { assertRetryExtensionBindings(dir, run); }
  catch (error) { throw new SnapshotError(`${description} for '${runId}' has invalid retry-extension bindings`, { cause: error }); }
  return run;
}

export async function dispatchSnapshot(positional, flags, operations = {}) {
  if (positional.length !== 1 || !ID.test(positional[0])) throw new SnapshotError("factory snapshot requires exactly one valid run id");
  if (flags.repo !== undefined && (typeof flags.repo !== "string" || !flags.repo.trim())) throw new SnapshotError("--repo must name a directory");
  const runId = positional[0], operatorInput = resolve(flags.repo ?? process.cwd());
  if (!entryState(operatorInput)) throw new SnapshotError(`operator repository '${operatorInput}' is not observable`);
  const operatorRoot = realpathSync(operatorInput), parked = join(operatorRoot, CONTROL_PLANE, ".parked");
  const canonical = join(parked, runId), fenced = hasRetryGrantTransaction(canonical, runId);
  const candidates = [join(operatorRoot, CONTROL_PLANE, runId), join(operatorRoot, ".factory-sandboxes", runId, CONTROL_PLANE, runId)]
    .filter((candidate) => entryState(join(candidate, "run.json"))
      || (fenced && entryState(candidate)?.isDirectory() && !entryState(candidate).isSymbolicLink()));
  if (candidates.length !== 1) throw new SnapshotError(candidates.length
    ? `factory snapshot found ambiguous live manifests for '${runId}'`
    : `control plane for '${runId}' is not observable`);
  const plane = candidates[0];

  return withRunJsonLock(plane, async () => {
    // Created one directory at a time, never written through a symlinked parent: the snapshot must land
    // under the operator's own control plane and nowhere a link could redirect it.
    for (const parent of [join(operatorRoot, CONTROL_PLANE), parked]) {
      const present = entryState(parent);
      if (present && (present.isSymbolicLink() || !present.isDirectory())) {
        throw new SnapshotError(`'${parent}' must be a real directory to publish a snapshot`);
      }
      if (!present) mkdirSync(parent);
    }
    const staging = join(parked, `.staging-${runId}`), prior = join(parked, `.prior-${runId}`);
    try { reconcileRetryGrantTransaction({ canonical, runDir: plane, runId }); }
    catch (error) { throw new SnapshotError(`factory snapshot could not reconcile retry-grant transaction for '${runId}'`, { cause: error }); }
    qualifyManifest(plane, runId, "run manifest");
    preflight(staging, prior, canonical, plane, runId);

    let committed = false;
    try {
      (operations.copy ?? copySnapshot)(plane, staging, LIVENESS);
      // Verify before the commit point. An unverified staging tree is never published, so a copy that
      // raced a write is discarded rather than published as evidence of a run it does not describe.
      if (inventory(plane, LIVENESS) !== inventory(staging, LIVENESS)) {
        throw new SnapshotError("staged snapshot does not match the live control plane; nothing was published");
      }
      // Equality alone cannot catch a manifest replaced between qualification and copy: both trees then
      // hold the same unvalidated bytes and compare equal. Qualify what is about to be renamed.
      qualifyManifest(staging, runId, "staged run manifest");
      await operations.beforeCommit?.({ plane, staging, canonical });
      if (!entryState(canonical)) {
        renameSync(staging, canonical);          // commit point, with no snapshot present
        committed = true;
      } else {
        renameSync(canonical, prior);
        try {
          renameSync(staging, canonical);        // commit point, replacing a previous snapshot
          committed = true;
        } catch (error) {
          // The first rename succeeded and the second did not: put the previous snapshot back and report
          // that nothing was committed, rather than leaving the canonical path empty.
          renameSync(prior, canonical);
          throw new SnapshotError("snapshot commit failed; the previous snapshot was restored", { cause: error });
        }
      }
    } finally {
      // Before the commit point every failure removes only the staging tree. After it the published
      // snapshot is authoritative and is never rolled back.
      if (!committed) rmSync(staging, { recursive: true, force: true });
    }

    // Cleanup, not publication: a residual `.prior-$R` is reported and left for the next preflight rather
    // than turning a completed publication into a failure.
    let residual = null;
    if (entryState(prior)) {
      try { rmSync(prior, { recursive: true, force: true }); }
      catch { residual = prior; }
    }
    return { run_id: runId, park_snapshot: canonical, residual };
  }, { nonExpiring: true });
}
