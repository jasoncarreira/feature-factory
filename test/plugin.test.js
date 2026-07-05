import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/plugin.js";

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

async function pluginConfig(options) {
  const cfg = {};
  const instance = await plugin({}, options);
  instance.config(cfg);
  return cfg;
}
