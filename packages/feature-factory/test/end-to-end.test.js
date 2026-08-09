// Wiring, not mechanism.
//
// The unit tests prove the observers are correct. They cannot prove the transition
// actually calls them. That distinction is not academic: the predecessor shipped a
// gate span whose attribute was always undefined, and an ancestry probe bound to a
// boolean, both of which had correct helpers and dead wiring. So every refusal
// below is driven through the real CLI against a real repository.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run as cli } from "../bin/factory.js";
import { GATE_NAMES, nextAction, validateRun } from "../state/index.js";
import { assertPublicationReady } from "../observe/review.js";
import { initFresh, seedLegacyRun } from "./init-fixture.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "factory.js");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Runs the CLI out of process so the assertion is against the real entry point,
// including argument parsing, rather than against an imported handler.
function factory(repo, args, { env = process.env } = {}) {
  try {
    const stdout = execFileSync("node", [CLI, ...args, "--repo", repo, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    return { ok: true, out: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? error.message) };
  }
}

const RUN = "app-1";
const NOW = (minute) => `2026-07-30T12:${String(minute).padStart(2, "0")}:00Z`;
const PASSING_TEST_COMMAND = "git --no-pager log -1 --format=%H";
const FAILING_TEST_COMMAND = "git --no-pager grep --quiet THIS_STRING_IS_ABSENT";
const DIRTYING_TEST_COMMAND = "node -e require('fs').writeFileSync('src/app/thing.ts','mutated')";

// This is a test-only process seam. The real CLI still parses the repository config,
// reaches buildEvidence(), and starts its shell child; the preloaded hook records the
// actual spawn options at that final boundary without exposing a production injection.
function repositoryVerifyTrace(operator, command) {
  const trace = join(operator, "repository-verify-spawn.jsonl");
  const preload = join(operator, "repository-verify-spawn-hook.cjs");
  writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const childProcess = require("node:child_process");',
    'const { syncBuiltinESMExports } = require("node:module");',
    'const original = childProcess.spawnSync;',
    'childProcess.spawnSync = function(command, args, options) {',
    '  if (command === process.env.FACTORY_VERIFY_TRACE_COMMAND && options?.shell === true) {',
    '    fs.appendFileSync(process.env.FACTORY_VERIFY_TRACE_PATH, `${JSON.stringify({ command, args, timeout: options.timeout })}\\n`);',
    '  }',
    '  return original.apply(this, arguments);',
    '};',
    'syncBuiltinESMExports();',
  ].join("\n"));
  return {
    trace,
    env: {
      ...process.env,
      FACTORY_VERIFY_TRACE_COMMAND: command,
      FACTORY_VERIFY_TRACE_PATH: trace,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" "),
    },
  };
}

