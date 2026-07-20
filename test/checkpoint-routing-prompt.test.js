import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const DECOMPOSER = readFileSync(new URL("../assets/agent/work-decomposer.md", import.meta.url), "utf8");
const REVIEWER = readFileSync(new URL("../assets/agent/work-reviewer.md", import.meta.url), "utf8");

describe("B4.3 reviewed checkpoint routing prompts", () => {
  it("requires the explicit closed checkpoint plan and forbids runtime scope inference", () => {
    assert.match(DECOMPOSER, /closed `delivery-checkpoint-plan` data/iu);
    assert.match(DECOMPOSER, /exact parent `acceptance_inventory`/iu);
    assert.match(DECOMPOSER, /policy-controlled `acceptance_mappings`/iu);
    assert.match(DECOMPOSER, /exact `brief_scope`/iu);
    assert.match(DECOMPOSER, /complete one-slice ordinary `child_plan`/iu);
    assert.match(DECOMPOSER, /has no nested checkpoint plan/iu);
    assert.match(DECOMPOSER, /runtime must never infer checkpoint scope or child plans/iu);
    assert.match(DECOMPOSER, /Runtime validates and copies each exact reviewed scope, child plan, acceptance projection, hashes, and child disposition/iu);
    assert.match(DECOMPOSER, /never synthesizes a child verdict or infers scope/iu);
  });

  it("requires a nonmutating probe after planning and before review", () => {
    assert.match(DECOMPOSER, /probe must run after the plan bytes are written and before work-reviewer review/iu);
    assert.match(REVIEWER, /exact nonmutating `delivery-plan-admission-probe` produced after the plan bytes were written/iu);
    assert.match(REVIEWER, /Never review or approve decomposition before this probe/iu);
    assert.match(REVIEWER, /reject a missing, invalid, stale, or plan-mismatched probe/iu);
    assert.match(REVIEWER, /never substitute your own inferred admission decision/iu);
  });

  it("requires APPROVE-CHECKPOINT with independent identity and exact child dispositions", () => {
    for (const prompt of [DECOMPOSER, REVIEWER]) {
      assert.match(prompt, /APPROVE-CHECKPOINT/iu);
      assert.match(prompt, /review_identity/iu);
      assert.match(prompt, /checkpoint-child-decomposition-review/iu);
      assert.match(prompt, /exactly one ordered|exactly one disposition/iu);
      assert.match(prompt, /verdict `?APPROVE`?/iu);
      assert.match(prompt, /Missing, duplicate, reordered, cross-bound, stale, rejecting, or extra dispositions/iu);
    }
    assert.match(DECOMPOSER, /not plain `APPROVE`/iu);
    assert.match(REVIEWER, /valid `checkpoint` probe may receive only `APPROVE-CHECKPOINT`/iu);
    assert.match(REVIEWER, /identity_hash.*other identity fields only/iu);
    assert.match(REVIEWER, /never hash the enclosing review bytes into themselves/iu);
    assert.match(REVIEWER, /never leave runtime to create or repair a child verdict/iu);
  });

  it("preserves the normal child whole-story and strict sequencing boundary", () => {
    assert.match(DECOMPOSER, /normal complete child feature run/iu);
    assert.match(DECOMPOSER, /complete acceptance boundary/iu);
    assert.match(DECOMPOSER, /integration test-verifier/iu);
    assert.match(DECOMPOSER, /whole-story implementation-validator and security-reviewer panels/iu);
    assert.match(DECOMPOSER, /Gate 3, and one PR/iu);
    assert.match(DECOMPOSER, /checkpoint N\+1 starts only from `main` containing merged PR N/iu);
    assert.match(DECOMPOSER, /must not seed runnable slices or proceed to Gate 2, slice branches, worktrees, dispatch/iu);
  });
});
