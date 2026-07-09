import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DIAGNOSTIC_CLASSIFICATIONS,
  DIAGNOSTIC_CONDITIONS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_STATUSES,
} from "../src/factory-diagnostics.js";
import { HEARTBEAT_PHASES, TERMINAL_RUN_STATUSES } from "../src/validate.js";

const SKILL = readDoc("../assets/skills/feature/SKILL.md");
const SCHEMA = readDoc("../assets/skills/feature/SCHEMA.md");
const COMMAND = readDoc("../assets/command/feature.md");
const README = readDoc("../README.md");
const SPEC = readDoc("../SPEC.md");
const TODO = readDoc("../TODO.md");
const CLI = readDoc("../src/cli.js");
const BLOCKED_CONTINUE_COMMAND = "feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>";
const STATE_WRITE_COMMANDS = Object.freeze([
  "factory env record-created <run-id> --json",
  "factory env record-resume <run-id> --json",
  "factory answer --json <run-id> <gate> approve",
  "factory recover <run-id> --reason TEXT --json",
  "factory gate-decision <run-id> <gate> pending",
  "factory gate-decision <run-id> <gate> approved",
  "factory slices-seed <run-id> --from plan/slices.json",
  "factory slice-status <run-id> <slice-id> running",
  "factory slice-status <run-id> <slice-id> review",
  "factory slice-status <run-id> <slice-id> blocked",
  "factory step <run-id> <known-agent> running",
  "factory step <run-id> <known-agent> accepted",
  "factory verdicts <run-id> --validator GO",
  "factory terminal <run-id> blocked --reason TEXT",
  "factory slice-merged <run-id> <slice-id> --merge-commit SHA",
  "factory pr-created <run-id> --pr-url URL --pr-number N --repository OWNER/REPO",
]);

