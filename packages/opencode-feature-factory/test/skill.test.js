import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const factoryRoot = resolve(packageRoot, "..", "feature-factory");
const skill = readFileSync(resolve(packageRoot, "skills/feature/SKILL.md"), "utf8");
const bundledWorkflow = readFileSync(resolve(packageRoot, "skills/feature/WORKFLOW.md"));
const canonicalWorkflow = readFileSync(resolve(factoryRoot, "WORKFLOW.md"));

describe("OpenCode skill adapter", () => {
  it("owns OpenCode mechanics and loads the exact canonical workflow before effects", () => {
    assert.ok(skill.startsWith("---\nname: feature\n"));
    assert.match(skill, /read `WORKFLOW\.md` located\nnext to this file completely/u);
    assert.match(skill, /feature_background/u);
    assert.match(skill, /FACTORY_SESSION_ID/u);
    assert.deepEqual(bundledWorkflow, canonicalWorkflow);
  });
});
