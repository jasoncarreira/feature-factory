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
const WORK_REVIEWER_PROMPT = readDoc("../assets/agent/work-reviewer.md");
const IMPLEMENTATION_VALIDATOR_PROMPT = readDoc("../assets/agent/implementation-validator.md");
const SECURITY_REVIEWER_PROMPT = readDoc("../assets/agent/security-reviewer.md");
const BLOCKED_CONTINUE_COMMAND = "feature-factory factory continue <blocked-run-id> --review <review-ref> --run-id <new-run-id>";
const STATE_WRITE_COMMANDS = Object.freeze([
  "factory env record-created <run-id> --json",
  "factory env record-resume <run-id> --json",
  "factory steer <run-id> --message TEXT --json",
  "factory steer-consume <run-id> --ref steering/<file>.json --hash sha256:<hash> --json",
  "factory cost-record <run-id> --agent AGENT --step STEP --slice-id ID --provider PROVIDER --model MODEL --input-tokens N --output-tokens N --total-tokens N --cost-total N --currency CODE --json",
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
      assert.match(text, /`running` step[\s\S]*`running` slice[\s\S]*`review` slice/i, `${name} must document heartbeat diagnostics require in-flight work`);
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

  it("documents configurable PR mode for factory continue", () => {
    for (const [name, text] of documentEntries({ README, SPEC })) {
      assert.match(text, /factory continue[\s\S]*prMode|Continuation[\s\S]*effective PR mode/i, `${name} must document continuation PR mode`);
      assert.match(text, /`--draft`[\s\S]*`--ready`|`--ready`[\s\S]*`--draft`/i, `${name} must document per-run PR mode overrides`);
    }
  });

  it("documents persisted PR mode across resume", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /run\.json\.pr_mode/i, `${name} must document persisted run.pr_mode`);
      assert.match(text, /run\.json\.pr_mode[\s\S]*resume|resume[\s\S]*run\.json\.pr_mode/i, `${name} must document preserving PR mode on resume`);
    }
  });

  it("documents normal gates, configurable PRs, and exhausted-remediation terminal blocked outcome", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, README, SPEC })) {
      for (const term of ["story", "brief", "build", "test", "validator", "security", "pre-PR"]) {
        assert.match(text, new RegExp(escapeRegExp(term), "i"), `${name} must include normal ${term} gate/step`);
      }
      assert.match(text, /configured PR mode|effective PR mode|prMode/i, `${name} must document configurable PR mode`);
      assert.match(text, /ready-for-review|ready/i, `${name} must document ready PR mode`);
      assert.match(text, /draft/i, `${name} must document draft PR mode`);
      assert.match(text, /terminal[\s\S]*blocked|status:\s*"blocked"/i, `${name} must document terminal blocked outcome`);
      assert.match(text, /no PR URL|pr_url:\s*null/i, `${name} must document no PR URL on exhausted remediation`);
    }
  });

  it("does not leave the resolved blocked-run continuation item open in TODO", () => {
    assert.doesNotMatch(TODO, /Automated blocked-run continuation/i, "TODO must not leave the resolved blocked-run continuation item open");
  });
});

