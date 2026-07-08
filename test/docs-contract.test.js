import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HEARTBEAT_PHASES, TERMINAL_RUN_STATUSES } from "../src/validate.js";

const SKILL = readDoc("../assets/skills/feature/SKILL.md");
const SCHEMA = readDoc("../assets/skills/feature/SCHEMA.md");
const COMMAND = readDoc("../assets/command/feature.md");
const README = readDoc("../README.md");
const SPEC = readDoc("../SPEC.md");
const TODO = readDoc("../TODO.md");

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

describe("run-state transition docs contract", () => {
  it("documents the run-state helpers and their semantic roles", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      for (const helper of [
        "hashRunState",
        "transitionRunJson",
        "transitionGateDecision",
        "transitionTerminalResult",
        "transitionRunStep",
        "transitionRunSlice",
        "transitionLifecycleRun",
        "mutateRunJsonLocked",
      ]) {
        assert.match(text, helperNamePattern(helper), `${name} must mention ${helper}`);
      }

      assert.match(text, /expectedCurrentHash|current-state hash|stale `run\.json` transition|stale-write detection/i, `${name} must document stale transition protection`);
      assert.match(text, /transitionRunStep[\s\S]*steps\[\]/i, `${name} must document step transitions`);
      assert.match(text, /transitionRunSlice[\s\S]*slices\[\]/i, `${name} must document slice transitions`);
      assert.match(text, /transitionTerminalResult[\s\S]*terminal_result/i, `${name} must document terminal result synchronization`);
    }
  });

  it("documents fail-closed no-index bootstrap rules and non-empty attestation indexes", () => {
    assert.match(SKILL, /Do not create placeholder\/empty `attestations\/index\.json`/i, "SKILL must forbid placeholder empty attestation indexes");
    assert.match(SKILL, /first accepted attestation[\s\S]*sequence-1 `attestations\/run-base\.json`/i, "SKILL must require run-base to anchor the accepted graph");
    assert.match(SKILL, /gate decisions cannot bootstrap[\s\S]*before run-base exists/i, "SKILL must forbid gate-decision bootstrap before run-base");
    assert.match(SKILL, /mutateRunJsonLocked[\s\S]*compatibility-only[\s\S]*fail closed/i, "SKILL must document fail-closed no-index compatibility mode");

    assert.match(SCHEMA, /must never be a placeholder-empty file/i, "SCHEMA must reject placeholder empty attestation indexes");
    assert.match(SCHEMA, /entries` must be a non-empty array|entries must be a non-empty array/i, "SCHEMA must require non-empty attestation index entries");
    assert.match(SCHEMA, /first accepted attestation[\s\S]*sequence-1 `attestations\/run-base\.json`/i, "SCHEMA must require run-base first");
    assert.match(SCHEMA, /gate decisions cannot bootstrap|cannot bootstrap or precede the graph root/i, "SCHEMA must forbid gate-decision bootstrap before run-base");
    assert.match(SCHEMA, /mutateRunJsonLocked[\s\S]*compatibility-only[\s\S]*fail closed/i, "SCHEMA must document fail-closed no-index compatibility mode");
  });

  it("documents approved gate ordering through transitionGateDecision", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /transitionGateDecision[\s\S]*only (path|approved-gate writer)/i, `${name} must reserve approved gates for transitionGateDecision`);
      assert.match(text, /transitionGateDecision[\s\S]*attestations\/gates\/<gate>\.json[\s\S]*attestations\/index\.json[\s\S]*before the approved gate state/i, `${name} must document gate attestation ordering`);
      assert.match(text, /roll back the staged gate attestation\/index files and leave `run\.json` unchanged/i, `${name} must document rollback on approved gate validation failure`);
    }
  });

  it("requires feature worktree and run-base bootstrap before story gate approval", () => {
    assert.match(SKILL, /Step 0[\s\S]*create the feature branch\/worktree immediately/i, "SKILL must create the feature worktree during Step 0");
    assert.match(SKILL, /Before Gate 1[\s\S]*attestations\/run-base\.json[\s\S]*attestations\/index\.json/i, "SKILL must write run-base/index before story gate approval");
    assert.match(SKILL, /caller checkout[\s\S]*launcher\/control-plane[\s\S]*clean `\$FEAT_WT`/i, "SKILL must isolate factory work from caller checkout dirt");
    assert.match(SKILL, /work-reviewer` subject `spec-writer` -> `\$FEAT_WT`/i, "SKILL must guard spec review against FEAT_WT");
    assert.match(SKILL, /work-reviewer` subject `work-decomposer` -> `\$FEAT_WT`/i, "SKILL must guard decomposition review against FEAT_WT");
    assert.match(SKILL, /codebase-researcher[\s\S]*`\$FEAT_WT` as the repository context/i, "SKILL must research the clean feature worktree");
    assert.match(SCHEMA, /New runs create the feature branch\/worktree during Step 0[\s\S]*before story Gate 1/i, "SCHEMA must document early feature worktree bootstrap");
    assert.match(SCHEMA, /Spec and decomposition reviews guard the clean feature worktree \(`\$FEAT_WT`\), not the caller checkout/i, "SCHEMA must keep planning guards on FEAT_WT");
  });

  it("states that transition helpers do not change heartbeat or external-driver authority", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /do not change heartbeat or external-driver semantics/i, `${name} must preserve heartbeat and external-driver semantics`);
      assert.match(text, /`heartbeat\.json` remains liveness-only/i, `${name} must keep heartbeat as liveness-only`);
      assert.match(text, /external drivers still write only `gates\/<gate>\.answer`/i, `${name} must keep gate answers external-driver-only`);
      assert.match(text, /approval_source: `?"?external-driver"?`?/i, `${name} must keep approved file answers labeled external-driver`);
    }
  });
});

describe("provenance redaction and pr-created docs contract", () => {
  it("documents diagnostic factory_provenance and credential redaction guarantees", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC, TODO })) {
      assert.match(text, /factory_provenance/i, `${name} must document factory_provenance`);
    }

    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /diagnostic-only|diagnostic only/i, `${name} must mark factory provenance diagnostic-only`);
      assert.match(text, /redact|omit/i, `${name} must document redaction/omission`);
      for (const tokenShape of ["ghp_*", "github_pat_*", "gho_*", "sk-proj_*", "sk-*", "xoxb_*"]) {
        assert.match(text, literalPattern(tokenShape), `${name} must mention token shape ${tokenShape}`);
      }
      assert.match(text, /high-entropy/i, `${name} must mention high-entropy credential redaction`);
    }
  });

  it("documents pending_snapshot gate freshness and fail-closed answer behavior", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC, TODO })) {
      assert.match(text, /pending_snapshot/i, `${name} must document pending_snapshot`);
    }

    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /question_ref/i, `${name} must document pending question refs`);
      assert.match(text, /artifact_ref|artifact/i, `${name} must document pending artifact refs`);
      assert.match(text, /question_hash/i, `${name} must document question hashes`);
      assert.match(text, /artifact_hash/i, `${name} must document artifact hashes`);
      assert.match(text, /fail closed|fails closed/i, `${name} must document fail-closed stale gate behavior`);
      assert.match(text, /stale|hash-mismatched|mismatched/i, `${name} must document stale/mismatched pending material`);
    }
  });

  it("documents provenanced pr-created CLI flow and trusted PR URL requirements", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC, TODO })) {
      assert.match(text, /pr-created/i, `${name} must document pr-created`);
    }

    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /feature-factory factory pr-created <run-id>/i, `${name} must document factory pr-created CLI`);
      assert.match(text, /attestations\/pr-created\.json/i, `${name} must document pr-created attestation path`);
      assert.match(text, /run\.pr_url/i, `${name} must document run.pr_url authority`);
      assert.match(text, /terminal_result\.pr_url/i, `${name} must document terminal_result.pr_url authority`);
      assert.match(text, /trusted only|only then|only after/i, `${name} must require attestation before PR URL trust`);
      assert.match(text, /fail closed|fails closed/i, `${name} must document fail-closed PR URL behavior`);
    }
  });

  it("documents provenance recording commands", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /feature-factory factory provenance record-created <run-id> --json/i, `${name} must document record-created`);
      assert.match(text, /feature-factory factory provenance record-resume <run-id> --json/i, `${name} must document record-resume`);
    }
  });

  it("does not instruct direct PR URL bookkeeping after draft PR creation", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC, TODO })) {
      assert.doesNotMatch(text, /PR URLs (?:are|remain) terminal bookkeeping/i, `${name} must not describe PR URLs as terminal bookkeeping`);
      assert.doesNotMatch(text, /Record `pr_url` in `run\.json` and set `status: completed`/i, `${name} must not instruct direct PR URL persistence`);
    }

    assert.match(SKILL, /Do not directly edit or persist `run\.json\.pr_url`/i, "SKILL must explicitly forbid direct PR URL persistence");
    assert.match(COMMAND, /Do not directly persist `run\.json\.pr_url`/i, "command must explicitly forbid direct PR URL persistence");
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

function helperNamePattern(name) {
  return new RegExp(`\\b${escapeRegExp(name)}(?:\\([^)]*\\))?\\b`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
