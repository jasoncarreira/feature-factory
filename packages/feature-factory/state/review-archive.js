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
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeProtectedFileAtomic, writeProtectedJsonAtomic } from "../core/atomic-write.js";

// The attempt comes from the record, not from `--attempts`. The record is what is being
// preserved, and a snapshot filed under a number the record does not itself claim would
// misattribute a verdict to an attempt that did not produce it.
export function attemptArchiveRef(ref, attempt) {
  const dir = dirname(ref);
  const stem = basename(ref).replace(/\.json$/u, "");
  return join(dir === "." ? "" : dir, `${stem}.attempt-${attempt}.json`);
}

// An archive has nothing to preserve: its content is already the frozen copy. Handed one anyway --
// run 1551 reported an archive path back as `--review-ref`, and the suffix was appended twice, leaving
// `spec-writer.attempt-1.attempt-1.json` beside the real archive with identical bytes. Harmless to
// state, because the live record is untouched and `createOnly` protects the genuine archive, but the
// reviews directory is the one place an operator reads to reconstruct why a run blocked, and a file
// naming an attempt of an attempt invites them to look for a second verdict that does not exist.
//
// Instruction, not enforcement, and a no-op rather than a refusal: this module must never fail the
// step that earned the verdict, which is the contract stated at the top of this file.
const ARCHIVE_REF = /\.attempt-\d+\.json$/u;

export function qualifyAttemptArchive(runDir, ref, description = "attempt record") {
  if (typeof ref !== "string" || !ref.trim() || ARCHIVE_REF.test(ref)) throw new Error(`${description} ref is not a live attempt record`);
  const root = realpathSync(runDir), source = join(runDir, ref), canonicalSource = resolve(root, ref), sourceStat = lstatSync(source);
  if (!canonicalSource.startsWith(`${root}${sep}`) || !sourceStat.isFile() || sourceStat.isSymbolicLink()
    || realpathSync(source) !== canonicalSource) throw new Error(`${description} must be a contained regular non-symlink file`);
  const bytes = readFileSync(source), record = JSON.parse(bytes.toString("utf8"));
  if (!Number.isSafeInteger(record?.attempt) || record.attempt < 1) throw new Error(`${description} does not name a positive attempt`);
  const archive = attemptArchiveRef(ref, record.attempt), target = join(runDir, archive);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(target) !== resolve(root, archive)) throw new Error(`${description} archive '${archive}' has an unsafe type`);
    const archiveBytes = readFileSync(target);
    if (!archiveBytes.equals(bytes) || !isDeepStrictEqual(JSON.parse(archiveBytes.toString("utf8")), record)) throw new Error(`${description} archive '${archive}' conflicts with the live record`);
  }
  return { archive, record, bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, exists: existsSync(target) };
}

export async function publishAttemptArchive(runDir, qualified) {
  if (!qualified.exists) await writeProtectedFileAtomic(runDir, qualified.archive, qualified.bytes, { createOnly: true });
  const archived = JSON.parse(readFileSync(join(runDir, qualified.archive), "utf8"));
  if (!isDeepStrictEqual(archived, qualified.record)) throw new Error(`attempt archive '${qualified.archive}' does not match its qualified record`);
  return qualified.archive;
}

export async function archiveReviewAttempt(runDir, ref) {
  if (typeof ref !== "string" || !ref.trim() || ARCHIVE_REF.test(ref)) return null;
  try {
    const source = join(runDir, ref), stat = lstatSync(source), record = JSON.parse(readFileSync(source, "utf8"));
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(record?.attempt) || record.attempt < 1) return null;
    const archive = attemptArchiveRef(ref, record.attempt), target = join(runDir, archive);
    if (existsSync(target)) return lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink() ? archive : null;
    await writeProtectedJsonAtomic(runDir, archive, record, { createOnly: true });
    return archive;
  } catch { return null; }
}
