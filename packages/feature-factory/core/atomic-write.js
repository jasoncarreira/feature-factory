// Atomic protected JSON write — temp file, fsync, rename.
//
// Replaces a 954-line port of which exactly one export was used. Dropped along
// with the scope that needed them: create-only link publication, append files,
// directory trees, sync variants, cross-device commit handling, and five of six
// lifecycle hooks. Kept, because each earns its lines here:
//
//   * refusal to follow a symlink at the target, re-checked immediately before the
//     rename. This writes into a repository working tree, so a hostile or confused
//     local process replacing run.json with a link is a real failure mode, and a
//     check that happens only before the temp write is a TOCTOU hole.
//   * O_EXCL temp creation, so two writers cannot share a temp file.
//   * fsync of the file and of the containing directory, so a completed rename
//     survives power loss. Attack 9 (crash-recovery replay) depends on this.
//   * a beforeCommit hook and an injectable rename, which is how the write core
//     performs compare-and-swap.
//
// Pull more back in if a real case appears.
import { lstat, open, rename as fsRename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";

export class ProtectedWriteError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProtectedWriteError";
  }
}

export function writeProtectedJsonAtomic(rootDir, relativePath, value, options = {}) {
  return writeProtectedFileAtomic(rootDir, relativePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writeProtectedFileAtomic(rootDir, relativePath, data, options = {}) {
  const targetPath = resolveProtectedPath(rootDir, relativePath);
  const parentDir = resolve(targetPath, "..");
  const rename = options.fsOps?.rename ?? fsRename;
  const beforeCommit = options.hooks?.beforeCommit;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");

  await assertSafeTarget(targetPath);

  const tempPath = join(parentDir, `.${randomUUID()}.tmp`);
  let handle = null;
  try {
    // "wx" is O_CREAT|O_EXCL|O_WRONLY: if the name exists, fail rather than adopt
    // a file somebody else created.
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    if (typeof beforeCommit === "function") await beforeCommit();

    // Re-check after the hook. The window between the first check and the commit
    // is exactly where a substituted target would land.
    await assertSafeTarget(targetPath);
    await rename(tempPath, targetPath);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* the original error is the one that matters */ }
    }
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        throw new ProtectedWriteError("protected temporary file cleanup is indeterminate", cleanupError);
      }
    }
    throw error instanceof ProtectedWriteError
      ? error
      : new ProtectedWriteError("protected file commit failed", error);
  }

  // A rename is only durable once its directory entry is. Without this, a crash
  // can lose a commit that already returned successfully.
  await syncDirectory(parentDir);
  return { path: targetPath };
}

function resolveProtectedPath(rootDir, relativePath) {
  if (typeof rootDir !== "string" || !rootDir.trim() || !isAbsolute(rootDir)) {
    throw new ProtectedWriteError("protected file root is invalid");
  }
  if (typeof relativePath !== "string" || !relativePath.trim() || isAbsolute(relativePath)) {
    throw new ProtectedWriteError("protected relative path is invalid");
  }
  const root = resolve(rootDir);
  const targetPath = resolve(root, relativePath);
  // Containment, not string prefixing: comparing against `${root}${sep}` refuses
  // `/a/bc` for root `/a/b`.
  if (targetPath === root || !targetPath.startsWith(`${root}${sep}`)) {
    throw new ProtectedWriteError("protected relative path escapes its root");
  }
  return targetPath;
}

async function assertSafeTarget(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    // Absent is the normal first-write case; anything else is unreadable state.
    if (error?.code === "ENOENT") return;
    throw new ProtectedWriteError("protected file target could not be inspected", error);
  }
  if (!stats.isFile()) throw new ProtectedWriteError("protected file target has an unsafe type");
}

async function syncDirectory(dir) {
  let handle = null;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    // A filesystem that refuses to fsync a directory is not a reason to fail a
    // write that already committed: durability degrades, correctness does not.
    if (!["EINVAL", "EPERM", "EISDIR", "EACCES", "ENOTSUP"].includes(error?.code)) {
      throw new ProtectedWriteError("protected directory sync failed", error);
    }
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* nothing actionable */ }
    }
  }
}