describe("heartbeat docs contract", () => {
  it("lists every required heartbeat phase in the skill and schema", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      for (const phase of HEARTBEAT_PHASES) assert.match(text, literalPattern(`\`${phase}\``), `${name} missing phase ${phase}`);
    }
  });

  it("documents start-before-dispatch ordering for long subagent waits", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /Mark in-flight state first/i, `${name} must require in-flight state before heartbeat`);
      assert.match(text, /Start heartbeat immediately before[\s\S]*(?:dispatch\/wait|dispatch)/i, `${name} must start heartbeat before dispatch/wait`);
      assert.match(text, /Stop heartbeat[\s\S]*(?:after-return|finally)/i, `${name} must stop heartbeat after return/finally`);
    }
    assert.match(SKILL, /Step 2[\s\S]*`spec-review`[\s\S]*start heartbeat immediately before[\s\S]*`decomposition-review`[\s\S]*Step 4/i, "SKILL must bracket spec/decomposition review waits");
    assert.match(SKILL, /Step 4[\s\S]*mark every dispatched slice `running` first[\s\S]*`builder-wave`[\s\S]*`slice-review`[\s\S]*Step 5/i, "SKILL must bracket builder waves and slice reviews");
    assert.match(SKILL, /Step 5[\s\S]*`test-verifier`[\s\S]*`test-rerun`[\s\S]*`test-review`[\s\S]*`implementation-validator`[\s\S]*`security-reviewer`[\s\S]*`remediation`/i, "SKILL must bracket integration, panel, and remediation waits");
  });

  it("brackets spec and decomposition producer Task waits as well as reviewer waits", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assertNear(text, "`spec-review`", "`spec-writer` Task dispatch/wait", `${name} must tie spec-review heartbeat to the spec-writer Task wait`);
      assertNear(text, "`spec-review`", "`work-reviewer`", `${name} must tie spec-review heartbeat to the reviewer wait`);
      assertNear(text, "`decomposition-review`", "`work-decomposer` Task dispatch/wait", `${name} must tie decomposition-review heartbeat to the work-decomposer Task wait`);
      assertNear(text, "`decomposition-review`", "`work-reviewer`", `${name} must tie decomposition-review heartbeat to the reviewer wait`);
    }
    assert.match(SKILL, /Step 2[\s\S]*`spec-writer` Task dispatch\/wait[\s\S]*`spec-review`[\s\S]*`work-reviewer` dispatch\/wait[\s\S]*`spec-review`[\s\S]*`work-decomposer` Task dispatch\/wait[\s\S]*`decomposition-review`[\s\S]*`work-reviewer` decomposition review dispatch\/wait[\s\S]*`decomposition-review`[\s\S]*Step 4/i, "SKILL Step 2 must bracket producer and reviewer waits for spec and decomposition");
  });

  it("requires stopping heartbeat before the next semantic state write", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /Do not perform the next semantic `run\.json` \/ factory CLI state write while the long-wait heartbeat remains active/i, `${name} must forbid semantic writes while heartbeat is active`);
      assert.match(text, /stop heartbeat|verify inactive/i, `${name} must stop or verify inactive before the next state write`);
    }
    assert.match(SKILL, /stop heartbeat[\s\S]*before writing evidence/i, "SKILL must stop before evidence writes");
    assert.match(SKILL, /stop heartbeat[\s\S]*before[\s\S]*(?:verdicts|terminal writes|Gate 3 state)/i, "SKILL must stop before verdict/terminal/gate writes");
  });

  it("maps every documented phase and keeps phase validation opaque", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      for (const phase of HEARTBEAT_PHASES) assert.match(text, literalPattern(`\`${phase}\``), `${name} missing phase ${phase}`);
      assert.match(text, /phase[\s\S]*(?:opaque|display convention)[\s\S]*(?:non-enforced|accepts any non-empty string|non-empty)/i, `${name} must keep heartbeat phase opaque/non-enforced`);
    }
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      for (const phase of HEARTBEAT_PHASES) {
        assert.match(text, new RegExp(`${escapeRegExp(`\`${phase}\``)}[\\s\\S]{0,180}(?:wait|review|builder|remediation|rerun|validator)`, "i"), `${name} must map phase ${phase} to a wait`);
      }
    }
  });

  it("keeps protected gates heartbeat-free and resolves the heartbeat TODO", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /Protected gates?[\s\S]*`story`[\s\S]*`brief`[\s\S]*`pre_pr`[\s\S]*(?:heartbeat-free|stay off|intentionally absent)/i, `${name} must keep protected gates heartbeat-free`);
      assert.match(text, /liveness-only[\s\S]*(?:not authority|not.*authority)|not authority[\s\S]*liveness-only/i, `${name} must keep heartbeat liveness-only and non-authoritative`);
    }
    assert.doesNotMatch(TODO, /Enforce heartbeat around long factory subagent waits/i, "TODO must not leave the resolved heartbeat enforcement item open");
  });

  it("documents heartbeat as liveness-only around long waits", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /liveness-only|liveness only/i, `${name} must describe heartbeat as liveness-only`);
      assert.match(text, /Start heartbeat immediately before/i, `${name} must start heartbeat immediately before waits`);
      assert.match(text, /long\s+`Task`|long orchestrator waits/i, `${name} must tie heartbeat to long waits`);
      assert.match(text, /stop heartbeat/i, `${name} must stop heartbeat after waits`);
      assert.match(text, /last_tick_at/i, `${name} must document timestamp liveness`);
      assert.match(text, /interval_ms/i, `${name} must document heartbeat interval`);
      assert.match(text, /max\(2 \* interval_ms, 120000ms\)/i, `${name} must document freshness threshold`);
      assert.match(text, /not.*heartbeat\.json.*authority|heartbeat\.json.*not.*authority/i, `${name} must not treat heartbeat.json as authority`);
    }
  });

  it("forbids heartbeat during protected gates and names terminal statuses", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA })) {
      assert.match(text, /Do not start heartbeat while[\s\S]*`story`[\s\S]*`brief`[\s\S]*`pre_pr`/i, `${name} must forbid heartbeat during protected gates`);
      assert.match(text, /Before writing terminal[\s\S]*terminal_result[\s\S]*stop heartbeat if it is active/i, `${name} must stop active heartbeat before terminal writes`);
      for (const status of TERMINAL_RUN_STATUSES) assert.match(text, literalPattern(`\`${status}\``), `${name} must name terminal status ${status}`);
    }
  });
});

