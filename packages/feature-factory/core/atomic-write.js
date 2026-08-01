// Exclusive same-directory temp, then fsync of the file and of the directory. The directory fsync is
// what makes a completed publication survive power loss, and attack 9 (crash-recovery replay) rests
// on it. Ordinary writes recheck the target immediately before the rename, not only up front: this
// writes into a working tree, so a local process swapping run.json for a symlink inside that window
// is a real failure mode and an up-front-only check is a TOCTOU hole. Create-only writes preflight
// absence and publish by link. beforeCommit is the last race seam, used by CAS and create-only tests.
import { link as fsLink, lstat, open, rename as fsRename, unlink } from "node:fs/promises";
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
  const createOnly = options.createOnly === true;
  const rename = options.fsOps?.rename ?? fsRename;
  const link = options.fsOps?.link ?? fsLink;
  const beforeCommit = options.hooks?.beforeCommit;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");

  await assertSafeTarget(targetPath, createOnly);

  const tempPath = join(parentDir, `.${randomUUID()}.tmp`);
  let handle = null;
  let published = false;
  try {
    // "wx" is O_CREAT|O_EXCL|O_WRONLY: if the name exists, fail rather than adopt
    // a file somebody else created.
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    if (createOnly) {
      await assertSafeTarget(targetPath, true);
      if (typeof beforeCommit === "function") await beforeCommit();
      try { await link(tempPath, targetPath); } catch (error) {
        if (error?.code === "EEXIST") throw new ProtectedWriteError("protected create target already exists", error);
        throw error;
      }
      published = true;
      try { await unlink(tempPath); } catch (cleanupError) {
        try { await unlink(tempPath); } catch (retryError) {
          if (retryError?.code !== "ENOENT") {
            throw new ProtectedWriteError("protected create published target but temporary cleanup is indeterminate", retryError);
          }
        }
        throw new ProtectedWriteError("protected create published target but initial temporary cleanup failed", cleanupError);
      }
    } else {
      if (typeof beforeCommit === "function") await beforeCommit();
      await assertSafeTarget(targetPath, false);
      await rename(tempPath, targetPath);
      published = true;
    }
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* the original error is the one that matters */ }
    }
    if (!published) {
      try {
        await unlink(tempPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new ProtectedWriteError("protected temporary file cleanup is indeterminate", cleanupError);
        }
      }
    }
    throw error instanceof ProtectedWriteError
      ? error
      : new ProtectedWriteError("protected file commit failed", error);
  }

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

async function assertSafeTarget(path, createOnly) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    // Absent is the normal first-write case; anything else is unreadable state.
    if (error?.code === "ENOENT") return;
    throw new ProtectedWriteError("protected file target could not be inspected", error);
  }
  if (createOnly) throw new ProtectedWriteError("protected create target already exists");
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
      throw new ProtectedWriteError("protected target is committed but directory sync failed", error);
    }
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* nothing actionable */ }
    }
  }
}
