import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { promises as fsPromises } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_TEMP_ATTEMPTS = 8;
const FILE_TYPE_MASK = 0o170000;

const ERROR_MESSAGES = Object.freeze({
  INVALID_ROOT: "protected file root is invalid",
  UNTRUSTED_ROOT: "protected file root is not trusted",
  INVALID_PATH: "protected relative path is invalid",
  INVALID_OPTIONS: "protected file options are invalid",
  PARENT_MISSING: "protected file parent is missing",
  PARENT_TYPE: "protected file parent has an unsafe type",
  PARENT_CHANGED: "protected file parent changed during the operation",
  TARGET_TYPE: "protected file target has an unsafe type",
  TARGET_CHANGED: "protected file target changed during the operation",
  TARGET_EXISTS: "protected file target already exists",
  TEMP_COLLISION: "protected temporary file name collisions exceeded the limit",
  TEMP_OPEN_FAILED: "protected temporary file could not be opened",
  TEMP_TYPE: "protected temporary file has an unsafe type",
  TEMP_CHANGED: "protected temporary file changed during the operation",
  WRITE_FAILED: "protected file write failed",
  CLOSE_FAILED: "protected file close failed",
  COMMIT_FAILED: "protected file commit failed",
  CROSS_DEVICE: "protected file commit crossed filesystem devices",
  LINK_UNSUPPORTED: "protected create-only publication is unsupported",
  CLEANUP_INDETERMINATE: "protected temporary file cleanup is indeterminate",
  DIRECTORY_CREATE_FAILED: "protected directory could not be created",
  APPEND_UNSUPPORTED: "protected no-follow append is unsupported",
  APPEND_OPEN_FAILED: "protected append file could not be opened",
});

export class ProtectedWriteError extends Error {
  constructor(code, cause) {
    super(ERROR_MESSAGES[code] || "protected file operation failed", cause === undefined ? undefined : { cause });
    this.name = "ProtectedWriteError";
    this.code = code;
  }
}

// These checks bound portable pathname operations on supported local filesystems.
// They cannot close the race between the final identity check and rename/link/unlink.
export function writeProtectedFileAtomicSync(rootDir, relativePath, data, options = {}) {
  const ops = syncOps(options.fsOps);
  const settings = normalizeWriteOptions(options);
  const bytes = normalizeData(data);
  const context = prepareWriteSync(rootDir, relativePath, settings, ops);
  let temp = null;
  let descriptor = null;
  let primaryError = null;

  try {
    invokeSyncHook(settings.hooks.afterParentCheck);
    recheckParentsSync(context, ops);

    context.target = inspectTargetSync(context.targetPath, settings.commit, ops);
    invokeSyncHook(settings.hooks.afterTargetCheck);
    recheckWriteStateSync(context, null, ops);

    temp = createTempSync(context, settings, ops);
    descriptor = temp.handle;
    invokeSyncHook(settings.hooks.afterTempOpen);
    recheckWriteStateSync(context, temp, ops, descriptor);

    writeAllSync(descriptor, bytes, ops);
    invokeSyncHook(settings.hooks.afterTempWrite);
    recheckWriteStateSync(context, temp, ops, descriptor);

    try {
      ops.close(descriptor);
      descriptor = null;
    } catch (error) {
      descriptor = null;
      throw protectedError("CLOSE_FAILED", error);
    }

    invokeSyncHook(settings.hooks.afterTempClose);
    recheckWriteStateSync(context, temp, ops);
    invokeSyncHook(settings.hooks.beforeCommit);
    recheckWriteStateSync(context, temp, ops);

    if (settings.commit === "create-only") {
      commitCreateOnlySync(temp.path, context.targetPath, ops);
      const cleanup = cleanupAfterPublishedSync(context, temp, settings, ops);
      const actualMode = temp.mode;
      temp = null;
      return resultFor(context, settings, cleanup, actualMode);
    }

    commitReplaceSync(temp.path, context.targetPath, ops);
    const actualMode = temp.mode;
    temp = null;
    return resultFor(context, settings, "none", actualMode);
  } catch (error) {
    primaryError = asProtectedError(error, "COMMIT_FAILED");
  }

  if (descriptor !== null) {
    try {
      ops.close(descriptor);
    } catch (error) {
      if (!primaryError) primaryError = protectedError("CLOSE_FAILED", error);
    }
  }

  if (temp) {
    const cleanupError = cleanupFailedTempSync(context, temp, settings, ops);
    if (cleanupError) throw cleanupError;
  }
  throw primaryError;
}