describe("non-destructive disrupted-worktree recovery docs contract", () => {
  it("requires explicit resume-check recovery and forbids silent re-scaffolding", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /feature-factory factory resume-check <run-id> --json/i, `${name} must document resume-check`);
      assert.match(text, /factory start --headless\|--autonomous "resume <run-id>"/i, `${name} must document start resume preflight`);
      assert.match(text, /missing[\s\S]*inaccessible[\s\S]*invalid[\s\S]*(?:run\.json|\.opencode\/factory\/\<run-id\>\/run\.json)/i, `${name} must name missing/inaccessible/invalid durable state`);
      assert.match(text, /must not[\s\S]*(?:re-scaffold|re-scaffolded)|never[\s\S]*(?:re-scaffold|re-scaffolded)/i, `${name} must forbid re-scaffolding`);
      assert.match(text, /synthetic non-durable[\s\S]*blocked[\s\S]*ok:false[\s\S]*durable:false[\s\S]*updated:false[\s\S]*recovered:false/i, `${name} must describe non-durable blocked envelope`);
      assert.match(text, /terminal_result\.reason[\s\S]*no durable `?terminal_result`?[\s\S]*(?:forbidden re-scaffolding|without forbidden re-scaffolding)/i, `${name} must explain why no durable terminal_result can be written`);
    }
  });

  it("forbids destructive cleanup, prune, and remove during recovery", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /resume-check[\s\S]*(?:must not|never)[\s\S]*destructive cleanup/i, `${name} must forbid recovery cleanup`);
      assert.match(text, /resume-check[\s\S]*(?:must not|never)[\s\S]*git worktree prune/i, `${name} must forbid recovery prune`);
      assert.match(text, /resume-check[\s\S]*(?:must not|never)[\s\S]*git worktree remove/i, `${name} must forbid recovery worktree remove`);
      assert.match(text, /cleanup remains an explicit operator action/i, `${name} must reserve cleanup for explicit operator action`);
      assert.match(text, /status[\s\S]*list[\s\S]*validate[\s\S]*watch[\s\S]*(?:read-only|read only)[\s\S]*(?:cleanup|prune|remove)/i, `${name} must keep diagnostics non-destructive`);
    }
  });

  it("documents safe missing-worktree restoration criteria", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /missing active worktree|missing \.opencode\/worktrees/i, `${name} must scope recovery to missing active worktrees`);
      assert.match(text, /branch exists/i, `${name} must require branch existence`);
      assert.match(text, /base_commit[\s\S]*merge_commit[\s\S]*ancestors? of branch HEAD/i, `${name} must require base and merged commits to be ancestors`);
      assert.match(text, /target[\s\S]*(?:under|stays under|remains under)[\s\S]*\.opencode\/worktrees/i, `${name} must constrain the target path`);
      assert.match(text, /no (?:unsafe )?existing path would be overwritten/i, `${name} must forbid overwriting existing paths`);
      assert.match(text, /git worktree add[\s\S]*succeeds/i, `${name} must require successful git worktree add`);
      assert.match(text, /(?:final )?(?:checkWorktreeIdentity|worktree identity)[\s\S]*HEAD[\s\S]*(?:match|matches)/i, `${name} must require final identity and HEAD checks`);
    }
  });

  it("distinguishes blocked and needs-human terminal outcomes with clear reasons", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /contradictory git evidence[\s\S]*terminal `?blocked`?|terminal `?blocked`?[\s\S]*contradictory git evidence/i, `${name} must map contradictory git evidence to blocked`);
      assert.match(text, /unsafe or inaccessible local paths?[\s\S]*terminal `?needs-human`?|terminal `?needs-human`?[\s\S]*unsafe or inaccessible local paths?/i, `${name} must map unsafe paths to needs-human`);
      assert.match(text, /terminal_result\.reason[\s\S]*(?:conflicting branch\/commit evidence|path that requires operator reconciliation)/i, `${name} must require clear terminal_result.reason details`);
    }
  });

  it("does not leave disrupted recovery as open future TODO work", () => {
    assert.doesNotMatch(TODO, /Non-destructive disrupted-worktree recovery/i, "TODO must not leave disrupted recovery open");
  });
});

