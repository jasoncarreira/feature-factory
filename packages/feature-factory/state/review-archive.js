// A review record lives at one path per subject, so each attempt overwrites the last. That is
// fine while a run succeeds and fatal when it does not: attempts are budgeted, exhausting the
// budget blocks a run, and `blocked` is final because `paths` freeze at seeding. The one
// artifact an operator needs to understand why a run blocked -- what the reviewer actually
// demanded on attempts 1 and 2 -- is the artifact the third attempt destroys.
//
// Run 216 is the case: its test-verifier was rejected twice and approved on the third. The
// reasons for both rejections are unrecoverable. They were reconstructed from commit subjects,
// which is guesswork wearing evidence's clothes.
//
// Instruction, not enforcement: losing a verdict cannot produce a false green, so a failed
// archive must never fail the step that earned it. The caller reports where the copy landed,
// or that it did not, rather than throwing.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeProtectedJsonAtomic } from "../core/atomic-write.js";
import { ProtectedWriteError } from "../core/atomic-write.js";

// The attempt comes from the record, not from `--attempts`. The record is what is being
// preserved, and a snapshot filed under a number the record does not itself claim would
// misattribute a verdict to an attempt that did not produce it.
export function attemptArchiveRef(ref, attempt) {
  const dir = dirname(ref);
  const stem = basename(ref).replace(/\.json$/u, "");
  return join(dir === "." ? "" : dir, `${stem}.attempt-${attempt}.json`);
}

export async function archiveReviewAttempt(runDir, ref) {
  if (typeof ref !== "string" || !ref.trim()) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(join(runDir, ref), "utf8"));
  } catch {
    return null;
  }
  const attempt = record?.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  const archive = attemptArchiveRef(ref, attempt);
  try {
    // createOnly: an archive that can be overwritten is not an archive. A second record for
    // the same attempt loses to the first, which is the one the verdict was recorded against.
    await writeProtectedJsonAtomic(runDir, archive, record, { createOnly: true });
  } catch (error) {
    const exists = error instanceof ProtectedWriteError && /already exists/u.test(error.message);
    if (!exists) return null;
  }
  return archive;
}
