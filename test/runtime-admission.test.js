import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { admitRuntimeLaunch, revalidateRuntimeLaunchBinding, RuntimeAdmissionError } from "../src/runtime-identity.js";
import { runForegroundFactory, startDetached } from "../src/factory.js";
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

  it("rejects local plugin A with stale package and PATH CLI B before foreground or detached launch", () => {
    const fixture = runtimeFixture("configured-plugin-a-cli-b");
    const configured = createPackage(fixture.root, "plugin-a", {
      ...packageContents(fixture),
      cli: "#!/bin/sh\nprintf 'plugin-a-cli\\n'\n",
      plugin: "export default { configured: 'a' };\n",
    });
    let launches = 0;
    try {
      writePluginConfig(fixture, configured.root);
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      const expectedArgv = `[\"install\",\"--global\",\"--\",${JSON.stringify(realpathSync(configured.root))}]`;
      for (const invoke of [
        () => runForegroundFactory(fixture.root, ["run"], { ...options(fixture), foregroundLaunchFn: () => { launches += 1; } }),
        () => startDetached(fixture.root, ["run"], { ...options(fixture), detachedLaunchFn: () => { launches += 1; } }),
        () => startDetached(fixture.root, ["run"], { ...options(fixture), supervisorSpawnFn: () => { launches += 1; } }),
      ]) {
        assert.throws(invoke, (error) => error.code === "RUNTIME_ADMISSION_FAILED"
          && /configured local plugin/u.test(error.message)
          && error.message.includes(expectedArgv));
      }
      assert.equal(launches, 0);
    } finally { cleanup(fixture); }
  });

  it("accepts a different configured local package only when the complete runtime closure is exact", () => {
    const fixture = runtimeFixture("configured-same-bytes");
    const configured = createPackage(fixture.root, "plugin-a", packageContents(fixture));
    try {
      writePluginConfig(fixture, join(configured.root, "src", "opencode-plugin.js"));
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      const binding = admit(fixture);
      assert.equal(binding.configured_local, true);
      assert.equal(binding.configured_plugin.source, realpathSync(configured.plugin));
      assert.equal(binding.configured_package_cli.source, realpathSync(configured.cli));
      assert.equal(binding.package_closure.hash, binding.configured_package_closure.hash);
      assert.notEqual(binding.package_closure.source, binding.configured_package_closure.source);
      assert.equal(revalidateRuntimeLaunchBinding(JSON.parse(JSON.stringify(binding)), options(fixture)), realpathSync(fixture.opencode));
    } finally { cleanup(fixture); }
  });

  it("rejects unchanged CLI/plugin packages with divergent imported runtime closure before foreground or detached launch", () => {
    const fixture = runtimeFixture("configured-divergent-factory");
    const configured = createPackage(fixture.root, "plugin-a", {
      ...packageContents(fixture),
      factory: "export const runtime = 'divergent';\n",
      entrypoint: "export { default } from './plugin.js'; // divergent entrypoint\n",
    });
    let launches = 0;
    try {
      writePluginConfig(fixture, configured.root);
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      for (const invoke of [
        () => runForegroundFactory(fixture.root, ["run"], { ...options(fixture), foregroundLaunchFn: () => { launches += 1; } }),
        () => startDetached(fixture.root, ["run"], { ...options(fixture), detachedLaunchFn: () => { launches += 1; } }),
        () => startDetached(fixture.root, ["run"], { ...options(fixture), supervisorSpawnFn: () => { launches += 1; } }),
      ]) {
        assert.throws(invoke, /runtime package closure differs/u);
      }
      assert.equal(readFileSync(configured.cli, "utf8"), readFileSync(fixture.packageCli, "utf8"));
      assert.equal(readFileSync(configured.plugin, "utf8"), readFileSync(fixture.packagePlugin, "utf8"));
      assert.equal(launches, 0);
    } finally { cleanup(fixture); }
  });

  it("re-reads config and configured plugin bytes immediately before every launch seam", () => {
    const fixture = runtimeFixture("configured-pre-spawn-drift");
    const configured = createPackage(fixture.root, "plugin-a", packageContents(fixture));
    let launches = 0;
    try {
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      writePluginConfig(fixture, configured.root);
      const binding = admit(fixture);
      writePluginConfig(fixture, null);
      assert.throws(() => revalidateRuntimeLaunchBinding(binding, options(fixture)), /registration changed or was removed before spawn/u);

      writePluginConfig(fixture, configured.root);
      const pluginBinding = admit(fixture);
      writeFileSync(configured.plugin, "export default { drifted: true };\n");
      assert.throws(() => revalidateRuntimeLaunchBinding(pluginBinding, options(fixture)), /configured plugin implementation bytes changed before spawn/u);

      writeFileSync(configured.plugin, readFileSync(fixture.packagePlugin));
      const closureBinding = admit(fixture);
      writeFileSync(configured.factory, "export const runtime = 'drifted';\n");
      assert.throws(() => revalidateRuntimeLaunchBinding(closureBinding, options(fixture)), /configured runtime package closure bytes changed before spawn/u);

      for (const [launchOption, launch] of [
        ["foregroundLaunchFn", runForegroundFactory],
        ["detachedLaunchFn", startDetached],
        ["supervisorSpawnFn", startDetached],
      ]) {
        restorePackage(configured, fixture);
        writePluginConfig(fixture, configured.root);
        const launchOptions = {
          ...options(fixture),
          runtimeAdmissionFn(admissionOptions) {
            const accepted = admitRuntimeLaunch(admissionOptions);
            writePluginConfig(fixture, null);
            return accepted;
          },
          [launchOption]: () => { launches += 1; },
        };
        assert.throws(() => launch(fixture.root, ["run"], launchOptions), /registration changed or was removed before spawn/u);
      }
      assert.equal(launches, 0);
    } finally { cleanup(fixture); }
  });

  it("fails closed for multiple or unreadable local feature-factory registrations", () => {
    const fixture = runtimeFixture("configured-ambiguous");
    const configured = createPackage(fixture.root, "plugin-a", {
      ...packageContents(fixture),
    });
    try {
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      writePluginConfig(fixture, [configured.root, configured.plugin]);
      assert.throws(() => admit(fixture), /multiple local opencode-feature-factory plugin registrations/u);
      writePluginConfig(fixture, join(fixture.root, "missing-opencode-feature-factory"));
      assert.throws(() => admit(fixture), /plugin configuration is unreadable or ambiguous/u);
      const config = join(fixture.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc");
      writeFileSync(config, JSON.stringify({ plugin: ["{env:FEATURE_FACTORY_PLUGIN}"] }));
      assert.throws(() => admit(fixture), /plugin configuration is unreadable or ambiguous/u);
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

  it("rejects a symlink-backed package closure before launch", () => {
    const fixture = runtimeFixture("package-path-lockstep-drift");
    try {
      const accepted = join(fixture.root, "accepted-cli.js");
      writeExecutable(accepted, "#!/bin/sh\nexit 0\n");
      rmSync(fixture.packageCli);
      symlinkSync(accepted, fixture.packageCli);
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      assert.throws(() => admit(fixture), (error) => error.code === "RUNTIME_ADMISSION_FAILED"
        && /runtime package closure is incomplete, unreadable, or unsafe/u.test(error.message));
    } finally { cleanup(fixture); }
  });

  it("rejects incomplete, unreadable, and excessive runtime package closures", { skip: process.platform === "win32" }, () => {
    const cases = [
      ["incomplete", (fixture) => rmSync(join(fixture.packageRoot, "src", "validate.js"))],
      ["unreadable", (fixture) => chmodSync(join(fixture.packageRoot, "src", "factory.js"), 0o000)],
      ["files", (fixture) => {
        const directory = join(fixture.packageRoot, "assets", "generated");
        mkdirSync(directory, { recursive: true });
        for (let index = 0; index < 512; index += 1) writeFileSync(join(directory, `${index}.md`), "x");
      }],
      ["bytes", (fixture) => writeFileSync(join(fixture.packageRoot, "assets", "large.md"), Buffer.alloc((16 * 1024 * 1024) + 1))],
    ];
    for (const [name, corrupt] of cases) {
      const fixture = runtimeFixture(`closure-${name}`);
      try {
        symlinkSync(fixture.packageCli, fixture.effectiveCli);
        corrupt(fixture);
        assert.throws(() => admit(fixture), (error) => error.code === "RUNTIME_ADMISSION_FAILED"
          && /runtime package closure is incomplete, unreadable, or unsafe/u.test(error.message), name);
      } finally { cleanup(fixture); }
    }
  });

  it("rejects package CLI byte drift when the PATH CLI follows the same file", () => {
    const fixture = runtimeFixture("package-path-byte-drift");
    try {
      symlinkSync(fixture.packageCli, fixture.effectiveCli);
      const binding = admit(fixture);
      writeExecutable(fixture.packageCli, "#!/bin/sh\nprintf 'replacement\\n'\n");
      assert.throws(
        () => revalidateRuntimeLaunchBinding(binding, options(fixture)),
        /package CLI bytes changed before spawn/u,
      );
    } finally { cleanup(fixture); }
  });

  it("does not let injected launch or supervisor seams bypass production admission", () => {
    const fixture = runtimeFixture("injected-production-admission");
    let launches = 0;
    try {
      writeExecutable(fixture.effectiveCli, "#!/bin/sh\nprintf 'different-cli\\n'\n");
      assert.throws(() => runForegroundFactory(fixture.root, ["run"], {
        ...options(fixture),
        foregroundLaunchFn: () => { launches += 1; },
      }), /CLI bytes differ/u);
      assert.throws(() => startDetached(fixture.root, ["run"], {
        ...options(fixture),
        detachedLaunchFn: () => { launches += 1; },
      }), /CLI bytes differ/u);
      assert.throws(() => startDetached(fixture.root, ["run"], {
        ...options(fixture),
        supervisorSpawnFn: () => { launches += 1; },
      }), /CLI bytes differ/u);
      assert.equal(launches, 0);
    } finally { cleanup(fixture); }
  });

  it("runs immediate revalidation before injected foreground and detached launch seams", () => {
    const fixture = runtimeFixture("injected-revalidation");
    const remediation = "runtime admission failed: accepted runtime changed; remediation: restore exact bytes";
    let launches = 0;
    const injected = {
      runtimeAdmissionFn: () => ({ package_cli: { source: fixture.packageCli, hash: `sha256:${"a".repeat(64)}` }, opencode: { source: fixture.opencode, hash: `sha256:${"b".repeat(64)}` } }),
      runtimeRevalidateFn: () => { throw new RuntimeAdmissionError(remediation); },
    };
    try {
      assert.throws(() => runForegroundFactory(fixture.root, ["run"], {
        ...injected,
        foregroundLaunchFn: () => { launches += 1; },
      }), (error) => error.code === "RUNTIME_ADMISSION_FAILED" && error.message === remediation);
      assert.throws(() => startDetached(fixture.root, ["run"], {
        ...injected,
        detachedLaunchFn: () => { launches += 1; },
      }), (error) => error.code === "RUNTIME_ADMISSION_FAILED" && error.message === remediation);
      assert.throws(() => startDetached(fixture.root, ["run"], {
        ...injected,
        supervisorSpawnFn: () => { launches += 1; },
      }), (error) => error.code === "RUNTIME_ADMISSION_FAILED" && error.message === remediation);
      assert.equal(launches, 0);
    } finally { cleanup(fixture); }
  });

  it("preserves typed admission failure through detached pre-child handling and parent IPC", async () => {
    const fixture = runtimeFixture("typed-detached-admission");
    const remediation = "runtime admission failed: accepted package CLI source=[redacted]; remediation: exact safe command";
    const binding = {
      package_cli: { source: fixture.packageCli, hash: `sha256:${"a".repeat(64)}` },
      opencode: { source: fixture.opencode, hash: `sha256:${"b".repeat(64)}` },
    };
    let childSpawns = 0;
    try {
      await assert.rejects(superviseDetachedLaunch({
        repo: fixture.root,
        commandArgs: ["run"],
        env: fixture.env,
        runtimeBinding: JSON.parse(JSON.stringify(binding)),
        log: join(fixture.root, "pre-child.log"),
        recordEvidence: false,
      }, {
        runtimeRevalidateFn: () => { throw new RuntimeAdmissionError(remediation); },
        spawnFn: () => { childSpawns += 1; },
      }), (error) => error instanceof RuntimeAdmissionError
        && error.code === "RUNTIME_ADMISSION_FAILED"
        && error.message === remediation);
      assert.equal(childSpawns, 0);

      const supervisor = childProcessStub();
      supervisor.send = (message, callback) => {
        callback?.(null);
        if (message?.type === "init") queueMicrotask(() => supervisor.emit("message", { type: "error", error: remediation, code: "RUNTIME_ADMISSION_FAILED" }));
      };
      supervisor.unref = () => {};
      supervisor.disconnect = () => {};
      await assert.rejects(startDetached(fixture.root, ["run"], {
        runtimeAdmissionFn: () => binding,
        runtimeRevalidateFn: () => fixture.opencode,
        supervisorSpawnFn: () => supervisor,
      }), (error) => error instanceof RuntimeAdmissionError
        && error.code === "RUNTIME_ADMISSION_FAILED"
        && error.message === remediation);
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
  writeFileSync(join(packageRoot, "src", "opencode-plugin.js"), "export { default } from './plugin.js';\n");
  writeFileSync(join(packageRoot, "src", "factory.js"), "export const runtime = 'exact';\n");
  writeFileSync(join(packageRoot, "src", "validate.js"), "export const validate = true;\n");
  writeFileSync(join(packageRoot, "src", "run-state.js"), "export const runState = true;\n");
  writeWorkflowAssets(packageRoot);
  writeExecutable(opencode, "#!/bin/sh\nprintf 'opencode-test 1\\n'\n");
  const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), PATH: bin };
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  return { root, packageRoot, packageCli, packagePlugin, bin, effectiveCli, opencode, env };
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

function createPackage(parent, name, { cli, plugin, factory, entrypoint, validate, runState }) {
  const packageRoot = join(parent, name, "opencode-feature-factory");
  const packageCli = join(packageRoot, "src", "cli.js");
  const packagePlugin = join(packageRoot, "src", "plugin.js");
  mkdirSync(dirname(packageCli), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-feature-factory", version: "1.2.3" }));
  writeExecutable(packageCli, cli);
  writeFileSync(packagePlugin, plugin);
  writeFileSync(join(packageRoot, "src", "opencode-plugin.js"), entrypoint);
  const packageFactory = join(packageRoot, "src", "factory.js");
  writeFileSync(packageFactory, factory);
  writeFileSync(join(packageRoot, "src", "validate.js"), validate);
  writeFileSync(join(packageRoot, "src", "run-state.js"), runState);
  writeWorkflowAssets(packageRoot);
  return { root: packageRoot, cli: packageCli, plugin: packagePlugin, factory: packageFactory };
}

function packageContents(fixture) {
  return {
    cli: readFileSync(fixture.packageCli),
    plugin: readFileSync(fixture.packagePlugin),
    factory: readFileSync(join(fixture.packageRoot, "src", "factory.js")),
    entrypoint: readFileSync(join(fixture.packageRoot, "src", "opencode-plugin.js")),
    validate: readFileSync(join(fixture.packageRoot, "src", "validate.js")),
    runState: readFileSync(join(fixture.packageRoot, "src", "run-state.js")),
  };
}

function restorePackage(configured, fixture) {
  writeFileSync(configured.plugin, readFileSync(fixture.packagePlugin));
  writeFileSync(configured.factory, readFileSync(join(fixture.packageRoot, "src", "factory.js")));
}

function writeWorkflowAssets(packageRoot) {
  const files = [
    ["assets/command/feature.md", "# Feature command\n"],
    ["assets/skills/feature/SKILL.md", "# Feature skill\n"],
    ["assets/skills/feature/SCHEMA.md", "# Feature schema\n"],
  ];
  for (const [path, contents] of files) {
    const target = join(packageRoot, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function writePluginConfig(fixture, target) {
  const config = join(fixture.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc");
  mkdirSync(dirname(config), { recursive: true });
  const targets = Array.isArray(target) ? target : target ? [target] : [];
  writeFileSync(config, JSON.stringify({ plugin: targets.map((path) => pathToFileURL(path).href) }));
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
