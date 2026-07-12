import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/plugin.js";
import { POST_PR_CI_DEFAULTS, normalizePostPrCiConfig, normalizePostPrCiDriverOverride, resolvePostPrCiPolicy } from "../src/config.js";
import { decodeFeatureCommandPayload, encodeFeatureCommandPayload } from "../src/feature-command-payload.js";

describe("durable default-off post-PR policy", () => {
  it("uses the documented built-in defaults and converts strict plugin units", () => {
    assert.deepEqual(normalizePostPrCiConfig(undefined), POST_PR_CI_DEFAULTS);
    assert.deepEqual(normalizePostPrCiConfig({
      enabled: true,
      waitMinutes: 45,
      initialPollSeconds: 20,
      maxPollSeconds: 90,
      checkStartGraceSeconds: 180,
      maxTransientErrors: 7,
    }), {
      enabled: true,
      wait_ms: 2_700_000,
      initial_poll_ms: 20_000,
      max_poll_ms: 90_000,
      check_start_grace_ms: 180_000,
      max_transient_errors: 7,
    });
  });

  it("rejects unknown, non-integer, out-of-range, and reversed plugin values", () => {
    for (const value of [
      { surprise: true },
      { enabled: "yes" },
      { waitMinutes: 29 },
      { waitMinutes: 30.5 },
      { initialPollSeconds: 14 },
      { maxPollSeconds: 601 },
      { checkStartGraceSeconds: 59 },
      { maxTransientErrors: 51 },
      { initialPollSeconds: 60, maxPollSeconds: 30 },
    ]) assert.throws(() => normalizePostPrCiConfig(value));
  });

  it("resolves every field built-in < plugin < parent < explicit driver and derives review policy", () => {
    const inherited = resolvePostPrCiPolicy({
      plugin: { enabled: false, waitMinutes: 40, initialPollSeconds: 20 },
      parent: { ...POST_PR_CI_DEFAULTS, enabled: true, wait_ms: 4_000_000, review: { required: true, reviewer_login: "Parent-Reviewer", source: "driver" } },
      driver: { wait_ms: 5_000_000, max_poll_ms: 180_000 },
    });
    assert.equal(inherited.enabled, true);
    assert.equal(inherited.wait_ms, 5_000_000);
    assert.equal(inherited.initial_poll_ms, 30_000, "parent field wins over plugin per field");
    assert.equal(inherited.max_poll_ms, 180_000);
    assert.equal(inherited.review.reviewer_login, "Parent-Reviewer");

    const childOverride = resolvePostPrCiPolicy({ parent: inherited, reviewer: "Child-Reviewer" });
    assert.deepEqual(childOverride.review, { required: true, reviewer_login: "Child-Reviewer", source: "driver" });
  });

  it("keeps driver overrides partial and rejects untrusted driver policy shapes", () => {
    assert.deepEqual(normalizePostPrCiDriverOverride({ enabled: true, initial_poll_ms: 15_000 }), { enabled: true, initial_poll_ms: 15_000 });
    assert.throws(() => normalizePostPrCiDriverOverride({ waitMinutes: 30 }), /unknown key/u);
    assert.throws(() => normalizePostPrCiDriverOverride({ max_transient_errors: 0 }), /integer/u);
  });

  it("normalizes post_pr_ci in the encoded driver payload and rejects malformed overrides", () => {
    const decoded = decodeFeatureCommandPayload(encodeFeatureCommandPayload({
      operator_request: "start",
      driver: { mode: "autonomous", post_pr_ci: { enabled: true, wait_ms: 3_600_000 } },
    }));
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.payload.driver.post_pr_ci, { enabled: true, wait_ms: 3_600_000 });

    assert.deepEqual(decodeFeatureCommandPayload(encodeFeatureCommandPayload({ operator_request: "start", driver: { post_pr_ci: { unknown: true } } })), { ok: false, reason: "invalid-driver-post-pr-ci" });
    assert.deepEqual(decodeFeatureCommandPayload(encodeFeatureCommandPayload({ operator_request: "start", driver: { post_pr_ci_enabled: true } })), { ok: false, reason: "invalid-driver" });
  });

  it("injects the complete normalized policy and rejects invalid canonical plugin config", async () => {
    const instance = await plugin({}, { postPrCi: { enabled: true, waitMinutes: 30 } });
    const cfg = {};
    instance.config(cfg);
    assert.match(cfg.command.feature.template, /Post-PR CI policy: \{"enabled":true,"wait_ms":1800000/u);
    assert.match(cfg.command.feature.template, /persist the complete effective policy once/u);

    const invalid = await plugin({}, { postPrCi: { enabled: true, typo: 1 } });
    assert.throws(() => invalid.config({}), /unknown key 'typo'/u);
  });
});