describe("simplified state contract docs", () => {
  it("documents durable local state, transition helpers, and no proof layer", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /run\.json/i, `${name} must document run.json`);
      assert.match(text, /transitionGateDecision/i, `${name} must document transitionGateDecision`);
      assert.match(text, /transitionPrCreated/i, `${name} must document transitionPrCreated`);
      assert.match(text, /pending_snapshot/i, `${name} must document pending_snapshot`);
      assert.match(text, /debug_snapshot/i, `${name} must document debug_snapshot`);
      assert.match(text, /proof layer removed/i, `${name} must document removed proof layer`);
    }
  });

  it("documents environment snapshot commands and redaction", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /factory env record-created <run-id> --json/i, `${name} must document record-created`);
      assert.match(text, /factory env record-resume <run-id> --json/i, `${name} must document record-resume`);
      assert.match(text, /diagnostic-only|diagnostic only/i, `${name} must mark snapshots diagnostic-only`);
      assert.match(text, /redact|omit/i, `${name} must document redaction`);
      for (const tokenShape of ["ghp_*", "github_pat_*", "gho_*", "sk-proj_*", "sk-*", "xoxb_*"]) {
        assert.match(text, literalPattern(tokenShape), `${name} must mention token shape ${tokenShape}`);
      }
    }
  });

  it("documents PR-created transition preconditions", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /feature-factory factory pr-created <run-id>/i, `${name} must document factory pr-created CLI`);
      assert.match(text, /pre_pr/i, `${name} must mention pre_pr gate`);
      assert.match(text, /validator[\s\S]*(GO|GO-WITH-NITS)/i, `${name} must require passing validator`);
      assert.match(text, /security[\s\S]*PASS/i, `${name} must require passing security review`);
      assert.match(text, /canonical GitHub PR URL|canonical PR URL/i, `${name} must require canonical PR URL`);
    }
  });

  it("documents reachable CLI verbs for orchestrator state writes", () => {
    for (const command of STATE_WRITE_COMMANDS) {
      assert.match(SKILL, commandPattern(command), `SKILL missing ${command}`);
      assert.match(SCHEMA, commandPattern(command), `SCHEMA missing ${command}`);
      assertCliSurfaceIncludes(command);
    }
    for (const verb of implementedStateWriteVerbs()) {
      assert.ok(documentedStateWriteVerbs().has(verb), `factory ${verb} mutates state but is missing from STATE_WRITE_COMMANDS`);
    }
    for (const forbidden of ["transitionRunStep", "transitionRunSlice", "transitionTerminalResult", "transitionLifecycleRun", "mutateRunJsonLocked", "run-state.js"]) {
      assert.doesNotMatch(SKILL, literalPattern(forbidden), `SKILL must not instruct unreachable helper ${forbidden}`);
    }
  });

  it("does not reintroduce removed proof-layer terminology in active docs", () => {
    const retiredTerms = [
      "heartbeat" + "_owner",
      "stop" + "_requested_at",
      "deadline" + "_at",
      "owner" + "Capability",
      "HEARTBEAT" + "_OWNER",
      "assertSemantic" + "TransitionHeartbeatState",
      "prove" + "nance",
      "prove" + "nance" + "-authority",
      "review" + "-guard",
      "safe" + "-git",
      "safe" + "_git" + "_policy",
      "merge" + "-chain",
      "invalid" + "-authority",
      "unverifiable" + "-authority",
    ];
    const retiredPattern = new RegExp(retiredTerms.map(escapeRegExp).join("|"), "i");
    const retiredDirectoryPattern = new RegExp(`${escapeRegExp("attest" + "ations")}/`, "i");
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC, TODO })) {
      assert.doesNotMatch(text, retiredPattern, `${name} must not reference removed proof-layer terms`);
      assert.doesNotMatch(text, retiredDirectoryPattern, `${name} must not require retired proof directories`);
    }
  });
});

