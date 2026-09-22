// Enforcement, not instruction: `factory terminal` needs no lock so a supervisor can park a run it is not
// driving, and `restore` consumes a parked snapshot -- but publishing one was specified only as driver
// prose, so an out-of-band park could complete step 1 of the three-step park and nothing else. mimir's
// budget park does exactly that: it cancels the driver, then terminalizes, and the process that would have
// published the snapshot is the one it just cancelled. A snapshot that exists but does not correspond to
// the plane is worse than none -- `status` reports a path, an operator believes the run is recoverable,
// and the copy is found partial only when it is needed -- so verify-before-commit cannot be delegated to
// prose for a caller that is not the driver.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTROL_PLANE } from "../state/schema.js";
import { copySnapshot, entryState, inventory } from "./restore.js";

// The one entry excluded from the comparison: `factory.lock` at the plane root is session liveness rather
// than run state, and is the only thing designed to change on a timer, so comparing it fails whenever a
// heartbeat lands between reading the source and reading the copy. Qualified status excludes the same
// single path for the same reason. A `factory.lock` anywhere below the root is run state and must match.
const LIVENESS = new Set(["factory.lock"]);

export class SnapshotError extends Error {
  constructor(message, options) { super(message, options); this.name = "SnapshotError"; }
}

const ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

// Removing a residual `.prior-$R` is preflight, not rollback: it is the trace of an earlier publication
// whose cleanup did not finish, not a snapshot to preserve. Failing to remove it stops before anything is
// staged, because publishing over an unknown residual would make the rollback path ambiguous.
function preflight(staging, prior) {
  if (entryState(staging)) throw new SnapshotError(`residual staging tree '${staging}' must be removed before publishing`);
  if (entryState(prior)) {
    try { rmSync(prior, { recursive: true, force: true }); }
    catch (error) { throw new SnapshotError(`residual '${prior}' could not be removed`, { cause: error }); }
  }
}

export function dispatchSnapshot(positional, flags) {
  if (positional.length !== 1 || !ID.test(positional[0])) throw new SnapshotError("factory snapshot requires exactly one valid run id");
  if (flags.repo !== undefined && (typeof flags.repo !== "string" || !flags.repo.trim())) throw new SnapshotError("--repo must name a directory");
  const runId = positional[0];
  const operatorRoot = resolve(flags.repo ?? process.cwd());
  const plane = join(operatorRoot, CONTROL_PLANE, runId);
  if (!entryState(plane)) throw new SnapshotError(`control plane '${plane}' is not observable`);
  // Matched to what `restore` will accept, not merely to what exists: restore refuses a parked manifest
  // that is a symlink or resolves elsewhere, so publishing one would report recovery evidence its only
  // consumer can never read -- a snapshot that fails exactly when it is needed.
  const manifest = join(plane, "run.json");
  const manifestState = entryState(manifest);
  if (!manifestState?.isFile() || manifestState.isSymbolicLink() || realpathSync(manifest) !== manifest) {
    throw new SnapshotError(`run manifest for '${runId}' must be a regular file to publish a snapshot`);
  }

  // Refused rather than permitted: a snapshot of a live plane records a moment no resume can return to,
  // and reporting it as recovery evidence would be a claim the bytes do not support.
  const run = JSON.parse(readFileSync(manifest, "utf8"));
  if (run.status !== "needs-human") {
    throw new SnapshotError(`factory snapshot requires a parked run; '${runId}' is '${run.status}'`);
  }

  // Created one directory at a time, never written through a symlinked parent: the snapshot must land
  // under the operator's own control plane and nowhere a link could redirect it.
  const parked = join(operatorRoot, CONTROL_PLANE, ".parked");
  for (const parent of [join(operatorRoot, CONTROL_PLANE), parked]) {
    const present = entryState(parent);
    if (present && (present.isSymbolicLink() || !present.isDirectory())) {
      throw new SnapshotError(`'${parent}' must be a real directory to publish a snapshot`);
    }
    if (!present) mkdirSync(parent);
  }
  const canonical = join(parked, runId);
  const staging = join(parked, `.staging-${runId}`);
  const prior = join(parked, `.prior-${runId}`);
  preflight(staging, prior);

  let committed = false;
  try {
    copySnapshot(plane, staging, LIVENESS);
    // Verify before the commit point. An unverified staging tree is never published, so a copy that
    // raced a write is discarded rather than published as evidence of a run it does not describe.
    if (inventory(plane, LIVENESS) !== inventory(staging, LIVENESS)) {
      throw new SnapshotError("staged snapshot does not match the live control plane; nothing was published");
    }
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
}
