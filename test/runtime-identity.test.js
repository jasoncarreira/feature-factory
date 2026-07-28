import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { spawnSync } from "./helpers/git-fixture.js";
import { normalizeRuntimeIdentity, resolveRuntimeIdentity } from "../src/runtime-identity.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli.js");

describe("runtime identity observation", () => {
  it("reports exact plugin, package CLI, effective CLI, and OpenCode identities", () => {
    const fixture = executableFixture("exact");
    try {
      const identity = resolveRuntimeIdentity({
        commandCandidates: { "feature-factory": CLI, opencode: fixture.opencode },
      });

      assert.equal(identity.schema_version, 1);
      assert.equal(identity.plugin.source, join(ROOT, "src", "plugin.js"));
      assert.equal(identity.plugin.version, "0.2.1");
      assert.match(identity.plugin.hash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(identity.package_cli.source, CLI);
      assert.equal(identity.package_cli.version, "0.2.1");
      assert.match(identity.package_cli.hash, /^sha256:[0-9a-f]{64}$/u);
      assert.deepEqual(identity.cli, identity.package_cli);
      assert.equal(identity.opencode.source, realpathSync(fixture.opencode));
      assert.equal(identity.opencode.version, "opencode-test 1.2.3");
      assert.match(identity.opencode.hash, /^sha256:[0-9a-f]{64}$/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("observes a separately resolved CLI package version without deciding admission", () => {
    const fixture = executableFixture("separate");
    const packageRoot = join(fixture.root, "node_modules", "opencode-feature-factory");
    const cli = join(packageRoot, "src", "cli.js");
    try {
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-feature-factory", version: "9.9.9" }), "utf8");
      writeFileSync(cli, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(cli, 0o755);

      const identity = resolveRuntimeIdentity({ commandCandidates: { "feature-factory": cli, opencode: fixture.opencode } });
      assert.equal(identity.cli.source, realpathSync(cli));
      assert.equal(identity.cli.version, "9.9.9");
      assert.notEqual(identity.cli.hash, identity.package_cli.hash);
      assert.equal(Object.hasOwn(identity, "consistency"), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("skips a non-executable PATH candidate exactly as native command execution does", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-identity-path-access-"));
    const first = join(root, "first", "opencode");
    const second = join(root, "second", "opencode");
    try {
      writeExecutable(first, "first", 0o644);
      writeExecutable(second, "second");
      const env = { ...process.env, PATH: [dirname(first), dirname(second)].join(delimiter) };
      const executed = spawnSync("opencode", ["--version"], { cwd: root, env, encoding: "utf8" });
      const observed = resolveRuntimeIdentity({ cwd: root, env }).opencode;

      assert.equal(executed.status, 0, executed.stderr);
      assert.deepEqual(observed, executableIdentity(second, executed.stdout.trim()));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches native current-directory and relative PATH lookup for PATH=:fallback", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-identity-relative-path-"));
    const current = join(root, "opencode");
    const fallback = join(root, "fallback", "opencode");
    try {
      writeExecutable(current, "current");
      writeExecutable(fallback, "fallback");
      const env = { ...process.env, PATH: `${delimiter}fallback` };
      const executed = spawnSync("opencode", ["--version"], { cwd: root, env, encoding: "utf8" });
      const observed = resolveRuntimeIdentity({ cwd: root, env }).opencode;

      assert.equal(executed.status, 0, executed.stderr);
      assert.deepEqual(observed, executableIdentity(current, executed.stdout.trim()));

      chmodSync(current, 0o644);
      const fallbackExecution = spawnSync("opencode", ["--version"], { cwd: root, env, encoding: "utf8" });
      const fallbackObserved = resolveRuntimeIdentity({ cwd: root, env }).opencode;
      assert.equal(fallbackExecution.status, 0, fallbackExecution.stderr);
      assert.deepEqual(fallbackObserved, executableIdentity(fallback, fallbackExecution.stdout.trim()));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts sensitive identity text and removes terminal controls before reuse", () => {
    const identity = normalizeRuntimeIdentity({
      cli: { source: "/tmp/secret-cli\u001b[2J", version: "token-version\u202e", hash: `sha256:${"a".repeat(64)}`, ignored: true },
      opencode: { source: null, version: "ignored", hash: "bad" },
    });

    assert.deepEqual(identity.cli, { source: "[redacted]", version: "[redacted]", hash: `sha256:${"a".repeat(64)}` });
    assert.deepEqual(identity.opencode, { source: null, version: null, hash: null });
    assert.doesNotMatch(JSON.stringify(identity), /[\u001b\u009b\u202e]/u);
    assert.equal(JSON.stringify(identity).includes("ignored\":true"), false);
  });
});

function executableFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `runtime-identity-${name}-`));
  const opencode = join(root, "opencode");
  writeFileSync(opencode, "#!/bin/sh\nprintf 'opencode-test 1.2.3\\n'\n", "utf8");
  chmodSync(opencode, 0o755);
  return { root, opencode };
}

function writeExecutable(path, version, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, "utf8");
  chmodSync(path, mode);
}

function executableIdentity(path, version) {
  return {
    source: realpathSync(path),
    version,
    hash: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}