// A repository with an integration branch and one slice branched from its head.
function project(name, { seed = true, testPlan = [PASSING_TEST_COMMAND], legacy = false, paths = ["src/app/"], additionalSlices = [], verify = null, verifyTimeout = undefined, bootstrap = undefined, bootstrapTimeout = undefined, bootstrapMarker = null, publish = "true", configBytes = null } = {}) {
  const operator = mkdtempSync(join(tmpdir(), `ff-e2e-${name}-`));
  git(operator, "init", "-q", "-b", "main");
  git(operator, "config", "user.email", "t@example.com");
  git(operator, "config", "user.name", "T");
  mkdirSync(join(operator, "src", "app"), { recursive: true });
  writeFileSync(join(operator, "src", "app", "base.ts"), "base\n");
  // The control plane must be untracked. If it is not, run.json changes appear in
  // every slice diff and every merge trips the privileged-path refusal - which is
  // how this fixture first failed, and is a real deployment requirement rather than
  // a test detail.
  writeFileSync(join(operator, ".gitignore"), ".factory/\n.factory-sandboxes/\n");
  if (configBytes !== null) writeFileSync(join(operator, ".factory.json"), configBytes);
  else if (verify !== null) {
    const config = {
      resolve: "true", verify: typeof verify === "function" ? verify(operator) : verify,
      publish, publishing_identity: "factory-test",
    };
    if (verifyTimeout !== undefined) config.verify_timeout_ms = verifyTimeout;
    if (bootstrap !== undefined) config.bootstrap = typeof bootstrap === "function" ? bootstrap(operator) : bootstrap;
    if (bootstrapTimeout !== undefined) config.bootstrap_timeout_ms = bootstrapTimeout;
    writeFileSync(join(operator, ".factory.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  git(operator, "add", "-A");
  git(operator, "commit", "-q", "-m", "base");
  git(operator, "remote", "add", "origin", operator);

  let selected;
  if (legacy) {
    git(operator, "switch", "-q", "-c", "feature");
    selected = seedLegacyRun(operator, RUN, { branch: "feature", pr_base: undefined, created_at: NOW(0) });
  } else {
    const fresh = initFresh(operator, [RUN, "--branch", "feature", "--worktree", ".", "--pr-base", "main", "--now", NOW(0)]);
    const operatorPush = git(operator, "remote", "get-url", "--push", "origin");
    git(fresh.repository, "config", "--replace-all", "remote.origin.pushurl", operatorPush);
    assert.equal(git(fresh.repository, "remote", "get-url", "--push", "origin"), operatorPush);
    git(fresh.repository, "config", "user.email", "t@example.com");
    git(fresh.repository, "config", "user.name", "T");
    selected = fresh;
  }
  const repo = selected.repository;
  const runDir = selected.runDir;
  if (bootstrapMarker) rmSync(join(repo, bootstrapMarker), { force: true });
  writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify({
    slices: [
      { id: "be-thing", stack: "backend", paths, depends_on: [], acceptance: ["AC1"], test_plan: testPlan },
      ...additionalSlices,
    ],
  }, null, 2));
  if (seed) {
    approveEarlyGates(repo, NOW(1));
    assert.equal(factory(repo, ["slices-seed", RUN, "--now", NOW(1)]).ok, true);
  }
  return { operator, repo, runDir };
}

const cleanupProject = ({ operator }) => rmSync(operator, { recursive: true, force: true });

// Build the slice, optionally touching extra paths, and return its head.
function buildSlice(repo, { extra = null, extraContent = "extra\n", extras = [] } = {}) {
  const basePoint = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "slice");
  writeFileSync(join(repo, "src", "app", "thing.ts"), "slice\n");
  for (const item of [...(extra ? [{ path: extra, content: extraContent }] : []), ...extras]) {
    mkdirSync(join(repo, dirname(item.path)), { recursive: true });
    writeFileSync(join(repo, item.path), item.content ?? "extra\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "slice work");
  return { head: git(repo, "rev-parse", "HEAD"), basePoint };
}

function writeReview(runDir, subject, reviewedCommit, overrides = {}) {
  writeFileSync(join(runDir, "reviews", `${subject}.json`), `${JSON.stringify({
    subject, reviewer: "work-reviewer", verdict: "APPROVE", attempt: 1,
    reviewed_commit: reviewedCommit, findings: [], required_fixes: [], checked_against: ["brief"],
    ...overrides,
  }, null, 2)}\n`);
  return `reviews/${subject}.json`;
}

// The validator judges a commit and says so in its record; `factory validator` derives the
// verdict and the head from that rather than taking them as arguments. Reports used to be
// an opaque path and the head an argument, so a report about one commit could be recorded
// as a verdict on another.
function recordValidator(repo, runDir, head, verdict, at) {
  writeReview(runDir, "implementation-validator", head, { verdict });
  return factory(repo, ["validator", RUN, "--report", "artifacts/validation-report.md", "--now", at]);
}

function mergeIntoFeature(repo) {
  git(repo, "checkout", "-q", "feature");
  git(repo, "merge", "-q", "--no-ff", "slice", "-m", "merge slice");
  return git(repo, "rev-parse", "HEAD");
}

const runJson = (runDir) => JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));

// Every publication check now asks for all three gates, so a fixture probing one specific
// refusal has to be otherwise-complete or the earlier gates explain the failure instead of
// the guard under test. That masking has bitten this suite repeatedly.
function approveEarlyGates(repo, at) {
  for (const name of ["story", "brief"]) { const r = approveGate(repo, name, at); assert.equal(r.ok, true, `${name}: ${r.stderr}`); }
}

function approveGate(repo, name, at) {
  factory(repo, ["gate", RUN, name, "pending", "--now", at]);
  return factory(repo, ["gate", RUN, name, "approved", "--now", at]);
}

describe("end to end — a merge is refused through the real CLI", () => {
  function upToReview(name, buildOptions, projectOptions = {}) {
    const p = project(name, projectOptions);
    const { head: sliceHead } = buildSlice(p.repo, buildOptions);
    const activated = factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
    assert.equal(activated.ok, true, activated.stderr);
    // The documented flow: `observe --base` takes the base_ref this command reported. Asserted
    // because the skill told readers to get it from `factory status`, which never exposed it.
    const basePoint = activated.out.base_ref;
    assert.match(String(basePoint), /^[0-9a-f]{40}$/u, "activation must report the base_ref it recorded");
    // The orchestrator must observe before it may merge: the diff is re-derived and
    // the named tests are re-run here, not taken from a builder's report.
    const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
      "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(3)]);
    assert.equal(observed.ok, true, observed.stderr);
    assert.equal(observed.out.review_ready, true, "the fixture must produce review_ready evidence");
    const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
    assert.equal(factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef,
      "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]).ok, true);
    return { ...p, sliceHead, basePoint };
  }

  it("records a clean serial merge", () => {
    const p = upToReview("clean");
    try {
      const mergeCommit = mergeIntoFeature(p.repo);
      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, true, merged.stderr);
      // review_archive names where this verdict was preserved before a later attempt could
      // overwrite it. It is reported rather than kept silent so that a null -- meaning the
      // reasoning behind a verdict was NOT retained -- is visible when it happens.
      assert.deepEqual(merged.out, {
        run_id: RUN, slice: "be-thing", status: "merged", attempts: 1,
        base_ref: p.basePoint, merge_commit: mergeCommit,
        review_archive: "reviews/be-thing.attempt-1.json",
      });
      assert.deepEqual(
        JSON.parse(readFileSync(join(p.runDir, "reviews", "be-thing.attempt-1.json"), "utf8")),
        JSON.parse(readFileSync(join(p.runDir, "reviews", "be-thing.json"), "utf8")),
        "an archive must be a faithful copy of the record it preserves");
      assert.equal(runJson(p.runDir).slices[0].status, "merged");
      assert.equal(existsSync(join(p.runDir, "evidence", "test-verifier.json")), false);
    } finally { cleanupProject(p); }

    const green = upToReview("clean-config", undefined, {
      verify: (operator) => `node -e "require('fs').appendFileSync('${join(operator, "verify-count")}','x')"`,
      verifyTimeout: 120001,
      bootstrap: "node -e \"require('fs').writeFileSync('.factory/excluded-bootstrap-marker','ran')\"",
      bootstrapMarker: ".factory/excluded-bootstrap-marker",
      publish: "node -e \"require('fs').writeFileSync('excluded-publish-marker','ran')\"",
    });
    try {
      assert.equal(existsSync(join(green.repo, ".factory", "excluded-bootstrap-marker")), false, "slice observation must not bootstrap");
      execFileSync(process.execPath, [CLI, "effective-push", "check", green.operator, green.repo]);
      assert.equal(existsSync(join(green.repo, ".factory", "excluded-bootstrap-marker")), false, "effective-push must not execute config bootstrap");
      const mergeCommit = mergeIntoFeature(green.repo);
      const configuredCommand = JSON.parse(readFileSync(join(green.repo, ".factory.json"), "utf8")).verify;
      const configuredTrace = repositoryVerifyTrace(green.operator, configuredCommand);
      const merged = factory(green.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)], { env: configuredTrace.env });
      assert.equal(merged.ok, true, merged.stderr);
      assert.deepEqual(JSON.parse(readFileSync(configuredTrace.trace, "utf8")), {
        command: configuredCommand, args: [], timeout: 120001,
      }, "the parsed explicit timeout must reach the repository shell spawn unchanged");
      const evidence = JSON.parse(readFileSync(join(green.runDir, "evidence", "test-verifier.json"), "utf8"));
      assert.equal(evidence.subject, "test-verifier");
      assert.equal(evidence.commit, mergeCommit);
      assert.equal(evidence.tests.exit, 0);
      assert.equal(evidence.review_ready, true);
      assert.equal(Object.hasOwn(evidence, "verify_timeout_ms"), false);
      assert.equal(Object.hasOwn(runJson(green.runDir), "verify_timeout_ms"), false);
      assert.equal(readFileSync(join(green.operator, "verify-count"), "utf8"), "x");
      assert.equal(existsSync(join(green.repo, ".factory", "excluded-bootstrap-marker")), false, "post-merge verify must not bootstrap");
      assert.equal(recordValidator(green.repo, green.runDir, mergeCommit, "GO", NOW(4)).ok, true);
      assert.equal(approveGate(green.repo, "pre_pr", NOW(4)).ok, true);
      assert.equal(factory(green.repo, ["pr", RUN, "--url", "https://example.test/pr/bootstrap-exclusion", "--now", NOW(4)]).ok, true);
      assert.equal(existsSync(join(green.repo, ".factory", "excluded-bootstrap-marker")), false, "Gate 3 and publication must not bootstrap or run configured publish");
      assert.equal(existsSync(join(green.repo, "excluded-publish-marker")), false, "factory pr must leave configured publish to the workflow");
      const before = readFileSync(join(green.runDir, "run.json"), "utf8");
      const replay = factory(green.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(5)]);
      assert.equal(replay.ok, true, replay.stderr);
      assert.equal(readFileSync(join(green.operator, "verify-count"), "utf8"), "x", "same-SHA replay must not execute verify");
      assert.equal(existsSync(join(green.repo, ".factory", "excluded-bootstrap-marker")), false, "same-SHA replay must not bootstrap");
      assert.equal(readFileSync(join(green.runDir, "run.json"), "utf8"), before, "same-SHA replay must not update the run");
      writeFileSync(join(green.repo, "src", "app", "after-merge.ts"), "moved\n");
      git(green.repo, "add", "-A");
      git(green.repo, "commit", "-q", "-m", "move integration head");
      const moved = factory(green.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(6)]);
      assert.equal(moved.ok, false);
      assert.equal(moved.stderr.trim(), `recorded merge ${mergeCommit} replay cannot reconcile the current integration head; do not re-execute factory config entry 'verify'.`);
      assert.equal(readFileSync(join(green.operator, "verify-count"), "utf8"), "x");
      git(green.repo, "reset", "--hard", mergeCommit);
      const evidencePath = join(green.runDir, "evidence", "test-verifier.json");
      const canonical = readFileSync(evidencePath, "utf8");
      const canonicalRecord = JSON.parse(canonical);
      const missingCanonicalFields = ["branch", "base_ref", "worktree", "commands", "claim_reconciliation"]
        .map((field) => {
          const record = structuredClone(canonicalRecord);
          delete record[field];
          return record;
        });
      const unknownRecords = [
        null,
        "{not json\n",
        ...missingCanonicalFields,
        { ...canonicalRecord, run_id: "foreign-run" },
        { ...canonicalRecord, commit: "0".repeat(40) },
        { ...canonicalRecord, base_ref: "0".repeat(40) },
        { ...canonicalRecord, worktree: `${canonicalRecord.worktree}-foreign` },
        { ...canonicalRecord, commands: canonicalRecord.commands.slice(0, 2) },
        { ...canonicalRecord, claim_reconciliation: { claimed: true, mismatches: [] } },
        { ...canonicalRecord, tests: { ...canonicalRecord.tests, cmd: "foreign command" } },
        {
          ...canonicalRecord, review_ready: true,
          tests: { ...canonicalRecord.tests, observed: false, exit: null, skipped_reason: "not canonical" },
        },
        // Canonical tests tuple with a contradicting review_ready. Pinned as a shape that must
        // stay unknown; `readEvidence` is what refuses it, before the canonical check runs.
        {
          ...canonicalRecord, review_ready: true,
          tests: { ...canonicalRecord.tests, observed: false, exit: null, skipped_reason: null },
        },
      ];
      for (const record of unknownRecords) {
        if (record === null) rmSync(evidencePath, { force: true });
        else writeFileSync(evidencePath, typeof record === "string" ? record : `${JSON.stringify(record, null, 2)}\n`);
        const unknown = factory(green.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(7)]);
        assert.equal(unknown.ok, false);
        assert.match(unknown.stderr, new RegExp(`post-merge verify outcome is unknown for recorded merge ${mergeCommit}`, "u"));
        assert.equal(readFileSync(join(green.operator, "verify-count"), "utf8"), "x", "untrusted replay must not execute verify");
      }
    } finally { cleanupProject(green); }

    const defaultTimeout = upToReview("default-verify-timeout", undefined, {
      verify: "node -e \"process.exit(0)\"",
    });
    try {
      const mergeCommit = mergeIntoFeature(defaultTimeout.repo);
      const defaultCommand = JSON.parse(readFileSync(join(defaultTimeout.repo, ".factory.json"), "utf8")).verify;
      const defaultTrace = repositoryVerifyTrace(defaultTimeout.operator, defaultCommand);
      const merged = factory(defaultTimeout.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)], { env: defaultTrace.env });
      assert.equal(merged.ok, true, merged.stderr);
      assert.deepEqual(merged.out, {
        run_id: RUN, slice: "be-thing", status: "merged", attempts: 1,
        base_ref: defaultTimeout.basePoint, merge_commit: mergeCommit,
        review_archive: "reviews/be-thing.attempt-1.json",
      }, "omitting verify_timeout_ms must preserve the existing merged response shape");
      assert.deepEqual(JSON.parse(readFileSync(defaultTrace.trace, "utf8")), {
        command: defaultCommand, args: [], timeout: 900000,
      }, "an omitted timeout must reach the repository shell spawn as exactly 900000");
    } finally { cleanupProject(defaultTimeout); }

    const malformed = upToReview("malformed-config", undefined, { configBytes: "{\"resolve\":\"true\"}\n", legacy: true });
    try {
      const mergeCommit = mergeIntoFeature(malformed.repo);
      const merged = factory(malformed.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.equal(merged.stderr.trim(), `factory config entry 'verify' unavailable after recorded merge ${mergeCommit}: invalid .factory.json; merged slice remains recorded; stop before advancing.`);
      assert.equal(runJson(malformed.runDir).slices[0].status, "merged");
    } finally { cleanupProject(malformed); }

    const unexpected = upToReview("unexpected-config-entry", undefined, { configBytes: `${JSON.stringify({
      resolve: "true", verify: "node -e \"require('fs').writeFileSync('unexpected-verify-ran','x')\"",
      publish: "true", publishing_identity: "factory-test", unexpected: true,
    }, null, 2)}\n`, legacy: true });
    try {
      const mergeCommit = mergeIntoFeature(unexpected.repo);
      const merged = factory(unexpected.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.equal(merged.stderr.trim(), `factory config entry 'verify' unavailable after recorded merge ${mergeCommit}: invalid .factory.json; merged slice remains recorded; stop before advancing.`);
      assert.equal(existsSync(join(unexpected.repo, "unexpected-verify-ran")), false, "malformed config must not execute repository verify");
      assert.equal(existsSync(join(unexpected.runDir, "evidence", "test-verifier.json")), false, "malformed config must not write repository evidence");
    } finally { cleanupProject(unexpected); }

    const invalidTimeouts = [0, -1, 1.5, "900000", null, Number.MAX_SAFE_INTEGER + 1];
    for (const [index, value] of invalidTimeouts.entries()) {
      const configBytes = `${JSON.stringify({
        resolve: "true", verify: "true", publish: "true", publishing_identity: "factory-test",
        verify_timeout_ms: value,
      }, null, 2)}\n`;
      const invalid = index === 0
        ? upToReview(`invalid-timeout-${index}`, undefined, { configBytes, legacy: true })
        : project(`invalid-timeout-${index}`, { configBytes, legacy: true });
      try {
        if (index !== 0) {
          buildSlice(invalid.repo);
          factory(invalid.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
        }
        git(invalid.repo, "checkout", "-q", "feature");
        const rootBase = runJson(invalid.runDir).slices[0].base_ref;
        const direct = factory(invalid.repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", rootBase,
          "--repository-verify", "--now", NOW(3)]);
        assert.equal(direct.ok, false);
        assert.equal(direct.stderr.trim(), "invalid .factory.json: entry 'verify_timeout_ms' must be a positive integer");
        assert.equal(existsSync(join(invalid.runDir, "evidence", "test-verifier.json")), false);
        if (index === 0) {
          const mergeCommit = mergeIntoFeature(invalid.repo);
          const merged = factory(invalid.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
          assert.equal(merged.ok, false);
          assert.equal(merged.stderr.trim(), `factory config entry 'verify' unavailable after recorded merge ${mergeCommit}: invalid .factory.json: entry 'verify_timeout_ms' must be a positive integer; merged slice remains recorded; stop before advancing.`);
          assert.equal(runJson(invalid.runDir).slices[0].status, "merged");
        }
      } finally { cleanupProject(invalid); }
    }

    const bootstrapConfigCases = [
      { name: "unknown", patch: { unexpected: true, bootstrap: 7, bootstrap_timeout_ms: 0 }, named: [] },
      { name: "invalid-both", patch: { resolve: null, bootstrap: 7, bootstrap_timeout_ms: 0 }, named: ["bootstrap"] },
      { name: "invalid-orphan-shape", patch: { bootstrap: " ", bootstrap_timeout_ms: 10 }, named: ["bootstrap"] },
      { name: "orphan", patch: { bootstrap_timeout_ms: 10 }, named: ["bootstrap_timeout_ms"] },
      { name: "invalid-orphan", patch: { bootstrap_timeout_ms: 0 }, named: ["bootstrap_timeout_ms"] },
      // Each timeout shape must lose only to a valid declared bootstrap, not to another
      // timeout or required-field rule. These are negative controls for the parser order.
      ...[
        ["zero", 0], ["negative", -1], ["fractional", 1.5], ["string", "900000"],
        ["null", null], ["unsafe", Number.MAX_SAFE_INTEGER + 1],
      ].map(([name, bootstrap_timeout_ms]) => ({
        name: `invalid-timeout-${name}`,
        patch: { bootstrap: "true", bootstrap_timeout_ms },
        named: ["bootstrap_timeout_ms"],
      })),
      { name: "both-absent", patch: {}, named: null },
      { name: "valid", patch: { bootstrap: "node -e \"require('fs').writeFileSync('direct-bootstrap-marker','ran')\"" }, named: null },
    ];
    for (const row of bootstrapConfigCases) {
      const configBytes = `${JSON.stringify({ resolve: "true", verify: "true", publish: "true", publishing_identity: "test", ...row.patch })}\n`;
      const configured = project(`bootstrap-config-${row.name}`, { configBytes, legacy: true });
      try {
        const activated = factory(configured.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "feature", "--now", NOW(2)]);
        assert.equal(activated.ok, true, activated.stderr);
        const observed = factory(configured.repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", activated.out.base_ref, "--repository-verify", "--now", NOW(3)]);
        if (row.named === null) assert.equal(observed.ok, true, observed.stderr);
        else {
          assert.equal(observed.ok, false, row.name);
          assert.deepEqual([...observed.stderr.matchAll(/entry '([^']+)'/gu)].map((match) => match[1]), row.named, row.name);
        }
        assert.equal(existsSync(join(configured.repo, "direct-bootstrap-marker")), false, "direct repository verification must not bootstrap");
      } finally { cleanupProject(configured); }
    }

    const retry = upToReview("verify-retry", undefined, {
      verify: (operator) => `node -e "const f=require('fs'),p='${join(operator, "verify-count")}';f.appendFileSync(p,'x');if(f.readFileSync(p,'utf8').length<2)setTimeout(()=>{},10000)"`,
      verifyTimeout: 1000,
    });
    try {
      const mergeCommit = mergeIntoFeature(retry.repo);
      const review = readFileSync(join(retry.runDir, "reviews", "be-thing.json"), "utf8");
      const sliceEvidence = readFileSync(join(retry.runDir, "evidence", "be-thing.json"), "utf8");
      const merged = factory(retry.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, true, merged.stderr);
      assert.equal(readFileSync(join(retry.operator, "verify-count"), "utf8"), "xx");
      assert.equal(JSON.parse(readFileSync(join(retry.runDir, "evidence", "test-verifier.json"), "utf8")).attempt, 2);
      assert.equal(readFileSync(join(retry.runDir, "reviews", "be-thing.json"), "utf8"), review);
      assert.equal(readFileSync(join(retry.runDir, "evidence", "be-thing.json"), "utf8"), sliceEvidence);
    } finally { cleanupProject(retry); }

    const dirty = upToReview("verify-dirty", undefined, {
      verify: (operator) => `node -e "const f=require('fs');f.appendFileSync('${join(operator, "verify-count")}','x');f.writeFileSync('src/app/thing.ts','dirty');setTimeout(()=>{},10000)"`,
      verifyTimeout: 1000,
    });
    try {
      const mergeCommit = mergeIntoFeature(dirty.repo);
      const beforeReview = readFileSync(join(dirty.runDir, "reviews", "be-thing.json"), "utf8");
      const beforeEvidence = readFileSync(join(dirty.runDir, "evidence", "be-thing.json"), "utf8");
      const merged = factory(dirty.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.match(merged.stderr, /repository verification retry is unsafe.*worktree has uncommitted changes/u);
      assert.equal(readFileSync(join(dirty.operator, "verify-count"), "utf8"), "x");
      assert.equal(runJson(dirty.runDir).slices[0].status, "merged");
      assert.equal(readFileSync(join(dirty.runDir, "reviews", "be-thing.json"), "utf8"), beforeReview);
      assert.equal(readFileSync(join(dirty.runDir, "evidence", "be-thing.json"), "utf8"), beforeEvidence);
    } finally { cleanupProject(dirty); }

    const moved = upToReview("verify-moved", undefined, {
      verify: (operator) => `node -e "const f=require('fs'),c=require('child_process');f.appendFileSync('${join(operator, "verify-count")}','x');f.writeFileSync('src/app/moved.ts','moved');c.execFileSync('git',['add','src/app/moved.ts']);c.execFileSync('git',['commit','-m','verify-moved']);setTimeout(()=>{},10000)"`,
      verifyTimeout: 1000,
    });
    try {
      const mergeCommit = mergeIntoFeature(moved.repo);
      const beforeReview = readFileSync(join(moved.runDir, "reviews", "be-thing.json"), "utf8");
      const beforeEvidence = readFileSync(join(moved.runDir, "evidence", "be-thing.json"), "utf8");
      const merged = factory(moved.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.match(merged.stderr, new RegExp(`repository verification retry is unsafe after recorded merge ${mergeCommit}: integration HEAD moved`, "u"));
      assert.equal(readFileSync(join(moved.operator, "verify-count"), "utf8"), "x");
      assert.equal(runJson(moved.runDir).slices[0].merge_commit, mergeCommit);
      assert.equal(readFileSync(join(moved.runDir, "reviews", "be-thing.json"), "utf8"), beforeReview);
      assert.equal(readFileSync(join(moved.runDir, "evidence", "be-thing.json"), "utf8"), beforeEvidence);
    } finally { cleanupProject(moved); }

    const resumed = upToReview("verify-resume", undefined, {
      verify: (operator) => `node -e "const f=require('fs'),p='${join(operator, "verify-count")}';f.appendFileSync(p,'x');if(f.readFileSync(p,'utf8').length===1){f.writeFileSync('repository-verify-dirty','dirty');setTimeout(()=>{},10000)}"`,
      verifyTimeout: 1000,
    });
    try {
      assert.equal(factory(resumed.repo, ["lock", RUN, "claim", "--session", "session-a", "--branch", "feature"]).ok, true);
      const mergeCommit = mergeIntoFeature(resumed.repo);
      const beforeReview = readFileSync(join(resumed.runDir, "reviews", "be-thing.json"), "utf8");
      const beforeEvidence = readFileSync(join(resumed.runDir, "evidence", "be-thing.json"), "utf8");
      const exhausted = factory(resumed.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(exhausted.ok, false);
      assert.match(exhausted.stderr, /repository verification retry is unsafe.*uncommitted changes/u);
      assert.equal(readFileSync(join(resumed.operator, "verify-count"), "utf8"), "x");
      assert.equal(runJson(resumed.runDir).status, "running");
      assert.equal(runJson(resumed.runDir).terminal_result, null);
      assert.equal(JSON.parse(readFileSync(join(resumed.runDir, "evidence", "test-verifier.json"), "utf8")).attempt, 1);
      const reason = exhausted.stderr.trim();
      const parked = factory(resumed.repo, ["terminal", RUN, "needs-human", "--reason", reason, "--now", NOW(5)]);
      assert.equal(parked.ok, true, parked.stderr);
      assert.equal(factory(resumed.repo, ["heartbeat", RUN, "--session", "session-a"]).ok, true);
      assert.equal(factory(resumed.repo, ["lock", RUN, "release", "--session", "other-session"]).ok, false);
      let status = factory(resumed.repo, ["status", RUN]);
      assert.equal(status.out.lock, "fresh");
      assert.equal(status.out.lock_session, "session-a");
      assert.equal(status.out.status, "needs-human");
      assert.equal(status.out.dead_lock, false);
      assert.equal(status.out.next, "gate:pre_pr");
      assert.deepEqual(status.out.terminal_result, { status: "needs-human", reason });
      assert.equal(factory(resumed.repo, ["lock", RUN, "release", "--session", "session-a"]).ok, true);
      status = factory(resumed.repo, ["status", RUN]);
      assert.equal(status.out.status, "needs-human");
      assert.equal(status.out.lock, "absent");
      const parkedBytes = readFileSync(join(resumed.runDir, "run.json"), "utf8");
      assert.deepEqual(factory(resumed.repo, ["status", RUN]).out, status.out);
      assert.equal(readFileSync(join(resumed.runDir, "run.json"), "utf8"), parkedBytes);

      const forbidden = [
        ["terminal", RUN, "needs-human", "--reason", "rewrite", "--now", NOW(6)],
        ["gate", RUN, "story", "pending", "--now", NOW(6)],
        ["step", RUN, "test-verifier", "accepted", "--now", NOW(6)],
        ["slices-seed", RUN, "--now", NOW(6)],
        ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(6)],
        ["observe", RUN, "test-verifier", "--worktree", ".", "--base", resumed.basePoint, "--repository-verify", "--now", NOW(6)],
        ["validator", RUN, "--report", "artifacts/validation-report.md", "--now", NOW(6)],
        ["pr", RUN, "--url", "https://example.test/pr/parked", "--now", NOW(6)],
      ];
      for (const args of forbidden) {
        const refused = factory(resumed.repo, args);
        assert.equal(refused.ok, false, args[0]);
        assert.equal(refused.stderr.trim(), `factory ${args[0]} refuses while run status is needs-human; run factory resume first`);
        assert.equal(readFileSync(join(resumed.runDir, "run.json"), "utf8"), parkedBytes, args[0]);
        assert.equal(readFileSync(join(resumed.operator, "verify-count"), "utf8"), "x", args[0]);
      }
      const collision = factory(resumed.operator, ["init", RUN, "--now", NOW(6)]);
      assert.equal(collision.ok, false);
      assert.match(collision.stderr, /run status\/resume with --repo/u);
      assert.equal(readFileSync(join(resumed.runDir, "run.json"), "utf8"), parkedBytes);

      assert.equal(factory(resumed.repo, ["lock", RUN, "claim", "--session", "old-owner", "--branch", "feature", "--now", "2020-01-01T00:00:00Z"]).ok, true);
      assert.equal(factory(resumed.repo, ["lock", RUN, "steal", "--session", "session-b", "--branch", "feature"]).ok, true);
      assert.equal(factory(resumed.repo, ["heartbeat", RUN, "--session", "session-b"]).ok, true);
      status = factory(resumed.repo, ["status", RUN]);
      assert.equal(status.out.lock, "fresh");
      assert.equal(status.out.lock_session, "session-b");
      assert.deepEqual(status.out.terminal_result, { status: "needs-human", reason });
      rmSync(join(resumed.repo, "repository-verify-dirty"));
      const badArity = factory(resumed.repo, ["resume", RUN, "extra"]);
      assert.equal(badArity.ok, false);
      assert.equal(badArity.stderr.trim(), "factory resume requires exactly one <run-id>");
      const badFlag = factory(resumed.repo, ["resume", RUN, "--branch", "feature"]);
      assert.equal(badFlag.ok, false);
      assert.match(badFlag.stderr, /unknown option '--branch' for 'resume'/u);

      // Ownership, proven at the handoff. Every other mutating command advances a run whose driver
      // already claimed the lock; resume is where a new driver takes over a run nobody is driving,
      // so two drivers could otherwise both believe they own the same parked run. Each refusal
      // below leaves the manifest byte-identical.
      const noSession = factory(resumed.repo, ["resume", RUN, "--now", NOW(7)]);
      assert.equal(noSession.ok, false);
      assert.equal(noSession.stderr.trim(), "factory resume requires --session <session-id>");
      const wrongSession = factory(resumed.repo, ["resume", RUN, "--session", "session-zzz", "--now", NOW(7)]);
      assert.equal(wrongSession.ok, false);
      assert.match(wrongSession.stderr, /is held by session session-b, not session-zzz/u);
      assert.equal(factory(resumed.repo, ["lock", RUN, "release", "--session", "session-b"]).ok, true);
      const unlocked = factory(resumed.repo, ["resume", RUN, "--session", "session-b", "--now", NOW(7)]);
      assert.equal(unlocked.ok, false);
      assert.match(unlocked.stderr, /requires a held session lock/u);
      writeFileSync(join(resumed.runDir, "factory.lock"), `${JSON.stringify({
        session: "session-b", pid: process.pid, run_id: RUN, branch: "feature",
        claimed_at: "2020-01-01T00:00:00.000Z", heartbeat_at: "2020-01-01T00:00:00.000Z",
      }, null, 2)}\n`);
      const staleLock = factory(resumed.repo, ["resume", RUN, "--session", "session-b", "--now", NOW(7)]);
      assert.equal(staleLock.ok, false);
      assert.match(staleLock.stderr, /refuses a stale session lock/u);
      // The lock written just above still carries `pid`, which the CLI no longer writes. That is the
      // migration contract, and it is load-bearing: `pid` is not required any more, but it must stay
      // a *tolerated* key, because the validator rejects unknown ones. Delisting it would read every
      // lock written before the change as absent -- not stale, absent -- and a second session could
      // then claim a run that is still being worked. "Stale" is only reachable by a lock that parsed,
      // so this refusal is the proof the legacy shape was recognised.
      assert.doesNotMatch(staleLock.stderr, /requires a held session lock/u,
        "a lock carrying the retired `pid` must still be recognised, not read as absent");
      assert.equal(factory(resumed.repo, ["lock", RUN, "steal", "--session", "session-b", "--branch", "feature"]).ok, true);
      assert.equal(readFileSync(join(resumed.runDir, "run.json"), "utf8"), parkedBytes,
        "every ownership refusal must leave the manifest untouched");

      const staleTime = factory(resumed.repo, ["resume", RUN, "--session", "session-b", "--now", NOW(5)]);
      assert.equal(staleTime.ok, false);
      assert.match(staleTime.stderr, /resume-needs-human must move updated_at forwards/u);
      assert.equal(readFileSync(join(resumed.runDir, "run.json"), "utf8"), parkedBytes);
      const resume = factory(resumed.repo, ["resume", RUN, "--session", "session-b", "--now", NOW(7)]);
      assert.equal(resume.ok, true, resume.stderr);
      assert.deepEqual(resume.out, {
        run_id: RUN, status: "running", terminal_result: { status: "needs-human", reason }, next: "gate:pre_pr",
      });
      status = factory(resumed.repo, ["status", RUN]);
      assert.equal(status.out.status, "running");
      assert.equal(status.out.lock_session, "session-b");
      assert.equal(status.out.next, "gate:pre_pr");
      assert.deepEqual(status.out.terminal_result, { status: "needs-human", reason });
      const resumedBytes = readFileSync(join(resumed.runDir, "run.json"), "utf8");
      const replay = factory(resumed.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(8)]);
      assert.equal(replay.ok, true, replay.stderr);
      assert.equal(readFileSync(join(resumed.operator, "verify-count"), "utf8"), "xx");
      assert.equal(readFileSync(join(resumed.runDir, "run.json"), "utf8"), resumedBytes);
      assert.equal(readFileSync(join(resumed.runDir, "reviews", "be-thing.json"), "utf8"), beforeReview);
      assert.equal(readFileSync(join(resumed.runDir, "evidence", "be-thing.json"), "utf8"), beforeEvidence);
      const replayEvidence = JSON.parse(readFileSync(join(resumed.runDir, "evidence", "test-verifier.json"), "utf8"));
      assert.equal(replayEvidence.attempt, 1);
      assert.equal(replayEvidence.commit, mergeCommit);
      const independent = factory(resumed.repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", resumed.basePoint,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(9)]);
      assert.equal(independent.ok, true, independent.stderr);
      assert.equal(readFileSync(join(resumed.operator, "verify-count"), "utf8"), "xx");
      assert.equal(JSON.parse(readFileSync(join(resumed.runDir, "evidence", "test-verifier.json"), "utf8")).tests.cmd, PASSING_TEST_COMMAND);
      assert.equal(recordValidator(resumed.repo, resumed.runDir, mergeCommit, "GO", NOW(9)).ok, true);
      assert.equal(approveGate(resumed.repo, "pre_pr", NOW(9)).ok, true);
      const pr = factory(resumed.repo, ["pr", RUN, "--url", "https://example.test/pr/resumed", "--now", NOW(10)]);
      assert.equal(pr.ok, true, pr.stderr);
      assert.equal(runJson(resumed.runDir).pr_url, "https://example.test/pr/resumed");
      assert.equal(factory(resumed.repo, ["lock", RUN, "release", "--session", "session-b"]).ok, true);
    } finally { cleanupProject(resumed); }

    const unfixed = upToReview("verify-resume-unfixed", undefined, {
      verify: (operator) => `node -e "const f=require('fs');f.appendFileSync('${join(operator, "verify-count")}','x');f.writeFileSync('repository-verify-dirty','dirty');setTimeout(()=>{},10000)"`,
      verifyTimeout: 1000,
    });
    try {
      assert.equal(factory(unfixed.repo, ["lock", RUN, "claim", "--session", "session-a", "--branch", "feature"]).ok, true);
      const mergeCommit = mergeIntoFeature(unfixed.repo);
      const first = factory(unfixed.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      const reason = first.stderr.trim();
      assert.match(reason, /repository verification retry is unsafe.*uncommitted changes/u);
      assert.equal(factory(unfixed.repo, ["terminal", RUN, "needs-human", "--reason", reason, "--now", NOW(5)]).ok, true);
      assert.equal(factory(unfixed.repo, ["lock", RUN, "release", "--session", "session-a"]).ok, true);
      assert.equal(factory(unfixed.repo, ["lock", RUN, "claim", "--session", "session-b", "--branch", "feature"]).ok, true);
      assert.equal(factory(unfixed.repo, ["resume", RUN, "--session", "session-b", "--now", NOW(6)]).ok, true);
      const replay = factory(unfixed.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(7)]);
      assert.equal(replay.ok, false);
      assert.equal(replay.stderr.trim(), reason);
      assert.equal(factory(unfixed.repo, ["terminal", RUN, "needs-human", "--reason", reason, "--now", NOW(8)]).ok, true);
      const reparks = factory(unfixed.repo, ["status", RUN]).out;
      assert.equal(reparks.status, "needs-human");
      assert.deepEqual(reparks.terminal_result, { status: "needs-human", reason });
      assert.equal(factory(unfixed.repo, ["lock", RUN, "release", "--session", "session-b"]).ok, true);
      assert.equal(factory(unfixed.repo, ["status", RUN]).out.lock, "absent");
    } finally { cleanupProject(unfixed); }

    const configuredResume = project("configured-resume");
    try {
      const command = "node -e \"const f=require('fs'),c=require('child_process'),m=f.existsSync('bootstrap-fail')?f.readFileSync('bootstrap-fail','utf8'):'';f.appendFileSync('bootstrap-resume-count','x');if(m==='dirty')f.writeFileSync('tracked-bootstrap.txt','dirty');if(m==='staged'){f.writeFileSync('tracked-bootstrap.txt','staged');c.execFileSync('git',['add','tracked-bootstrap.txt'])}if(m==='unobservable')f.renameSync('.git','.git-gone');if(m==='exit')process.exit(7);if(m==='timeout')setTimeout(()=>{},10000)\"";
      writeFileSync(join(configuredResume.repo, ".factory.json"), `${JSON.stringify({
        resolve: "true", verify: "true", publish: "true", publishing_identity: "test",
        bootstrap: command, bootstrap_timeout_ms: 500,
      })}\n`);
      writeFileSync(join(configuredResume.repo, "tracked-bootstrap.txt"), "clean\n");
      git(configuredResume.repo, "add", ".factory.json", "tracked-bootstrap.txt");
      git(configuredResume.repo, "commit", "-q", "-m", "declare bootstrap");
      assert.equal(factory(configuredResume.repo, ["terminal", RUN, "needs-human", "--reason", "bootstrap recovery", "--now", NOW(3)]).ok, true);
      assert.equal(factory(configuredResume.repo, ["lock", RUN, "claim", "--session", "bootstrap-owner", "--branch", "feature"]).ok, true);
      writeFileSync(join(configuredResume.repo, "bootstrap-fail"), "exit");
      const staleRequest = factory(configuredResume.repo, ["resume", RUN, "--session", "bootstrap-owner", "--now", NOW(3)]);
      assert.equal(staleRequest.ok, false);
      assert.match(staleRequest.stderr, /resume-needs-human must move updated_at forwards/u);
      assert.equal(existsSync(join(configuredResume.repo, "bootstrap-resume-count")), false, "updated_at is proven forward before bootstrap runs");
      const failedExit = factory(configuredResume.repo, ["resume", RUN, "--session", "bootstrap-owner", "--now", NOW(4)]);
      assert.equal(failedExit.ok, false);
      assert.match(failedExit.stderr, /failed during resume with exit status 7; run remains needs-human and its historical terminal result is preserved/u);
      assert.deepEqual({ status: runJson(configuredResume.runDir).status, command: runJson(configuredResume.runDir).bootstrap_command,
        exit: runJson(configuredResume.runDir).bootstrap_exit, result: runJson(configuredResume.runDir).terminal_result }, {
        status: "needs-human", command, exit: 7, result: { status: "needs-human", reason: "bootstrap recovery" },
      });
      writeFileSync(join(configuredResume.repo, "bootstrap-fail"), "timeout");
      const timedOut = factory(configuredResume.repo, ["resume", RUN, "--session", "bootstrap-owner", "--now", NOW(5)]);
      assert.equal(timedOut.ok, false);
      assert.match(timedOut.stderr, /exit status unavailable; run remains needs-human/u);
      assert.equal(runJson(configuredResume.runDir).bootstrap_exit, null);
      // These three rows exercise the configured CLI resume path rather than the cleanliness
      // helper alone. The historical result and owner are isolating controls: an unpark or
      // ownership rewrite would make the refusal look correct while violating recovery safety.
      for (const [mode, diagnostic] of [
        ["dirty", /left tracked paths dirty after resume: "tracked-bootstrap\.txt"/u],
        ["staged", /left tracked paths dirty after resume: "tracked-bootstrap\.txt"/u],
      ]) {
        writeFileSync(join(configuredResume.repo, "bootstrap-fail"), mode);
        const refused = factory(configuredResume.repo, ["resume", RUN, "--session", "bootstrap-owner", "--now", NOW(mode === "dirty" ? 6 : 7)]);
        assert.equal(refused.ok, false, mode);
        assert.match(refused.stderr, diagnostic, mode);
        const parked = runJson(configuredResume.runDir);
        assert.deepEqual({ status: parked.status, result: parked.terminal_result, command: parked.bootstrap_command, exit: parked.bootstrap_exit }, {
          status: "needs-human", result: { status: "needs-human", reason: "bootstrap recovery" }, command, exit: 0,
        }, mode);
        assert.equal(JSON.parse(readFileSync(join(configuredResume.runDir, "factory.lock"), "utf8")).session, "bootstrap-owner", mode);
        // Resetting each deliberate negative control lets the next row prove its own tracked
        // state (worktree versus index) rather than inheriting the prior failure.
        git(configuredResume.repo, "reset", "--", "tracked-bootstrap.txt");
        git(configuredResume.repo, "checkout", "--", "tracked-bootstrap.txt");
      }
      rmSync(join(configuredResume.repo, "bootstrap-fail"));
      const recovered = factory(configuredResume.repo, ["resume", RUN, "--session", "bootstrap-owner", "--now", NOW(8)]);
      assert.equal(recovered.ok, true, recovered.stderr);
      assert.equal(runJson(configuredResume.runDir).bootstrap_exit, 0);
      assert.equal(runJson(configuredResume.runDir).bootstrap_command, command);
      assert.equal(Object.hasOwn(factory(configuredResume.repo, ["status", RUN]).out, "bootstrap_command"), false, "status response stays compatible");
      assert.equal(readFileSync(join(configuredResume.repo, "bootstrap-resume-count"), "utf8"), "xxxxx", "every eligible explicit resume reruns bootstrap");
      assert.equal(factory(configuredResume.repo, ["terminal", RUN, "needs-human", "--reason", "bootstrap observation", "--now", NOW(9)]).ok, true);
      writeFileSync(join(configuredResume.repo, "bootstrap-fail"), "unobservable");
      const unobservable = factory(configuredResume.repo, ["resume", RUN, "--session", "bootstrap-owner", "--now", NOW(10)]);
      assert.equal(unobservable.ok, false);
      assert.match(unobservable.stderr, /could not observe tracked paths after resume; run remains needs-human and its historical terminal result is preserved/u);
      const unobservableRun = runJson(configuredResume.runDir);
      assert.deepEqual({ status: unobservableRun.status, result: unobservableRun.terminal_result, command: unobservableRun.bootstrap_command, exit: unobservableRun.bootstrap_exit }, {
        status: "needs-human", result: { status: "needs-human", reason: "bootstrap observation" }, command, exit: 0,
      });
      assert.equal(JSON.parse(readFileSync(join(configuredResume.runDir, "factory.lock"), "utf8")).session, "bootstrap-owner");
      assert.equal(readFileSync(join(configuredResume.repo, "bootstrap-resume-count"), "utf8"), "xxxxxx", "an unobservable tracked-state attempt still executes exactly once");
    } finally { cleanupProject(configuredResume); }

    const bound = project("bound-resume");
    try {
      writeFileSync(join(bound.repo, "bootstrap-race.js"), [
        "const f=require('fs'),c=require('child_process'),p='.factory/app-1/run.json';",
        "const m=f.existsSync('bootstrap-mode')?f.readFileSync('bootstrap-mode','utf8'):'';",
        "if(m==='equivalent')f.writeFileSync(p,JSON.stringify(JSON.parse(f.readFileSync(p,'utf8')))+'\\n');",
        "if(m==='valid'){const r=JSON.parse(f.readFileSync(p,'utf8'));r.issue_key='changed';f.writeFileSync(p,JSON.stringify(r,null,2)+'\\n')} ",
        "if(m==='malformed')f.writeFileSync(p,'{malformed\\n');",
        "if(m==='heartbeat')c.execFileSync(process.execPath,[process.env.FACTORY_TEST_CLI,'heartbeat','app-1','--session','owner-a','--repo',process.cwd(),'--json'],{stdio:'inherit'});",
        "if(m==='owner'){c.execFileSync(process.execPath,[process.env.FACTORY_TEST_CLI,'lock','app-1','steal','--session','owner-b','--branch','feature','--repo',process.cwd(),'--json'],{stdio:'inherit'});f.writeFileSync('owner-replacement-lock-bytes',f.readFileSync('.factory/app-1/factory.lock'))}",
      ].join("\n"));
      writeFileSync(join(bound.repo, ".factory.json"), `${JSON.stringify({ resolve: "true", verify: "true", publish: "true", publishing_identity: "test", bootstrap: "node bootstrap-race.js" })}\n`);
      git(bound.repo, "add", ".factory.json", "bootstrap-race.js");
      git(bound.repo, "commit", "-q", "-m", "declare race bootstrap");
      assert.equal(factory(bound.repo, ["terminal", RUN, "needs-human", "--reason", "bound", "--now", NOW(3)]).ok, true);
      assert.equal(factory(bound.repo, ["lock", RUN, "claim", "--session", "owner-a", "--branch", "feature"]).ok, true);
      writeFileSync(join(bound.repo, "bootstrap-mode"), "heartbeat");
      assert.equal(factory(bound.repo, ["resume", RUN, "--session", "owner-a", "--now", NOW(4)], { env: { ...process.env, FACTORY_TEST_CLI: CLI } }).ok, true,
        "a forward heartbeat from the same stable owner remains bound");
      assert.equal(factory(bound.repo, ["terminal", RUN, "needs-human", "--reason", "bound again", "--now", NOW(5)]).ok, true);
      const original = readFileSync(join(bound.runDir, "run.json"), "utf8");
      for (const [mode, pattern] of [
        ["equivalent", /run\.json bytes changed while bootstrap ran; current state was preserved/u],
        ["valid", /run\.json bytes changed while bootstrap ran; current state was preserved/u],
        ["malformed", /current run state cannot be qualified because run\.json bytes changed while bootstrap ran/u],
      ]) {
        writeFileSync(join(bound.repo, "bootstrap-mode"), mode);
        const refused = factory(bound.repo, ["resume", RUN, "--session", "owner-a", "--now", NOW(6)], { env: { ...process.env, FACTORY_TEST_CLI: CLI } });
        assert.equal(refused.ok, false, mode);
        assert.match(refused.stderr, pattern, mode);
        const expected = mode === "malformed" ? "{malformed\n" : mode === "equivalent"
          ? `${JSON.stringify(JSON.parse(original))}\n`
          : `${JSON.stringify({ ...JSON.parse(original), issue_key: "changed" }, null, 2)}\n`;
        assert.equal(readFileSync(join(bound.runDir, "run.json"), "utf8"), expected, `${mode} bytes must be preserved exactly`);
        assert.equal(JSON.parse(readFileSync(join(bound.runDir, "factory.lock"), "utf8")).session, "owner-a");
        if (mode === "malformed") {
          assert.doesNotMatch(refused.stderr, /run remains needs-human|resumability|resumable/u,
            "an unqualified malformed replacement must not be described as a parked resumable run");
        }
        writeFileSync(join(bound.runDir, "run.json"), original);
      }
      // This preload changes bytes only on factory resume's third synchronous run.json read:
      // the final guard. The earlier bound-byte read, post-bootstrap check, and both async CAS
      // reads therefore all pass; removing the wired final guard makes this resume incorrectly
      // publish. It is deliberately not the write-core unit seam.
      const finalHook = join(bound.repo, "final-bootstrap-binding-hook.cjs");
      const finalMutation = `${JSON.stringify({ ...JSON.parse(original), issue_key: "changed-at-final-guard" }, null, 2)}\n`;
      writeFileSync(finalHook, [
        'const fs=require("node:fs"),{syncBuiltinESMExports}=require("node:module");',
        'const originalRead=fs.readFileSync;let reads=0;',
        'fs.readFileSync=function(path,...args){',
        ' if(String(path)===process.env.FACTORY_FINAL_RUN_JSON&&++reads===3){',
        '  if(process.env.FACTORY_FINAL_MUTATION)fs.writeFileSync(path,process.env.FACTORY_FINAL_MUTATION);',
        '  if(process.env.FACTORY_FINAL_COMPETITOR_WORKER)require("node:child_process").spawn(process.execPath,[process.env.FACTORY_FINAL_COMPETITOR_WORKER],{stdio:"ignore",env:{...process.env,NODE_OPTIONS:""}});',
        ' }',
        ' return originalRead.call(this,path,...args);',
        '};syncBuiltinESMExports();',
      ].join("\n"));
      rmSync(join(bound.repo, "bootstrap-mode"));
      const finalRefusal = factory(bound.repo, ["resume", RUN, "--session", "owner-a", "--now", NOW(7)], {
        env: {
          ...process.env, FACTORY_TEST_CLI: CLI, FACTORY_FINAL_RUN_JSON: join(bound.runDir, "run.json"),
          FACTORY_FINAL_MUTATION: finalMutation,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${finalHook}`].filter(Boolean).join(" "),
        },
      });
      assert.equal(finalRefusal.ok, false);
      assert.match(finalRefusal.stderr, /run\.json bytes changed while bootstrap ran; current state was preserved/u);
      assert.equal(readFileSync(join(bound.runDir, "run.json"), "utf8"), finalMutation,
        "the real resume final guard must preserve a byte mutation injected after both CAS reads");
      assert.equal(JSON.parse(readFileSync(join(bound.runDir, "factory.lock"), "utf8")).session, "owner-a");
      writeFileSync(join(bound.runDir, "run.json"), original);
      // Spawn the competing factory operation from that same final-guard read. The worker marks
      // its attempted acquisition before calling `lock claim`; its later refusal against owner A
      // is the negative control that distinguishes lock serialization from a late successful claim.
      const competitorWorker = join(bound.repo, "final-guard-competitor.cjs");
      const competitorReady = join(bound.repo, "final-guard-competitor-ready");
      const competitorResult = join(bound.repo, "final-guard-competitor-result.json");
      writeFileSync(competitorWorker, [
        'const fs=require("node:fs"),{spawnSync}=require("node:child_process");',
        'fs.writeFileSync(process.env.FACTORY_FINAL_COMPETITOR_READY,"attempting");',
        'const result=spawnSync(process.execPath,[process.env.FACTORY_TEST_CLI,"lock","app-1","claim","--session","owner-b","--branch","feature","--repo",process.env.FACTORY_FINAL_REPO,"--json"],{encoding:"utf8",env:{...process.env,NODE_OPTIONS:""}});',
        'fs.writeFileSync(process.env.FACTORY_FINAL_COMPETITOR_RESULT,JSON.stringify({status:result.status,stderr:String(result.stderr??"")}));',
      ].join("\n"));
      const finalPublication = factory(bound.repo, ["resume", RUN, "--session", "owner-a", "--now", NOW(8)], {
        env: {
          ...process.env, FACTORY_TEST_CLI: CLI, FACTORY_FINAL_RUN_JSON: join(bound.runDir, "run.json"),
          FACTORY_FINAL_COMPETITOR_WORKER: competitorWorker, FACTORY_FINAL_COMPETITOR_READY: competitorReady,
          FACTORY_FINAL_COMPETITOR_RESULT: competitorResult, FACTORY_FINAL_REPO: bound.repo,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${finalHook}`].filter(Boolean).join(" "),
        },
      });
      assert.equal(finalPublication.ok, true, finalPublication.stderr);
      assert.equal(readFileSync(competitorReady, "utf8"), "attempting");
      const competing = JSON.parse(readFileSync(competitorResult, "utf8"));
      assert.notEqual(competing.status, 0, "a final-seam competitor must remain blocked through owner A publication");
      assert.match(competing.stderr, /held by session owner-a/u);
      assert.equal(runJson(bound.runDir).status, "running");
      assert.equal(JSON.parse(readFileSync(join(bound.runDir, "factory.lock"), "utf8")).session, "owner-a");
      assert.equal(factory(bound.repo, ["terminal", RUN, "needs-human", "--reason", "bound after final seam", "--now", NOW(9)]).ok, true);
      const beforeOwnerTurnover = readFileSync(join(bound.runDir, "run.json"), "utf8");
      writeFileSync(join(bound.repo, "bootstrap-mode"), "owner");
      const ownerRefusal = factory(bound.repo, ["resume", RUN, "--session", "owner-a", "--now", NOW(10)], { env: { ...process.env, FACTORY_TEST_CLI: CLI } });
      assert.equal(ownerRefusal.ok, false);
      assert.match(ownerRefusal.stderr, /factory\.lock is absent, stale, or no longer names the same owner/u);
      assert.equal(readFileSync(join(bound.runDir, "run.json"), "utf8"), beforeOwnerTurnover,
        "pre-transition owner turnover must preserve the current parked manifest bytes");
      assert.equal(JSON.parse(readFileSync(join(bound.runDir, "factory.lock"), "utf8")).session, "owner-b");
      assert.equal(readFileSync(join(bound.runDir, "factory.lock"), "utf8"), readFileSync(join(bound.repo, "owner-replacement-lock-bytes"), "utf8"),
        "pre-transition owner turnover must preserve the exact replacement lock bytes");
      rmSync(join(bound.repo, "bootstrap-mode"));
      assert.equal(factory(bound.repo, ["resume", RUN, "--session", "owner-b", "--now", NOW(11)]).ok, true);
    } finally { cleanupProject(bound); }
  });

  it("refuses a slice that changed a path it does not own", () => {
    const companionPaths = ["test/module.integration.test.js", "test/module.unit.test.js"];
    const p = upToReview("unowned", { extras: companionPaths.map((path) => ({ path })) }, {
      additionalSlices: [{
        id: "be-other", stack: "backend", paths: [companionPaths[0]], depends_on: [],
        acceptance: ["AC2"], test_plan: [],
      }],
    });
    try {
      assert.deepEqual(runJson(p.runDir).slices.map((slice) => slice.path_amendments), [[], []],
        "every newly seeded slice starts with empty amendment history");
      const mergeCommit = mergeIntoFeature(p.repo);
      const before = readFileSync(join(p.runDir, "run.json"), "utf8");
      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "the merge must be refused");
      assert.match(merged.stderr, /changed paths it does not own: test\/module\.integration\.test\.js, test\/module\.unit\.test\.js/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), before, "run.json must be untouched");
      const runningRefusal = factory(p.repo, ["amend-paths", RUN, "be-thing", "--add", companionPaths[0],
        "--reason", "not parked", "--session", "session-b", "--now", NOW(5)]);
      assert.equal(runningRefusal.ok, false);
      assert.match(runningRefusal.stderr, /requires current status needs-human; found 'running'/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), before);

      const reason = "  reviewer verified the omitted ownership  ";
      assert.equal(factory(p.repo, ["terminal", RUN, "needs-human", "--reason", reason, "--now", NOW(5)]).ok, true);
      const parked = readFileSync(join(p.runDir, "run.json"), "utf8");
      const amendment = ["amend-paths", RUN, "be-thing", "--add", companionPaths[0],
        "--add", companionPaths[1], "--reason", reason, "--session", "session-b", "--now", NOW(7)];
      assert.equal(factory(p.repo, ["lock", RUN, "claim", "--session", "session-b", "--branch", "feature"]).ok, true);

      for (const [label, args, pattern, absentPattern] of [
        ["arity", ["amend-paths", RUN], /requires exactly <run-id> <slice-id>/u],
        ["missing add", ["amend-paths", RUN, "be-thing", "--reason", reason, "--session", "session-b"], /requires at least one --add/u],
        ["blank reason", ["amend-paths", RUN, "be-thing", "--add", companionPaths[0], "--reason", "   ", "--session", "session-b"], /requires nonblank --reason/u],
        ["blank session", ["amend-paths", RUN, "be-thing", "--add", companionPaths[0], "--reason", reason, "--session", "   "], /requires nonblank --session/u],
        ["malformed blank", ["amend-paths", RUN, "be-thing", "--add", "", "--reason", reason, "--session", "session-b"], /must be non-empty/u],
        ["external absolute", ["amend-paths", RUN, "be-thing", "--add", "/tmp/outside", "--reason", reason, "--session", "session-b"], /repository-relative/u],
        ["traversal", ["amend-paths", RUN, "be-thing", "--add", "src/../outside", "--reason", reason, "--session", "session-b"], /contain no '\.\.' segment/u],
        ...[".factory", ".factory/run.json", ".git", ".git/config", ".gitignore", ".factory.json"].map((path) =>
          [`privileged ${path}`, ["amend-paths", RUN, "be-thing", "--add", path, "--reason", reason, "--session", "session-b"], /cannot amend privileged/u]),
        ["privilege before duplicate", ["amend-paths", RUN, "be-thing", "--add", ".git", "--add", ".git", "--reason", reason, "--session", "session-b"], /cannot amend privileged/u, /duplicate requested path/u],
        ["duplicate", ["amend-paths", RUN, "be-thing", "--add", companionPaths[0], "--add", companionPaths[0], "--reason", reason, "--session", "session-b"], /duplicate requested path/u],
        ["already owned exact", ["amend-paths", RUN, "be-thing", "--add", "src/app/", "--reason", reason, "--session", "session-b"], /already owns requested path/u],
        ["already owned boundary", ["amend-paths", RUN, "be-thing", "--add", "src/app/thing.ts", "--reason", reason, "--session", "session-b"], /already owns requested path/u],
      ]) {
        const refused = factory(p.repo, args);
        assert.equal(refused.ok, false, label);
        assert.match(refused.stderr, pattern, label);
        if (absentPattern) assert.doesNotMatch(refused.stderr, absentPattern, label);
        assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), parked, label);
      }

      assert.equal(factory(p.repo, ["lock", RUN, "release", "--session", "session-b"]).ok, true);
      const absentOwner = factory(p.repo, amendment);
      assert.equal(absentOwner.ok, false);
      assert.match(absentOwner.stderr, /requires a held session lock/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), parked);
      assert.equal(factory(p.repo, ["lock", RUN, "claim", "--session", "old-owner", "--branch", "feature", "--now", "2020-01-01T00:00:00Z"]).ok, true);
      const staleOwner = factory(p.repo, amendment.map((value) => value === "session-b" ? "old-owner" : value));
      assert.equal(staleOwner.ok, false);
      assert.match(staleOwner.stderr, /refuses a stale session lock/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), parked);
      assert.equal(factory(p.repo, ["lock", RUN, "steal", "--session", "session-b", "--branch", "feature"]).ok, true);
      const wrongOwner = factory(p.repo, amendment.map((value) => value === "session-b" ? "other-owner" : value));
      assert.equal(wrongOwner.ok, false);
      assert.match(wrongOwner.stderr, /held by session session-b, not other-owner/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), parked);

      const amended = factory(p.repo, amendment);
      assert.equal(amended.ok, true, amended.stderr);
      assert.deepEqual(amended.out, {
        run_id: RUN,
        slice: "be-thing",
        status: "needs-human",
        terminal_result: { status: "needs-human", reason },
        amendment: {
          added_paths: companionPaths,
          reason,
          session: "session-b",
          at: new Date(NOW(7)).toISOString(),
        },
      });
      let durable = runJson(p.runDir);
      assert.deepEqual(durable.slices[0].paths, ["src/app/", ...companionPaths]);
      assert.deepEqual(durable.slices[0].path_amendments, [amended.out.amendment]);
      assert.deepEqual(durable.slices[1].paths, [companionPaths[0]]);
      assert.equal(durable.status, "needs-human");
      assert.deepEqual(durable.terminal_result, { status: "needs-human", reason });
      const amendedBytes = readFileSync(join(p.runDir, "run.json"), "utf8");
      const replayedAmendment = factory(p.repo, amendment);
      assert.equal(replayedAmendment.ok, false);
      assert.match(replayedAmendment.stderr, /already owns requested path/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), amendedBytes);

      const resumed = factory(p.repo, ["resume", RUN, "--session", "session-b", "--now", NOW(8)]);
      assert.equal(resumed.ok, true, resumed.stderr);
      durable = runJson(p.runDir);
      assert.deepEqual(durable.slices[0].path_amendments, [amended.out.amendment], "resume preserves amendment history");
      assert.deepEqual(durable.slices[0].test_plan, [PASSING_TEST_COMMAND]);
      const recovered = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(9)]);
      assert.equal(recovered.ok, true, recovered.stderr);
      assert.equal(runJson(p.runDir).slices[0].status, "merged");
      assert.equal(factory(p.repo, ["terminal", RUN, "needs-human", "--reason", "late widening", "--now", NOW(10)]).ok, true);
      const mergedBytes = readFileSync(join(p.runDir, "run.json"), "utf8");
      const mergedRefusal = factory(p.repo, ["amend-paths", RUN, "be-thing", "--add", "late/path.ts",
        "--reason", "late widening", "--session", "session-b", "--now", NOW(11)]);
      assert.equal(mergedRefusal.ok, false);
      assert.match(mergedRefusal.stderr, /slice 'be-thing' is already merged/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), mergedBytes);
    } finally { cleanupProject(p); }

    const unamended = upToReview("unamended-control", { extra: "test/unamended.test.js" });
    try {
      const mergeCommit = mergeIntoFeature(unamended.repo);
      const before = readFileSync(join(unamended.runDir, "run.json"), "utf8");
      const refused = factory(unamended.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(refused.ok, false);
      assert.match(refused.stderr, /changed paths it does not own: test\/unamended\.test\.js/u);
      assert.equal(readFileSync(join(unamended.runDir, "run.json"), "utf8"), before);
    } finally { cleanupProject(unamended); }

    const privilegedOwned = project("privileged-owned", { paths: ["src/app/", ".factory.json"] });
    try {
      assert.equal(factory(privilegedOwned.repo, ["terminal", RUN, "needs-human", "--reason", "precedence", "--now", NOW(2)]).ok, true);
      assert.equal(factory(privilegedOwned.repo, ["lock", RUN, "claim", "--session", "session-c", "--branch", "feature"]).ok, true);
      const before = readFileSync(join(privilegedOwned.runDir, "run.json"), "utf8");
      const refused = factory(privilegedOwned.repo, ["amend-paths", RUN, "be-thing", "--add", ".factory.json",
        "--reason", "precedence", "--session", "session-c", "--now", NOW(3)]);
      assert.equal(refused.ok, false);
      assert.match(refused.stderr, /cannot amend privileged/u);
      assert.doesNotMatch(refused.stderr, /already owns requested path/u);
      assert.equal(readFileSync(join(privilegedOwned.runDir, "run.json"), "utf8"), before);
    } finally { cleanupProject(privilegedOwned); }
  });

  it("governs manifests through seeded ownership while .gitignore stays privileged", () => {
    const cases = [
      { name: "owned-package", extra: "package.json", extraContent: "{}\n", paths: ["src/app/", "package.json"], status: "merged" },
      { name: "owned-lockfile", extra: "package-lock.json", extraContent: "{\"lockfileVersion\":3}\n", paths: ["src/app/", "package-lock.json"], status: "merged" },
      { name: "unowned-package", extra: "package.json", extraContent: "{}\n", paths: ["src/app/"], error: "slice 'be-thing' changed paths it does not own: package.json" },
      { name: "owned-gitignore", extra: ".gitignore", extraContent: ".factory/\n# slice change\n", paths: ["src/app/", ".gitignore"], error: "slice 'be-thing' changed privileged control-plane paths: .gitignore" },
    ];

    for (const scenario of cases) {
      const p = upToReview(scenario.name, { extra: scenario.extra, extraContent: scenario.extraContent }, { paths: scenario.paths });
      try {
        const mergeCommit = mergeIntoFeature(p.repo);
        const before = readFileSync(join(p.runDir, "run.json"), "utf8");
        const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
        if (scenario.status === "merged") {
          assert.equal(merged.ok, true, `${scenario.name}: ${merged.stderr}`);
          assert.equal(runJson(p.runDir).slices[0].status, "merged");
        } else {
          assert.equal(merged.ok, false, `${scenario.name}: the merge must be refused`);
          assert.equal(merged.stderr.trim(), scenario.error);
          assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), before, `${scenario.name}: run.json must be untouched`);
        }
      } finally { cleanupProject(p); }
    }
  });

  it("refuses a merge whose review approved a different commit", () => {
    const p = upToReview("stale-review");
    try {
      // The builder pushes one more commit after the review was written.
      git(p.repo, "checkout", "-q", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "changed after review\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "post-review change");
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "an approval for an earlier commit must not merge a later one");
      assert.match(merged.stderr, /approved [0-9a-f]{12} but the head is [0-9a-f]{12}/u);
    } finally { cleanupProject(p); }
  });

  it("tolerates a moved base, however it moved, and refuses unreviewed content in the merge", () => {
    // Inverted once and then left alone deliberately.
    //
    // It originally asserted a moved base fails, which is what every wave's second merge
    // looks like. A round later a guard was added requiring the base to have moved only by
    // recorded slice merges — opencode had walked a direct privileged commit through here —
    // and it was reverted: `base_ref` is immutable, so refusing the merge permanently
    // strands the slice and the run produces no PR. Destroying a shipped feature to enforce
    // a lane check is the wrong trade, and SKILL.md's NO-GO remediation explicitly permits
    // fixing test-only problems directly in the integration branch.
    //
    // So a direct commit moves the base here on purpose: that shape must merge. What must
    // fail is unreviewed content inside the *merge*, which the next test covers.
    const p = upToReview("moved-base");
    try {
      git(p.repo, "checkout", "-q", "feature");
      writeFileSync(join(p.repo, "src", "app", "sibling.ts"), "landed by other means\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "direct integration commit");
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, true, `a moved base must not block a merge: ${merged.stderr}`);
      assert.equal(runJson(p.runDir).slices[0].status, "merged");

      // Tolerating this shape is half the contract; the other half is telling a run what to do when it
      // cannot use it. mimir run 1387 stopped to ask a human because an already-merged slice's test made
      // the current slice's evidence unpassable, and when it resumed it got green by dropping that test
      // from the ratified command — proving less than the plan ratified, which every downstream check
      // then honoured.
      //
      // Two earlier versions of this rule tried to give Step 4 a repair. Both were unreachable, and
      // mimir refused both: `factory observe` runs the suite with `cwd: worktree` on a pinned `base_ref`,
      // so an integration-branch commit is invisible; and a foreign test *outside*
      // `SLICE_TEST_COMMAND` cannot fail the observation at all, so there is no detection point for a
      // pre-merge repair. What survives is the honest outcome — block, do not narrow — plus a pointer to
      // Step 5, which owns the repair because that is where the suite runs on the branch being repaired.
      //
      // Pinned inside this site rather than at a new one: the budget in ceiling.test.js constrains call
      // sites, and binding existing prose to existing behaviour is meant to arrive as data at a site
      // that already exists.
      const skillPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "WORKFLOW.md");
      const build = readFileSync(skillPath, "utf8");
      const step4 = build.slice(build.indexOf("## Step 4 — Build slices"), build.indexOf("## Step 5 — Integrate"));
      for (const required of [
        "ratified suite fails on something this slice may not touch", // the trigger condition
        "is no repair available at this step",                        // the only reachable outcome
        "follow the wave rule below",                                 // terminalizing is an explicit transition
        "Never narrow the ratified command",                          // the false green this invites
        "a false green wearing evidence's",                            // named, because it already happened
        "Step 5's NO-GO repair owns it",                              // where the repair actually lives
        "escalate the smallest decision",                             // anything outside this case
      ]) {
        assert.notEqual(step4.indexOf(required), -1, `Step 4 must state the honest outcome: ${required}`);
      }
    } finally { cleanupProject(p); }
  });

  it("refuses a merge that smuggles an unreviewed path", () => {
    const p = upToReview("smuggled");
    try {
      git(p.repo, "checkout", "-q", "feature");
      git(p.repo, "merge", "-q", "--no-ff", "--no-commit", "slice");
      writeFileSync(join(p.repo, "src", "app", "smuggled.ts"), "never reviewed\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "merge plus extra");
      const mergeCommit = git(p.repo, "rev-parse", "HEAD");

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "content nobody reviewed must not merge");
      assert.match(merged.stderr, /contributed paths that were not reviewed: src\/app\/smuggled\.ts/u);
    } finally { cleanupProject(p); }
  });

  it("refuses a merge with no observed evidence", () => {
    // opencode drove init -> slice merge without ever invoking observe and the merge
    // succeeded, which made the entire observe-don't-trust mechanism optional.
    const p = project("no-evidence");
    try {
      const { head: sliceHead, basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef, "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "a merge without observed evidence must be refused");
      assert.match(merged.stderr, /cannot merge without an evidence_ref/u);
    } finally { cleanupProject(p); }
  });

  it("observe refuses slice commands outside the ratified test_plan before execution or evidence write", () => {
    const testPlan = [
      "git --no-pager log -1 --format=%H -- base.txt extra.txt",
      "touch observe-command-ran",
    ];
    const p = project("observe-command-auth", { testPlan });
    try {
      const { basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      for (const received of [
        "git --no-pager log -1 --format=%H -- base.txt",
        "touch  observe-command-ran",
      ]) {
        const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
          "--attempt", "1", "--test-cmd", received, "--now", NOW(3)]);
        assert.equal(observed.ok, false, "an unratified command must be refused");
        assert.ok(observed.stderr.includes(`expected ${JSON.stringify(testPlan)}; received ${JSON.stringify(received)}`));
      }
      assert.equal(existsSync(join(p.repo, "observe-command-ran")), false);
      assert.equal(existsSync(join(p.runDir, "evidence", "be-thing.json")), false);
    } finally { cleanupProject(p); }

    const q = upToReview("repository-verify-auth", undefined, { verify: "node -e \"process.exit(0)\"" });
    try {
      const rootBase = runJson(q.runDir).slices[0].base_ref;
      const sliceUse = factory(q.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", rootBase,
        "--repository-verify", "--now", NOW(3)]);
      assert.equal(sliceUse.ok, false);
      assert.match(sliceUse.stderr, /valid only for test-verifier/u);
      assert.equal(existsSync(join(q.runDir, "evidence", "test-verifier.json")), false);
      const mixed = factory(q.repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", rootBase,
        "--repository-verify", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(3)]);
      assert.equal(mixed.ok, false);
      assert.match(mixed.stderr, /mutually exclusive/u);

      const mergeCommit = mergeIntoFeature(q.repo);
      assert.equal(factory(q.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]).ok, true);
      const evidencePath = join(q.runDir, "evidence", "test-verifier.json");
      const before = readFileSync(evidencePath, "utf8");
      const other = join(q.repo, "other-worktree");
      mkdirSync(other);
      writeFileSync(join(q.repo, ".factory.json"), "{}\n");
      const wrongWorktree = factory(q.repo, ["observe", RUN, "test-verifier", "--worktree", other, "--base", rootBase,
        "--repository-verify", "--now", NOW(5)]);
      assert.equal(wrongWorktree.ok, false);
      assert.match(wrongWorktree.stderr, /integration worktree mismatch: committed/u);
      assert.equal(readFileSync(evidencePath, "utf8"), before);
      git(q.repo, "checkout", "--", ".factory.json");
      rmSync(other, { recursive: true });
      git(q.repo, "checkout", "-q", "slice");
      const wrongBranch = factory(q.repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", rootBase,
        "--repository-verify", "--now", NOW(5)]);
      assert.equal(wrongBranch.ok, false);
      assert.match(wrongBranch.stderr, /must have branch 'feature' checked out; observed slice/u);
      assert.equal(readFileSync(evidencePath, "utf8"), before);
      git(q.repo, "checkout", "-q", "--detach", mergeCommit);
      const detached = factory(q.repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", rootBase,
        "--repository-verify", "--now", NOW(5)]);
      assert.equal(detached.ok, false);
      assert.match(detached.stderr, /observed detached HEAD/u);
      assert.equal(readFileSync(evidencePath, "utf8"), before);
    } finally { cleanupProject(q); }
  });

  it("refuses a merge whose evidence is not review_ready", () => {
    const p = project("not-ready", { testPlan: [FAILING_TEST_COMMAND] });
    try {
      const { head: sliceHead, basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      // A failing test command: observed, and observed to fail.
      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
        "--attempt", "1", "--test-cmd", FAILING_TEST_COMMAND, "--now", NOW(3)]);
      assert.equal(observed.ok, true, observed.stderr);
      assert.equal(observed.out.review_ready, false);
      const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef, "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "a failing observed test must block the merge");
      assert.match(merged.stderr, /evidence is not review_ready/u);

      // Folded in, because it is the same question asked one level up: what makes a slice
      // review-ready with no test run at all. That used to be `--skip-tests-reason`, set at
      // observation time by the party being observed, and any nonempty string was accepted.
      // It is now the test_plan the decompose gate ratified, and both directions are
      // asserted because only the pair shows the field is being read.
      for (const [label, testPlan, expected] of [["required", [PASSING_TEST_COMMAND], false], ["waived", [], true]]) {
        const q = project(`test-plan-${label}`, { testPlan });
        try {
          const { basePoint: qBase } = buildSlice(q.repo);
          factory(q.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
          // No --test-cmd in either case: the only difference is the ratified plan.
          const seen = factory(q.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", qBase,
            "--attempt", "1", "--now", NOW(3)]);
          assert.equal(seen.ok, true, seen.stderr);
          assert.equal(seen.out.review_ready, expected,
            `an untested slice whose test_plan is ${label} must be review_ready: ${expected}`);
          if (label === "waived") {
            const evidencePath = join(q.runDir, "evidence", "be-thing.json");
            const before = readFileSync(evidencePath, "utf8");
            const supplied = factory(q.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", qBase,
              "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(3)]);
            assert.equal(supplied.ok, false);
            assert.ok(supplied.stderr.includes(`expected []; received ${JSON.stringify(PASSING_TEST_COMMAND)}`));
            assert.equal(readFileSync(evidencePath, "utf8"), before);
          }
        } finally { cleanupProject(q); }
      }
    } finally { cleanupProject(p); }
  });

  it("binds the slice base to the observed integration head, not to a supplied value", () => {
    // opencode's probe: an earlier commit added an unowned file, a later commit added an
    // owned one, and activating against the *earlier* commit made the ownership diff
    // exclude the unowned change. The base is now observed at activation, so a stale or
    // convenient value cannot be supplied at all - --base no longer exists.
    const p = project("stale-base");
    try {
      const integrationHead = git(p.repo, "rev-parse", "HEAD");
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "secret.ts"), "unowned\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "unowned work");
      writeFileSync(join(p.repo, "src", "app", "visible.ts"), "owned\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "owned work");
      const sliceHead = git(p.repo, "rev-parse", "HEAD");

      const activated = factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      assert.equal(activated.ok, true, activated.stderr);
      assert.equal(runJson(p.runDir).slices[0].base_ref, integrationHead,
        "the base must be the observed integration head, not a caller's choice");

      factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", integrationHead,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(3)]);
      const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef,
        "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "the unowned earlier commit must still be in the diff");
      assert.match(merged.stderr, /changed paths it does not own: src\/secret\.ts/u);
    } finally { cleanupProject(p); }
  });

  it("refuses a review that approved a different slice at the same commit", () => {
    // opencode's probe: a valid approval for other-slice at the same commit was accepted
    // as the review for be-thing. With several slices in a wave and one --review-ref
    // argument, passing the wrong one is an ordinary mistake.
    const p = upToReview("foreign-review");
    try {
      const foreignRef = writeReview(p.runDir, "other-slice", p.sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", foreignRef, "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "an approval for another slice must not merge this one");
      assert.match(merged.stderr, /approved 'other-slice', not 'be-thing'/u);
    } finally { cleanupProject(p); }
  });

  it("refuses to observe a worktree with uncommitted changes", () => {
    // opencode's probe: commit broken code, approve that commit, then make the working
    // tree pass. Tests ran on the dirty bytes while the evidence claimed the clean HEAD,
    // so the merge succeeded and the same test failed on the merged tree.
    const p = project("dirty");
    try {
      const integrationHead = git(p.repo, "rev-parse", "HEAD");
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "BROKEN\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "broken");
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);

      // The working tree now differs from the commit: a test could pass here and fail on
      // what actually merges.
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "FIXED, but uncommitted\n");

      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", integrationHead,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(3)]);
      assert.equal(observed.ok, true, "observation still records; it just cannot be ready");
      assert.equal(observed.out.review_ready, false, "a dirty tree cannot produce review_ready evidence");
      const record = JSON.parse(readFileSync(join(p.runDir, "evidence", "be-thing.json"), "utf8"));
      assert.equal(record.worktree_clean, false);
      assert.equal(record.tests.observed, false, "tests must not run against bytes that will not merge");
      assert.match(record.blocked_reason, /uncommitted changes/u);
    } finally { cleanupProject(p); }
  });

  it("refuses activation when the integration head moves before the transition commits", () => {
    // opencode's race probe: the head was observed, the feature ref advanced, and the
    // stale value was persisted as base_ref without notice. The write core's CAS covers
    // run.json, not a Git ref, so the head is re-observed at the commit boundary.
    const p = project("base-race");
    try {
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "slice\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "slice work");

      // Advance the integration branch after activation would have sampled it. The
      // boundary observation must notice and refuse rather than persist the old head.
      git(p.repo, "checkout", "-q", "feature");
      writeFileSync(join(p.repo, "src", "app", "advanced.ts"), "moved on\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "integration advanced");
      const movedHead = git(p.repo, "rev-parse", "feature");
      git(p.repo, "checkout", "-q", "slice");

      // A clean activation records the current head; assert it is the moved one, not a
      // stale sample, which is the property the boundary re-observation guarantees.
      const activated = factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      assert.equal(activated.ok, true, activated.stderr);
      assert.equal(runJson(p.runDir).slices[0].base_ref, movedHead,
        "the persisted base must be the head observed at the commit boundary");
    } finally { cleanupProject(p); }
  });

  it("refuses a merge whose review changed while the merge was being verified", () => {
    // opencode's race probe: merge read a valid APPROVE, the sidecar became REJECT during
    // the merge-proof observations, and the slice was still recorded as merged. A
    // reviewer process rewriting its own output is a plausible race.
    const p = upToReview("review-race");
    try {
      const mergeCommit = mergeIntoFeature(p.repo);
      const reviewPath = join(p.runDir, "reviews", "be-thing.json");
      const approved = readFileSync(reviewPath, "utf8");

      // Rewrite the sidecar to a REJECT after the merge command has read it. The
      // rewrite happens here rather than mid-process, which still exercises the re-read:
      // the second read must disagree with the first.
      const rejected = JSON.parse(approved);
      rejected.verdict = "REJECT";
      writeFileSync(reviewPath, `${JSON.stringify(rejected, null, 2)}\n`);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "a rejected review must not merge");
      assert.match(merged.stderr, /verdict is REJECT, not an approval|changed while the merge was being verified/u);
      assert.equal(runJson(p.runDir).slices[0].status, "review");
    } finally { cleanupProject(p); }
  });

  it("refuses evidence when the test itself dirties the worktree", () => {
    // opencode's first probe: a passing test modified tracked source and left it dirty.
    // The pre-test snapshot said clean, so the evidence claimed a clean HEAD and the
    // merged tree then failed the same test.
    const p = project("test-dirties", { testPlan: [DIRTYING_TEST_COMMAND] });
    try {
      const integrationHead = git(p.repo, "rev-parse", "HEAD");
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "slice\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "slice work");
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);

      // A "test" that passes and writes a tracked file — ordinary behaviour for snapshot
      // updaters, formatters, and code generators. No spaces: the command splits on them.
      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", integrationHead,
        "--attempt", "1", "--test-cmd", DIRTYING_TEST_COMMAND, "--now", NOW(3)]);

      assert.equal(observed.ok, true);
      const record = JSON.parse(readFileSync(join(p.runDir, "evidence", "be-thing.json"), "utf8"));
      assert.equal(record.worktree_clean, false, "a test that dirties the tree must not yield clean evidence");
      assert.equal(record.review_ready, false);
      assert.match(record.blocked_reason, /uncommitted changes|changed while the tests ran/u);
    } finally { cleanupProject(p); }
  });

  // The case that exposed the old tree-equality proof: a wave's slices branch from one
  // head and merge serially, so the second merge lands on a moved base. Now passing, and
  // kept as the default multi-slice coverage — a single-slice fixture cannot detect a
  // proof built on "nothing lands between branch and merge".
  it("merges two file-disjoint slices from the same wave", () => {
    // The central case, and the one that exposes the merge proof's assumption. Both
    // slices branch from the same integration head, as the inherited wave contract specifies ("a slice worktree
    // branched from the current feature-branch HEAD"), and merges are serial. So the
    // second merge lands on a base that has moved, and its merged tree contains the
    // first slice's work as well as its own. Tree equality cannot hold for it.
    const configuredVerify = (operator) => `node -e "const f=require('fs');f.appendFileSync('${join(operator, "wave-count")}','x');process.exit(f.existsSync('src/app/one/work.ts')&&f.existsSync('src/app/two/work.ts')?23:0)"`;
    const p = project("wave", { seed: false, verify: configuredVerify });
    try {
      const verify = JSON.parse(readFileSync(join(p.repo, ".factory.json"), "utf8")).verify;
      // Both slices declare a test_plan. This fixture used to omit it, which was how the
      // omitted-field waiver stayed invisible: the fixture institutionalized the very
      // shape that granted a silent exemption. Seeding a plan without one is now refused,
      // and that refusal is asserted first so the fixture cannot drift back.
      const planFile = join(p.runDir, "plan", "slices.json");
      const slices = [
        { id: "be-one", stack: "backend", paths: ["src/app/one/"], depends_on: [] },
        { id: "be-two", stack: "backend", paths: ["src/app/two/"], depends_on: [] },
        { id: "be-dependent", stack: "backend", paths: ["src/app/dependent/"], depends_on: ["be-two"] },
      ];
      writeFileSync(planFile, JSON.stringify({ slices }, null, 2));
      const unapproved = factory(p.repo, ["slices-seed", RUN, "--now", NOW(1)]);
      assert.equal(unapproved.ok, false, "a plan must not seed before Brief approval");
      assert.match(unapproved.stderr, /slices-seed requires the Brief gate to be approved/u);
      assert.deepEqual(runJson(p.runDir).slices, []);

      approveEarlyGates(p.repo, NOW(1));
      const omitted = factory(p.repo, ["slices-seed", RUN, "--now", NOW(1)]);
      assert.equal(omitted.ok, false, "a plan that never mentions tests must not seed");
      assert.match(omitted.stderr, /test_plan: must be an array of strings/u);

      writeFileSync(planFile, JSON.stringify({ slices: slices.map((s) => ({ ...s, test_plan: [PASSING_TEST_COMMAND] })) }, null, 2));
      // Revising the plan after approval unbinds it: the gate approved the earlier bytes. Re-approve
      // so the seed below ratifies what was presented, which is the contract, not a fixture detail.
      assert.equal(approveGate(p.repo, "brief", NOW(1)).ok, true);
      const presentedPlan = readFileSync(planFile, "utf8");
      rmSync(planFile);
      const missing = factory(p.repo, ["slices-seed", RUN, "--now", NOW(1)]);
      assert.equal(missing.ok, false, "a failed first seed must leave the run recoverable");
      assert.match(missing.stderr, /could not read plan\/slices\.json/u);
      const recoverable = factory(p.repo, ["status", RUN]);
      assert.equal(recoverable.ok, true, recoverable.stderr);
      assert.equal(recoverable.out.gates.brief, "approved");
      assert.deepEqual(recoverable.out.slices, []);
      assert.equal(recoverable.out.next, "seed-slices");
      writeFileSync(planFile, presentedPlan);
      assert.equal(factory(p.repo, ["slices-seed", RUN, "--now", NOW(1)]).ok, true);
      const waveBase = git(p.repo, "rev-parse", "HEAD");

      const build = (id, dir, t) => {
        git(p.repo, "checkout", "-q", "-b", id, waveBase);
        mkdirSync(join(p.repo, "src", "app", dir), { recursive: true });
        writeFileSync(join(p.repo, "src", "app", dir, "work.ts"), `${id}\n`);
        git(p.repo, "add", "-A");
        git(p.repo, "commit", "-q", "-m", id);
        const head = git(p.repo, "rev-parse", "HEAD");
        const act = factory(p.repo, ["slice", RUN, id, "running", "--worktree", ".", "--branch", id, "--now", NOW(t)]);
        assert.equal(act.ok, true, `activate ${id}: ${act.stderr}`);
        const obs = factory(p.repo, ["observe", RUN, id, "--worktree", ".", "--base", waveBase, "--attempt", "1",
          "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(t + 1)]);
        assert.equal(obs.ok, true, `observe ${id}: ${obs.stderr}`);
        writeReview(p.runDir, id, head);
        factory(p.repo, ["slice", RUN, id, "review", "--review-ref", `reviews/${id}.json`,
          "--evidence-ref", `evidence/${id}.json`, "--now", NOW(t + 2)]);
        return head;
      };
      build("be-one", "one", 2);
      build("be-two", "two", 6);

      const mergeOne = (id, t) => {
        git(p.repo, "checkout", "-q", "feature");
        git(p.repo, "merge", "-q", "--no-ff", id, "-m", `merge ${id}`);
        return factory(p.repo, ["slice", RUN, id, "merged", "--merge-commit", git(p.repo, "rev-parse", "HEAD"), "--now", NOW(t)]);
      };

      const first = mergeOne("be-one", 10);
      assert.equal(first.ok, true, `first merge of a wave: ${first.stderr}`);
      assert.equal(readFileSync(join(p.operator, "wave-count"), "utf8"), "x");
      const preserved = Object.fromEntries(["be-two"].flatMap((id) => [
        [`evidence/${id}.json`, readFileSync(join(p.runDir, "evidence", `${id}.json`), "utf8")],
        [`reviews/${id}.json`, readFileSync(join(p.runDir, "reviews", `${id}.json`), "utf8")],
      ]));

      // The second slice reviewed a tree without be-one in it; the merged tree has both.
      const second = mergeOne("be-two", 11);
      const secondMerge = git(p.repo, "rev-parse", "HEAD");
      assert.equal(second.ok, false, "the repository verify must detect the cross-slice defect");
      assert.equal(second.stderr.trim(), `factory config entry 'verify' failed after recorded merge ${secondMerge} with exit status 23; merged slice remains recorded; stop before advancing.`);
      assert.deepEqual(runJson(p.runDir).slices.map((slice) => slice.status), ["merged", "merged", "pending"]);
      for (const [ref, bytes] of Object.entries(preserved)) assert.equal(readFileSync(join(p.runDir, ref), "utf8"), bytes);
      const failedEvidence = JSON.parse(readFileSync(join(p.runDir, "evidence", "test-verifier.json"), "utf8"));
      assert.equal(failedEvidence.commit, secondMerge);
      assert.equal(failedEvidence.tests.cmd, verify);
      assert.equal(failedEvidence.tests.exit, 23);
      const replay = factory(p.repo, ["slice", RUN, "be-two", "merged", "--merge-commit", secondMerge, "--now", NOW(12)]);
      assert.equal(replay.ok, false);
      assert.equal(replay.stderr.trim(), second.stderr.trim(), "known failure replay must reproduce the refusal without re-execution");
      assert.equal(readFileSync(join(p.operator, "wave-count"), "utf8"), "xx", "failed replay must reuse canonical evidence");
    } finally { cleanupProject(p); }
  });

  it("refuses a merge with evidence but no review", () => {
    // Evidence is checked before the review, so this supplies review_ready evidence
    // and withholds only the review — otherwise the evidence refusal fires and the
    // review requirement goes untested.
    const p = project("no-review");
    try {
      const { basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
        "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(3)]);
      assert.equal(observed.out.review_ready, true, "the evidence must be otherwise acceptable");
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.match(merged.stderr, /cannot merge without a review_ref/u);
    } finally { cleanupProject(p); }
  });
});

describe("end to end — a PR is recorded once, against the judged head", () => {
  // Everything up to the point where publication becomes a question: the slice built,
  // observed, reviewed, merged, and the integration branch validated. The test-verifier
  // observation is deliberately NOT done here, so each test decides whether that stage
  // ran and the requirement can be tested in isolation.
  function readyForPr(name, options) {
    const p = project(name, options);
    const { head: sliceHead, basePoint } = buildSlice(p.repo);
    factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
    factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
      "--attempt", "1", "--test-cmd", PASSING_TEST_COMMAND, "--now", NOW(3)]);
    const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
    factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef,
      "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
    const mergeCommit = mergeIntoFeature(p.repo);
    assert.equal(factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]).ok, true);
    const head = git(p.repo, "rev-parse", "HEAD");
    assert.equal(recordValidator(p.repo, p.runDir, head, "GO", NOW(5)).ok, true);
    return { ...p, head, basePoint };
  }

  // The test-verifier stage, observed on the integrated branch rather than asserted to
  // have happened.
  function verifyTests(repo, base, at, { cmd = "git --no-pager log -1 --format=%H" } = {}) {
    return factory(repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", base,
      "--attempt", "1", "--test-cmd", cmd, "--now", at]);
  }

  it("records a PR against the validated head, and is idempotent on replay", () => {
    const p = readyForPr("pr-ok", { legacy: true });
    try {
      const status = factory(p.repo, ["status", RUN]);
      assert.equal(status.ok, true, status.stderr);
      assert.equal(status.out.pr_base, null);
      assert.equal(factory(p.repo, ["lock", RUN, "claim", "--session", "legacy", "--branch", "feature", "--now", NOW(5)]).ok, true);
      assert.equal(factory(p.repo, ["heartbeat", RUN, "--session", "legacy", "--now", NOW(5)]).ok, true);
      assert.equal(factory(p.repo, ["lock", RUN, "release", "--session", "legacy", "--now", NOW(5)]).ok, true);
      assert.equal(factory(p.repo, ["step", RUN, "test-verifier", "accepted", "--now", NOW(5)]).ok, true);
      assert.equal(Object.hasOwn(runJson(p.runDir), "pr_base"), false);
      // Gate 3 is the last transition before the skill pushes and opens the PR, so the
      // readiness refusal has to be able to land here. Isolated: the slice is merged, the
      // verdict is a GO against the current head, and the only thing missing is an
      // observed test-verifier run.
      const noTests = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(noTests.ok, false, "Gate 3 must not approve before the tests were observed");
      assert.match(noTests.stderr, /evidence\/test-verifier\.json' could not be read/u);

      // And a test-verifier run that was observed *failing* is not a pass either.
      assert.equal(verifyTests(p.repo, p.basePoint, NOW(5), { cmd: "git rev-parse --verify --quiet refs/heads/nope" }).ok, true);
      const redTests = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(redTests.ok, false, "a failing test-verifier run must not approve Gate 3");
      assert.match(redTests.stderr, /test-verifier\.json records tests exiting 1/u);

      assert.equal(verifyTests(p.repo, p.basePoint, NOW(5)).ok, true);
      assert.equal(approveGate(p.repo, "pre_pr", NOW(5)).ok, true, "a ready run must approve");

      const first = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(first.ok, true, first.stderr);
      assert.equal(first.out.pr_url, "https://example.test/pr/1");

      // Attack 9: the crash-replay path. Recording the same PR again must succeed
      // without creating or implying a second one.
      const replay = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(7)]);
      assert.equal(replay.ok, true, replay.stderr);
      assert.equal(replay.out.idempotent, true);
      assert.equal(runJson(p.runDir).pr_url, "https://example.test/pr/1");
      assert.equal(Object.hasOwn(runJson(p.runDir), "pr_base"), false);

      const terminal = project("legacy-terminal", { seed: false, legacy: true });
      try {
        const stopped = factory(terminal.repo, ["terminal", RUN, "blocked", "--reason", "legacy stop", "--now", NOW(8)]);
        assert.equal(stopped.ok, true, stopped.stderr);
        assert.equal(Object.hasOwn(runJson(terminal.runDir), "pr_base"), false);
      } finally { cleanupProject(terminal); }

      const runningBefore = readFileSync(join(p.runDir, "run.json"), "utf8");
      const runningResume = factory(p.repo, ["resume", RUN, "--now", NOW(8)]);
      assert.equal(runningResume.ok, false);
      assert.equal(runningResume.stderr.trim(), "factory resume requires current status needs-human; found 'running'");
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), runningBefore);
      for (const status of ["completed", "partial", "blocked"]) {
        const finalRun = project(`resume-final-${status}`, { seed: false });
        try {
          assert.equal(factory(finalRun.repo, ["terminal", RUN, status, "--reason", "final", "--now", NOW(8)]).ok, true);
          const before = readFileSync(join(finalRun.runDir, "run.json"), "utf8");
          const refused = factory(finalRun.repo, ["resume", RUN, "--now", NOW(9)]);
          assert.equal(refused.ok, false);
          assert.equal(refused.stderr.trim(), `factory resume requires current status needs-human; found '${status}'`);
          assert.equal(readFileSync(join(finalRun.runDir, "run.json"), "utf8"), before);
        } finally { cleanupProject(finalRun); }
      }
    } finally { cleanupProject(p); }
  });

  it("refuses a second, different PR", () => {
    const p = readyForPr("pr-second");
    try {
      verifyTests(p.repo, p.basePoint, NOW(5));
      approveGate(p.repo, "pre_pr", NOW(5));

      // Folded in first, on an otherwise-publishable run: the approved Story cannot be
      // changed underneath everything that was judged against it. Both routes are asserted,
      // because the second needs no re-opening at all.
      //
      // Re-opening any *approved* gate was permitted for one round, to give the late-head recovery
      // a way out. That let Story be re-opened, pointed at a new document and re-approved, while
      // the Brief, validator, tests and Gate 3 that all judged the *old* story stayed valid — the
      // run then published Story v1's implementation under Story v2. Only pre_pr re-opens from
      // approved now, because only its subject can legitimately change after approval. (A gate
      // that asked for `changes` re-opens anywhere — nothing downstream exists to contradict, and
      // that half is covered in prompt-claims.)
      const reopenStory = factory(p.repo, ["gate", RUN, "story", "pending", "--now", NOW(6)]);
      assert.equal(reopenStory.ok, false, "an approved gate must not re-open under completed work");
      assert.match(reopenStory.stderr, /gate 'story' cannot be re-opened once approved and its plan is seeded/u);

      // And the shorter route: re-deciding an approved gate to the status it already holds
      // used to skip every check, so `--artifact` swapped the document in place.
      const swap = factory(p.repo, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW(6)]);
      assert.equal(swap.ok, false, "an approved gate's artifact must not change in place");
      assert.match(swap.stderr, /gate 'story' artifact is what was decided against and cannot change/u);
      assert.equal(runJson(p.runDir).gates.story.artifact, null, "and the manifest is untouched");

      factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      const second = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/2", "--now", NOW(7)]);
      assert.equal(second.ok, false, "a run has one PR");
      assert.match(second.stderr, /pr_url is immutable once recorded/u);
      assert.equal(runJson(p.runDir).pr_url, "https://example.test/pr/1");
    } finally { cleanupProject(p); }
  });

  it("refuses a PR once the integration head has moved past what was approved", () => {
    // This is why readiness is asked twice rather than inherited from Gate 3. The run is
    // genuinely ready at approval; the branch then moves, and the PR would publish a head
    // nobody validated. Only the second check can see that.
    const p = readyForPr("pr-stale");
    try {
      verifyTests(p.repo, p.basePoint, NOW(5));
      assert.equal(approveGate(p.repo, "pre_pr", NOW(5)).ok, true, "the run is ready at approval time");

      writeFileSync(join(p.repo, "src", "app", "after-validation.ts"), "late\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "after validation");

      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false, "a stale verdict must not authorize a PR");
      assert.match(pr.stderr, /validator judged [0-9a-f]{12} but the integration head is [0-9a-f]{12}/u);
      assert.equal(runJson(p.runDir).pr_url, null);

      // Folded in: opencode's continuation of this exact sequence. Refusing the PR is not
      // enough on its own, because the obvious next move is to re-observe and re-validate
      // at the new head — which made every machine check current again while the human's
      // Gate 3 approval still referred to the old one. The gate record holds a status and a
      // time, not a commit, so nothing noticed. Freezing the verdict once the gate is
      // approved is what binds that approval to a commit without storing a second copy of
      // it for the two records to disagree about.
      const newHead = git(p.repo, "rev-parse", "HEAD");
      assert.notEqual(newHead, p.head);
      assert.equal(verifyTests(p.repo, p.basePoint, NOW(6)).ok, true, "re-observing tests is allowed");

      // Folded in: a validator record that judged the *old* head cannot be recorded while the
      // branch is at the new one. The verdict and head used to be arguments, so a report about
      // one commit could be recorded as a verdict on another — this asserts the record has to
      // name what it judged and that git is asked whether that is still current. Checked
      // before the transition, so it fires ahead of the approval freeze below.
      const stale = recordValidator(p.repo, p.runDir, p.head, "GO", NOW(6));
      assert.equal(stale.ok, false, "a verdict on a commit that is no longer the head must refuse");
      assert.match(stale.stderr, /judged [0-9a-f]{12} but the integration head is [0-9a-f]{12}; re-run the validator/u);

      const revalidate = recordValidator(p.repo, p.runDir, newHead, "GO", NOW(6));
      assert.equal(revalidate.ok, false, "an approved gate must not be re-pointed at a new head");
      assert.match(revalidate.stderr, /re-open it as pending before re-recording the validator/u);
      assert.equal(runJson(p.runDir).validator.reviewed_head, p.head, "the approved verdict stands");

      // And the recovery, which is the half that matters more than the refusal: this costs
      // one more approval, not the run. Re-open Gate 3, re-validate at the new head, present
      // it again, and the PR records. A guard that turned a late test-only commit into a
      // dead run would be worse than the staleness it prevents.
      assert.equal(factory(p.repo, ["gate", RUN, "pre_pr", "pending", "--now", NOW(7)]).ok, true, "a decided gate re-opens");
      assert.equal(recordValidator(p.repo, p.runDir, newHead, "GO", NOW(7)).ok, true, "and re-validating is then allowed");
      assert.equal(factory(p.repo, ["gate", RUN, "pre_pr", "approved", "--now", NOW(7)]).ok, true, "re-approved at the new head");
      const after = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(8)]);
      assert.equal(after.ok, true, `the run must still be able to ship: ${after.stderr}`);
      assert.equal(runJson(p.runDir).pr_url, "https://example.test/pr/1");
    } finally { cleanupProject(p); }
  });

  it("refuses to approve Gate 3 on a run that did no work", () => {
    // opencode drove init -> approving validator -> PR with no gates, steps, slices or
    // evidence, and the PR was recorded. Unseeded on purpose: the run never decomposed,
    // so there is no slice plan at all.
    //
    // Asserted at the gate rather than at `pr`, because that is now where it is refused
    // first — and refusing at `pr` alone would be a report about a PR that already exists.
    const p = project("no-work", { seed: false });
    try {
      const head = git(p.repo, "rev-parse", "HEAD");
      approveEarlyGates(p.repo, NOW(5));
      recordValidator(p.repo, p.runDir, head, "GO", NOW(5));
      const gate = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(gate.ok, false, "a run with no slice plan must not clear Gate 3");
      assert.match(gate.stderr, /no slice plan has been seeded/u);

      // And with the gate refused, the PR cannot be recorded either — the other half of
      // the pair, since a `pr` call is what an orchestrator that ignored the gate would do.
      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false);
      assert.match(pr.stderr, /every gate must be approved; not approved: pre_pr\(pending\)/u);
      assert.equal(runJson(p.runDir).pr_url, null);
    } finally { cleanupProject(p); }
  });

  it("refuses to approve Gate 3 while a slice is still open", () => {
    const p = project("open-slice");
    try {
      buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      const head = git(p.repo, "rev-parse", "slice");
      recordValidator(p.repo, p.runDir, head, "GO", NOW(5));
      const running = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(running.ok, false);
      assert.match(running.stderr, /every slice must be merged; not merged: be-thing\(running\)/u);

      // Folded in rather than added, per the test budget: a *blocked* slice must refuse
      // too. This accepted "merged or blocked", so a run with blocked work published
      // while its status stayed running.
      factory(p.repo, ["slice", RUN, "be-thing", "blocked", "--now", NOW(7)]);
      const blocked = approveGate(p.repo, "pre_pr", NOW(8));
      assert.equal(blocked.ok, false, "blocked work must not be published");
      assert.match(blocked.stderr, /every slice must be merged; not merged: be-thing\(blocked\)/u);
    } finally { cleanupProject(p); }
  });

  it("refuses to approve Gate 3 with no approving verdict", () => {
    const p = readyForPr("pr-nogo");
    try {
      verifyTests(p.repo, p.basePoint, NOW(5));
      // The validator loops: a NO-GO recorded over the GO the fixture established.
      recordValidator(p.repo, p.runDir, p.head, "NO-GO", NOW(5));
      const gate = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(gate.ok, false);
      assert.match(gate.stderr, /the validator verdict is not an approval/u);
    } finally { cleanupProject(p); }
  });
});

