import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { continueFactory, resumeFactory, startFactory, startFactoryCheckpoint } from "../src/factory.js";
import { assertGlobalDefinitionsCurrent, inspectGlobalDefinitions } from "../src/global-definitions.js";
import { spawnSync } from "./helpers/git-fixture.js";
import { withTestRuntimeAdmission } from "./helpers/runtime-admission.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli.js");
const PLUGIN_URL = pathToFileURL(join(ROOT, "src", "plugin.js")).href;
const FEATURE_FACTORY_AGENT_FILES = Object.freeze([
  "backend-builder.md",
  "codebase-researcher.md",
  "design-interpreter.md",
  "frontend-builder.md",
  "implementation-validator.md",
  "security-reviewer.md",
  "spec-writer.md",
  "story-reader.md",
  "story-writer.md",
  "test-verifier.md",
  "work-decomposer.md",
  "work-reviewer.md",
]);

// Issue #103 sanctions only this exact global delegation bootstrap alongside the packaged skill.
const SANCTIONED_GLOBAL_FEATURE_SKILL = `---
name: feature
description: Use when the user invokes /feature or asks to take a feature, Jira ticket, work item, or product idea end-to-end with the opencode feature-factory workflow. Delegates to the repo-seeded current workflow under .opencode/skills/feature.
---

# Feature Factory Delegator

This global skill is intentionally a small bootstrapper. The current feature-factory workflow is seeded into the target repository before \`feature-factory factory start\` launches \`opencode run\`.

Before creating, resuming, validating, or mutating any factory run state:

1. Read the target repository file \`.opencode/skills/feature/SKILL.md\`.
2. Read \`.opencode/skills/feature/SCHEMA.md\` if the workflow references schema or state shape details.
3. Follow those repo-local files as the authoritative instructions for this run.

If \`.opencode/skills/feature/SKILL.md\` is missing, stop and report that the feature-factory skill was not seeded into the target repository. Do not fall back to inventing a run-state shape.

Do not use older global instructions, old \`version\` manifests, \`status: intake\`, or object-shaped \`steps\`. Use only the repo-local workflow and schema.
`;

