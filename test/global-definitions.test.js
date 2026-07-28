import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resumeFactory, startFactory } from "../src/factory.js";
import { FEATURE_FACTORY_AGENT_FILES, SANCTIONED_GLOBAL_FEATURE_SKILL, inspectGlobalDefinitions } from "../src/global-definitions.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("global feature-factory definition inspection", () => {
  it("treats absent definitions as healthy", () => {
    withHome((home) => {
      const result = inspectGlobalDefinitions({ home });
      assert.equal(result.ok, true);
      assert.equal(result.status, "healthy");
      assert.equal(result.definitions.every((item) => item.status === "absent"), true);
    });
  });

  it("accepts exact packaged and sanctioned feature skill bytes", () => {
    for (const contents of [
      readFileSync(join(ROOT, "assets", "skills", "feature", "SKILL.md")),
      SANCTIONED_GLOBAL_FEATURE_SKILL,
    ]) {
      withHome((home) => {
        write(join(home, ".config", "opencode", "skills", "feature", "SKILL.md"), contents);
        const result = inspectGlobalDefinitions({ home });
        assert.equal(result.ok, true);
        assert.equal(result.definitions.find((item) => item.kind === "skill" && item.status !== "absent")?.status, "exact");
      });
    }
  });

  it("rejects a stale feature skill", () => {
    withHome((home) => {
      const path = join(home, ".agents", "skills", "feature", "SKILL.md");
      write(path, "old feature workflow\n");
      const result = inspectGlobalDefinitions({ home });
      assert.equal(result.ok, false);
      assert.deepEqual(result.findings, [{ kind: "skill", path, status: "mismatch" }]);
    });
  });

  it("accepts exact agents and rejects stale recognized agent files in either global directory", () => {
    withHome((home) => {
      const exactName = FEATURE_FACTORY_AGENT_FILES[0];
      const staleName = FEATURE_FACTORY_AGENT_FILES.at(-1);
      const exact = join(home, ".config", "opencode", "agent", exactName);
      const stale = join(home, ".config", "opencode", "agents", staleName);
      write(exact, readFileSync(join(ROOT, "assets", "agent", exactName)));
      write(stale, "old agent prompt\n");

      const result = inspectGlobalDefinitions({ home });
      assert.equal(result.definitions.find((item) => item.path === exact)?.status, "exact");
      assert.deepEqual(result.findings, [{ kind: "agent", path: stale, status: "mismatch" }]);
    });
  });

  it("rejects extra recognized primary-agent definition files", () => {
    withHome((home) => {
      const path = join(home, ".config", "opencode", "agent", "feature-factory.md");
      write(path, "old primary agent prompt\n");
      const result = inspectGlobalDefinitions({ home });
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

      const result = inspectGlobalDefinitions({ home });
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
        const result = inspectGlobalDefinitions({ home });
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