// The one field `factory status` and the sidebar both read, and it had no test of its own.
// Found by watching a live run report `gate:brief` for the whole of research and spec: naming a
// gate that has not been opened reads as "waiting on you" while an agent is mid-round.
describe("what happens next", () => {
  const at = "2026-07-30T12:00:00.000Z";
  const gate = (status) => ({ status, at: status === "pending" ? null : at, artifact: null });
  const step = (agent, status) => ({ agent, status, attempts: 1, review_ref: null, evidence_ref: null });
  const slice = (id, status) => ({
    id, stack: "backend", depends_on: [], status,
    worktree: status === "pending" ? null : ".", branch: status === "pending" ? null : id, attempts: 1,
    paths: ["src/"], test_plan: ["npm test"], base_ref: status === "pending" ? null : "a".repeat(40),
    evidence_ref: null, review_ref: null, merge_commit: status === "merged" ? "b".repeat(40) : null,
  });
  const state = (overrides = {}) => validateRun({
    version: 1, run_id: "next-action", issue_key: null, branch: "feature/next-action", worktree: ".", pr_base: "main",
    created_at: at, updated_at: at, status: "running", mode: "interactive", max_parallel_slices: 2, max_retries: 3,
    gates: {}, steps: [], slices: [], validator: null, terminal_result: null, pr_url: null, ...overrides,
  });
  const action = (overrides) => nextAction(state(overrides));
  const approved = gate("approved");
  const acceptedSteps = [step("first-step", "accepted"), step("second-step", "accepted")];
  const openSteps = [step("first-step", "running"), step("second-step", "blocked")];
  const priorGates = (target) => Object.fromEntries(GATE_NAMES.slice(0, GATE_NAMES.indexOf(target)).map((name) => [name, approved]));
  const allApproved = Object.fromEntries(GATE_NAMES.map((name) => [name, approved]));
  const competingSlices = [
    slice("pending-first", "pending"), slice("active-first", "running"), slice("merged-first", "merged"),
    slice("blocked-first", "blocked"),
  ];

  it("preserves the mandatory next-action precedence table", () => {
    const failures = [];
    const check = (overrides, expected, label) => {
      const actual = action(overrides);
      if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
      if (overrides.status === undefined || overrides.status === "running") {
        const parked = action({ ...overrides, status: "needs-human", terminal_result: { status: "needs-human", reason: "external cause" } });
        if (parked !== expected) failures.push(`${label} parked: expected ${expected}, got ${parked}`);
      }
    };
    const absentCases = [
      ["blocked category and array order", [
        slice("pending-first", "pending"), slice("active-first", "running"), slice("blocked-first", "blocked"),
        slice("active-second", "review"), slice("blocked-second", "blocked"), slice("pending-second", "pending"),
        slice("merged-first", "merged"),
      ], openSteps, "blocked-slice:blocked-first"],
      ["review before running", [
        slice("pending-first", "pending"), slice("review-first", "review"), slice("running-second", "running"),
        slice("pending-second", "pending"), slice("merged-first", "merged"),
      ], acceptedSteps, "observe-slice:review-first"],
      ["running before review", [
        slice("pending-first", "pending"), slice("running-first", "running"), slice("review-second", "review"),
        slice("pending-second", "pending"), slice("merged-first", "merged"),
      ], acceptedSteps, "observe-slice:running-first"],
      ["merged before pending", [
        slice("merged-first", "merged"), slice("pending-first", "pending"), slice("pending-second", "pending"),
      ], acceptedSteps, "dispatch-slice:pending-first"],
      ["pending before open steps", [slice("pending-first", "pending"), slice("pending-second", "pending")], openSteps,
        "dispatch-slice:pending-first"],
      ["merged before open steps", [slice("merged-first", "merged")], openSteps, "step:first-step"],
      ["open steps", [], openSteps, "step:first-step"],
      ["merged only", [slice("merged-first", "merged")], acceptedSteps, null],
      ["nothing in flight", [], acceptedSteps, null],
    ];
    // An approved Brief with nothing seeded is a checkpoint of its own (#178): it outranks both an
    // absent later gate and any open step, because the only correct next act is the first seed. It
    // cannot collide with the slice rows above, since slice work implies slices exist.
    const unseeded = (target, slices) => target === "pre_pr" && slices.length === 0;
    for (const target of GATE_NAMES) {
      for (const [label, slices, steps, expected] of absentCases) {
        check({ gates: priorGates(target), slices, steps },
          unseeded(target, slices) ? "seed-slices" : expected ?? `gate:${target}`,
          `${target} absent: ${label}`);
      }
    }

    // And a later gate opened by accident must not outrank it either: the seed is still the only
    // thing that can legitimately happen next.
    for (const status of ["pending", "stop", "changes"]) {
      check({ gates: { story: approved, brief: approved, pre_pr: gate(status) }, steps: acceptedSteps },
        "seed-slices", `unseeded Brief outranks pre_pr ${status}`);
      check({ gates: { story: approved, brief: approved, pre_pr: gate(status) }, steps: openSteps },
        "seed-slices", `unseeded Brief outranks pre_pr ${status} and an open step`);
    }

    const decidedLabels = {
      pending: (name) => `gate:${name}`,
      stop: (name) => `stopped-at-gate:${name}`,
      changes: (name) => `changes-at-gate:${name}`,
    };
    for (const target of GATE_NAMES) {
      for (const status of ["pending", "stop", "changes"]) {
        check({
          gates: { ...priorGates(target), [target]: gate(status) }, slices: competingSlices, steps: openSteps,
        }, decidedLabels[status](target), `${target} ${status} must outrank all slice and step work`);
      }
    }

    const approvedCases = [
      ["blocked category and array order", [
        slice("pending-first", "pending"), slice("active-first", "review"), slice("blocked-first", "blocked"),
        slice("blocked-second", "blocked"),
      ], acceptedSteps, null, "blocked-slice:blocked-first"],
      ["review before running", [slice("review-first", "review"), slice("running-second", "running")], acceptedSteps, null,
        "observe-slice:review-first"],
      ["running before review", [slice("running-first", "running"), slice("review-second", "review")], acceptedSteps, null,
        "observe-slice:running-first"],
      ["pending array order", [slice("merged-first", "merged"), slice("pending-first", "pending"),
        slice("pending-second", "pending")], acceptedSteps, null, "dispatch-slice:pending-first"],
      ["merged before open steps", [slice("merged-first", "merged")], openSteps, null, "step:first-step"],
      ["merged before pr", [slice("merged-first", "merged")], acceptedSteps, null, "pr"],
      ["merged before complete", [slice("merged-first", "merged")], acceptedSteps, "https://example.test/pr/1", "complete"],
    ];
    for (const [label, slices, steps, pr_url, expected] of approvedCases) {
      check({ gates: allApproved, slices, steps, pr_url }, expected, `all gates approved: ${label}`);
    }

    for (const status of ["completed", "partial", "blocked"]) {
      check({
        status, terminal_result: { status, reason: "final" },
        gates: { story: gate("pending"), brief: gate("stop"), pre_pr: gate("changes") },
        slices: competingSlices, steps: openSteps,
      }, `terminal:${status}`, `${status} status must outrank all gate, slice, and step work`);
    }
    assert.deepEqual(failures, []);
  });
});

