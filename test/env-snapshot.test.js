import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTED_ENV_VALUE,
  collectRunDebugSnapshot,
  isSensitiveEnvKey,
  isSensitiveEnvValue,
  scrubSecretEnv,
} from "../src/env-snapshot.js";

describe("environment snapshot redaction", () => {
  it("redacts token-shaped and high-entropy values", () => {
    assert.equal(scrubSecretEnv("github_pat_123456789012345678901234567890"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("ghp_123456789012345678901234567890"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("hc_api_12345678901234567890"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("0123456789abcdef0123456789abcdef"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("abcdefghijklmnopqrstuvwxyz123456"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("Bearer abcdefghijklmnopqrstuvwxyz123456"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("https://user:pass@example.test/repo.git"), REDACTED_ENV_VALUE);
    assert.equal(scrubSecretEnv("a".repeat(20)), "a".repeat(20));
    assert.equal(isSensitiveEnvValue("AKIA1234567890ABCDEF"), true);
  });

  it("omits sensitive keys recursively", () => {
    assert.equal(isSensitiveEnvKey("api_token"), true);
    assert.deepEqual(scrubSecretEnv({ keep: "ok", api_token: "secret", nested: { password: "secret", safe: "value" } }), {
      keep: "ok",
      nested: { safe: "value" },
    });
  });

  it("collects run snapshots under env", async () => {
    const snapshot = await collectRunDebugSnapshot({ cwd: process.cwd(), event: "run-created", now: "2026-07-08T12:00:00.000Z" });
    assert.equal(snapshot.event, "run-created");
    assert.equal(snapshot.diagnostic_only, true);
    assert.equal(typeof snapshot.env, "object");
    assert.equal(snapshot.provenance, undefined);
  });
});
