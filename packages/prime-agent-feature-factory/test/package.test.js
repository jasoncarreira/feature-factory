import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const skill = readFileSync(new URL("../skills/feature/SKILL.md", import.meta.url), "utf8");

describe("Prime package contract", () => {
  it("declares a conventional Prime package with only runtime factory state dependency", () => {
    assert.equal(manifest.name, "prime-agent-feature-factory");
    assert.ok(manifest.keywords.includes("pi-package"));
    assert.deepEqual(manifest.pi, {
      extensions: ["./extensions"],
      skills: ["./skills"],
    });
    assert.deepEqual(manifest.dependencies, { "feature-factory": "0.3.6" });
    assert.ok(manifest.files.includes("extensions"));
    assert.ok(manifest.files.includes("skills"));
  });

  it("ships a valid feature skill and binds the canonical workflow to Prime delegation", () => {
    assert.ok(skill.startsWith("---\nname: feature\ndescription: "));
    assert.match(skill, /\nlicense: MIT\ncompatibility: [^\n]+\n---\n/u);
    assert.match(skill, /\[WORKFLOW\.md\]\(WORKFLOW\.md\)/u);
    assert.match(skill, /Do not assume the skill loader inlined it/u);
    assert.match(skill, /feature_factory_context/u);
    assert.match(skill, /handle = await rlm\(prompt\)/u);
    assert.match(skill, /receiver_role="parent"/u);
    assert.match(skill, /never hand-write `run\.json`/u);
    assert.match(skill, /Reject `--background` before any run effect/u);
  });
});
