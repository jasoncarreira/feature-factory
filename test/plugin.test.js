import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import plugin from "../src/plugin.js";

const schemaDoc = readFileSync(new URL("../assets/skills/feature/SCHEMA.md", import.meta.url), "utf8");
const skillDoc = readFileSync(new URL("../assets/skills/feature/SKILL.md", import.meta.url), "utf8");

describe("plugin profiles", () => {
  it("lets security-reviewer use a dedicated security profile", async () => {
    const cfg = await pluginConfig({
      profiles: {
        reviewer: { model: "openai/gpt-5.5", variant: "xhigh" },
        security: { model: "openai/gpt-5.5", variant: "high" },
      },
    });

    assert.equal(cfg.agent["implementation-validator"].variant, "xhigh");
    assert.equal(cfg.agent["security-reviewer"].variant, "high");
  });

  it("falls security-reviewer back to reviewer profile for compatibility", async () => {
    const cfg = await pluginConfig({
      profiles: {
        reviewer: { model: "openai/gpt-5.5", variant: "xhigh" },
      },
    });

    assert.equal(cfg.agent["security-reviewer"].variant, "xhigh");
  });
});

describe("review tier contract docs", () => {
  it("documents top-level run.json.review_tier in the schema", () => {
    assert.match(schemaDoc, /Top-level `run\.json\.review_tier` stores the selected review tier/i);
    assert.match(schemaDoc, /optional for backward compatibility/i);
    assert.match(schemaDoc, /schema_version`; it remains `1`/i);
    assert.match(schemaDoc, /`selected`: required when `review_tier` is present\. Allowed values: `light`, `standard`, `strict`\./);
    assert.match(schemaDoc, /`source`: required when `review_tier` is present\. Allowed values: `explicit`, `default`\./);
    assert.match(schemaDoc, /`risk_reasons`: required array when `review_tier` is present\./);
    assert.match(schemaDoc, /`rationale`: required non-empty string when `review_tier` is present\./);

    for (const risk of [
      "security_or_auth",
      "schema_or_persistence",
      "generated_or_owned_code",
      "external_system_policy",
      "dependency_or_supply_chain",
      "workflow_or_release",
      "destructive_or_broad_scope",
    ]) {
      assert.match(schemaDoc, new RegExp(risk));
    }
  });

  it("documents initialization, backfill, and conservative defaults in the skill", () => {
    assert.match(skillDoc, /review tier: light\|standard\|strict/i);
    assert.match(skillDoc, /New runs must initialize `run\.json\.review_tier` during Step 0\./);
    assert.match(skillDoc, /Resumed runs missing `review_tier` must backfill it before the next state mutation, except `status` intents\./);
    assert.match(skillDoc, /If no explicit tier is selected and risky categories are detected[\s\S]*select `strict` with `source: default`/i);
    assert.match(skillDoc, /If no explicit tier is selected and no risky category is detected, select `standard` with `source: default`/i);
    assert.match(skillDoc, /Explicit `light` or `standard` is not automatically overwritten later\./);
    assert.match(skillDoc, /do not add or remove unrelated gates, agents, PR behavior, mandatory security review, or workflow redesign in v1/i);
    assert.match(skillDoc, /Existing mandatory gates, observed evidence, `work-reviewer`, `implementation-validator`, and `security-reviewer` behavior still applies\./);

    for (const risk of [
      "security_or_auth",
      "schema_or_persistence",
      "generated_or_owned_code",
      "external_system_policy",
      "dependency_or_supply_chain",
      "workflow_or_release",
      "destructive_or_broad_scope",
    ]) {
      assert.match(skillDoc, new RegExp(risk));
    }
  });
});

async function pluginConfig(options) {
  const cfg = {};
  const instance = await plugin({}, options);
  instance.config(cfg);
  return cfg;
}