describe("diagnostics docs contract", () => {
  it("documents the diagnostic envelope shape and enums", () => {
    for (const [name, text] of documentEntries({ README, SPEC, SKILL, SCHEMA })) {
      for (const field of ["schema_version", "checked_at", "authoritative", "status", "severity", "classification", "summary", "items", "condition", "message", "action", "evidence"]) {
        assert.match(text, literalPattern(field), `${name} must document diagnostics.${field}`);
      }
      for (const condition of DIAGNOSTIC_CONDITIONS) assert.match(text, literalPattern(`\`${condition}\``), `${name} must document condition ${condition}`);
      for (const classification of DIAGNOSTIC_CLASSIFICATIONS) assert.match(text, literalPattern(`\`${classification}\``), `${name} must document classification ${classification}`);
      for (const status of DIAGNOSTIC_STATUSES) assert.match(text, literalPattern(`\`${status}\``), `${name} must document status ${status}`);
      for (const severity of DIAGNOSTIC_SEVERITIES) assert.match(text, literalPattern(`\`${severity}\``), `${name} must document severity ${severity}`);
    }
  });

  it("documents aggregation order and operator actions", () => {
    const conditionOrder = ["invalid-run-state", "missing-worktree", "missing-heartbeat-process", "stale-heartbeat", "protected-gate", "terminal-run"];
    for (const [name, text] of documentEntries({ README, SPEC, SKILL, SCHEMA })) {
      assert.match(text, orderedPattern(["invalid", "blocked", "needs-human", "recoverable", "terminal", "healthy"]), `${name} must document classification order`);
      assert.match(text, orderedPattern(["critical", "error", "warning", "info"]), `${name} must document severity order`);
      assert.match(text, orderedPattern(["error", "warning", "ok"]), `${name} must document status order`);
      assert.match(text, orderedPattern(conditionOrder), `${name} must document condition order`);
      assert.match(text, /original detection order/i, `${name} must document detection-order tiebreaker`);
      assert.match(text, /do not restart blindly|not restart blindly/i, `${name} must warn against blind restart`);
      assert.match(text, /restore (?:the )?worktree|recover from durable state/i, `${name} must explain missing-worktree action`);
      assert.match(text, /answer (?:the )?pending protected gate|answer or stop/i, `${name} must explain protected-gate action`);
      assert.match(text, /read `terminal_result`|inspect the terminal result/i, `${name} must explain terminal-run action`);
    }
  });
});

