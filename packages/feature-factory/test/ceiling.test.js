// The ceiling. This test exists to fail when scope grows.
//
// BUILD-PLAN-SMALL.md lists non-goals as refusals, not deferrals. Prose cannot
// enforce that: the predecessor's 43,013 lines were each individually defensible
// at the time. So the command set, the run.json key set, the family list, and the
// absence of the dropped subsystems are asserted here as exact values.
//
// Widening any of them requires editing this file, which is the point: the
// decision becomes visible in a diff instead of arriving as a reasonable-sounding
// addition. Only Jason widens it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../bin/factory.js";
import { FAMILY_IDS } from "../core/contracts.js";
import { RUN_KEYS } from "../state/schema.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Widened deliberately when slices/observe landed. BUILD-PLAN-SMALL.md declares
// twelve commands; `validator` and `pr` are not built yet, so they are absent here
// and adding them will be another visible diff.
const CLI_COMMANDS = [
  "init", "status", "lock", "heartbeat", "gate", "step", "terminal",
  "slices-seed", "slice", "observe",
];

const RUN_JSON_KEYS = [
  // viso's fifteen
  "version", "run_id", "jira_key", "branch", "worktree", "created_at", "updated_at",
  "status", "max_parallel_slices", "max_retries", "gates", "steps", "slices", "validator", "pr_url",
  // the three justified additions
  "mode", "terminal_result", "base_commit",
];

const FAMILIES = ["envelope", "gates", "steps", "slices", "verdict"];

// Dropped subsystems. Each was a top-level run.json field or a module in the
// predecessor; none is required by "viso + atomic transitions + autonomy".
const FORBIDDEN_SUBSTRINGS = [
  "post_pr", "continuation", "checkpoint_source", "checkpoint_progress",
  "integration_amendment", "integration_gate", "steering", "cost_attribution",
  "delivery_envelope", "special_builder_dispatch", "debug_snapshot", "review_tier",
  "dispatch_claim", "completion_token", "hash_chain", "claim_nonce",
];

function sourceFiles(dir = pkg, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith(".js")) found.push(path);
  }
  return found;
}

const files = sourceFiles();
const productionFiles = files.filter((path) => !path.includes(`${pkg}/test/`));

describe("ceiling — scope cannot grow without editing this file", () => {
  it("exposes exactly the declared CLI commands", () => {
    assert.deepEqual(Object.keys(COMMANDS).sort(), [...CLI_COMMANDS].sort());
  });

  it("declares exactly the declared run.json top-level keys", () => {
    assert.deepEqual([...RUN_KEYS].sort(), [...RUN_JSON_KEYS].sort());
    assert.equal(RUN_KEYS.length, 18, "eighteen fields: viso's fifteen plus three");
  });

  it("registers exactly the declared families", () => {
    assert.deepEqual([...FAMILY_IDS].sort(), [...FAMILIES].sort());
  });

  it("contains no trace of a dropped subsystem", () => {
    const offenders = [];
    for (const path of productionFiles) {
      const text = readFileSync(path, "utf8");
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        // The ceiling test names them to forbid them, so it exempts itself.
        if (text.includes(needle)) offenders.push(`${path.slice(pkg.length + 1)} :: ${needle}`);
      }
    }
    assert.deepEqual(offenders, [], "a dropped subsystem reappeared");
  });

  it("imports nothing from the predecessor tree", () => {
    const offenders = files
      .filter((path) => /from\s+["'][^"']*\/src\//u.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(pkg.length + 1));
    assert.deepEqual(offenders, [], "the old tree is a reference, never a dependency");
  });

  it("depends on nothing outside the node standard library", () => {
    const offenders = [];
    for (const path of files) {
      for (const [, specifier] of readFileSync(path, "utf8").matchAll(/from\s+["']([^"']+)["']/gu)) {
        const bare = !specifier.startsWith(".") && !specifier.startsWith("node:");
        if (bare) offenders.push(`${path.slice(pkg.length + 1)} :: ${specifier}`);
      }
    }
    // The standalone package must build and test with no opencode installed, and
    // a zero-dependency package is the cheapest way to keep that true.
    assert.deepEqual(offenders, [], "the standalone package takes no third-party dependency");
  });

  it("keeps the production surface small enough to read in one sitting", () => {
    const total = productionFiles.reduce((sum, path) => sum + readFileSync(path, "utf8").split("\n").length, 0);
    // Not a hard architectural limit — a tripwire. Crossing it means re-reading
    // BUILD-PLAN-SMALL.md's non-goals before adding more, not that the number is
    // wrong. Raise it deliberately, with a reason in the commit message.
    assert.ok(total < 2000, `production source is ${total} lines; the tripwire is 2000`);
  });

  it("keeps the test budget within the attack catalogue's scale", () => {
    const testFiles = files.filter((path) => path.endsWith(".test.js"));
    const count = testFiles.reduce((sum, path) => sum + (readFileSync(path, "utf8").match(/^\s*it\(/gmu)?.length ?? 0), 0);
    // The catalogue is 12 attacks with a 12-15 budget, plus write-plane and
    // ceiling coverage. Exceeding this means proof mass is creeping, which is the
    // failure mode that produced 68,911 lines of tests last time.
    assert.ok(count <= 60, `${count} tests; the budget is 60`);
  });
});
