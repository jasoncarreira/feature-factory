// Read-only rendering of run state. No write primitive may appear in this package.
import { readRunUnchecked } from "feature-factory";

export function renderRun(runDir) {
  const observed = readRunUnchecked(runDir);
  if (!observed.ok) return { valid: false, error: observed.error };
  const run = observed.run;
  return {
    valid: true,
    run_id: run.run_id,
    status: run.status,
    mode: run.mode,
    slices: (run.slices ?? []).map((slice) => ({ id: slice.id, status: slice.status, attempts: slice.attempts })),
  };
}