describe("global feature-factory definition inspection", () => {
  it("treats absent definitions as healthy", () => {
    withHome((home) => {
      const result = inspect(home);
      assert.equal(result.ok, true);
      assert.equal(result.status, "healthy");
      assert.equal(result.definitions.every((item) => item.status === "absent"), true);
    });
  });

  it("inspects the exact closed-world global definition inventory", () => {
    withHome((home) => {
      const expected = [
        ["skill", ".config", "opencode", "skills", "feature", "SKILL.md"],
        ["skill", ".config", "opencode", "skill", "feature", "SKILL.md"],
        ["skill", ".claude", "skills", "feature", "SKILL.md"],
        ["skill", ".agents", "skills", "feature", "SKILL.md"],
        ...["agent", "agents"].flatMap((directory) => FEATURE_FACTORY_AGENT_FILES.map((name) => [
          "agent",
          ".config",
          "opencode",
          directory,
          name,
        ])),
        ["agent", ".config", "opencode", "agent", "feature-factory.md"],
        ["agent", ".config", "opencode", "agents", "feature-factory.md"],
      ].map(([kind, ...segments]) => ({ kind, path: join(home, ...segments) }));

      const result = inspect(home);
      assert.deepEqual(
        result.definitions.map(({ kind, path }) => ({ kind, path })),
        expected,
      );
      assert.equal(new Set(result.definitions.map(({ path }) => path)).size, 30);
    });
  });

  it("deduplicates HOME and effective config-dir definitions while preserving the 30-path oracle", () => {
    withHome((home) => {
      const result = inspect(home, {
        XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
      });
      assert.equal(result.definitions.length, 30);
      assert.equal(new Set(result.definitions.map(({ path }) => path)).size, 30);
    });
  });

  it("inspects stale skill and agent definitions under the effective XDG root", () => {
    withHome((home) => {
      const xdg = join(home, "xdg");
      const skill = join(xdg, "opencode", "skills", "feature", "SKILL.md");
      const agent = join(xdg, "opencode", "agents", FEATURE_FACTORY_AGENT_FILES[0]);
      write(skill, "stale skill\n");
      write(agent, "stale agent\n");

      const result = inspect(home, { XDG_CONFIG_HOME: xdg });
      assert.equal(result.definitions.length, 58);
      assert.equal(result.findings.some((item) => item.path === skill && item.status === "mismatch"), true);
      assert.equal(result.findings.some((item) => item.path === agent && item.status === "mismatch"), true);
    });
  });

  it("inspects singular and plural definition paths under OPENCODE_CONFIG_DIR", () => {
    withHome((home) => {
      const configDir = join(home, "effective-config");
      const skill = join(configDir, "skill", "feature", "SKILL.md");
      const agent = join(configDir, "agents", FEATURE_FACTORY_AGENT_FILES[0]);
      write(skill, "stale skill\n");
      write(agent, "stale agent\n");

      const result = inspect(home, { OPENCODE_CONFIG_DIR: configDir });
      assert.equal(result.definitions.length, 58);
      assert.equal(result.findings.some((item) => item.path === skill && item.status === "mismatch"), true);
      assert.equal(result.findings.some((item) => item.path === agent && item.status === "mismatch"), true);
    });
  });

  it("fails closed for inline and file config overrides without publishing their values", () => {
    withHome((home) => {
      const result = inspect(home, {
        OPENCODE_CONFIG: join(home, "Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==", "opencode.json"),
        OPENCODE_CONFIG_CONTENT: "{\"agent\":{\"feature-factory\":{\"prompt\":\"stale\"}}}",
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.findings.map(({ kind, source, status }) => ({ kind, source, status })), [
        { kind: "override", source: "OPENCODE_CONFIG", status: "unsupported" },
        { kind: "override", source: "OPENCODE_CONFIG_CONTENT", status: "unsupported" },
      ]);
      let error;
      try {
        assertGlobalDefinitionsCurrent({ inspect: () => result });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error);
      assert.doesNotMatch(error.message, /QWxhZGRpb/u);
      assert.doesNotMatch(error.message, /feature-factory.*prompt.*stale/u);
    });
  });

  it("accepts exact packaged and sanctioned feature skill bytes", () => {
    for (const contents of [
      readFileSync(join(ROOT, "assets", "skills", "feature", "SKILL.md")),
      SANCTIONED_GLOBAL_FEATURE_SKILL,
    ]) {
      withHome((home) => {
        write(join(home, ".config", "opencode", "skills", "feature", "SKILL.md"), contents);
        const result = inspect(home);
        assert.equal(result.ok, true);
        assert.equal(result.definitions.find((item) => item.kind === "skill" && item.status !== "absent")?.status, "exact");
      });
    }
  });

  it("rejects a one-byte mutation of the sanctioned feature skill", () => {
    withHome((home) => {
      const path = join(home, ".config", "opencode", "skills", "feature", "SKILL.md");
      const contents = Buffer.from(SANCTIONED_GLOBAL_FEATURE_SKILL);
      contents[contents.length - 1] ^= 1;
      write(path, contents);

      const result = inspect(home);
      assert.equal(result.ok, false);
      assert.deepEqual(result.findings, [{ kind: "skill", path, status: "mismatch" }]);
    });
  });

  it("rejects a stale feature skill", () => {
    withHome((home) => {
      const path = join(home, ".agents", "skills", "feature", "SKILL.md");
      write(path, "old feature workflow\n");
      const result = inspect(home);
      assert.equal(result.ok, false);
      assert.deepEqual(result.findings, [{ kind: "skill", path, status: "mismatch" }]);
    });
  });

  it("accepts exact and rejects one-byte mutations for all asset agents in both directory forms", () => {
    for (const directory of ["agent", "agents"]) {
      for (const name of FEATURE_FACTORY_AGENT_FILES) {
        for (const expectedStatus of ["exact", "mismatch"]) {
          withHome((home) => {
            const path = join(home, ".config", "opencode", directory, name);
            const contents = readFileSync(join(ROOT, "assets", "agent", name));
            if (expectedStatus === "mismatch") contents[contents.length - 1] ^= 1;
            write(path, contents);

            const result = inspect(home);
            assert.equal(result.definitions.find((item) => item.path === path)?.status, expectedStatus, `${directory}/${name} ${expectedStatus}`);
          });
        }
      }
    }
  });

  it("rejects extra recognized primary-agent definition files", () => {
    withHome((home) => {
      const path = join(home, ".config", "opencode", "agent", "feature-factory.md");
      write(path, "old primary agent prompt\n");
      const result = inspect(home);
      assert.deepEqual(result.findings, [{ kind: "agent", path, status: "mismatch" }]);
    });
  });

  it("fails closed for symlinked and ambiguous recognized paths", () => {
    withHome((home) => {
      const target = join(home, "target.md");
      const skill = join(home, ".config", "opencode", "skills", "feature", "SKILL.md");
      write(target, SANCTIONED_GLOBAL_FEATURE_SKILL);
      mkdirSync(dirname(skill), { recursive: true });
      symlinkSync(target, skill);
      write(join(home, ".config", "opencode", "agent"), "not a directory\n");

      const result = inspect(home);
      assert.equal(result.ok, false);
      assert.equal(result.findings.some((item) => item.path === skill && item.status === "symlink"), true);
      assert.equal(result.findings.some((item) => item.path === join(home, ".config", "opencode", "agent") && item.status === "ambiguous"), true);
    });
  });

  it("fails closed for unreadable recognized definitions", { skip: process.platform === "win32" }, (context) => {
    withHome((home) => {
      const path = join(home, ".config", "opencode", "agent", FEATURE_FACTORY_AGENT_FILES[0]);
      write(path, readFileSync(join(ROOT, "assets", "agent", FEATURE_FACTORY_AGENT_FILES[0])));
      chmodSync(path, 0o000);
      try {
        const result = inspect(home);
        const finding = result.findings.find((item) => item.path === path);
        if (!finding) return context.skip("the current user can read mode-000 files");
        assert.equal(finding.status, "unreadable");
      } finally {
        chmodSync(path, 0o600);
      }
    });
  });

  for (const operation of ["start", "resume"]) {
    for (const detached of [false, true]) {
      it(`blocks stale ${operation} ${detached ? "detached" : "foreground"} before child spawn`, async () => {
        const home = mkdtempSync(join(tmpdir(), "feature-factory-stale-launch-home-"));
        const repo = mkdtempSync(join(tmpdir(), "feature-factory-stale-launch-repo-"));
        let launches = 0;
        try {
          write(join(home, ".config", "opencode", "agent", FEATURE_FACTORY_AGENT_FILES[0]), "stale\n");
          const options = {
            cwd: repo,
            home,
            detached,
            headless: detached,
            foregroundLaunchFn: async () => { launches += 1; },
            detachedLaunchFn: async () => { launches += 1; },
          };
          await assert.rejects(
            operation === "start" ? startFactory(["build feature"], options) : resumeFactory("existing-run", options),
            (error) => error?.code === "ERR_STALE_GLOBAL_DEFINITIONS" && /restart opencode/u.test(error.message),
          );
          assert.equal(launches, 0);
        } finally {
          rmSync(home, { recursive: true, force: true });
          rmSync(repo, { recursive: true, force: true });
        }
      });
    }
  }

  it("blocks stale OPENCODE_CONFIG_DIR inherited by factory children before launch", async () => {
    const home = mkdtempSync(join(tmpdir(), "feature-factory-config-dir-home-"));
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-config-dir-repo-"));
    const configDir = join(home, "effective-opencode");
    let launches = 0;
    try {
      write(join(configDir, "agents", FEATURE_FACTORY_AGENT_FILES[0]), "stale\n");
      await assert.rejects(startFactory(["build feature"], {
        cwd: repo,
        env: cleanEnv(home, { OPENCODE_CONFIG_DIR: configDir }),
        foregroundLaunchFn: async () => { launches += 1; },
      }), (error) => error?.code === "ERR_STALE_GLOBAL_DEFINITIONS");
      assert.equal(launches, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  for (const definition of [
    { name: "skill", segments: ["skills", "feature", "SKILL.md"] },
    { name: "agent", segments: ["agents", FEATURE_FACTORY_AGENT_FILES[0]] },
  ]) {
    it(`blocks stale XDG ${definition.name} across every factory launch route`, async () => {
      const home = mkdtempSync(join(tmpdir(), "feature-factory-xdg-launch-home-"));
      const repo = mkdtempSync(join(tmpdir(), "feature-factory-xdg-launch-repo-"));
      const xdg = join(home, "effective-xdg");
      let launches = 0;
      try {
        write(join(xdg, "opencode", ...definition.segments), "stale\n");
        const base = {
          cwd: repo,
          env: cleanEnv(home, { XDG_CONFIG_HOME: xdg }),
          foregroundLaunchFn: async () => { launches += 1; },
          detachedLaunchFn: async () => { launches += 1; },
        };
        const routes = [
          ["start foreground", () => startFactory(["build feature"], base)],
          ["start detached", () => startFactory(["build feature"], { ...base, detached: true, headless: true, runId: "xdg-start" })],
          ["resume foreground", () => resumeFactory("missing-run", base)],
          ["resume detached", () => resumeFactory("missing-run", { ...base, detached: true, headless: true })],
          ["continue foreground", () => continueFactory("missing-parent", base)],
          ["continue detached", () => continueFactory("missing-parent", { ...base, detached: true, headless: true })],
          ["checkpoint foreground", () => startFactoryCheckpoint("missing-parent", "checkpoint-001", { ...base, runId: "xdg-checkpoint" })],
          ["checkpoint detached", () => startFactoryCheckpoint("missing-parent", "checkpoint-001", { ...base, runId: "xdg-checkpoint", detached: true, headless: true })],
        ];
        for (const [name, invoke] of routes) {
          await assert.rejects(
            async () => invoke(),
            (error) => error?.code === "ERR_STALE_GLOBAL_DEFINITIONS" && !error.message.includes(xdg),
            name,
          );
        }
        assert.equal(launches, 0);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  it("resolves relative OPENCODE_CONFIG_DIR from the child repository root", async () => {
    const home = mkdtempSync(join(tmpdir(), "feature-factory-relative-config-home-"));
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-relative-config-repo-"));
    const nested = join(repo, "nested", "caller");
    let launches = 0;
    try {
      mkdirSync(nested, { recursive: true });
      const initialized = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
      assert.equal(initialized.status, 0, initialized.stderr);
      write(join(repo, "relative-config", "agent", FEATURE_FACTORY_AGENT_FILES[0]), "stale\n");
      await assert.rejects(startFactory(["build feature"], {
        cwd: nested,
        env: cleanEnv(home, { OPENCODE_CONFIG_DIR: "relative-config" }),
        foregroundLaunchFn: async () => { launches += 1; },
      }), (error) => error?.code === "ERR_STALE_GLOBAL_DEFINITIONS");
      assert.equal(launches, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("passes the same inspected OpenCode environment to a healthy child launch", async () => {
    const home = mkdtempSync(join(tmpdir(), "feature-factory-launch-env-home-"));
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-launch-env-repo-"));
    const configDir = join(home, "effective-opencode");
    const env = cleanEnv(home, { OPENCODE_CONFIG_DIR: configDir, FEATURE_FACTORY_TEST_ENV: "inherited-exactly" });
    let launchedEnv;
    try {
      await startFactory(["build feature"], withTestRuntimeAdmission({
        cwd: repo,
        env,
        foregroundLaunchFn: async (_repo, _args, options) => { launchedEnv = options.env; },
      }));
      assert.equal(launchedEnv.HOME, home);
      assert.equal(launchedEnv.OPENCODE_CONFIG_DIR, configDir);
      assert.equal(launchedEnv.FEATURE_FACTORY_TEST_ENV, "inherited-exactly");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("requires an injected inspection result to use boolean ok=true", async () => {
    let launches = 0;
    await assert.rejects(startFactory(["build feature"], {
      inspectGlobalDefinitionsFn: () => ({ ok: 1, findings: [] }),
      foregroundLaunchFn: async () => { launches += 1; },
    }), (error) => error?.code === "ERR_STALE_GLOBAL_DEFINITIONS");
    assert.equal(launches, 0);
  });

  it("rejects direct plugin startup under stale effective definitions despite serialized bypass-like options", () => {
    withHome((home) => {
      const configDir = join(home, "effective-opencode");
      const stale = join(configDir, "agent", FEATURE_FACTORY_AGENT_FILES[0]);
      write(stale, "stale\n");
      const proc = runPlugin(home, { OPENCODE_CONFIG_DIR: configDir }, { diagnosticOnly: true, skipGlobalDefinitions: true });
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /stale global feature-factory definitions detected/u);
      assert.doesNotMatch(proc.stderr, new RegExp(escapeRegExp(stale), "u"));
    });
  });

  for (const definition of [
    { name: "skill", segments: ["skills", "feature", "SKILL.md"] },
    { name: "agent", segments: ["agent", FEATURE_FACTORY_AGENT_FILES[0]] },
  ]) {
    it(`rejects direct plugin registration under a stale XDG ${definition.name}`, () => {
      withHome((home) => {
        const xdg = join(home, "xdg");
        write(join(xdg, "opencode", ...definition.segments), "stale\n");
        const proc = runPlugin(home, { XDG_CONFIG_HOME: xdg });
        assert.notEqual(proc.status, 0);
        assert.match(proc.stderr, /stale global feature-factory definitions detected/u);
        assert.doesNotMatch(proc.stderr, new RegExp(escapeRegExp(xdg), "u"));
      });
    });
  }

  it("resolves direct plugin relative OPENCODE_CONFIG_DIR from pluginInput.directory", () => {
    withHome((home) => {
      const repo = join(home, "repo");
      const caller = join(home, "caller");
      mkdirSync(repo, { recursive: true });
      mkdirSync(caller, { recursive: true });
      write(join(repo, "relative-config", "agents", FEATURE_FACTORY_AGENT_FILES[0]), "stale\n");
      const proc = runPlugin(home, { OPENCODE_CONFIG_DIR: "relative-config" }, {}, { directory: repo }, caller);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /stale global feature-factory definitions detected/u);
      assert.doesNotMatch(proc.stderr, new RegExp(escapeRegExp(repo), "u"));
    });
  });

  it("registers /feature, the primary agent, and subagents under healthy effective definitions", () => {
    withHome((home) => {
      const proc = runPlugin(home);
      assert.equal(proc.status, 0, proc.stderr);
      assert.deepEqual(JSON.parse(proc.stdout), { command: true, primary: true, subagents: 12 });
    });
  });

  it("rechecks admission at config registration before mutating config", () => {
    withHome((home) => {
      const configDir = join(home, "effective-opencode");
      const stale = join(configDir, "agent", FEATURE_FACTORY_AGENT_FILES[0]);
      const script = `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { dirname } from "node:path";
        import plugin from ${JSON.stringify(PLUGIN_URL)};
        const hooks = await plugin({});
        mkdirSync(dirname(${JSON.stringify(stale)}), { recursive: true });
        writeFileSync(${JSON.stringify(stale)}, "stale\\n");
        const cfg = {};
        try { hooks.config(cfg); } catch (error) {
          console.log(JSON.stringify({ code: error.code, keys: Object.keys(cfg) }));
          process.exit(7);
        }
      `;
      const proc = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
        env: cleanEnv(home, { OPENCODE_CONFIG_DIR: configDir }),
      });
      assert.equal(proc.status, 7, proc.stderr);
      assert.deepEqual(JSON.parse(proc.stdout), { code: "ERR_STALE_GLOBAL_DEFINITIONS", keys: [] });
    });
  });

  it("does not expose Basic credentials from a hostile HOME in factory launch stderr", () => {
    const parent = mkdtempSync(join(tmpdir(), "feature-factory-hostile-launch-"));
    const secret = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
    const home = join(parent, `Authorization: Basic ${secret},visible`);
    const repo = join(parent, "repo");
    try {
      mkdirSync(repo, { recursive: true });
      write(join(home, ".config", "opencode", "agent", FEATURE_FACTORY_AGENT_FILES[0]), "stale\n");
      const proc = spawnSync(process.execPath, [CLI, "factory", "start", "build feature"], {
        cwd: repo,
        encoding: "utf8",
        env: cleanEnv(home),
      });
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /stale global feature-factory definitions detected/u);
      assert.doesNotMatch(proc.stderr, new RegExp(secret, "u"));
      assert.doesNotMatch(proc.stderr, new RegExp(escapeRegExp(home), "u"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "feature-factory-global-definitions-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function inspect(home, extraEnv = {}) {
  return inspectGlobalDefinitions({ home, env: cleanEnv(home, extraEnv) });
}

function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
    if (!Object.hasOwn(extra, name)) delete env[name];
  }
  return env;
}

function runPlugin(home, extraEnv = {}, options = {}, pluginInput = {}, cwd) {
  const script = `
    import plugin from ${JSON.stringify(PLUGIN_URL)};
    const hooks = await plugin(${JSON.stringify(pluginInput)}, ${JSON.stringify(options)});
    const cfg = {};
    hooks.config(cfg);
    console.log(JSON.stringify({ command: Boolean(cfg.command?.feature), primary: Boolean(cfg.agent?.["feature-factory"]), subagents: Object.keys(cfg.agent || {}).length - 1 }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(home, extraEnv),
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