export async function writeProtectedFileAtomic(rootDir, relativePath, data, options = {}) {
  const ops = asyncOps(options.fsOps);
  const settings = normalizeWriteOptions(options);
  const bytes = normalizeData(data);
  const context = await prepareWrite(rootDir, relativePath, settings, ops);
  let temp = null;
  let descriptor = null;
  let primaryError = null;

  try {
    await invokeHook(settings.hooks.afterParentCheck);
    await recheckParents(context, ops);

    context.target = await inspectTarget(context.targetPath, settings.commit, ops);
    await invokeHook(settings.hooks.afterTargetCheck);
    await recheckWriteState(context, null, ops);

    temp = await createTemp(context, settings, ops);
    descriptor = temp.handle;
    await invokeHook(settings.hooks.afterTempOpen);
    await recheckWriteState(context, temp, ops, descriptor);

    await writeAll(descriptor, bytes, ops);
    await invokeHook(settings.hooks.afterTempWrite);
    await recheckWriteState(context, temp, ops, descriptor);

    try {
      await ops.close(descriptor);
      descriptor = null;
    } catch (error) {
      descriptor = null;
      throw protectedError("CLOSE_FAILED", error);
    }

    await invokeHook(settings.hooks.afterTempClose);
    await recheckWriteState(context, temp, ops);
    await invokeHook(settings.hooks.beforeCommit);
    await recheckWriteState(context, temp, ops);

    if (settings.commit === "create-only") {
      await commitCreateOnly(temp.path, context.targetPath, ops);
      const cleanup = await cleanupAfterPublished(context, temp, settings, ops);
      const actualMode = temp.mode;
      temp = null;
      return resultFor(context, settings, cleanup, actualMode);
    }

    await commitReplace(temp.path, context.targetPath, ops);
    const actualMode = temp.mode;
    temp = null;
    return resultFor(context, settings, "none", actualMode);
  } catch (error) {
    primaryError = asProtectedError(error, "COMMIT_FAILED");
  }

  if (descriptor !== null) {
    try {
      await ops.close(descriptor);
    } catch (error) {
      if (!primaryError) primaryError = protectedError("CLOSE_FAILED", error);
    }
  }

  if (temp) {
    const cleanupError = await cleanupFailedTemp(context, temp, settings, ops);
    if (cleanupError) throw cleanupError;
  }
  throw primaryError;
}

export function writeProtectedJsonAtomicSync(rootDir, relativePath, value, options = {}) {
  return writeProtectedFileAtomicSync(rootDir, relativePath, serializeJson(value, options), options);
}

export function writeProtectedJsonAtomic(rootDir, relativePath, value, options = {}) {
  return writeProtectedFileAtomic(rootDir, relativePath, serializeJson(value, options), options);
}

