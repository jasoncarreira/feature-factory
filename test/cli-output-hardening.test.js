import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "./helpers/git-fixture.js";
import { fileURLToPath } from "node:url";
import { renderCliResultLines } from "../src/cli-output.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SECRET = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
const HOSTILE = `visible\u001B]0;pwned\u0007 Authorization: Basic ${SECRET}`;
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
    }, { json: true })[0];
    assert.deepEqual(JSON.parse(json), {
      status: "running",
      boundary_token: "boundary-token-value",
      summary: `visible\u001B]0;pwned\u0007 Authorization: Basic [redacted]`,
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

    const keyValue = renderCliResultLines({ status: "running", reason: HOSTILE }, {});
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
});

function assertSafe(output) {
  assert.doesNotMatch(output, new RegExp(SECRET, "u"));
  assert.doesNotMatch(output, ACTIVE_CONTROLS);
  assert.match(output, /\\u001B/iu);
}
