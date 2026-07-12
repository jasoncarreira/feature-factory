import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "./helpers/git-fixture.js";
import { fileURLToPath } from "node:url";
import { projectCliData, renderCliResultLines } from "../src/cli-output.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SECRET = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
const HOSTILE = `visible\u001B]0;pwned\u0007 Authorization: Basic ${SECRET}`;
const PAT = "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH";
const TOKEN = "ghp_11AA22BB33CC44DD55EE66FF77GG88HH";
const ACTIVE_CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

describe("centralized CLI output", () => {
  it("projects scalar, JSON, table, and key-value results without changing their normal shapes", () => {
    const scalar = renderCliResultLines(HOSTILE, {});
    assert.equal(scalar.length, 1);
    assertSafe(scalar.join("\n"));

    const json = renderCliResultLines({
      status: "running",
      boundary_token: "boundary-token-value",
      summary: HOSTILE,
      model: HOSTILE,
    }, { json: true })[0];
    assert.deepEqual(JSON.parse(json), {
      status: "running",
      boundary_token: "boundary-token-value",
      summary: `visible\u001B]0;pwned\u0007 Authorization: Basic [redacted]`,
      model: `visible\u001B]0;pwned\u0007 Authorization: Basic [redacted]`,
    });
    assertSafe(json);

    const table = renderCliResultLines([{
      run_id: "run-1",
      status: "running",
      gate: "brief",
      updated_at: "2026-07-11T00:00:00.000Z",
      diagnostics: { classification: "recoverable", status: "warning", summary: HOSTILE },
    }], {}, { formatListCostColumn: () => "-" })[0];
    assert.equal(table.split("\t").length, 6);
    assertSafe(table.replaceAll("\t", ""));

    const hostileTable = renderCliResultLines([{
      run_id: HOSTILE,
      status: HOSTILE,
      gate: HOSTILE,
      updated_at: HOSTILE,
      diagnostics: null,
    }], {}, { formatListCostColumn: () => HOSTILE })[0];
    assert.equal(hostileTable.split("\t").length, 6);
    assertSafe(hostileTable.replaceAll("\t", ""));

    const keyValue = renderCliResultLines({ status: "running", model: HOSTILE, reason: HOSTILE }, {});
    assert.equal(keyValue[0], "status: running");
    assertSafe(keyValue.join("\n"));
  });

  it("hardens unknown commands and top-level errors while preserving stderr and failure exits", () => {
    for (const args of [["factory", HOSTILE], [HOSTILE]]) {
      const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.notEqual(proc.status, 0);
      assert.equal(proc.stdout, "");
      assertSafe(proc.stderr);
      assert.match(proc.stderr, /unknown (?:factory )?command/u);
    }
  });

  it("preserves validated contractual identities exactly", () => {
    const identities = {
      run_hash: `sha256:${"a".repeat(64)}`,
      hash: `sha256:${"b".repeat(64)}`,
      state_hash: `sha256:${"c".repeat(64)}`,
      ref: "steering/consumed-2026-07-11T00-00-00Z-steer-1.json",
      review_ref: "reviews/spec-writer.json",
      run_ref: ".opencode/factory/feature-run/run.json",
      branch: "feature/contract-hardening",
      commit: "abcdef1234567890",
      merge_commit: "1234567abcdef",
      worktree: "/var/folders/generated-worktree-9H0VP7/.opencode/worktrees/feature-run",
      artifact_path: "/tmp/project/artifacts/spec.md",
    };

    assert.deepEqual({ ...projectCliData(identities) }, identities);
    assert.deepEqual(JSON.parse(renderCliResultLines(identities, { json: true })[0]), identities);
  });

  it("rejects credentials and invalid ref, branch, and path identities", () => {
    const cases = [
      ["basic ref", "ref", `Authorization: Basic ${SECRET}`],
      ["PAT ref", "review_ref", PAT],
      ["PAT run id", "run_id", PAT],
      ["token branch", "branch", TOKEN],
      ["Basic branch", "branch", `Authorization: Basic ${SECRET}`],
      ["PAT worktree", "worktree", `/tmp/${PAT}/worktree`],
      ["Basic path", "path", `/tmp/Authorization: Basic ${SECRET}/worktree`],
      ["traversal ref", "ref", "reviews/../secrets.json"],
      ["option ref", "ref", "-option"],
      ["dot ref", "ref", "reviews/./spec.json"],
      ["hidden ref", "ref", "reviews/.hidden/spec.json"],
      ["trailing ref", "ref", "reviews/spec.json/"],
      ["duplicate ref", "ref", "reviews//spec.json"],
      ["lock ref", "ref", "reviews/spec.lock"],
      ["trailing-dot ref", "ref", "reviews/spec."],
      ["reflog branch", "branch", "feature/@{previous"],
      ["at branch", "branch", "@"],
      ["hidden branch", "branch", "feature/.hidden"],
      ["lock branch", "branch", "feature/topic.lock"],
      ["duplicate branch", "branch", "feature//topic"],
      ["option branch", "branch", "-option"],
      ["whitespace branch", "branch", "feature topic"],
      ["metachar branch", "branch", "feature~topic"],
      ["backslash branch", "branch", "feature\\topic"],
      ["bidi branch", "branch", "feature/\u202Etopic"],
      ["controlled path", "path", "/tmp/worktree\u001Bescape"],
    ];

    for (const [label, key, value] of cases) {
      assert.equal(projectCliData({ [key]: value })[key], "[redacted]", label);
    }
    const output = cases.map(([, key, value]) => renderCliResultLines({ [key]: value }, { json: true })[0]).join("\n");
    for (const secret of [SECRET, PAT, TOKEN]) assert.doesNotMatch(output, new RegExp(secret, "u"));
    assert.doesNotMatch(output, ACTIVE_CONTROLS);
  });

  it("keeps controls escaped and credentials absent in non-identity freeform fields", () => {
    const output = renderCliResultLines({ summary: HOSTILE, detail: `token ${PAT}` }, { json: true })[0];
    assert.doesNotMatch(output, new RegExp(SECRET, "u"));
    assert.doesNotMatch(output, new RegExp(PAT, "u"));
    assert.doesNotMatch(output, ACTIVE_CONTROLS);
    assert.match(output, /\\u001B/iu);
  });
});

function assertSafe(output) {
  assert.doesNotMatch(output, new RegExp(SECRET, "u"));
  assert.doesNotMatch(output, ACTIVE_CONTROLS);
  assert.match(output, /\\u001B/iu);
}