export function ensureProtectedDirectoryTreeSync(rootDir, relativePath, options = {}) {
  const ops = syncOps(options.fsOps);
  const root = inspectRootSync(rootDir, ops);
  const segments = normalizeRelativePath(relativePath, { allowEmpty: true });
  const mode = normalizeMode(options.mode, 0o777);
  const snapshots = [root];

  for (const segment of segments) {
    const path = join(snapshots[snapshots.length - 1].path, segment);
    let entry = lstatOptionalSync(path, ops, "PARENT_TYPE");
    if (!entry) {
      try {
        ops.mkdir(path, mode);
      } catch (error) {
        if (error?.code !== "EEXIST") throw protectedError("DIRECTORY_CREATE_FAILED", error);
      }
      entry = lstatRequiredSync(path, ops, "PARENT_TYPE");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw protectedError("PARENT_TYPE");
    assertContained(root.path, path, "PARENT_CHANGED");
    snapshots.push(snapshot(path, entry));
  }

  invokeSyncHook(normalizeHooks(options.hooks).afterParentCheck);
  recheckSnapshotListSync(snapshots, ops);
  return snapshots[snapshots.length - 1].path;
}

export async function ensureProtectedDirectoryTree(rootDir, relativePath, options = {}) {
  const ops = asyncOps(options.fsOps);
  const root = await inspectRoot(rootDir, ops);
  const segments = normalizeRelativePath(relativePath, { allowEmpty: true });
  const mode = normalizeMode(options.mode, 0o777);
  const snapshots = [root];

  for (const segment of segments) {
    const path = join(snapshots[snapshots.length - 1].path, segment);
    let entry = await lstatOptional(path, ops, "PARENT_TYPE");
    if (!entry) {
      try {
        await ops.mkdir(path, mode);
      } catch (error) {
        if (error?.code !== "EEXIST") throw protectedError("DIRECTORY_CREATE_FAILED", error);
      }
      entry = await lstatRequired(path, ops, "PARENT_TYPE");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw protectedError("PARENT_TYPE");
    assertContained(root.path, path, "PARENT_CHANGED");
    snapshots.push(snapshot(path, entry));
  }

  await invokeHook(normalizeHooks(options.hooks).afterParentCheck);
  await recheckSnapshotList(snapshots, ops);
  return snapshots[snapshots.length - 1].path;
}

export function openProtectedAppendFileSync(rootDir, relativePath, options = {}) {
  if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") throw protectedError("APPEND_UNSUPPORTED");
  const ops = syncOps(options.fsOps);
  const mode = normalizeMode(options.mode, 0o666);
  const hooks = normalizeHooks(options.hooks);
  const context = preparePathSync(rootDir, relativePath, ops);

  invokeSyncHook(hooks.afterParentCheck);
  recheckParentsSync(context, ops);
  const initial = inspectAppendTargetSync(context.targetPath, ops);
  invokeSyncHook(hooks.afterTargetCheck);
  recheckParentsSync(context, ops);
  recheckAppendTargetSync(context.targetPath, initial, ops);

  let descriptor;
  try {
    descriptor = ops.open(
      context.targetPath,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_NOFOLLOW,
      mode,
    );
  } catch (error) {
    throw protectedError("APPEND_OPEN_FAILED", error);
  }

  let opened = null;
  try {
    opened = ops.fstat(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) throw protectedError("TARGET_TYPE");
    invokeSyncHook(hooks.afterTempOpen);
    recheckParentsSync(context, ops);
    const reopened = ops.fstat(descriptor);
    const current = lstatRequiredSync(context.targetPath, ops, "TARGET_CHANGED");
    if (
      !reopened.isFile()
      || reopened.nlink !== 1
      || !current.isFile()
      || current.isSymbolicLink()
      || current.nlink !== 1
      || !sameIdentity(reopened, opened)
      || !sameIdentity(current, reopened)
    ) {
      throw protectedError("TARGET_CHANGED");
    }
    if (initial && !sameIdentity(initial.entry, reopened)) throw protectedError("TARGET_CHANGED");
    return descriptor;
  } catch (error) {
    try {
      ops.close(descriptor);
    } catch {
      // The validation error remains authoritative; no write was attempted.
    }
    throw asProtectedError(error, "TARGET_CHANGED");
  }
}

function prepareWriteSync(rootDir, relativePath, settings, ops) {
  const context = preparePathSync(rootDir, relativePath, ops);
  context.settings = settings;
  return context;
}

async function prepareWrite(rootDir, relativePath, settings, ops) {
  const context = await preparePath(rootDir, relativePath, ops);
  context.settings = settings;
  return context;
}

function preparePathSync(rootDir, relativePath, ops) {
  const root = inspectRootSync(rootDir, ops);
  const segments = normalizeRelativePath(relativePath);
  const parentSegments = segments.slice(0, -1);
  const parents = [root];
  let current = root.path;
  for (const segment of parentSegments) {
    current = join(current, segment);
    const entry = lstatOptionalSync(current, ops, "PARENT_TYPE");
    if (!entry) throw protectedError("PARENT_MISSING");
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw protectedError("PARENT_TYPE");
    assertContained(root.path, current, "PARENT_CHANGED");
    parents.push(snapshot(current, entry));
  }
  return { root, parents, targetPath: join(current, segments.at(-1)), target: null };
}

async function preparePath(rootDir, relativePath, ops) {
  const root = await inspectRoot(rootDir, ops);
  const segments = normalizeRelativePath(relativePath);
  const parentSegments = segments.slice(0, -1);
  const parents = [root];
  let current = root.path;
  for (const segment of parentSegments) {
    current = join(current, segment);
    const entry = await lstatOptional(current, ops, "PARENT_TYPE");
    if (!entry) throw protectedError("PARENT_MISSING");
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw protectedError("PARENT_TYPE");
    assertContained(root.path, current, "PARENT_CHANGED");
    parents.push(snapshot(current, entry));
  }
  return { root, parents, targetPath: join(current, segments.at(-1)), target: null };
}

function inspectRootSync(rootDir, ops) {
  if (typeof rootDir !== "string" || rootDir.trim() === "" || rootDir.includes("\0")) {
    throw protectedError("INVALID_ROOT");
  }
  const requested = resolve(rootDir);
  const requestedEntry = lstatOptionalSync(requested, ops, "INVALID_ROOT");
  if (!requestedEntry || requestedEntry.isSymbolicLink() || !requestedEntry.isDirectory()) {
    throw protectedError(requestedEntry?.isSymbolicLink() ? "UNTRUSTED_ROOT" : "INVALID_ROOT");
  }
  let canonical;
  try {
    canonical = ops.realpath(requested);
  } catch (error) {
    throw protectedError("UNTRUSTED_ROOT", error);
  }
  const entry = lstatRequiredSync(canonical, ops, "UNTRUSTED_ROOT");
  if (entry.isSymbolicLink() || !entry.isDirectory() || !sameIdentity(entry, requestedEntry)) {
    throw protectedError("UNTRUSTED_ROOT");
  }
  return snapshot(canonical, entry);
}

async function inspectRoot(rootDir, ops) {
  if (typeof rootDir !== "string" || rootDir.trim() === "" || rootDir.includes("\0")) {
    throw protectedError("INVALID_ROOT");
  }
  const requested = resolve(rootDir);
  const requestedEntry = await lstatOptional(requested, ops, "INVALID_ROOT");
  if (!requestedEntry || requestedEntry.isSymbolicLink() || !requestedEntry.isDirectory()) {
    throw protectedError(requestedEntry?.isSymbolicLink() ? "UNTRUSTED_ROOT" : "INVALID_ROOT");
  }
  let canonical;
  try {
    canonical = await ops.realpath(requested);
  } catch (error) {
    throw protectedError("UNTRUSTED_ROOT", error);
  }
  const entry = await lstatRequired(canonical, ops, "UNTRUSTED_ROOT");
  if (entry.isSymbolicLink() || !entry.isDirectory() || !sameIdentity(entry, requestedEntry)) {
    throw protectedError("UNTRUSTED_ROOT");
  }
  return snapshot(canonical, entry);
}

function inspectTargetSync(path, commit, ops) {
  const entry = lstatOptionalSync(path, ops, "TARGET_TYPE");
  if (!entry) return { exists: false };
  if (commit === "create-only") throw protectedError("TARGET_EXISTS");
  if (entry.isSymbolicLink() || !entry.isFile()) throw protectedError("TARGET_TYPE");
  return { exists: true, identity: identity(entry) };
}

async function inspectTarget(path, commit, ops) {
  const entry = await lstatOptional(path, ops, "TARGET_TYPE");
  if (!entry) return { exists: false };
  if (commit === "create-only") throw protectedError("TARGET_EXISTS");
  if (entry.isSymbolicLink() || !entry.isFile()) throw protectedError("TARGET_TYPE");
  return { exists: true, identity: identity(entry) };
}

function inspectAppendTargetSync(path, ops) {
  const entry = lstatOptionalSync(path, ops, "TARGET_TYPE");
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw protectedError("TARGET_TYPE");
  return { entry };
}

function recheckAppendTargetSync(path, initial, ops) {
  const entry = lstatOptionalSync(path, ops, "TARGET_CHANGED");
  if (!initial) {
    if (entry) throw protectedError("TARGET_CHANGED");
    return;
  }
  if (!entry || entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || !sameIdentity(entry, initial.entry)) {
    throw protectedError("TARGET_CHANGED");
  }
}

function createTempSync(context, settings, ops) {
  let collision = null;
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
    const name = tempName(settings.randomName, context.targetPath, attempt);
    const path = join(context.parents.at(-1).path, name);
    let handle;
    try {
      handle = ops.open(path, exclusiveWriteFlags(), settings.mode);
    } catch (error) {
      if (error?.code === "EEXIST") {
        collision = error;
        continue;
      }
      throw protectedError("TEMP_OPEN_FAILED", error);
    }
    let entry;
    try {
      entry = ops.fstat(handle);
    } catch (error) {
      return { path, handle, identity: null, mode: null, deferredError: protectedError("TEMP_TYPE", error) };
    }
    const temp = { path, handle, identity: identity(entry), mode: entry.mode & 0o7777 };
    if (!entry.isFile() || entry.nlink !== 1) {
      temp.deferredError = protectedError("TEMP_TYPE");
      return temp;
    }
    let pathEntry;
    try {
      pathEntry = lstatRequiredSync(path, ops, "TEMP_CHANGED");
    } catch (error) {
      temp.deferredError = asProtectedError(error, "TEMP_CHANGED");
      return temp;
    }
    if (!pathEntry.isFile() || pathEntry.isSymbolicLink() || !sameIdentity(pathEntry, entry)) {
      temp.deferredError = protectedError("TEMP_CHANGED");
      return temp;
    }
    return temp;
  }
  throw protectedError("TEMP_COLLISION", collision);
}

async function createTemp(context, settings, ops) {
  let collision = null;
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
    const name = tempName(settings.randomName, context.targetPath, attempt);
    const path = join(context.parents.at(-1).path, name);
    let handle;
    try {
      handle = await ops.open(path, exclusiveWriteFlags(), settings.mode);
    } catch (error) {
      if (error?.code === "EEXIST") {
        collision = error;
        continue;
      }
      throw protectedError("TEMP_OPEN_FAILED", error);
    }
    let entry;
    try {
      entry = await ops.fstat(handle);
    } catch (error) {
      return { path, handle, identity: null, mode: null, deferredError: protectedError("TEMP_TYPE", error) };
    }
    const temp = { path, handle, identity: identity(entry), mode: entry.mode & 0o7777 };
    if (!entry.isFile() || entry.nlink !== 1) {
      temp.deferredError = protectedError("TEMP_TYPE");
      return temp;
    }
    let pathEntry;
    try {
      pathEntry = await lstatRequired(path, ops, "TEMP_CHANGED");
    } catch (error) {
      temp.deferredError = asProtectedError(error, "TEMP_CHANGED");
      return temp;
    }
    if (!pathEntry.isFile() || pathEntry.isSymbolicLink() || !sameIdentity(pathEntry, entry)) {
      temp.deferredError = protectedError("TEMP_CHANGED");
      return temp;
    }
    return temp;
  }
  throw protectedError("TEMP_COLLISION", collision);
}

