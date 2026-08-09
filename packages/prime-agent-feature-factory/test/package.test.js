import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const skill = readFileSync(new URL("../skills/feature/SKILL.md", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../skills/feature/WORKFLOW.md", import.meta.url), "utf8");
const canonicalWorkflow = readFileSync(new URL("../../feature-factory/WORKFLOW.md", import.meta.url), "utf8");

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
    for (const fragment of ["--base <value>", "missing value for --base; no run created.", "repeated --base; no run created.",
      "git check-ref-format --branch", "refs/heads/<value>", "factory init --pr-base <value>"]) assert.ok(skill.includes(fragment), fragment);
    assert.equal(workflow, canonicalWorkflow);
    const firstMatch = "Validation refuses the first matching defect in this order: unreadable or invalid JSON, a non-object root, or unknown keys; invalid `bootstrap`; `bootstrap_timeout_ms` without `bootstrap`; invalid `bootstrap_timeout_ms`; invalid `verify_timeout_ms`; then missing or invalid required entries.";
    const noOp = "When both bootstrap keys are absent, init and resume are exact no-ops for bootstrap: no execution, manifest fields, output, or response-shape change.";
    const checkBootstrapPolicy = (text) => {
      if (!text.includes(firstMatch)) throw new Error("bootstrap-first-match");
      if (!text.includes(noOp)) throw new Error("bootstrap-absence-no-op");
    };
    checkBootstrapPolicy(workflow);
    assert.throws(() => checkBootstrapPolicy(workflow.replace(firstMatch, "")), /bootstrap-first-match/u);
    assert.throws(() => checkBootstrapPolicy(workflow.replace(noOp, "")), /bootstrap-absence-no-op/u);
  });
});
