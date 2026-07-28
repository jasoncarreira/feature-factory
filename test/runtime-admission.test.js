import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { admitRuntimeLaunch, revalidateRuntimeLaunchBinding } from "../src/runtime-identity.js";
import { runForegroundFactory } from "../src/factory.js";
import { superviseDetachedLaunch } from "../src/detached-log-supervisor.js";

describe("runtime launch admission", () => {
  it("accepts a separately resolved feature-factory CLI with exact package CLI bytes", () => {
    const fixture = runtimeFixture("exact");
    try {
      writeExecutable(fixture.effectiveCli, readFileSync(fixture.packageCli));
      const binding = admit(fixture);
      assert.equal(binding.package_cli.source, realpathSync(fixture.packageCli));
      assert.equal(binding.opencode.source, realpathSync(fixture.opencode));
      assert.equal(revalidateRuntimeLaunchBinding(binding, options(fixture)), realpathSync(fixture.opencode));
    } finally { cleanup(fixture); }
  });

  it("rejects mismatched and unavailable PATH CLIs with exact package-source remediation", () => {
    const fixture = runtimeFixture("cli-failures");
    try {
      writeExecutable(fixture.effectiveCli, "#!/bin/sh\nprintf 'different-cli\\n'\n");
      assert.throws(() => admit(fixture), (error) => {
        assert.match(error.message, /CLI bytes differ/u);
        assert.match(error.message, new RegExp(escapeRegex(realpathSync(fixture.packageCli)), "u"));
        assert.match(error.message, /exact argv \["install","--global","--"/u);
        return true;
      });
      rmSync(fixture.effectiveCli);
      assert.throws(() => admit(fixture), /effective PATH feature-factory CLI is unavailable/u);
    } finally { cleanup(fixture); }
  });

  it("redacts sensitive package paths in mismatch remediation", () => {
    const fixture = runtimeFixture("Bearer-Q7M4Z9N2C8V5B1X6L3K0P7R2T9Y4U8I5");
    try {
      writeExecutable(fixture.effectiveCli, "#!/bin/sh\nprintf 'different-cli\\n'\n");
      assert.throws(() => admit(fixture), (error) => {
        assert.match(error.message, /\[redacted\]/u);
        assert.doesNotMatch(error.message, /Q7M4Z9N2C8V5B1X6L3K0P7R2T9Y4U8I5/u);
        return true;
      });
    } finally { cleanup(fixture); }
  });

  it("rejects OpenCode byte and effective-path drift after binding", () => {
    const fixture = runtimeFixture("opencode-drift");
    try {
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      const binding = admit(fixture);
      writeExecutable(fixture.opencode, "#!/bin/sh\nprintf 'changed\\n'\n");
      assert.throws(() => revalidateRuntimeLaunchBinding(binding, options(fixture)), /OpenCode executable bytes changed/u);

      writeExecutable(fixture.opencode, "#!/bin/sh\nprintf 'opencode-test 1\\n'\n");
      const rebound = admit(fixture);
      const replacement = join(fixture.bin, "opencode-next");
      writeExecutable(replacement, readFileSync(fixture.opencode));
      rmSync(fixture.opencode);
      symlinkSync(replacement, fixture.opencode);
      assert.throws(() => revalidateRuntimeLaunchBinding(rebound, options(fixture)), /opencode executable changed before spawn/u);
    } finally { cleanup(fixture); }
  });

  it("uses the bound absolute OpenCode executable with shell:false for foreground and detached spawn", async () => {
    const fixture = runtimeFixture("spawn-options");
    try {
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      const binding = admit(fixture);
      const foregroundChild = childProcessStub();
      const foreground = runForegroundFactory(fixture.root, ["run"], {
        env: fixture.env,
        runtimeAdmissionFn: () => binding,
        runtimeRevalidateFn: (accepted) => revalidateRuntimeLaunchBinding(accepted, options(fixture)),
        spawnFn(file, _args, spawnOptions) {
          assert.equal(file, realpathSync(fixture.opencode));
          assert.equal(spawnOptions.shell, false);
          queueMicrotask(() => {
            foregroundChild.stdout.end();
            foregroundChild.stderr.end();
            foregroundChild.emit("close", 0);
          });
          return foregroundChild;
        },
      });
      await foreground;

      const detachedChild = childProcessStub();
      const messages = [];
      const detached = superviseDetachedLaunch({
        repo: fixture.root,
        commandArgs: ["run"],
        env: fixture.env,
        runtimeBinding: binding,
        log: join(fixture.root, "detached.log"),
        recordEvidence: false,
      }, {
        send: (message) => messages.push(message),
        runtimeRevalidateFn: (accepted) => revalidateRuntimeLaunchBinding(accepted, options(fixture)),
        spawnFn(file, _args, spawnOptions) {
          assert.equal(file, realpathSync(fixture.opencode));
          assert.equal(spawnOptions.shell, false);
          queueMicrotask(() => {
            detachedChild.stdout.end();
            detachedChild.stderr.end();
            detachedChild.emit("close", 0);
          });
          return detachedChild;
        },
      });
      await detached;
      assert.deepEqual(messages.map(({ type }) => type), ["spawned", "ready"]);
    } finally { cleanup(fixture); }
  });
});

function runtimeFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `runtime-admission-${name}-`));
  const packageRoot = join(root, "package");
  const packageCli = join(packageRoot, "src", "cli.js");
  const packagePlugin = join(packageRoot, "src", "plugin.js");
  const bin = join(root, "bin");
  const effectiveCli = join(bin, "feature-factory");
  const opencode = join(bin, "opencode");
  mkdirSync(dirname(packageCli), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-feature-factory", version: "1.2.3" }));
  writeExecutable(packageCli, "#!/bin/sh\nexit 0\n");
  writeFileSync(packagePlugin, "export default {};\n");
  writeExecutable(opencode, "#!/bin/sh\nprintf 'opencode-test 1\\n'\n");
  const env = { ...process.env, PATH: bin };
  return { root, packageRoot, packageCli, bin, effectiveCli, opencode, env };
}

function admit(fixture) {
  return admitRuntimeLaunch(options(fixture));
}

function options(fixture) {
  return { packageRoot: fixture.packageRoot, cwd: fixture.root, env: fixture.env };
}

function writeExecutable(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function childProcessStub() {
  const child = new EventEmitter();
  child.pid = 43210;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