function recheckWriteStateSync(context, temp, ops, handle = null) {
  recheckParentsSync(context, ops);
  if (context.target) recheckTargetSync(context.targetPath, context.target, ops);
  if (temp) recheckTempSync(temp, ops, handle);
}

async function recheckWriteState(context, temp, ops, handle = null) {
  await recheckParents(context, ops);
  if (context.target) await recheckTarget(context.targetPath, context.target, ops);
  if (temp) await recheckTemp(temp, ops, handle);
}

function recheckParentsSync(context, ops) {
  recheckSnapshotListSync(context.parents, ops);
}

function recheckSnapshotListSync(snapshots, ops) {
  for (const expected of snapshots) {
    const entry = lstatRequiredSync(expected.path, ops, "PARENT_CHANGED");
    if (entry.isSymbolicLink() || !entry.isDirectory() || !sameIdentity(entry, expected.identity)) {
      throw protectedError("PARENT_CHANGED");
    }
  }
}

async function recheckParents(context, ops) {
  await recheckSnapshotList(context.parents, ops);
}

async function recheckSnapshotList(snapshots, ops) {
  for (const expected of snapshots) {
    const entry = await lstatRequired(expected.path, ops, "PARENT_CHANGED");
    if (entry.isSymbolicLink() || !entry.isDirectory() || !sameIdentity(entry, expected.identity)) {
      throw protectedError("PARENT_CHANGED");
    }
  }
}