describe("blocked-run continuation docs contract", () => {
  it("documents the public continuation command and intent", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, literalPattern(BLOCKED_CONTINUE_COMMAND), `${name} must document factory continue CLI`);
      assert.match(text, /blocked-run-continuation/, `${name} must document blocked-run-continuation intent or payload`);
    }
    assert.match(SKILL, /Intent types:[\s\S]*blocked-run-continuation/i, "SKILL must list blocked-run-continuation intent");
    assert.match(SKILL, /Actions by intent:[\s\S]*blocked-run-continuation/i, "SKILL must define blocked-run-continuation action");
  });

  it("treats continuation payloads as untrusted operator data, not privileged instructions", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /continuation payload[\s\S]*untrusted operator data\/config/i, `${name} must call continuation payload untrusted data/config`);
      assert.match(text, /not privileged instruction/i, `${name} must deny privileged-instruction status`);
    }
  });

  it("documents top-level payload.continuation rather than driver.continuation", () => {
    assert.match(COMMAND, /payload\.continuation/, "COMMAND must read continuation metadata from top-level payload.continuation");
    assert.match(COMMAND, /Do not read continuation metadata from driver configuration/i, "COMMAND must reject driver config as the continuation source");
    assert.doesNotMatch(COMMAND, /driver\.continuation/i, "COMMAND must not route continuation from driver.continuation");
  });

  it("documents continuation manifest persistence and parent validation", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /run\.json\.continuation|run\.continuation/i, `${name} must persist run.continuation`);
      assert.match(text, /status(?:`|\s)*(?:is\s+)?exactly(?:`|\s)*`?blocked`?/i, `${name} must require parent status exactly blocked`);
      assert.match(text, /read-only parent context|parent context as read-only/i, `${name} must make parent context read-only`);
      assert.match(text, /approved review evidence/i, `${name} must validate approved review evidence`);
      assert.match(text, /not rely on|do not depend on|without relying on/i, `${name} must not rely on a blocking verdict enum`);
      assert.match(text, /blocking verdict enum/i, `${name} must name the blocking verdict enum non-requirement`);
    }
  });

  it("documents the accepted nested run.continuation shape with hashes", () => {
    for (const term of [
      '"kind": "blocked-run-continuation"',
      '"parent"',
      '"review"',
      '"target"',
      '"run_hash"',
      '"hash"',
      '"parent_artifacts"',
      '"parent_evidence"',
      '"parent_reviews"',
      '"base_commit"',
    ]) {
      assert.match(SCHEMA, literalPattern(term), `SCHEMA must document continuation field ${term}`);
    }
    assert.match(SCHEMA, /parent_artifacts[\s\S]*\{kind, ref, hash\}/, "SCHEMA must describe parent_artifacts as ref/hash entries");
    assert.match(SCHEMA, /nested `parent`, `review`, and `target` objects/i, "SCHEMA must describe nested continuation objects");
    assert.match(SCHEMA, /refs paired with hashes|ref.*hash/i, "SCHEMA must require validated refs and hashes");
  });

  it("documents rejected ready/non-draft flags for factory continue", () => {
    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /factory continue[\s\S]*rejects?[\s\S]*`--ready`[\s\S]*`--no-draft`/i, `${name} must document rejecting --ready and --no-draft`);
      assert.match(text, /draft-only|draft mode/i, `${name} must document draft-only continuation behavior`);
    }
  });

  it("documents normal gates, draft-only PRs, and exhausted-remediation terminal blocked outcome", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      for (const term of ["story", "brief", "build", "test", "validator", "security", "pre-PR"]) {
        assert.match(text, new RegExp(escapeRegExp(term), "i"), `${name} must include normal ${term} gate/step`);
      }
      assert.match(text, /draft-only/i, `${name} must require draft-only continuation PRs`);
      assert.match(text, /driver\.ready\s*=\s*false/i, `${name} must force driver.ready=false`);
      assert.match(text, /terminal[\s\S]*blocked|status:\s*"blocked"/i, `${name} must document terminal blocked outcome`);
      assert.match(text, /no PR URL|pr_url:\s*null/i, `${name} must document no PR URL on exhausted remediation`);
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

function orderedPattern(values) {
  return new RegExp(values.map((value) => escapeRegExp(value)).join("[\\s\\S]*"));
}

function assertNear(text, left, right, message) {
  const eitherOrder = new RegExp(`${escapeRegExp(left)}[\\s\\S]{0,320}${escapeRegExp(right)}|${escapeRegExp(right)}[\\s\\S]{0,320}${escapeRegExp(left)}`, "i");
  assert.match(text, eitherOrder, message);
}

function commandPattern(command) {
  return new RegExp(command.split(/\s+/u).map((part) => escapeRegExp(part)).join("\\s+"));
}

function assertCliSurfaceIncludes(command) {
  const parts = command.split(/\s+/u);
  const verb = parts[1];
  for (const flag of commandFlags(command)) assertCliParsesFlag(flag, command);
  if (verb === "env") {
    assert.match(CLI, /sub === "env"/, "CLI missing factory env");
    assert.match(CLI, /action === "record-created"/, "CLI missing env record-created");
    assert.match(CLI, /action === "record-resume"/, "CLI missing env record-resume");
    return;
  }
  assert.match(CLI, new RegExp(`sub === "${escapeRegExp(verb)}"`), `CLI missing factory ${verb}`);
}

function documentedStateWriteVerbs() {
  return new Set(STATE_WRITE_COMMANDS.map((command) => command.split(/\s+/u)[1]));
}

function implementedStateWriteVerbs() {
  const verbs = [];
  const dispatchPattern = /if \(sub === "([^"]+)"(?: \|\| sub === "[^"]+")?\) return ([A-Za-z0-9]+)\(rest\);/gu;
  for (const [, verb, handler] of CLI.matchAll(dispatchPattern)) {
    const body = extractFunctionBody(handler);
    if (/transition[A-Z]|writeGateAnswer|persistFactoryRun/u.test(body)) verbs.push(verb);
  }
  return verbs;
}

function extractFunctionBody(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`, "u").exec(CLI);
  assert.ok(match, `CLI missing handler function ${name}`);
  const open = CLI.indexOf("{", match.index);
  let depth = 0;
  for (let index = open; index < CLI.length; index += 1) {
    const char = CLI[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return CLI.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated CLI handler function ${name}`);
}

function commandFlags(command) {
  return [...new Set([...command.matchAll(/--[a-z-]+/gu)].map((match) => match[0]))];
}

function assertCliParsesFlag(flag, command) {
  assert.ok(parsedCliFlags().has(flag), `${command} documents ${flag}, but CLI options() does not parse it`);
}

function parsedCliFlags() {
  return new Set([...extractFlagSet("BOOLEAN_FLAGS"), ...extractFlagSet("VALUE_FLAGS")]);
}

function extractFlagSet(name) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\);`, "u").exec(CLI);
  assert.ok(match, `CLI missing ${name}`);
  return [...match[1].matchAll(/"(--[^"]+)"/gu)].map((flagMatch) => flagMatch[1]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
