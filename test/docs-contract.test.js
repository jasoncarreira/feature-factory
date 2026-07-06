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
    assert.match(SCHEMA, /factory\.lock/, "SCHEMA must document factory.lock");
    assert.match(SCHEMA, /run-json\.lock\//, "SCHEMA must document run-json.lock/");
    assert.match(
      SCHEMA,
      /only allowed `run\.json` mutation is the helper updating `heartbeat_at`/i,
      "SCHEMA must document the heartbeat-only manifest mutation rule",
    );

    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /feature-factory factory heartbeat <run-id> --status --json/, `${name} must document the heartbeat helper surface`);
      assert.match(text, /factory\.lock/, `${name} must mention factory.lock`);
      assert.match(text, /heartbeat\.json/, `${name} must mention heartbeat.json monitoring`);
      assert.match(text, /terminal_result/, `${name} must explain terminal monitoring semantics`);
    }
  });

  it("documents owner-bound heartbeat authority instead of treating heartbeat.json as authority", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /trusted heartbeat owner capability/i, `${name} must require trusted heartbeat owner capability`);
      assert.match(text, /factory\.lock/, `${name} must source heartbeat authority from factory.lock`);
      assert.match(text, /not.*heartbeat\.json.*authority|heartbeat\.json.*not.*authority/i, `${name} must treat heartbeat.json as data, not authority`);
    }
  });
});

describe("provenance authority docs contract", () => {
  it("defines authority roles and treats mutable local state as claims only", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /untrusted caller claims/i, `${name} must define untrusted caller claims`);
      assert.match(text, /orchestrator observations/i, `${name} must define orchestrator observations`);
      assert.match(text, /factory-owned attestations/i, `${name} must define factory-owned attestations`);
      assert.match(text, /status booleans.*claims only|claims only.*status booleans|must not trust status booleans alone/i, `${name} must reject status booleans as sole proof`);
      assert.match(text, /run\.json[\s\S]*claims only|run\.json[\s\S]*not proof/i, `${name} must treat run.json as claim data, not proof`);
    }
  });

  it("documents the attestation directory, common fields, and accepted graph semantics", () => {
    for (const phrase of [
      "attestations/index.json",
      "attestations/run-base.json",
      "attestations/gates/<gate>.json",
      "attestations/slices/<slice-id>.observation.json",
      "attestations/reviews/<subject>.approval.json",
      "attestations/direct-commits/<entry-id>.observation.json",
      "attestations/merge-chain.json",
      "feature-factory-provenance-v1",
      "safe-git-v1",
      "attestation_hash",
      "prev_hash",
    ]) {
      assert.match(SCHEMA, literalPattern(phrase), `SCHEMA must mention ${phrase}`);
    }

    assert.match(SCHEMA, /canonical JSON hash/i, "SCHEMA must document canonical attestation hashing");
    assert.match(SCHEMA, /attestation graph/i, "SCHEMA must document the accepted attestation graph");
    assert.match(SCHEMA, /index\.json[\s\S]*prev_hash/i, "SCHEMA must describe index.json and prev_hash semantics together");
  });

  it("documents attestation types, safe Git, and physical identity validation", () => {
    for (const phrase of [
      "run-base",
      "slice-observation",
      "review-approval",
      "direct-reviewed-commit",
      "gate-decision",
      "merge-chain",
      "slice_merge",
      "direct_reviewed_commit",
    ]) {
      assert.match(SCHEMA, literalPattern(phrase), `SCHEMA must document ${phrase}`);
    }

    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /safe Git|safeGit|safe_git_policy/i, `${name} must document the safe Git policy`);
      assert.match(text, /worktree identity/i, `${name} must document worktree identity validation`);
      assert.match(text, /fail closed/i, `${name} must document fail-closed validation`);
    }

    assert.match(SCHEMA, /symlinked durable roots are rejected/i, "SCHEMA must reject symlinked durable roots");
    assert.match(SCHEMA, /bounded local authority|local-only/i, "SCHEMA must explain local-only provenance limits");
  });

  it("documents gate-decision ref roots to match the implemented authority model", () => {
    assert.match(SCHEMA, /question_ref.*rooted under `gates\//i, "SCHEMA must require question_ref under gates/");
    assert.match(SCHEMA, /answer_ref.*rooted under `gates\//i, "SCHEMA must require answer_ref under gates/");
    assert.match(SCHEMA, /artifact_ref.*rooted under `artifacts\//i, "SCHEMA must require artifact_ref under artifacts/");

    assert.match(SKILL, /question_ref.*`gates\/`/i, "SKILL must keep gate question refs under gates/");
    assert.match(SKILL, /answer_ref.*`gates\/`/i, "SKILL must keep gate answer refs under gates/");
    assert.match(SKILL, /artifact_ref.*`artifacts\/`/i, "SKILL must keep gate artifact refs under artifacts/");
    assert.match(SKILL, /Do not write gate question or answer refs under `artifacts\//i, "SKILL must forbid artifact-rooted gate question/answer refs");
  });

  it("requires the orchestrator to write attestations at each provenance boundary", () => {
    for (const phrase of [
      "attestations/index.json",
      "run-base attestation",
      "attestations/gates/<gate>.json",
      "attestations/slices/<slice-id>.observation.json",
      "attestations/reviews/<slice-id>.approval.json",
      "attestations/direct-commits/<entry-id>.observation.json",
      "attestations/merge-chain.json",
      "direct_reviewed_commit",
    ]) {
      assert.match(SKILL, literalPattern(phrase), `SKILL must mention ${phrase}`);
    }

    assert.match(SKILL, /reviewer approval attestations are written only after the reviewed-worktree guard returns `clean`/i, "SKILL must bind review approvals to a clean guard");
    assert.match(SKILL, /must not trust status booleans alone/i, "SKILL must warn against trusting status booleans alone");
  });

  it("summarizes guarantees and limits in README and SPEC", () => {
    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /attestations\//i, `${name} must mention the attestation directory`);
      assert.match(text, /safe Git|safe_git_policy/i, `${name} must mention safe Git guarantees`);
      assert.match(text, /bounded local authority|local-only/i, `${name} must describe bounded local authority`);
      assert.match(text, /fail closed/i, `${name} must mention fail-closed behavior`);
      assert.match(text, /not cryptographic|not tamper-proof|coherent rewrite of local files and Git history/i, `${name} must describe local-only limits`);
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