function recheckTargetSync(path, expected, ops) {
  const entry = lstatOptionalSync(path, ops, "TARGET_CHANGED");
  if (!expected.exists) {
    if (entry) throw protectedError("TARGET_CHANGED");
    return;
  }
  if (!entry || entry.isSymbolicLink() || !entry.isFile() || !sameIdentity(entry, expected.identity)) {
    throw protectedError("TARGET_CHANGED");
  }
}

async function recheckTarget(path, expected, ops) {
  const entry = await lstatOptional(path, ops, "TARGET_CHANGED");
  if (!expected.exists) {
    if (entry) throw protectedError("TARGET_CHANGED");
    return;
  }
  if (!entry || entry.isSymbolicLink() || !entry.isFile() || !sameIdentity(entry, expected.identity)) {
    throw protectedError("TARGET_CHANGED");
  }
}

function recheckTempSync(temp, ops, handle) {
  if (temp.deferredError) throw temp.deferredError;
  if (!temp.identity) throw protectedError("TEMP_TYPE");
  if (handle !== null) {
    let opened;
    try {
      opened = ops.fstat(handle);
    } catch (error) {
      throw protectedError("TEMP_CHANGED", error);
    }
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, temp.identity)) throw protectedError("TEMP_CHANGED");
  }
  const entry = lstatRequiredSync(temp.path, ops, "TEMP_CHANGED");
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || !sameIdentity(entry, temp.identity)) {
    throw protectedError("TEMP_CHANGED");
  }
}

