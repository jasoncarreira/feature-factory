import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REDACTED_PROVENANCE_VALUE,
  collectRunProvenanceSnapshot,
  isSensitiveProvenanceKey,
  isSensitiveProvenanceValue,
  scrubSecretProvenance,
} from "../src/provenance.js";

const TOKEN_FIXTURES = [
  ["github classic ghp", "ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCDEF"],
  ["github fine-grained", "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890"],
  ["github oauth", "gho_abcdefghijklmnopqrstuvwxyz1234567890ABCDEF"],
  ["github user-to-server", "ghu_abcdefghijklmnopqrstuvwxyz1234567890ABCDEF"],
  ["github server-to-server", "ghs_abcdefghijklmnopqrstuvwxyz1234567890ABCDEF"],
  ["github refresh", "ghr_abcdefghijklmnopqrstuvwxyz1234567890ABCDEF"],
  ["openai project", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef"],
  ["openai secret", "sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef"],
  ["slack bot", "xoxb_123456789012-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"],
  ["slack user", "xoxp_123456789012-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"],
  ["slack app", "xoxa_123456789012-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"],
  ["gitlab", "glpat-AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
  ["bearer", "Bearer abcdefghijklmnopqrstuvwxyzABCDE1234567890"],
  ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.aBcdEf1234567890_-signature"],
  ["aws access key", "AKIAIOSFODNN7EXAMPLE"],
  ["aws temporary access key", "ASIAIOSFODNN7EXAMPLE"],
  ["credential url", "https://oauth2:credential-value@example.com/owner/repo.git"],
  ["high entropy single token", "AbCDefGhIJklMNOpQRstUVwxYZ0123456789_-+=AbCdEf"],
];

describe("provenance redaction", () => {
  it("redacts token-shaped and high-entropy provenance values", () => {
    for (const [name, raw] of TOKEN_FIXTURES) {
      assert.equal(isSensitiveProvenanceValue(raw), true, name);
      assert.equal(scrubSecretProvenance(raw), REDACTED_PROVENANCE_VALUE, name);
    }

    assert.equal(isSensitiveProvenanceValue("ordinary-model-name"), false);
    assert.equal(scrubSecretProvenance("ordinary-model-name"), "ordinary-model-name");
  });

  it("omits sensitive keys while redacting whole string values", () => {
    const rawGithubToken = TOKEN_FIXTURES[0][1];
    const rawBearerToken = TOKEN_FIXTURES[12][1];
    const rawHighEntropyToken = TOKEN_FIXTURES[17][1];
    const input = {
      safe: "ordinary-model-name",
      accessToken: rawGithubToken,
      nested: {
        api_key: rawGithubToken,
        public_model: rawBearerToken,
        variants: [rawGithubToken, "safe-variant", { password: "literal-password", visible: rawHighEntropyToken }],
      },
    };

    assert.equal(isSensitiveProvenanceKey("accessToken"), true);
    assert.equal(isSensitiveProvenanceKey("api_key"), true);
    assert.equal(isSensitiveProvenanceKey("public_model"), false);

    const scrubbed = scrubSecretProvenance(input);
    assert.deepEqual(scrubbed, {
      safe: "ordinary-model-name",
      nested: {
        public_model: REDACTED_PROVENANCE_VALUE,
        variants: [REDACTED_PROVENANCE_VALUE, "safe-variant", { visible: REDACTED_PROVENANCE_VALUE }],
      },
    });
    assertRawValuesAbsent(scrubbed, [rawGithubToken, rawBearerToken, rawHighEntropyToken, "literal-password"]);
  });

  it("collects diagnostic snapshots with raw credential values absent", async () => {
    const rawModelToken = TOKEN_FIXTURES[1][1];
    const rawVariantToken = TOKEN_FIXTURES[6][1];
    const rawDriverToken = TOKEN_FIXTURES[16][1];
    const rawPluginToken = TOKEN_FIXTURES[12][1];

    const snapshot = await collectRunProvenanceSnapshot({
      now: "2026-01-01T00:00:00.000Z",
      event: "run-created",
      driverKind: rawDriverToken,
      pluginSpec: rawPluginToken,
      pluginOptions: {
        profiles: {
          default: {
            model: rawModelToken,
            variant: rawVariantToken,
          },
        },
      },
    });

    assert.equal(snapshot.collected_at, "2026-01-01T00:00:00.000Z");
    assert.equal(snapshot.event, "run-created");
    assert.equal(snapshot.diagnostic_only, true);
    assert.equal(snapshot.provenance.plugin_spec, REDACTED_PROVENANCE_VALUE);
    assert.equal(snapshot.provenance.driver.kind, REDACTED_PROVENANCE_VALUE);
    assert.equal(snapshot.provenance.resolved_models["feature-factory"], REDACTED_PROVENANCE_VALUE);
    assert.equal(snapshot.provenance.resolved_variants["feature-factory"], REDACTED_PROVENANCE_VALUE);
    assertRawValuesAbsent(snapshot, [rawModelToken, rawVariantToken, rawDriverToken, rawPluginToken]);
  });
});

function assertRawValuesAbsent(value, rawValues) {
  const json = JSON.stringify(value);
  for (const rawValue of rawValues) {
    assert.equal(json.includes(rawValue), false, `raw value leaked: ${rawValue}`);
  }
}
