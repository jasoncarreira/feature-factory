import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HEARTBEAT_PHASES, TERMINAL_RUN_STATUSES } from "../src/validate.js";

const SKILL = readDoc("../assets/skills/feature/SKILL.md");
const SCHEMA = readDoc("../assets/skills/feature/SCHEMA.md");
const README = readDoc("../README.md");
const SPEC = readDoc("../SPEC.md");

describe("heartbeat docs contract", () => {
  it("lists every required heartbeat phase in the skill and schema", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      for (const phase of HEARTBEAT_PHASES) {
        assert.match(text, literalPattern(`\`${phase}\``), `${name} missing phase ${phase}`);
      }
    }
  });

  it("requires heartbeat only around long Task waits and stops it before semantic manifest writes", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /Start heartbeat immediately before/i, `${name} must start heartbeat immediately before the long wait`);
      assert.match(text, /long\s+`Task`/i, `${name} must tie heartbeat to long Task waits`);
      assert.match(text, /`?finally`?\/after-return path/i, `${name} must stop heartbeat in a finally/after-return path`);
      assert.match(text, /foreground semantic `run\.json` (write|mutation)/i, `${name} must stop heartbeat before semantic run.json writes`);
    }
  });

  it("forbids heartbeat during gates and before terminal states", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /Do not start heartbeat while[\s\S]*`story`[\s\S]*`brief`[\s\S]*`pre_pr`/i, `${name} must forbid heartbeat during story/brief/pre_pr gates`);
      assert.match(text, /Before writing terminal[\s\S]*`terminal_result`[\s\S]*stop heartbeat/i, `${name} must stop heartbeat before terminal writes`);
      for (const status of TERMINAL_RUN_STATUSES) {
        assert.match(text, literalPattern(`\`${status}\``), `${name} must name terminal status ${status}`);
      }
    }
  });

  it("documents the heartbeat helper, sidecar, lock, and monitoring semantics", () => {
    assert.match(SCHEMA, /heartbeat\.json/, "SCHEMA must document heartbeat.json");
    assert.match(SCHEMA, /run-json\.lock\//, "SCHEMA must document run-json.lock/");
    assert.match(
      SCHEMA,
      /only allowed `run\.json` mutation is the helper updating `heartbeat_at`/i,
      "SCHEMA must document the heartbeat-only manifest mutation rule",
    );

    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /feature-factory factory heartbeat <run-id> --status --json/, `${name} must document the heartbeat helper surface`);
      assert.match(text, /heartbeat\.json/, `${name} must mention heartbeat.json monitoring`);
      assert.match(text, /terminal_result/, `${name} must explain terminal monitoring semantics`);
    }
  });
});

function documentEntries(map) {
  return Object.entries(map);
}

function readDoc(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function literalPattern(value) {
  return new RegExp(escapeRegExp(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