async function recheckTemp(temp, ops, handle) {
  if (temp.deferredError) throw temp.deferredError;
  if (!temp.identity) throw protectedError("TEMP_TYPE");
  if (handle !== null) {
    let opened;
    try {
      opened = await ops.fstat(handle);
    } catch (error) {
      throw protectedError("TEMP_CHANGED", error);
    }
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, temp.identity)) throw protectedError("TEMP_CHANGED");
  }
  const entry = await lstatRequired(temp.path, ops, "TEMP_CHANGED");
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || !sameIdentity(entry, temp.identity)) {
    throw protectedError("TEMP_CHANGED");
  }
}

function writeAllSync(handle, bytes, ops) {
  let offset = 0;
  while (offset < bytes.length) {
    let count;
    try {
      count = ops.write(handle, bytes, offset, bytes.length - offset, null);
    } catch (error) {
      throw protectedError("WRITE_FAILED", error);
    }
    if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw protectedError("WRITE_FAILED");
    offset += count;
  }
}

async function writeAll(handle, bytes, ops) {
  let offset = 0;
  while (offset < bytes.length) {
    let count;
    try {
      count = await ops.write(handle, bytes, offset, bytes.length - offset, null);
    } catch (error) {
      throw protectedError("WRITE_FAILED", error);
    }
    if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw protectedError("WRITE_FAILED");
    offset += count;
  }
}

function commitReplaceSync(tempPath, targetPath, ops) {
  try {
    ops.rename(tempPath, targetPath);
  } catch (error) {
    throw commitError(error);
  }
}

async function commitReplace(tempPath, targetPath, ops) {
  try {
    await ops.rename(tempPath, targetPath);
  } catch (error) {
    throw commitError(error);
  }
}

function commitCreateOnlySync(tempPath, targetPath, ops) {
  try {
    ops.link(tempPath, targetPath);
  } catch (error) {
    throw createOnlyCommitError(error);
  }
}

async function commitCreateOnly(tempPath, targetPath, ops) {
  try {
    await ops.link(tempPath, targetPath);
  } catch (error) {
    throw createOnlyCommitError(error);
  }
}

function cleanupFailedTempSync(context, temp, settings, ops) {
  try {
    invokeSyncHook(settings.hooks.beforeCleanup);
    recheckParentsSync(context, ops);
    cleanupOwnedTempSync(temp, ops);
    return null;
  } catch (error) {
    return error instanceof ProtectedWriteError && error.code === "CLEANUP_INDETERMINATE"
      ? error
      : protectedError("CLEANUP_INDETERMINATE", error);
  }
}

