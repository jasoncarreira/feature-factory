import assert from "node:assert/strict";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ProtectedWriteError,
  ensureProtectedDirectoryTree,
  ensureProtectedDirectoryTreeSync,
  openProtectedAppendFileSync,
  writeProtectedFileAtomic,
  writeProtectedFileAtomicSync,
  writeProtectedJsonAtomic,
  writeProtectedJsonAtomicSync,
} from "../src/hardening/atomic-write.js";

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "feature-factory-atomic-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withRootAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), "feature-factory-atomic-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof ProtectedWriteError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("/"), false);
    return true;
  };
}

function tempEntries(root) {
  return readdirSync(root).filter((name) => name.startsWith(".known-temp"));
}

describe("protected atomic writes", () => {
  it("rejects missing, symlinked, and non-directory roots with fixed safe errors", () => withRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "feature-factory-atomic-outside-"));
    const rootLink = join(root, "root-link");
    const regular = join(root, "regular");
    try {
      symlinkSync(outside, rootLink, "dir");
      writeFileSync(regular, "not a directory");
      assert.throws(() => writeProtectedFileAtomicSync(join(root, "missing"), "x", "x"), assertCode("INVALID_ROOT"));
      assert.throws(() => writeProtectedFileAtomicSync(rootLink, "x", "x"), assertCode("UNTRUSTED_ROOT"));
      assert.throws(() => writeProtectedFileAtomicSync(regular, "x", "x"), assertCode("INVALID_ROOT"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it("rejects absolute, empty, NUL, backslash, empty, dot, and parent relative segments", () => withRoot((root) => {
    for (const path of ["", "/absolute", "a\0b", "a\\b", "a//b", "./a", "a/./b", "a/../b"]) {
      assert.throws(() => writeProtectedFileAtomicSync(root, path, "x"), assertCode("INVALID_PATH"), path);
    }
  }));

  it("creates checked directory trees and rejects symlinked or non-directory components", async () => withRootAsync(async (root) => {
    const canonicalRoot = realpathSync.native(root);
    assert.equal(ensureProtectedDirectoryTreeSync(root, "a/b"), join(canonicalRoot, "a", "b"));
    assert.ok(statSync(join(root, "a", "b")).isDirectory());
    assert.equal(await ensureProtectedDirectoryTree(root, "c/d"), join(canonicalRoot, "c", "d"));

    const outside = mkdtempSync(join(tmpdir(), "feature-factory-tree-outside-"));
    try {
      symlinkSync(outside, join(root, "linked"), "dir");
      writeFileSync(join(root, "file"), "x");
      assert.throws(() => ensureProtectedDirectoryTreeSync(root, "linked/child"), assertCode("PARENT_TYPE"));
      assert.throws(() => ensureProtectedDirectoryTreeSync(root, "file/child"), assertCode("PARENT_TYPE"));
      assert.equal(readdirSync(outside).length, 0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it("rejects symlinked, dangling, and non-regular targets without touching outside sentinels", () => withRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "feature-factory-target-outside-"));
    const sentinel = join(outside, "sentinel");
    try {
      writeFileSync(sentinel, "outside");
      symlinkSync(sentinel, join(root, "leaf-link"));
      symlinkSync(join(outside, "missing"), join(root, "dangling"));
      mkdirSync(join(root, "directory"));
      for (const target of ["leaf-link", "dangling", "directory"]) {
        assert.throws(() => writeProtectedFileAtomicSync(root, target, "new"), assertCode("TARGET_TYPE"));
      }
      assert.equal(readFileSync(sentinel, "utf8"), "outside");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it("rejects symlinked and missing parents", () => withRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "feature-factory-parent-outside-"));
    try {
      symlinkSync(outside, join(root, "linked"), "dir");
      assert.throws(() => writeProtectedFileAtomicSync(root, "linked/x", "new"), assertCode("PARENT_TYPE"));
      assert.throws(() => writeProtectedFileAtomicSync(root, "missing/x", "new"), assertCode("PARENT_MISSING"));
      assert.equal(readdirSync(outside).length, 0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it("replaces a regular hard link without modifying its outside inode", () => withRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "feature-factory-hardlink-outside-"));
    const sentinel = join(outside, "sentinel");
    try {
      writeFileSync(sentinel, "outside");
      linkSync(sentinel, join(root, "target"));
      writeProtectedFileAtomicSync(root, "target", "inside");
      assert.equal(readFileSync(join(root, "target"), "utf8"), "inside");
      assert.equal(readFileSync(sentinel, "utf8"), "outside");
      assert.notEqual(statSync(join(root, "target")).ino, statSync(sentinel).ino);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it("supports replacement, hard-link create-only publication, and JSON sync/async wrappers", async () => withRootAsync(async (root) => {
    writeFileSync(join(root, "replace"), "old");
    const replaced = writeProtectedFileAtomicSync(root, "replace", "new");
    assert.deepEqual({ commit: replaced.commit, cleanup: replaced.cleanup }, { commit: "replace-regular", cleanup: "none" });
    assert.equal(readFileSync(join(root, "replace"), "utf8"), "new");

    const created = await writeProtectedFileAtomic(root, "created", Buffer.from("published"), { commit: "create-only" });
    assert.equal(created.cleanup, "clean");
    assert.equal(readFileSync(join(root, "created"), "utf8"), "published");
    assert.throws(
      () => writeProtectedFileAtomicSync(root, "created", "clobber", { commit: "create-only" }),
      assertCode("TARGET_EXISTS"),
    );

    writeProtectedJsonAtomicSync(root, "sync.json", { ok: true });
    await writeProtectedJsonAtomic(root, "async.json", { ok: true }, { space: 0, trailingNewline: false });
    assert.equal(readFileSync(join(root, "sync.json"), "utf8"), '{\n  "ok": true\n}\n');
    assert.equal(readFileSync(join(root, "async.json"), "utf8"), '{"ok":true}');
  }));

  it("applies requested file modes only at exclusive creation and respects umask", () => withRoot((root) => {
    const previous = process.umask(0o027);
    try {
      const result = writeProtectedFileAtomicSync(root, "mode", "x", { mode: 0o666 });
      assert.equal(statSync(join(root, "mode")).mode & 0o777, 0o640);
      assert.equal(result.mode & 0o777, 0o640);
      writeProtectedFileAtomicSync(root, "private", "x", { mode: 0o600 });
      assert.equal(statSync(join(root, "private")).mode & 0o777, 0o600);
    } finally {
      process.umask(previous);
    }
  }));

  it("loops over short writes and rejects zero-progress writes", () => withRoot((root) => {
    let calls = 0;
    writeProtectedFileAtomicSync(root, "short", "abcdefgh", {
      fsOps: {
        writeSync(fd, bytes, offset, length) {
          calls += 1;
          return writeSync(fd, bytes, offset, Math.min(2, length));
        },
      },
    });
    assert.ok(calls >= 4);
    assert.equal(readFileSync(join(root, "short"), "utf8"), "abcdefgh");

    assert.throws(() => writeProtectedFileAtomicSync(root, "zero", "x", {
      randomName: ".known-temp-zero",
      fsOps: { writeSync: () => 0 },
    }), assertCode("WRITE_FAILED"));
    assert.equal(tempEntries(root).length, 0);
  }));

  it("detects a parent swap after the parent hook and never writes through it", () => withRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "feature-factory-parent-swap-"));
    mkdirSync(join(root, "parent"));
    try {
      assert.throws(() => writeProtectedFileAtomicSync(root, "parent/target", "new", {
        hooks: {
          afterParentCheck() {
            renameSync(join(root, "parent"), join(root, "old-parent"));
            symlinkSync(outside, join(root, "parent"), "dir");
          },
        },
      }), assertCode("PARENT_CHANGED"));
      assert.equal(readdirSync(outside).length, 0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  for (const hookName of ["afterTargetCheck", "afterTempOpen", "afterTempWrite", "afterTempClose", "beforeCommit"]) {
    it(`detects a target identity swap after ${hookName}`, () => withRoot((root) => {
      const target = join(root, "target");
      writeFileSync(target, "old");
      assert.throws(() => writeProtectedFileAtomicSync(root, "target", "new", {
        randomName: `.known-temp-${hookName}`,
        hooks: {
          [hookName]() {
            rmSync(target, { force: true });
            writeFileSync(target, "swapped");
          },
        },
      }), assertCode("TARGET_CHANGED"));
      assert.equal(readFileSync(target, "utf8"), "swapped");
      assert.equal(tempEntries(root).length, 0);
    }));
  }

  for (const hookName of ["afterTempOpen", "afterTempWrite", "afterTempClose", "beforeCommit"]) {
    it(`detects a temporary pathname swap after ${hookName} and leaves the replacement untouched`, () => withRoot((root) => {
      const temp = `.known-temp-swap-${hookName}`;
      assert.throws(() => writeProtectedFileAtomicSync(root, "target", "new", {
        randomName: temp,
        hooks: {
          [hookName]() {
            rmSync(join(root, temp), { force: true });
            writeFileSync(join(root, temp), "attacker");
          },
        },
      }), assertCode("CLEANUP_INDETERMINATE"));
      assert.equal(readFileSync(join(root, temp), "utf8"), "attacker");
      assert.equal(readdirSync(root).includes("target"), false);
    }));
  }

  it("stops after eight exclusive temporary-name collisions", () => withRoot((root) => {
    for (let attempt = 0; attempt < 8; attempt += 1) writeFileSync(join(root, `.collision-${attempt}`), "sentinel");
    let calls = 0;
    assert.throws(() => writeProtectedFileAtomicSync(root, "target", "new", {
      randomName({ attempt }) {
        calls += 1;
        return `.collision-${attempt}`;
      },
    }), assertCode("TEMP_COLLISION"));
    assert.equal(calls, 8);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      assert.equal(readFileSync(join(root, `.collision-${attempt}`), "utf8"), "sentinel");
    }
  }));

  it("maps write, close, rename, EXDEV, link, and unsupported-link failures to fixed errors", () => withRoot((root) => {
    const cases = [
      ["write", "WRITE_FAILED", { writeSync() { throw Object.assign(new Error("secret write detail"), { code: "EIO" }); } }],
      ["close", "CLOSE_FAILED", { closeSync(fd) { closeSync(fd); throw Object.assign(new Error("secret close detail"), { code: "EIO" }); } }],
      ["rename", "COMMIT_FAILED", { renameSync() { throw Object.assign(new Error("secret rename detail"), { code: "EIO" }); } }],
      ["exdev", "CROSS_DEVICE", { renameSync() { throw Object.assign(new Error("secret exdev detail"), { code: "EXDEV" }); } }],
    ];
    for (const [name, code, fsOps] of cases) {
      assert.throws(() => writeProtectedFileAtomicSync(root, `target-${name}`, "new", {
        randomName: `.known-temp-${name}`,
        fsOps,
      }), (error) => {
        assertCode(code)(error);
        assert.equal(error.message.includes("secret"), false);
        return true;
      });
      assert.equal(tempEntries(root).length, 0);
    }

    assert.throws(() => writeProtectedFileAtomicSync(root, "link-exists", "new", {
      commit: "create-only",
      randomName: ".known-temp-link-exists",
      fsOps: { linkSync() { throw Object.assign(new Error("detail"), { code: "EEXIST" }); } },
    }), assertCode("TARGET_EXISTS"));
    assert.throws(() => writeProtectedFileAtomicSync(root, "link-unsupported", "new", {
      commit: "create-only",
      randomName: ".known-temp-link-unsupported",
      fsOps: { linkSync() { throw Object.assign(new Error("detail"), { code: "EOPNOTSUPP" }); } },
    }), assertCode("LINK_UNSUPPORTED"));
    assert.throws(() => writeProtectedFileAtomicSync(root, "link-exdev", "new", {
      commit: "create-only",
      randomName: ".known-temp-link-exdev",
      fsOps: { linkSync() { throw Object.assign(new Error("detail"), { code: "EXDEV" }); } },
    }), assertCode("CROSS_DEVICE"));
    assert.throws(() => writeProtectedFileAtomicSync(root, "temp-open", "new", {
      fsOps: { openSync() { throw Object.assign(new Error("detail"), { code: "EACCES" }); } },
    }), assertCode("TEMP_OPEN_FAILED"));
    assert.equal(tempEntries(root).length, 0);
  }));

  it("rejects a non-regular or multiply-linked temporary descriptor", () => withRoot((root) => {
    assert.throws(() => writeProtectedFileAtomicSync(root, "target", "new", {
      randomName: ".known-temp-type",
      fsOps: {
        fstatSync(fd) {
          const actual = fstatSync(fd);
          return new Proxy(actual, { get(target, key) { return key === "nlink" ? 2 : Reflect.get(target, key); } });
        },
      },
    }), assertCode("TEMP_TYPE"));
    assert.equal(tempEntries(root).length, 0);
  }));

  it("never unlinks a different entry observed at cleanup", () => withRoot((root) => {
    const temp = ".known-temp-cleanup-swap";
    assert.throws(() => writeProtectedFileAtomicSync(root, "target", "new", {
      randomName: temp,
      fsOps: { writeSync() { throw Object.assign(new Error("fail"), { code: "EIO" }); } },
      hooks: {
        beforeCleanup() {
          rmSync(join(root, temp), { force: true });
          writeFileSync(join(root, temp), "different-entry");
        },
      },
    }), assertCode("CLEANUP_INDETERMINATE"));
    assert.equal(readFileSync(join(root, temp), "utf8"), "different-entry");
  }));

  it("leaves cleanup indeterminate rather than following a swapped parent", () => withRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "feature-factory-cleanup-parent-outside-"));
    mkdirSync(join(root, "parent"));
    writeFileSync(join(outside, ".known-temp-parent-cleanup"), "outside-sentinel");
    try {
      assert.throws(() => writeProtectedFileAtomicSync(root, "parent/target", "new", {
        randomName: ".known-temp-parent-cleanup",
        fsOps: { writeSync() { throw Object.assign(new Error("write"), { code: "EIO" }); } },
        hooks: {
          beforeCleanup() {
            renameSync(join(root, "parent"), join(root, "old-parent"));
            symlinkSync(outside, join(root, "parent"), "dir");
          },
        },
      }), assertCode("CLEANUP_INDETERMINATE"));
      assert.equal(readFileSync(join(outside, ".known-temp-parent-cleanup"), "utf8"), "outside-sentinel");
      assert.equal(readFileSync(join(root, "old-parent", ".known-temp-parent-cleanup"), "utf8"), "");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it("reports failed pre-commit unlink cleanup as indeterminate", () => withRoot((root) => {
    assert.throws(() => writeProtectedFileAtomicSync(root, "target", "new", {
      randomName: ".known-temp-unlink-fail",
      fsOps: {
        writeSync() { throw Object.assign(new Error("write"), { code: "EIO" }); },
        unlinkSync() { throw Object.assign(new Error("unlink"), { code: "EACCES" }); },
      },
    }), assertCode("CLEANUP_INDETERMINATE"));
    assert.equal(readFileSync(join(root, ".known-temp-unlink-fail"), "utf8"), "");
  }));

  it("returns committed create-only success when owned-temp unlink fails", () => withRoot((root) => {
    const result = writeProtectedFileAtomicSync(root, "target", "published", {
      commit: "create-only",
      randomName: ".known-temp-published",
      fsOps: { unlinkSync() { throw Object.assign(new Error("unlink"), { code: "EACCES" }); } },
    });
    assert.equal(result.cleanup, "owned-temp-left");
    assert.equal(readFileSync(join(root, "target"), "utf8"), "published");
    assert.equal(readFileSync(join(root, ".known-temp-published"), "utf8"), "published");
    assert.equal(statSync(join(root, "target")).ino, statSync(join(root, ".known-temp-published")).ino);
  }));

  it("provides a regular one-link no-follow append opener", () => withRoot((root) => {
    const descriptor = openProtectedAppendFileSync(root, "log", { mode: 0o600 });
    writeSync(descriptor, "one\n");
    closeSync(descriptor);
    const again = openProtectedAppendFileSync(root, "log");
    writeSync(again, "two\n");
    closeSync(again);
    assert.equal(readFileSync(join(root, "log"), "utf8"), "one\ntwo\n");
    assert.equal(statSync(join(root, "log")).nlink, 1);

    const outside = join(root, "outside");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "log-link"));
    linkSync(outside, join(root, "log-hardlink"));
    assert.throws(() => openProtectedAppendFileSync(root, "log-link"), assertCode("TARGET_TYPE"));
    assert.throws(() => openProtectedAppendFileSync(root, "log-hardlink"), assertCode("TARGET_TYPE"));
    assert.equal(readFileSync(outside, "utf8"), "outside");
  }));

  it("exposes injected filesystem operations without weakening no-follow flags", () => withRoot((root) => {
    let observedFlags = 0;
    const descriptor = openProtectedAppendFileSync(root, "log", {
      fsOps: {
        openSync(path, flags, mode) {
          observedFlags = flags;
          return openSync(path, flags, mode);
        },
      },
    });
    closeSync(descriptor);
    assert.notEqual(observedFlags & FS_CONSTANTS.O_APPEND, 0);
    assert.notEqual(observedFlags & FS_CONSTANTS.O_NOFOLLOW, 0);
  }));

  it("makes only complete old-or-new destination contents observable", async () => withRootAsync(async (root) => {
    const oldValue = "o".repeat(128 * 1024);
    const newValue = "n".repeat(128 * 1024);
    writeFileSync(join(root, "visible"), oldValue);
    const observed = new Set();
    let polling = true;
    const observer = (async () => {
      while (polling) {
        observed.add(readFileSync(join(root, "visible"), "utf8"));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let index = 0; index < 8; index += 1) {
      await writeProtectedFileAtomic(root, "visible", index % 2 === 0 ? newValue : oldValue, {
        fsOps: {
          async write(handle, bytes, offset, length, position) {
            await new Promise((resolve) => setImmediate(resolve));
            const result = await handle.write(bytes, offset, Math.min(4096, length), position);
            return result.bytesWritten;
          },
        },
      });
    }
    polling = false;
    await observer;
    assert.ok(observed.size >= 1);
    for (const value of observed) assert.ok(value === oldValue || value === newValue);
  }));

  it("does not claim protection against a swap inside the final rename syscall seam", () => withRoot((root) => {
    const target = join(root, "target");
    writeFileSync(target, "old");
    writeProtectedFileAtomicSync(root, "target", "new", {
      fsOps: {
        renameSync(source, destination) {
          rmSync(destination, { force: true });
          writeFileSync(destination, "raced-after-final-check");
          renameSync(source, destination);
        },
      },
    });
    assert.equal(readFileSync(target, "utf8"), "new");
  }));
});
