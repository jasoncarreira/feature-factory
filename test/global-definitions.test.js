import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resumeFactory, startFactory } from "../src/factory.js";
import { inspectGlobalDefinitions } from "../src/global-definitions.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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
      const result = inspectGlobalDefinitions({ home });
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

      const result = inspectGlobalDefinitions({ home });
      assert.deepEqual(
        result.definitions.map(({ kind, path }) => ({ kind, path })),
        expected,
      );
      assert.equal(new Set(result.definitions.map(({ path }) => path)).size, 30);
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

  it("rejects a one-byte mutation of the sanctioned feature skill", () => {
    withHome((home) => {
      const path = join(home, ".config", "opencode", "skills", "feature", "SKILL.md");
      const contents = Buffer.from(SANCTIONED_GLOBAL_FEATURE_SKILL);
      contents[contents.length - 1] ^= 1;
      write(path, contents);

      const result = inspectGlobalDefinitions({ home });
      assert.equal(result.ok, false);
      assert.deepEqual(result.findings, [{ kind: "skill", path, status: "mismatch" }]);
    });
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

  it("accepts exact and rejects stale bytes for every asset agent", () => {
    withHome((home) => {
      const exactPaths = FEATURE_FACTORY_AGENT_FILES.map((name) => {
        const path = join(home, ".config", "opencode", "agent", name);
        write(path, readFileSync(join(ROOT, "assets", "agent", name)));
        return path;
      });
      const stalePaths = FEATURE_FACTORY_AGENT_FILES.map((name) => {
        const path = join(home, ".config", "opencode", "agents", name);
        const contents = readFileSync(join(ROOT, "assets", "agent", name));
        contents[contents.length - 1] ^= 1;
        write(path, contents);
        return path;
      });

      const result = inspectGlobalDefinitions({ home });
      assert.deepEqual(
        result.definitions.filter((item) => exactPaths.includes(item.path)).map(({ path, status }) => ({ path, status })),
        exactPaths.map((path) => ({ path, status: "exact" })),
      );
      assert.deepEqual(
        result.definitions.filter((item) => stalePaths.includes(item.path)).map(({ path, status }) => ({ path, status })),
        stalePaths.map((path) => ({ path, status: "mismatch" })),
      );
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