async function cleanupFailedTemp(context, temp, settings, ops) {
  try {
    await invokeHook(settings.hooks.beforeCleanup);
    await recheckParents(context, ops);
    await cleanupOwnedTemp(temp, ops);
    return null;
  } catch (error) {
    return error instanceof ProtectedWriteError && error.code === "CLEANUP_INDETERMINATE"
      ? error
      : protectedError("CLEANUP_INDETERMINATE", error);
  }
}

function cleanupAfterPublishedSync(context, temp, settings, ops) {
  try {
    invokeSyncHook(settings.hooks.beforeCleanup);
    recheckParentsSync(context, ops);
    cleanupOwnedTempSync(temp, ops);
    return "clean";
  } catch {
    return "owned-temp-left";
  }
}

async function cleanupAfterPublished(context, temp, settings, ops) {
  try {
    await invokeHook(settings.hooks.beforeCleanup);
    await recheckParents(context, ops);
    await cleanupOwnedTemp(temp, ops);
    return "clean";
  } catch {
    return "owned-temp-left";
  }
}

function cleanupOwnedTempSync(temp, ops) {
  if (!temp.identity) throw protectedError("CLEANUP_INDETERMINATE");
  const entry = lstatOptionalSync(temp.path, ops, "CLEANUP_INDETERMINATE");
  if (!entry) return;
  if (!sameIdentity(entry, temp.identity)) throw protectedError("CLEANUP_INDETERMINATE");
  try {
    ops.unlink(temp.path);
  } catch (error) {
    throw protectedError("CLEANUP_INDETERMINATE", error);
  }
}

async function cleanupOwnedTemp(temp, ops) {
  if (!temp.identity) throw protectedError("CLEANUP_INDETERMINATE");
  const entry = await lstatOptional(temp.path, ops, "CLEANUP_INDETERMINATE");
  if (!entry) return;
  if (!sameIdentity(entry, temp.identity)) throw protectedError("CLEANUP_INDETERMINATE");
  try {
    await ops.unlink(temp.path);
  } catch (error) {
    throw protectedError("CLEANUP_INDETERMINATE", error);
  }
}

function lstatOptionalSync(path, ops, code) {
  try {
    return ops.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw protectedError(code, error);
  }
}

function lstatRequiredSync(path, ops, code) {
  const entry = lstatOptionalSync(path, ops, code);
  if (!entry) throw protectedError(code);
  return entry;
}

async function lstatOptional(path, ops, code) {
  try {
    return await ops.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw protectedError(code, error);
  }
}

async function lstatRequired(path, ops, code) {
  const entry = await lstatOptional(path, ops, code);
  if (!entry) throw protectedError(code);
  return entry;
}

function normalizeWriteOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw protectedError("INVALID_OPTIONS");
  const commit = options.commit ?? "replace-regular";
  if (commit !== "replace-regular" && commit !== "create-only") throw protectedError("INVALID_OPTIONS");
  return {
    commit,
    mode: normalizeMode(options.mode, 0o666),
    randomName: options.randomName,
    hooks: normalizeHooks(options.hooks),
  };
}

function normalizeMode(value, fallback) {
  const mode = value ?? fallback;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw protectedError("INVALID_OPTIONS");
  return mode;
}

function normalizeHooks(hooks) {
  if (hooks === undefined) return Object.freeze({});
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw protectedError("INVALID_OPTIONS");
  for (const value of Object.values(hooks)) {
    if (value !== undefined && typeof value !== "function") throw protectedError("INVALID_OPTIONS");
  }
  return hooks;
}

function normalizeRelativePath(value, options = {}) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw protectedError("INVALID_PATH");
  }
  if (value === "" && options.allowEmpty) return [];
  if (value === "") throw protectedError("INVALID_PATH");
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw protectedError("INVALID_PATH");
  }
  return segments;
}

function normalizeData(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw protectedError("INVALID_OPTIONS");
}

function serializeJson(value, options) {
  const space = options.space ?? 2;
  if (space !== 0 && space !== 2) throw protectedError("INVALID_OPTIONS");
  let serialized;
  try {
    serialized = JSON.stringify(value, null, space);
  } catch (error) {
    throw protectedError("INVALID_OPTIONS", error);
  }
  if (serialized === undefined) throw protectedError("INVALID_OPTIONS");
  return options.trailingNewline === false ? serialized : `${serialized}\n`;
}