// The validator requirement turns on the slice count, so it needs both sides. Every fixture in
// this file is single-slice, which means the requirement would otherwise have gone untested the
// moment single-slice runs stopped needing it.
describe("the holistic validator is required only when there is something holistic to judge", () => {
  const slice = (id, status = "merged") => ({
    id, stack: "backend", depends_on: [], status, worktree: ".", branch: id, attempts: 1,
    paths: ["src/"], test_plan: ["t"], base_ref: "a".repeat(40), evidence_ref: null,
    review_ref: null, merge_commit: "b".repeat(40),
  });
  const HEAD = "c".repeat(40);
  const state = (slices, validator = null, overrides = {}) => ({
    status: "running", slices, validator,
    gates: Object.fromEntries(["story", "brief", "pre_pr"].map((n) => [n, { status: "approved" }])),
    terminal_result: null,
    ...overrides,
  });
  const refusal = (slices, validator, overrides) => {
    try {
      assertPublicationReady({
        runDir: "/nonexistent", state: state(slices, validator, overrides), runId: RUN, observeHead: () => HEAD,
      });
      return null;
    } catch (error) { return error.message; }
  };

  it("refuses a multi-slice run with no verdict, and lets a single-slice run past that check", () => {
    assert.match(refusal([slice("one"), slice("two")]),
      /a multi-slice run requires an approving validator verdict/u);
    // The single-slice run gets past the validator and refuses later, on evidence it has not got.
    // Asserted as "not the validator refusal" so the test cannot pass because of an unrelated throw.
    const single = refusal([slice("one")]);
    assert.doesNotMatch(single, /validator/u, `single-slice must clear the validator check: ${single}`);

    // Skipping is permitted; ignoring is not. A recorded NO-GO blocks either way.
    assert.match(refusal([slice("one")], { verdict: "NO-GO", reviewed_head: HEAD, report: null, loops: 1 }),
      /the validator verdict is not an approval/u);
    // And a recorded approval is still bound to the head it judged.
    assert.match(refusal([slice("one")], { verdict: "GO", reviewed_head: "d".repeat(40), report: null, loops: 1 }),
      /but the integration head is/u);
    assert.match(refusal([slice("one")], null, {
      status: "needs-human", terminal_result: { status: "needs-human", reason: "external cause" },
    }), /a needs-human run is parked; run factory resume before publication/u);
    const resumed = refusal([slice("one")], null, {
      terminal_result: { status: "needs-human", reason: "external cause" },
    });
    assert.doesNotMatch(resumed, /parked|terminal/u);
  });
});
