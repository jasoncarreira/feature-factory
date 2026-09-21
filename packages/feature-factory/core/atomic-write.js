// Ordinary writes use an exclusive same-directory temp; every write fsyncs its file and directory. Directory fsync is
// what makes a completed publication survive power loss, and attack 9 (crash-recovery replay) rests
// on it. Ordinary writes recheck the target immediately before the rename, not only up front: this
// writes into a working tree, so a local process swapping run.json for a symlink inside that window
// is a real failure mode and an up-front-only check is a TOCTOU hole. Create-only writes preflight
// absence, then write through the protected target's held mode-000 inode; only verified, fsynced bytes
// become readable. beforeCommit is the last race seam used by CAS and create-only tests.
import { lstat, open, realpath, rename as fsRename, unlink } from "node:fs/promises";
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
  const targetPath = resolveProtectedPath(rootDir, relativePath), parentDir = resolve(targetPath, "..");
  const createOnly = options.createOnly === true, beforeCommit = options.hooks?.beforeCommit;
  const openFile = options.fsOps?.open ?? open;
  const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), "utf8");
  await assertSafeParent(rootDir, parentDir);
  await assertSafeTarget(targetPath, createOnly);
  if (createOnly) return writeProtectedCreate(rootDir, parentDir, targetPath, bytes, beforeCommit, openFile);

  const tempPath = join(parentDir, `.${randomUUID()}.tmp`), rename = options.fsOps?.rename ?? fsRename;
  let handle = null, published = false, targetLinked = false;
  try {
    handle = await openFile(tempPath, "wx+", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    if (typeof beforeCommit === "function") await beforeCommit();
    await assertSafeParent(rootDir, parentDir);
    await assertSafeTarget(targetPath, false);
    await assertPublishedInode(handle, tempPath, bytes);
    await rename(tempPath, targetPath);
    targetLinked = true;
    await assertPublishedInode(handle, targetPath, bytes);
    await handle.close();
    handle = null;
    published = true;
  } catch (error) {
    if (handle) try { await handle.close(); } catch { /* the original error is primary */ }
    if (targetLinked && !published) try { await unlink(targetPath); } catch { /* integrity failure is primary */ }
    if (!published) try { await unlink(tempPath); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw new ProtectedWriteError("protected temporary file cleanup is indeterminate", cleanupError);
    }
    throw error instanceof ProtectedWriteError ? error : new ProtectedWriteError("protected file commit failed", error);
  }
  await syncDirectory(parentDir);
  return { path: targetPath };
}

async function writeProtectedCreate(rootDir, parentDir, targetPath, bytes, beforeCommit, openFile) {
  let handle = null;
  try {
    if (typeof beforeCommit === "function") await beforeCommit();
    await assertSafeParent(rootDir, parentDir);
    await assertSafeTarget(targetPath, true);
    try { handle = await openFile(targetPath, "wx+", 0o000); } catch (error) {
      if (error?.code === "EEXIST") throw new ProtectedWriteError("protected create target already exists", error);
      throw error;
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await assertPublishedInode(handle, targetPath, bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await assertPublishedInode(handle, targetPath, bytes);
    await handle.close();
    handle = null;
  } catch (error) {
    if (handle) try { await handle.close(); } catch { /* the original error is primary */ }
    // Never unlink by pathname after claiming it: a competitor could have replaced that name.
    // A failed direct create remains mode 000 and blocks reuse instead of exposing uncertain state.
    throw error instanceof ProtectedWriteError ? error : new ProtectedWriteError("protected file commit failed", error);
  }
  await syncDirectory(parentDir);
  return { path: targetPath };
}

async function assertPublishedInode(handle, targetPath, bytes) {
  const [held, named] = await Promise.all([handle.stat(), lstat(targetPath)]);
  const observed = Buffer.alloc(bytes.length + 1), read = await handle.read(observed, 0, observed.length, 0);
  if (!named.isFile() || held.dev !== named.dev || held.ino !== named.ino || read.bytesRead !== bytes.length
    || !observed.subarray(0, bytes.length).equals(bytes)) throw new ProtectedWriteError("protected publication inode or bytes changed before commit");
}

async function assertSafeParent(rootDir, parentDir) {
  const root = resolve(rootDir), rel = resolve(parentDir).slice(root.length + 1);
  let observed; try { observed = await realpath(parentDir); } catch (error) { throw new ProtectedWriteError("protected file parent could not be inspected", error); }
  if (observed !== resolve(await realpath(root), rel)) throw new ProtectedWriteError("protected file parent has an unsafe symlink");
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
