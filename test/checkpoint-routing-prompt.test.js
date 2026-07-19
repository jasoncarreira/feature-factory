import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const DECOMPOSER = readFileSync(new URL("../assets/agent/work-decomposer.md", import.meta.url), "utf8");
const SKILL = readFileSync(new URL("../assets/skills/feature/SKILL.md", import.meta.url), "utf8");
const COMMAND = readFileSync(new URL("../assets/command/feature.md", import.meta.url), "utf8");

describe("B4.3 checkpoint routing prompts", () => {
  it("keeps routing machine-authored and stops the oversized parent before implementation authority", () => {
    assert.match(DECOMPOSER, /factory, not this agent, deterministically routes it into checkpoint requests before implementation/iu);
    assert.match(DECOMPOSER, /do not emit .* checkpoint requests/iu);
    assert.match(DECOMPOSER, /stable dependency\/topological then unit\/family\/obligation\/artifact order/iu);
    assert.match(DECOMPOSER, /must not seed runnable slices or proceed to slice branches, worktrees, dispatch, accepted decomposer state/iu);

    for (const prompt of [SKILL, COMMAND]) {
      assert.match(prompt, /factory slices-seed <run-id> --from plan\/slices\.json --json/iu);
      assert.match(prompt, /before .*accepted .*work-decomposer|before accepted decomposer state/iu);
      assert.match(prompt, /content-addressed .*manifest|content-addresses and persists the deterministic checkpoint manifest/iu);
      assert.match(prompt, /stop .*slice.*branch\/worktree\/dispatch/iu);
      assert.match(prompt, /no model-authored plan file|trust only the content-addressed runtime manifest/iu);
      assert.match(prompt, /boundary-open <run-id> terminal/iu);
      assert.match(prompt, /--boundary-token <terminal-boundary\.token>/iu);
      assert.match(prompt, /generation\/state[- ]hash/iu);
      assert.match(prompt, /rejects .*pending.*steering.*heartbeat.*Gate 2.*test-verifier/iu);
    }
  });

  it("requires every checkpoint to run as a fresh whole story and forbids cross-run assembly", () => {
    for (const prompt of [DECOMPOSER, SKILL, COMMAND]) {
      assert.match(prompt, /fresh normal .*feature.*run|fresh normal feature/iu);
      assert.match(prompt, /complete acceptance boundary/iu);
      assert.match(prompt, /integration test-verifier/iu);
      assert.match(prompt, /whole-story .*implementation-validator.*security-reviewer|whole-story validator\/security panels/iu);
      assert.match(prompt, /Gate 3/iu);
      assert.match(prompt, /one PR|exactly one PR/iu);
      assert.match(prompt, /checkpoint N\+1 .*only from `?main`? containing merged PR N/iu);
    }
    assert.match(SKILL, /Never split this oversized parent with B1 continuation\/carry-forward, retained merged rows, a partial PR, a cross-run merge train, a join, or a shared final panel/iu);
    assert.match(COMMAND, /Never use continuation\/carry-forward, retained merged rows, a partial PR, a cross-run merge train, a join, or a shared final panel/iu);
  });
});