function tempName(randomName, targetPath, attempt) {
  const generated = typeof randomName === "function"
    ? randomName({ attempt, targetPath })
    : typeof randomName === "string"
      ? randomName
      : `.${targetPath.split(sep).at(-1)}.${process.pid}.${randomUUID()}.tmp`;
  if (
    typeof generated !== "string"
    || generated === ""
    || generated === "."
    || generated === ".."
    || generated.includes("\0")
    || generated.includes("/")
    || generated.includes("\\")
    || generated === basename(targetPath)
  ) {
    throw protectedError("INVALID_OPTIONS");
  }
  return generated;
}

function exclusiveWriteFlags() {
  let flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL;
  if (typeof FS_CONSTANTS.O_NOFOLLOW === "number") flags |= FS_CONSTANTS.O_NOFOLLOW;
  return flags;
}

function snapshot(path, entry) {
  return { path, identity: identity(entry) };
}

function identity(entry) {
  return { dev: entry.dev, ino: entry.ino, type: entry.mode & FILE_TYPE_MASK };
}

function sameIdentity(left, right) {
  const expected = right.identity || right;
  const expectedType = expected.type ?? (expected.mode & FILE_TYPE_MASK);
  return left.dev === expected.dev && left.ino === expected.ino && (left.mode & FILE_TYPE_MASK) === expectedType;
}

function assertContained(root, path, code) {
  const rel = relative(root, path);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  throw protectedError(code);
}

function resultFor(context, settings, cleanup, mode) {
  return Object.freeze({ path: context.targetPath, commit: settings.commit, mode, cleanup });
}

function commitError(error) {
  return protectedError(error?.code === "EXDEV" ? "CROSS_DEVICE" : "COMMIT_FAILED", error);
}

function createOnlyCommitError(error) {
  if (error?.code === "EEXIST") return protectedError("TARGET_EXISTS", error);
  if (error?.code === "EXDEV") return protectedError("CROSS_DEVICE", error);
  if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) return protectedError("LINK_UNSUPPORTED", error);
  return protectedError("COMMIT_FAILED", error);
}

function protectedError(code, cause) {
  return new ProtectedWriteError(code, cause);
}

function asProtectedError(error, fallback) {
  return error instanceof ProtectedWriteError ? error : protectedError(fallback, error);
}

function invokeSyncHook(hook) {
  if (hook) hook();
}

async function invokeHook(hook) {
  if (hook) await hook();
}

function syncOps(injected = {}) {
  if (!injected || typeof injected !== "object" || Array.isArray(injected)) throw protectedError("INVALID_OPTIONS");
  return {
    lstat: injected.lstatSync || injected.lstat || lstatSync,
    realpath: injected.realpathSync || injected.realpath || realpathSync.native,
    mkdir: injected.mkdirSync || injected.mkdir || mkdirSync,
    open: injected.openSync || injected.open || openSync,
    fstat: injected.fstatSync || injected.fstat || fstatSync,
    write: injected.writeSync || injected.write || writeSync,
    close: injected.closeSync || injected.close || closeSync,
    rename: injected.renameSync || injected.rename || renameSync,
    link: injected.linkSync || injected.link || linkSync,
    unlink: injected.unlinkSync || injected.unlink || unlinkSync,
  };
}

function asyncOps(injected = {}) {
  if (!injected || typeof injected !== "object" || Array.isArray(injected)) throw protectedError("INVALID_OPTIONS");
  return {
    lstat: injected.lstat || ((path) => fsPromises.lstat(path)),
    realpath: injected.realpath || ((path) => fsPromises.realpath(path)),
    mkdir: injected.mkdir || ((path, mode) => fsPromises.mkdir(path, { mode })),
    open: injected.open || ((path, flags, mode) => fsPromises.open(path, flags, mode)),
    fstat: injected.fstat || ((handle) => handle.stat()),
    write: injected.write || (async (handle, buffer, offset, length, position) => {
      const result = await handle.write(buffer, offset, length, position);
      return result.bytesWritten;
    }),
    close: injected.close || ((handle) => handle.close()),
    rename: injected.rename || ((source, destination) => fsPromises.rename(source, destination)),
    link: injected.link || ((source, destination) => fsPromises.link(source, destination)),
    unlink: injected.unlink || ((path) => fsPromises.unlink(path)),
  };
}