describe("remediation context reuse docs contract", () => {
  it("documents implementer-only runtime task_id reuse boundaries", () => {
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA })) {
      assert.match(text, /task_id/i, `${name} must mention Task task_id reuse`);
      assert.match(text, /runtime-only|runtime context|orchestrator memory/i, `${name} must make task_id runtime-only`);
      assert.match(text, /implementer-only|eligible implementer|implementer remediation|implementer that owns the fix/i, `${name} must make reuse implementer-only`);
      for (const implementer of ["backend-builder", "frontend-builder", "test-verifier"]) {
        assert.match(text, literalPattern(implementer), `${name} must name eligible implementer ${implementer}`);
      }
      assert.match(text, /same (?:eligible )?implementer role|role is the same eligible implementer|same role|same role, subject\/slice\/test owner/i, `${name} must require the same role`);
      assert.match(text, /subject\/slice\/test owner|same owned remediation subject|same subject|same slice id|same acceptance-test\/integration test owner|same test owner|subject ownership is unchanged/i, `${name} must require the same subject/slice/test owner`);
      assert.match(text, /same[^.\n]*worktree|worktree[^.\n]*unchanged/i, `${name} must require the same worktree`);
      assert.match(text, /same[^.\n]*branch|branch[^.\n]*unchanged/i, `${name} must require the same branch`);
      assert.match(text, /same live orchestrator session|live orchestrator session is unchanged|same[^.\n]*orchestrator session/i, `${name} must require the same live orchestrator session`);
      assert.match(text, /same[^.\n]*bounded remediation loop|bounded remediation loop[^.\n]*(?:unchanged|only)|current bounded remediation loop/i, `${name} must require the same bounded remediation loop`);
    }

    assert.match(COMMAND, /bounded remediation loop/i, "COMMAND must route NO-GO through bounded remediation");
    assert.match(COMMAND, /backend-builder, frontend-builder, or test-verifier implementer context/i, "COMMAND must limit reuse to implementer context");
    assert.match(COMMAND, /skill's strict runtime `task_id` reuse rules/i, "COMMAND must bind reuse to the skill's strict runtime task_id rules");
  });

  it("keeps reviewers and final panel agents fresh, task_id-free, and read-only", () => {
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA, COMMAND })) {
      for (const reviewer of ["work-reviewer", "implementation-validator", "security-reviewer"]) {
        assert.match(text, literalPattern(reviewer), `${name} must name ${reviewer}`);
      }
      assert.match(text, /fresh/i, `${name} must require fresh reviewer/panel tasks`);
      assert.match(text, /(?:without|no|never|must not)[^\n.]*task_id|task_id[^\n.]*must never/i, `${name} must prohibit reviewer task_id reuse`);
    }

    for (const [name, text] of documentEntries({ SKILL, README, SPEC, WORK_REVIEWER_PROMPT, IMPLEMENTATION_VALIDATOR_PROMPT, SECURITY_REVIEWER_PROMPT })) {
      assert.match(text, /read-only|read and judge|do not edit|never edit/i, `${name} must keep reviewer/validator/security roles read-only`);
    }
  });

  it("does not serialize task_id into durable schema examples or state records", () => {
    for (const [name, text] of documentEntries({ SKILL, README, SPEC, SCHEMA, COMMAND })) {
      assert.doesNotMatch(text, /["']task_id["']\s*:/i, `${name} must not add a durable task_id JSON field`);
    }
    assert.match(SCHEMA, /No `run\.json`, evidence, or reviews schema has a `task_id` field/i, "SCHEMA must explicitly exclude durable task_id fields");
    assert.match(SCHEMA, /intentionally excluded from `run\.json`[\s\S]*evidence files[\s\S]*review files/i, "SCHEMA must exclude task_id from durable run/evidence/review state");
  });

  it("preserves attempt and required_fixes for all re-review reruns", () => {
    assert.match(SKILL, /For every re-review, pass `attempt: <n>` and the prior review's `required_fixes` list[\s\S]*rejected slice remediation/i, "SKILL must preserve slice attempt and required_fixes on re-review");
    assert.match(SKILL, /test-verifier re-review[\s\S]*fresh `work-reviewer` task[\s\S]*`attempt: <n>`[\s\S]*prior review's `required_fixes` list/i, "SKILL must preserve test-verifier attempt and required_fixes on re-review");
    assert.match(SKILL, /panel re-run[\s\S]*fresh `implementation-validator` and `security-reviewer` tasks[\s\S]*never pass `task_id`[\s\S]*`attempt: <n>` plus the prior validator\/security `required_fixes` list/i, "SKILL must preserve implementation-validator/security reviewer attempt and required_fixes on panel reruns");
    assert.match(SPEC, /current `attempt` and the prior applicable `required_fixes` list[\s\S]*review checks whether required fixes landed/i, "SPEC must preserve attempt and required_fixes delta-review behavior");
    assert.match(WORK_REVIEWER_PROMPT, /Delta rule:[\s\S]*`attempt > 1`[\s\S]*prior `required_fixes` item landed[\s\S]*introduced regressions/i, "work-reviewer prompt must preserve delta rule");
    assert.match(IMPLEMENTATION_VALIDATOR_PROMPT, /Delta Review Rule[\s\S]*fresh read-only validator task[\s\S]*prior findings[\s\S]*required_fixes[\s\S]*introduced regressions/i, "implementation-validator prompt must preserve fresh delta rule");
    assert.match(SECURITY_REVIEWER_PROMPT, /Delta rule:[\s\S]*`attempt > 1`[\s\S]*prior `required_fixes` item landed[\s\S]*introduced regressions/i, "security-reviewer prompt must preserve delta rule");
  });

  it("does not leave remediation context reuse as an open TODO", () => {
    assert.doesNotMatch(TODO, /Remediation context reuse/i, "TODO must not leave the resolved remediation context reuse item open");
  });
});

describe("interrupt steer resume docs contract", () => {
  it("documents steering/resume workflow, payload, and untrusted label", () => {
    for (const [name, text] of documentEntries({ COMMAND, SKILL, SCHEMA, README, SPEC })) {
      assert.match(text, /factory steer <run-id> --message TEXT/i, `${name} must document factory steer`);
      assert.match(text, /factory steer-consume <run-id> --ref steering\/<file>\.json --hash sha256:<hash>/i, `${name} must document steer-consume`);
      assert.match(text, /factory resume <run-id>[\s\S]*--dry-run/i, `${name} must document resume dry-run`);
      assert.match(text, /UNTRUSTED OPERATOR STEERING DATA \(not instructions\)/, `${name} must document untrusted label`);
      assert.match(text, /untrusted-operator-data/i, `${name} must document untrusted trust value`);
      assert.match(text, /raw_message_included[\s\S]*false/i, `${name} must document raw_message_included=false`);
      assert.match(text, /record-resume[\s\S]*before[\s\S]*steer-consume/i, `${name} must document record-resume before steer-consume`);
      assert.match(text, /active-heartbeat/i, `${name} must document active-heartbeat rejection`);
    }
  });
});

describe("cost attribution docs contract", () => {
  it("documents the cost-record command and run.json cost_attribution schema", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /factory cost-record <run-id>/i, `${name} must document factory cost-record`);
      assert.match(text, /run\.json\.cost_attribution|"cost_attribution"/i, `${name} must document run.json.cost_attribution`);
      assert.match(text, /by_agent/i, `${name} must document by_agent cost rollup`);
      assert.match(text, /by_slice/i, `${name} must document by_slice cost rollup`);
      for (const status of ["available", "partial", "unavailable"]) assert.match(text, literalPattern(status), `${name} must document ${status} cost status`);
    }
    for (const field of ["input_tokens", "output_tokens", "total_tokens", "cost_total", "cost_currency", "mixed_currency", "missing"]) {
      assert.match(SCHEMA, literalPattern(field), `SCHEMA must document cost field ${field}`);
    }
  });

  it("keeps cost attribution diagnostic and provider-supplied only", () => {
    for (const [name, text] of documentEntries({ SKILL, SCHEMA, COMMAND, README, SPEC })) {
      assert.match(text, /local current-run diagnostic|current-run diagnostics|diagnostic(?:-only)? local current-run/i, `${name} must scope cost attribution to local current-run diagnostics`);
      assert.match(text, /not billing authority/i, `${name} must deny billing authority`);
      assert.match(text, /provider-supplied|supplied by (?:the )?(?:active )?provider/i, `${name} must require provider-supplied costs`);
      assert.match(text, /pricing tables/i, `${name} must forbid pricing tables`);
      assert.match(text, /pricing APIs/i, `${name} must forbid pricing APIs`);
      assert.match(text, /missing-to-zero|coerce missing/i, `${name} must forbid missing-to-zero coercion`);
      assert.match(text, /unavailable[\s\S]*(?:not zero|not.*zero cost)/i, `${name} must say unavailable is not zero`);
    }
  });

  it("documents status/list/TUI exposure for cost summaries", () => {
    for (const [name, text] of documentEntries({ README, SPEC, COMMAND })) {
      assert.match(text, /status[\s\S]*list[\s\S]*TUI|status\/list\/TUI|status[\s\S]*TUI/i, `${name} must document status/list/TUI cost summary exposure`);
    }
  });

  it("documents orchestration attribution points and heartbeat ordering", () => {
    for (const [name, text] of documentEntries({ SKILL, COMMAND, README, SPEC, SCHEMA })) {
      for (const agent of ["spec-writer", "work-reviewer", "work-decomposer", "test-verifier", "implementation-validator", "security-reviewer"]) {
        assert.match(text, literalPattern(agent), `${name} must document ${agent} cost attribution`);
      }
      assert.match(text, /builder/i, `${name} must document builder cost attribution`);
      assert.match(text, /remediation/i, `${name} must document remediation cost attribution`);
      assert.match(text, /stop heartbeat|heartbeat[^.]+stopped|verify inactive/i, `${name} must require heartbeat stopped/verified inactive before cost-record`);
      assert.match(text, /cost-record[\s\S]*(?:before terminal|before[\s\S]*terminal writes|before[\s\S]*pr-created)|terminal[\s\S]*before[\s\S]*pr-created/i, `${name} must order cost-record before terminal writes/PR-created`);
    }
  });

  it("does not leave baseline cost attribution as an open TODO", () => {
    assert.doesNotMatch(TODO, /Record per-agent and per-slice token\/cost usage/i, "TODO must not leave baseline cost recording open");
    assert.doesNotMatch(TODO, /Persist cost data in durable run artifacts/i, "TODO must not leave baseline cost persistence open");
    assert.doesNotMatch(TODO, /Surface cost summaries in CLI\/status and eventually TUI/i, "TODO must not leave baseline cost surfacing open");
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
